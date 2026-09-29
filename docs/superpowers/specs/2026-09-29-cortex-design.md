# Cortex — Design Spec

Date: 2026-09-29 · Status: awaiting review · Repo: `claude-token-plugins` → `plugins/cortex`
Build order: after jev-router ships. Delivered in milestones M0–M6 (§15).

## 1. Goal

A local-first persistent memory plugin for Claude Code. It stores knowledge as Markdown, retrieves only
what is relevant, and injects it within a strict token budget. Everything happens automatically through
lifecycle hooks, with optional commands for inspection and control.

Success criteria:

1. A new session in a known project starts with the right context, and the user does not re-explain it.
2. Measured overhead: ≤ 500 tokens at session start, ≤ 350 per prompt, ≤ 4,000 per session (defaults).
   Each memory entry is injected **at most once per session**.
3. Markdown is the only source of truth. Every other artefact (the SQLite index, CORTEX.md) is derived
   and can be rebuilt with a single command.
4. Works offline on CPU, with zero dependencies, on Node ≥ 18. Node ≥ 22.5 enables the SQLite fast path.
5. Never stores secrets. `forget` is permanent: automatic capture cannot bring a forgotten entry back.

## 2. Verified platform facts (2026-09-29)

| Fact | Consequence |
|---|---|
| `UserPromptSubmit` can add `additionalContext` but **cannot replace the prompt** | "Rewriting" means adding a *resolved-context* block; the original prompt stays untouched and traceable |
| `SessionStart` sources: `startup`, `resume`, `clear`, `compact`, `fork`; supports `additionalContext` | Profile injection happens here; the ledger resets on `clear`/`compact` |
| `Stop` fires after every turn; command hooks support `async: true` | Incremental background checkpoint every turn, so a crash loses at most one turn |
| `SessionEnd` has a shared **1.5 s** budget | It only writes a "closed" marker and spawns a detached consolidation job |
| `PreCompact` fires before compaction | A synchronous quick snapshot before context is lost |
| All hooks receive `transcript_path` (JSONL) | Capture reads the transcript incrementally, so no PostToolUse hook is needed |
| Node 25 `node:sqlite` has FTS5 + `bm25()` (tested locally); it prints an ExperimentalWarning | Hooks run with `node --no-warnings`; a pure-JS BM25 fallback covers Node < 22.5 |
| Reads outside the working directory need approval; `Read(~/.cortex/**)` allow rules work | Hooks inject excerpts (no permission needed); on-demand reads need one allow rule, which the doctor prints |
| Native auto-memory loads `MEMORY.md` (first 200 lines / 25 KB), and topic files load on demand | CORTEX.md follows the same proven pattern; Cortex never re-injects native memory or CLAUDE.md |

## 3. Relationship to native memory

Claude Code already loads CLAUDE.md files and auto-memory `MEMORY.md` every session. Cortex:
- **reads** them as retrieval sources (indexed with `source: native`, read-only),
- **never injects** content that native memory already loads (dedupe by source path),
- **never writes** to them.

## 4. Storage layout (`storage_dir`, default `~/.cortex/`)

```
~/.cortex/
├── CORTEX.md                         # GENERATED root index (see §5)
├── global/                           # core memory: preferences, standing instructions
│   └── <id>.md
├── projects/<project-slug>/
│   ├── CORTEX.md                     # GENERATED project index
│   ├── STATE.md                      # current project state + open tasks (maintained by consolidation)
│   └── entries/<id>.md               # concept, decision, procedure, error-solution, ...
├── sessions/<yyyy-mm>/<session-id>.md  # session checkpoints
├── .index/cortex.db                  # DERIVED: SQLite (FTS5, links, metadata); or lexicon.json fallback
├── .backups/<relpath>.<n>.md         # last 5 versions of each file
├── .locks/                           # lockfiles
├── .state/<session-id>.json          # per-session ledger + transcript offset
└── tombstones.jsonl                  # forgotten ids + content fingerprints
```

