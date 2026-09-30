# jev-router — Design Spec

Date: 2026-09-29 (rev 2: fully local engine) · Status: approved · Repo: `claude-token-plugins` → `plugins/jev-router`

## 1. Goal

Reduce Claude Code credit usage with a fast, **fully local** "System One" decision layer in the style of
TypeSafe's JEV. It answers typed questions (`choice` / `score` / `noul`) about each prompt. The plugin turns
the answers into small routing hints and blocks the most common token-wasting tool calls.

Success criteria:

1. Installs from a Git repo; the engine installs with one command (`/jev-router:setup`).
2. **Nothing leaves the device.** After setup there are no network calls. Setup itself only downloads pinned,
   checksummed artefacts; no user data is sent.
3. No API key and no account.
4. Adds ≤ 80 tokens of context per prompt, and **zero** when it has nothing useful to say.
5. Routes to *all* subagents the user really has: built-ins, user agents, project agents, and agents
   shipped by enabled plugins.
6. Never blocks the user. Any failure means no hint.
7. Every behaviour has automated tests, plus a real headless `claude --plugin-dir` run.

## 2. Why a local embedding engine (spike, 2026-09-29, Win11 laptop, 14.8 GB RAM, no GPU)

| Engine | Result |
|---|---|
| TypeSafe hosted JEV | Cloud-only (no weights), so it violates "nothing leaves the device". Rejected |
| jeff (JEV-compatible, GLiFormer, PyTorch) | **Blocked by Windows Smart App Control** (unsigned torch DLL, WinError 4551); listens on 0.0.0.0 by default. Rejected |
| Ollama + qwen3.5 0.8B (logprob decisions) | 6.3 s per prompt, unusable accuracy. Rejected |
| **all-MiniLM-L6-v2 (q8, 23 MB) on onnxruntime-node** | **4.7 ms per prompt once loaded, ~1.0 s per cold hook process**; Microsoft-signed binaries pass Smart App Control; 12/12 confident agent picks correct in a 20-prompt sanity set. **Chosen** |

The engine is described as *JEV-style*. It is not JEV and makes no claim of JEV's accuracy.

## 3. Platform facts relied on (verified 2026-09-29)

| Fact | Source |
|---|---|
| `UserPromptSubmit` → `hookSpecificOutput.additionalContext`; cannot replace the prompt or change the model | code.claude.com/docs/en/hooks |
| `PreToolUse` → `permissionDecision: "deny"` + `permissionDecisionReason` (shown to Claude) | same |
| `PostToolUse` → `hookSpecificOutput.updatedToolOutput` replaces the tool result | same |
| Common JSON output `systemMessage` is shown to the **user** (costs Claude no context) | same |
| Hook `timeout` is in seconds; `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` | same |
| Plugin agents are namespaced `<plugin>:<name>`; `userConfig` → `CLAUDE_PLUGIN_OPTION_<KEY>` | plugins docs |
| `claude --plugin-dir`, `claude plugin validate` | plugins/cli-reference |
| `onnxruntime-node@1.30.0` bundles win32/linux/darwin binaries; its `postinstall` downloads extras, so it is installed with `--ignore-scripts` | npm registry metadata |

## 4. Repository layout

```
claude-token-plugins/
├── .claude-plugin/marketplace.json          # marketplace "claude-token-plugins"
├── .github/workflows/ci.yml                 # tests on ubuntu + windows, plugin validate
├── README.md  LICENSE (MIT)
└── plugins/jev-router/
    ├── .claude-plugin/plugin.json           # name, version, userConfig
    ├── hooks/hooks.json
    ├── engine/package.json, package-lock.json   # pinned engine deps (installed by setup, not at plugin install)
    ├── scripts/
    │   ├── route-prompt.js    # UserPromptSubmit
    │   ├── guard-tool.js      # PreToolUse (Read|Bash|Grep)
    │   ├── trim-output.js     # PostToolUse (Bash)
    │   ├── session-start.js   # SessionStart: setup reminder (hard gate)
    │   ├── setup.js           # /jev-router:setup
    │   └── doctor.js          # /jev-router:doctor
    ├── lib/
    │   ├── hookio.js  config.js  log.js  ledger.js
    │   ├── catalog.js  shortlist.js  heuristics.js  policy.js  guard-rules.js
    │   └── engine/
    │       ├── index.js       # decide(): engine → Decision; loopback-only remote option
    │       ├── local.js       # ONNX session, mean pooling, normalise
    │       ├── questions.js   # typed questions: choice / score / noul
    │       ├── wordpiece.js   # zero-dep BERT WordPiece tokenizer (reads tokenizer.json)
    │       ├── vectors.js     # label-vector cache (vectors.json, base64 Float32)
    │       └── manifest.js    # pinned model revision + sha256, engine paths
    ├── agents/quick.md  agents/scout.md
    ├── skills/setup/SKILL.md  skills/doctor/SKILL.md   # skills supersede commands/ in current Claude Code
    └── test/ (node:test) + test/fixtures/
```

Plugin code: Node ≥ 18, CommonJS, **zero runtime dependencies**. The engine's only dependency,
`onnxruntime-node`, lives in `${CLAUDE_PLUGIN_DATA}/engine`, is installed by setup, and is loaded with a
dynamic `require` from that path. Hook commands are `node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.js"`.

## 5. Configuration (`userConfig`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | string: `advise` \| `guard-only` \| `off` | `advise` | `guard-only` disables prompt routing |
| `read_line_cap` | number | 800 | Read guard threshold (lines) |
| `trim_output_lines` | number | 600 | Bash output trim threshold; `0` disables |

Env-only: `JEV_BASE_URL` (optional). If set, it must resolve to `127.0.0.1`, `::1` or `localhost`, and it is
used as a JEV-wire-compatible local server instead of the built-in engine. **Any non-loopback URL is
refused** and logged. `CLAUDE_CONFIG_DIR` (default `~/.claude`).

## 6. Local engine

### 6.1 Setup (`/jev-router:setup` → `scripts/setup.js`)
1. Print what will happen: roughly 100 MB of downloads (the `onnxruntime-node` package and a 23 MB model)
   into `${CLAUDE_PLUGIN_DATA}/engine`, with no data uploaded.
2. Copy `engine/package.json` and `package-lock.json` into the data dir, then run
   `npm ci --ignore-scripts --no-audit --no-fund --omit=dev`. The lockfile carries integrity hashes.
3. Delete `onnxruntime-node/bin/**` entries for other OS/arch combinations to save space. The host's own
   binaries are kept.
4. Download `Xenova/all-MiniLM-L6-v2` at **revision `751bff37182d3f1213fa05d7196b954e230abad9`**:
   `onnx/model_quantized.onnx` (sha256 `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`)
   and `tokenizer.json` (sha256 pinned in `manifest.js` when implemented). Each is written to a temp file,
   hash-checked, then renamed. A mismatch deletes the file and aborts.
5. Self-test: load the model, embed 3 fixed strings, and check the vector dimension (384) and the expected
   similarity ordering. Write `engine/READY.json` = `{version, revision, installedAt, platform}`.
6. The script is idempotent: a re-run verifies and repairs. `--uninstall` deletes `engine/`.

### 6.2 Hard gate
- `session-start.js`: if `mode=advise` and `READY.json` is missing or invalid, emit
  `{"systemMessage": "jev-router: routing is off until you run /jev-router:setup (local engine, ~100 MB, one-time)."}`.
  It is shown to the user only, costs no Claude tokens, and appears once per session.
- `route-prompt.js`: engine not ready → no output. The tool guard and trim work regardless of setup.
- Runtime failure after setup (corrupt model, load error, or over time budget) → heuristic decision for that
  prompt (fail-open). Recorded as `source: "heuristic-fallback"` so the doctor shows it.

### 6.3 Typed questions (`local.js`)
Everything runs on normalised mean-pooled embeddings with cosine similarity. `T` is the softmax temperature.
- `choice(state, criteria{key: description})`: softmax over `sim(state, "key: description")`, T = 0.05 →
  `{choice, probabilities, confidence}`.
- `score(state, levels[])`: each level has a prototype text plus 2–3 fixed exemplar phrases; its similarity is
  the max over them; softmax with T = 0.05 → `{score: Σ i·pᵢ, probabilities, confidence: max pᵢ}`.