- `project-slug` is the git remote name (or the git root folder name, or the cwd folder name), plus a
  6-character hash of the root path so projects with the same name don't collide.
- `id` = `YYYYMMDD-<kebab-title>` with a numeric suffix if it already exists; ids are never reused.
- `storage_dir` is verified at startup: it must be writable, must not be under `os.tmpdir()`, and must pass
  a write–fsync–read test. If it fails, Cortex runs read-only and the doctor explains why.

## 5. CORTEX.md: the storage index

**Purpose:** one small, human- and Claude-readable map of what is stored where. It serves three roles:
1. **Progressive disclosure:** Claude reads the index, then opens only the entry files it needs.
2. **Degraded-mode retrieval:** if the SQLite index is missing or corrupt, retrieval parses CORTEX.md lines
   (id, title, hook, tags) and ranks them with BM25. Retrieval still works while the index rebuilds.
3. **Human navigation:** readable in any editor. `[[wikilinks]]` make it browsable in Obsidian.

**Rules:**
- **Generated, never hand-edited.** It starts with `<!-- GENERATED by cortex — edit entries, not this file -->`.
  It is rebuilt from entry frontmatter after every store write, using the atomic write + lock (§8). It is
  cheap because the metadata comes from the index (or a frontmatter scan in fallback mode).
- **Size-capped and hierarchical**, like native `MEMORY.md`: the root has at most 120 lines, each project
  index at most 200 lines and 25 KB. Past the cap, older and lower-confidence entries collapse into a
  `+N more (see: /cortex:search)` line per section. Nothing is silently dropped.
- **One line per entry**: `- [[<id>]] <title> — <one-line hook> · <type> · <status> · <updated>`.
- **Validated**: the doctor diffs CORTEX.md against the entry files and regenerates it on any mismatch.

**Root `~/.cortex/CORTEX.md`:**
```markdown
<!-- GENERATED by cortex — edit entries, not this file -->
# Cortex index
Layout: global/ (core) · projects/<slug>/ (CORTEX.md, STATE.md, entries/) · sessions/<yyyy-mm>/
## Core memory (global)
- [[20260912-prefers-pnpm]] Use pnpm, not npm — in every project · preference · current · 2026-09-12
## Projects
| Project | Entries | Updated | Index |
|---|---|---|---|
| shop-api-a1b2c3 | 48 | 2026-09-28 | [[projects/shop-api-a1b2c3/CORTEX]] |
## Recent sessions
- 2026-09-28 shop-api-a1b2c3 — Redis pool exhaustion fix in checkout worker → [[sessions/2026-09/<id>]]
```

**Project `projects/<slug>/CORTEX.md`:** state summary (3 lines from STATE.md) → open tasks → sections by
type (Decisions, Procedures, Error→Solution, Concepts, Sessions) → **Hubs** (the 5 most-linked entries,
listed with their links) → **Conflicts** (entries whose status is `conflict`) → Superseded (count plus a link).

**Where it is used:**
- `SessionStart` injects the project index's **state, open-tasks and hubs sections only** (≤ 500 tokens), plus
  one pointer line: `More: ~/.cortex/projects/<slug>/CORTEX.md`.
- `UserPromptSubmit` never injects CORTEX.md. It injects entry excerpts (§9), each with the entry's path,
  so Claude can open the full entry.

## 6. Entry schema (`MEMORY_SCHEMA.md` will mirror this)