- `noul(state, {true, false})`: softmax over the two descriptions with T = 0.05 → `{noul: p(true)}`.
- Label vectors are cached in `${CLAUDE_PLUGIN_DATA}/vectors.json` (base64 Float32, keyed by sha1 of the
  label text, atomic rename on save, capped at 3,000 entries), so agents are embedded only once. Setup
  pre-computes vectors for the whole catalog.
- Candidate pool = the top 12 agents by cosine similarity plus the BM25 shortlist, so agents with no
  lexical overlap can still be chosen.
- Inputs are truncated to 256 WordPiece tokens. ONNX session options: 1 intra-op thread and graph
  optimisation enabled.

### 6.4 `engine/index.js`: `decide({prompt, candidates, cfg}) → Decision | null`
Questions: `difficulty` (score, 4 levels), `agent` (choice over `main` plus the shortlist), and `verbose`
(noul). `Decision = {source: "engine"|"remote", difficulty 0..3, difficultyConf, agent|null, agentConf, verbose, latencyMs}`.
The whole call has a 2,500 ms budget, then it returns `null` and the caller uses the heuristic.

### 6.5 Hybrid with heuristics
The final difficulty combines the engine distribution (weight 0.6) with the heuristic's one-hot level
(weight 0.4). `verbose` = heuristic regex match **or** engine `noul ≥ 0.7`. `agent` comes from the engine only.

## 7. Other components (unchanged from rev 1 unless noted)

- **`catalog.js`**: sources are built-ins, `<configDir>/agents/**`, `<project>/.claude/agents/**`, and enabled
  plugins resolved through `installed_plugins.json` + `enabledPlugins` (user → project → local, later wins).
  Scope-aware entry choice, `plugin.json` custom `agents` path, names `<plugin>:<name>`, a frontmatter parser
  that handles block scalars, `<example>` stripping, 240-character descriptions, and a cache keyed on mtimes.
- **`shortlist.js`**: BM25 top 12, always including `Explore`, `jev-router:scout` and `jev-router:quick`.
- **`heuristics.js`**: difficulty and verbose signals; agent = the top BM25 result with a ≥ 1.5× margin; confidences 0.6.
- **`policy.js`**: decision → one hint line of at most 300 characters, or `null`.
  - No hint for slash commands, prompts under 4 characters, or acknowledgements.
  - Delegate when `agentConf ≥ 0.55`.
  - Scout suggestion when difficulty ≤ 1 and there is no agent.
  - "Answer tersely" when difficulty ≤ 1 and verbose is not wanted.
  - Difficulty 3 → no extra advice.
  - All confidences < 0.5 → `null`.
- **`guard-rules.js` + `ledger.js`**: the Read, Bash and Grep rules from rev 1. Deny once, then allow the
  identical repeat through the normal permission flow. The guard **never returns `allow`**.
- **`trim-output.js`**: head 150 + marker + tail 100 once a result exceeds `trim_output_lines`. Enabled by
  default only after the headless run confirms the Bash `updatedToolOutput` shape; otherwise it ships with `0`.
- **`log.js`**: `decisions.jsonl` capped at 500 lines. It stores a sha1 prefix of the prompt, never the text.
- **`hookio.js`**: fail-open wrapper with hard timers (routing 7 s, guard and trim 4 s, session-start 3 s).
  Errors go to `errors.log`.

## 8. Hook wiring

| Event | Matcher | Script | timeout (s) |
|---|---|---|---|
| SessionStart | `startup\|resume\|clear` | session-start.js | 5 |
| UserPromptSubmit | — | route-prompt.js | 8 |
| PreToolUse | `Read\|Bash\|Grep` | guard-tool.js | 5 |
| PostToolUse | `Bash` | trim-output.js | 5 |

## 9. Commands and agents

- `/jev-router:setup`: runs `setup.js` (6.1). `/jev-router:setup --uninstall` removes the engine.
- `/jev-router:doctor`: reports:
  - Node version and mode,
  - engine status (READY.json, revision, file hashes re-verified, 3-string self-test latency),
  - `JEV_BASE_URL` status (loopback check),
  - catalog counts by source, plus any duplicates,
  - the last 10 decisions (source, difficulty, agent, confidence, latency),
  - counts of guard denies and trims.