```yaml
---
id: 20260912-asg-warm-pool
title: GPU workers use an ASG warm pool (Stopped state)
type: decision        # core | project | session | concept | decision | procedure | error-solution
scope: project        # global | project
project: shop-api-a1b2c3
created: 2026-09-12T10:04:00Z
updated: 2026-09-20T08:11:00Z
source_session: 3f9e1c42-…
status: current       # current | historical | unverified | superseded | preference | conflict
confidence: 0.9       # 0..1
related: ["[[ecs-capacity-provider]]", "[[gpu-worker]]"]
supersedes: []        # ids
superseded_by: null
files: [{path: "infra/asg.tf", sha: "a1b2c3d", mtime: "2026-09-20T08:00:00Z"}]
tags: [aws, autoscaling, gpu]
---
One-line summary (always the first body line; used for summary-first retrieval).

Details…
```

- **Backlinks** are computed in the index and shown by `/cortex:inspect` and in CORTEX.md hubs. They are
  not written into entry files, so a new link never rewrites old files.
- **Validation**: required fields, known enums, ISO timestamps, confidence between 0 and 1, and the
  summary line present. An invalid file is quarantined (skipped and listed by the doctor), never deleted.
- **Staleness**: when a file listed in `files` has changed since the entry recorded it (sha or mtime),
  retrieval marks the excerpt `⚠ may be stale — check repo`.

## 7. Modules (`plugins/cortex/lib/`)

| Module | Responsibility |
|---|---|
| `hooks/` (scripts) | Thin entrypoints per event; fail-open wrapper; project detection; session state |
| `store/` | Entry read/write, schema validation, atomic write, locks, backups, quarantine, tombstones, redaction |
| `index/` | SQLite FTS5 + link and metadata tables; JSON-lexicon fallback; incremental updates by mtime; CORTEX.md generation |
| `retrieve/` | Query building, exact + BM25, metadata filters, graph expansion, rerank, excerpting |
| `budget/` | Token estimation, P0–P4 packing, per-session ledger, caps |
| `capture/` | Incremental transcript parsing → candidate entries and session checkpoint |
| `consolidate/` | Dedupe/merge, supersede, conflicts, STATE.md refresh; optional Haiku pass |

Diagnostics live in `/cortex:doctor` and `bench/` (§15).

## 8. Integrity

- **Atomic write**: write `<file>.tmp-<pid>`, fsync, then rename. On Windows, retry EPERM/EBUSY 5× with
  backoff. Before overwriting, copy the previous version into `.backups/` (keep 5).
- **Locking**: `.locks/<name>.lock` is created with the exclusive-create flag and holds `{pid, host, ts}`. A lock
  older than 30 s whose pid is dead counts as stale and is broken. Store writes take the lock; reads don't.
- **SQLite** runs in WAL mode with a `busy_timeout` of 3 s, which makes concurrent sessions safe.
- **Recovery**: the index is disposable. If it is missing, corrupt, or on a schema version mismatch, it is
  rebuilt from the Markdown files (retrieval uses the CORTEX.md fallback meanwhile).
- **Truthful reporting**: every write returns `{ok, path}` or `{ok:false, error}`. Hooks and commands report
  only what actually succeeded.

## 9. Hook flows

| Event | Mode | Work |
|---|---|---|
| `SessionStart` (`startup`/`resume`) | sync, ≤ 3 s | detect project → check storage → incremental index refresh → inject profile (project CORTEX.md state/tasks/hubs + core preferences not already in native memory), ≤ 500 tokens |
| `SessionStart` (`clear`/`compact`) | sync | reset ledger → re-inject the compact profile |
| `UserPromptSubmit` | sync, ≤ 1.5 s | skip slash commands, trivial prompts and self-contained prompts → retrieve → drop ledger hits → pack by priority → inject the resolved-context block |
| `Stop` | **async** | read transcript from the saved offset → capture → write/merge entries + session checkpoint → advance offset |
| `PreCompact` | sync, ≤ 2 s | quick capture pass (no model calls) so nothing is lost at compaction |
| `SessionEnd` | ≤ 1.5 s | write the `closed` marker; spawn a detached consolidation job if enabled |

**Retrieval pipeline:**
1. Query terms come from the prompt, plus identifiers (file paths, symbols, quoted strings), plus the titles
   of entries injected in the last 3 turns. This last input resolves "it" and "same approach" lexically.