- `jev-router:quick` (haiku): small edits and lookups. `jev-router:scout` (haiku, read-only): search and summaries.

## 10. Privacy guarantees (enforced and tested)

1. No hosted endpoint exists in the code. `JEV_BASE_URL` must be loopback, which a unit test covers.
2. After setup, a test runs the engine with `fetch` and `http(s).request` monkey-patched to throw. Routing must
   still succeed.
3. Logs never contain prompt text. The doctor output prints no content, only counts and hashes.
4. What leaves the device: nothing from the plugin. Claude Code itself sends conversations, including any hint
   the plugin adds, to Anthropic as usual. The README states this plainly.

## 11. Testing

- **Unit** (`node --test`):
  - catalog fixtures (enabled and disabled plugins, stale cached versions, translation folders, custom agents
    path, project scope, malformed frontmatter),
  - shortlist, heuristics, policy (table-driven),
  - guard rules (positive and negative case per rule, bounded pipes), ledger,
  - wordpiece tokenizer against known token ids,
  - typed-question maths with a fake embedder, hybrid combination, loopback URL validation,
  - manifest hash verification, log capping.
- **Engine integration** (runs when READY): real model, 20-prompt golden set with expected agent/difficulty;
  report precision at ≥ 0.55 and p50/p95 latency; the no-network test (§10.2). Skipped if the engine isn't
  installed, and reported as skipped.
- **Setup**: install into a temp `CLAUDE_PLUGIN_DATA`, then check hash-mismatch abort, idempotent re-run and uninstall.
- **Hook integration**: spawn scripts with stdin fixtures and a temp config/data dir. Every path (not ready,
  ready, engine throws, timeout) exits 0 with valid JSON or empty output.
- **Plugin**: `claude plugin validate`; marketplace add + install from the repo path into a throwaway `CLAUDE_CONFIG_DIR`.
- **Headless end to end**: `claude --plugin-dir plugins/jev-router -p …`. Asserts:
  - the setup reminder appears before setup,
  - a decision is logged after setup,
  - a Read of a >800-line file is denied once and allowed on retry,
  - the PostToolUse shape is confirmed.
- **CI**: GitHub Actions on `ubuntu-latest` and `windows-latest`, running unit tests, setup + engine
  integration, and `claude plugin validate`.

## 12. User-trouble hardening (rev 3, 2026-09-30)

The implementation plan carries a 21-row user-trouble register (U1–U21), with a fix and a test or check for each row. Design-level additions:

- **Readiness states**: `missing | stale | broken | lite | ready`. Each state has its own SessionStart message, shown at most once per 24 h per state.
- **Lite mode**: when the native engine can't run (unsupported OS/arch, musl, Smart App Control/AV block, or `--lite`), routing uses the built-in rules. The guard is unaffected.
- **Setup**:
  - preflight (Node 18+, npm, write access, ~300 MB free) and an exclusive lock;
  - `HF_ENDPOINT` mirrors and `--model-dir` offline import, both checksum-enforced;
  - proxy guidance in the download error.
- **Guard**:
  - circuit breaker after 5 denials per session;
  - `find` with `-delete`/`-exec` isn't treated as a listing;
  - deny reasons tell Claude to repeat the call if the user asked for full output;
  - `agent_type` is logged for subagent calls.
- **Hints** are tool-neutral (`delegate to subagent "<name>"`).
- **Engine**:
  - the model loads from bytes (non-ASCII paths);
  - at most 40 new agent embeddings per prompt, with the cache saved every 20.
- **Releases**:
  - every change to shipped plugin files bumps `plugin.json` `version`, enforced in CI, because users only receive updates when it changes;
  - weekly scheduled CI on Linux, Windows and macOS.
- **Latency budget**: route hook p95 ≤ 1200 ms and guard hook p95 ≤ 200 ms, measured by `scripts/bench-hooks.js`.
- **Live-verified behaviours** (Task 3b), recorded in §3: coexistence with other plugins' hooks, hooks inside subagents, Edit after a partial Read, a missing Node, and plugin paths with spaces.

## 13. Non-goals

The TypeSafe hosted API, model switching, a request proxy, an MCP decide tool, and savings dashboards.
Cortex is specified separately.