2. Exact match on ids, titles and tags.
3. FTS5 `bm25()`, or the fallback BM25.
4. Metadata filter: current project + global; `superseded` and `historical` excluded unless the prompt asks
   about history.
5. Graph expansion over `related` and backlinks: depth 1 by default (max 2), neighbours at 0.5× score.
6. Rerank: `score × recency(half-life 30 d) × confidence × status weight`
   (current 1.0, preference 1.0, unverified 0.6, conflict 0.8).
7. Keep entries above a relevance floor (top 5 at most).
8. Excerpt = the summary line, plus up to 2 matching detail lines.

**Injected block** (the original prompt is untouched; Claude resolves references using it):
```
[cortex] Related memory — current instructions and repo state take precedence:
- (decision · current · 0.9) GPU workers use an ASG warm pool (Stopped state) — ~/.cortex/projects/shop-api-a1b2c3/entries/20260912-asg-warm-pool.md
- (error-solution · current) Redis pool exhaustion → raise pool size and add retry backoff ⚠ may be stale — check repo
```
If two retrieved entries conflict, one line is added: `Conflicting memories above; ask the user if it matters.`

**Optional JEV gating:** if `JEV_API_KEY` is set, a `noul` question ("Does this request refer to earlier
work or context not stated in it?") skips retrieval for self-contained prompts. A `choice` question reranks
the top 8. Without JEV, a heuristic gate is used (pronouns and "again / same / previous / continue" cues,
or known entity names).

## 10. Token budget

- Estimator: `ceil(chars / 4 × model_factor)`, where `model_factor` is configurable (default 1.0).
- Priorities:
  - **P0**: the user's current instructions. These are never injected, because they're already in the prompt.
  - **P1**: STATE.md and open tasks.
  - **P2**: decisions.
  - **P3**: procedures, error-solutions and concepts.
  - **P4**: graph neighbours.
- Packing happens in priority order. When over budget, drop duplicates first (same id, or Jaccard > 0.8
  between excerpts), then shorten excerpts to their summary line, then drop P4 and then P3. The source path
  is always kept.
- Ledger: `.state/<session>.json` records the ids injected this session, so each entry is injected at most once.
  It resets on `clear`/`compact`.
- Metrics per injection go to `.state/metrics.jsonl`: tokens added, entries considered and injected,
  duplicate ratio, and latency.

## 11. Capture (deterministic by default)

It parses new transcript lines since the saved offset.

| Signal | Becomes |
|---|---|
| User text matching "remember / always / never / from now on / I prefer / don't …" | `preference` or instruction entry (global if it contains no project nouns), status `current` |
| A tool error followed later by success of the same command or file edit | `error-solution` (error line, the change in between, the successful command) |
| Assistant text containing "decided / we'll use / going with / chose" | `decision`, status `unverified`, confidence 0.5 |
| Files edited, commits made, tests run, final assistant summary | Session checkpoint (`sessions/…`) |
| Explicit `/cortex:remember` | Entry with status `current`, confidence 1.0 |

**Optional Haiku consolidation** (`llm_consolidation: false` by default): after `SessionEnd` or `PreCompact`,
a detached job runs `claude -p --model haiku` over the session checkpoint to extract facts, decisions and
failed approaches as schema-valid entries. It has a daily token cap (default 20k), and its results are
validated by the same schema as manual entries.

## 12. Consolidation (incremental, idempotent)

It runs on the `Stop` capture (cheap rules) and in the detached job (full pass):
- **Duplicates**: same type and project with title/summary shingle-Jaccard ≥ 0.8 → merge into the older id,
  union `related`/`files`/`tags`, confidence = max, provenance kept in a `## History` section.
- **Supersede**: a newer entry that explicitly replaces an older one (same subject key + a replace cue, or a
  user confirmation) sets `superseded_by`. The old entry becomes `superseded`. Nothing is deleted.
- **Conflicts**: contradictory entries (same subject key, different value) without an explicit replace
  both become `conflict` and are listed in the CORTEX.md Conflicts section until confirmed.
- **Idempotence**: running the job twice on the same inputs produces a byte-identical store (tested).
- It refreshes STATE.md and regenerates CORTEX.md.

## 13. Security and privacy

- **Redaction before any write**: AWS keys, `sk-`/`ghp_`/`xox`-style tokens, JWTs, PEM blocks, connection
  strings with passwords, `password=`/`secret=` assignments, and high-entropy strings (≥ 20 characters,
  entropy > 4.0) are replaced with `[REDACTED:<kind>]`.
- **Path deny-list**: `.env*`, `*.pem`, `*.key`, `id_*`, `*credentials*` and `secrets/**` never have their
  content captured.
- **`/cortex:forget <query|id>`**: removes the entry file, its backups and index rows, and adds its id and
  a content fingerprint to `tombstones.jsonl`. Capture checks tombstones, so forgotten facts cannot come back.
- **Everything local.** Network is used only if the optional JEV key or Haiku consolidation is enabled.

## 14. Commands

`/cortex:status`, `/cortex:search <q>`, `/cortex:remember <text>`, `/cortex:forget <q|id>`,
`/cortex:inspect <topic|id>` (entry + backlinks + neighbours), `/cortex:export` (zip of Markdown + CORTEX.md),
`/cortex:rebuild` (index + CORTEX.md from Markdown), `/cortex:doctor` (storage checks, index health,
CORTEX.md diff, quarantined files, allow-rule hint, last metrics).
Whether an unprefixed `/cortex status` form works is verified in M0. If it doesn't, the namespaced form is documented.

## 15. Milestones and tests

| M | Delivers | Tests (spec area) |
|---|---|---|
| M0 | Plugin skeleton, all hooks as logging no-ops, validate, **headless proof that each event fires with the expected input** | Lifecycle integration (15) |
| M1 | `store/`: schema, atomic write, locks, backups, quarantine, redaction, tombstones | Persistence (5), crash recovery (6), concurrent writes (7: 2 processes × 200 writes), secret exclusion (11), deletion (12) |
| M2 | `index/` + `retrieve/` + **CORTEX.md generation and fallback retrieval** | Topic discovery (4), offline use (13), large store (14: 5k synthetic entries, p95 latency), CORTEX.md cap/diff/fallback |
| M3 | `budget/` + SessionStart/UserPromptSubmit injection + ledger | New-session retrieval (1), reference resolution (3), budget enforcement (10) |
| M4 | `capture/` + Stop async + PreCompact + SessionEnd | Cross-session continuity (2), crash with no SessionEnd |
| M5 | `consolidate/` + optional Haiku job | Duplicates (8), conflicting updates (9), idempotence |
| M6 | Commands, doctor, docs, `bench/` | Golden-query evaluation in CI (recall@5, tokens, latency); opt-in A/B benchmark with `claude -p --output-format json` over scripted multi-session scenarios. **Numbers are reported only from real runs** |

Docs: README (install, config, storage, backup/restore, troubleshooting, limitations), ARCHITECTURE,
MEMORY_SCHEMA (including CORTEX.md), SECURITY, BENCHMARKS.

## 16. Configuration (`userConfig`)

| Key | Default |
|---|---|
| `storage_dir` (directory) | `~/.cortex` |
| `session_start_budget` / `prompt_budget` / `session_cap` | 500 / 350 / 4000 |
| `graph_depth` | 1 |
| `llm_consolidation` (boolean) / `llm_daily_tokens` | false / 20000 |
| `mode` | `auto` \| `capture-only` \| `off` |

## 17. Non-goals (v1)

Embeddings (revisit only if the M6 benchmark shows a recall gap), cloud sync, a UI, and writing into native memory.
