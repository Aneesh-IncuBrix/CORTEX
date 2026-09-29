# jev-router — Design Spec

Date: 2026-09-29 · Status: awaiting review · Repo: `claude-token-plugins` (marketplace) → `plugins/jev-router`

## 1. Goal

Reduce Claude Code credit usage by putting TypeSafe's **JEV** System-One decision model in front of
Claude as a cheap, fast triage layer. JEV (≈$42 per billion input tokens, output free, 70–500 ms)
answers typed questions about each prompt; the plugin turns the answers into small, actionable
guidance and blocks the most common token-wasting tool calls.

Success criteria:

1. Installs with two commands from a Git repo; works for anyone with Node ≥ 18.
2. Works **without** a JEV key (local heuristic fallback) and never blocks the user.
3. Adds ≤ 80 tokens of context per prompt, and **zero** when it has nothing useful to say.
4. Routes to *all* subagents the user really has: built-ins, user agents, project agents, and agents
   shipped by enabled plugins.
5. Every behaviour is covered by automated tests, plus a real headless `claude --plugin-dir` run.

## 2. Platform facts this design relies on (verified 2026-09-29)

| Fact | Source |
|---|---|
| `UserPromptSubmit` can add `hookSpecificOutput.additionalContext`; cannot replace the prompt or change the model | code.claude.com/docs/en/hooks |
| `PreToolUse` can return `permissionDecision: "deny"` + `permissionDecisionReason` (shown to Claude) | same |
| `PostToolUse` can return `hookSpecificOutput.updatedToolOutput` to replace a tool result | same |
| Hook `timeout` is in **seconds**; `UserPromptSubmit` default 30 s | same |
| `${CLAUDE_PLUGIN_ROOT}` (install dir), `${CLAUDE_PLUGIN_DATA}` (persistent dir) | same |
| `userConfig` in `plugin.json`; values reach hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`; `sensitive` values go to the OS secure store | plugins/manifest-reference |
| Plugin agents are namespaced `<plugin>:<name>` | plugins/components |
| `claude --plugin-dir <path>` loads a local plugin; `claude plugin validate <path>` checks it | plugins/cli-reference |
| JEV: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body `{model, state, questions}`; question types `noul`/`choice`/`score`; errors 401/422/429/529 | docs.typesafe.ai/api |

A hook **cannot switch the model**. Rejected alternative: an `ANTHROPIC_BASE_URL` proxy that
rewrites `model` per request. Switching models mid-conversation invalidates the prompt cache, and
that usually costs more than it saves.

## 3. Repository layout

```
claude-token-plugins/
├── .claude-plugin/marketplace.json      # marketplace "claude-token-plugins", lists jev-router
├── README.md  LICENSE (MIT)
└── plugins/jev-router/
    ├── .claude-plugin/plugin.json       # name, version, userConfig
    ├── hooks/hooks.json
    ├── scripts/                         # hook entrypoints (thin: parse stdin → lib → stdout)
    │   ├── route-prompt.js              # UserPromptSubmit
    │   ├── guard-tool.js                # PreToolUse  (Read|Bash|Grep)
    │   ├── trim-output.js               # PostToolUse (Bash)
    │   └── doctor.js                    # used by /jev-router:doctor
    ├── lib/
    │   ├── hookio.js      # read stdin JSON, write output, fail-open wrapper
    │   ├── config.js      # userConfig/env → typed config
    │   ├── jev.js         # JEV HTTP client
    │   ├── catalog.js     # subagent discovery + cache
    │   ├── shortlist.js   # BM25 ranking of agents vs prompt
    │   ├── heuristics.js  # local fallback decision
    │   ├── policy.js      # decision → hint text (or null)
    │   ├── guard-rules.js # tool-call rules
    │   ├── ledger.js      # per-session deny-once memory
    │   └── log.js         # capped decisions.jsonl
    ├── agents/quick.md  agents/scout.md   # model: haiku
    ├── commands/doctor.md
    └── test/ (node:test) + test/fixtures/
```

Runtime: Node ≥ 18 (global `fetch`), CommonJS, **zero dependencies**. Hook commands are
`node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.js"`, which works in bash, PowerShell and cmd.

## 4. Configuration (`userConfig`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `jev_api_key` | string, sensitive, optional | — | TypeSafe key. Also read from env `JEV_API_KEY` / `TYPESAFE_API_KEY` |
| `mode` | string: `advise` \| `guard-only` \| `off` | `advise` | `guard-only` disables prompt routing |
| `read_line_cap` | number | 800 | Read guard threshold (lines) |
| `trim_output_lines` | number | 600 | Bash output trim threshold; `0` disables trimming |

Env-only (for testing and advanced use): `JEV_BASE_URL` (default `https://api.typesafe.ai`),
`JEV_TIMEOUT_MS` (default 2500), `CLAUDE_CONFIG_DIR` (default `~/.claude`).

## 5. Component contracts

### 5.1 `catalog.js`: `loadCatalog({configDir, projectDir, dataDir}) → Agent[]`
`Agent = {name, description, model, source: "builtin"|"user"|"project"|"plugin"}`

Sources:
1. **Built-ins**: `general-purpose` (inherit), `Explore` (haiku), `Plan` (inherit), with short fixed descriptions.
2. **User**: `<configDir>/agents/**/*.md`.
3. **Project**: `<projectDir>/.claude/agents/**/*.md`.
4. **Plugins**: read `<configDir>/plugins/installed_plugins.json` (v2: `plugins[id][] = {scope, installPath, projectPath?}`).
   Keep ids enabled in `enabledPlugins` merged from `<configDir>/settings.json` →
   `<projectDir>/.claude/settings.json` → `settings.local.json` (later wins, `false` disables).
   Pick the entry whose scope applies (a `project`/`local` entry only if its `projectPath` equals `projectDir`,
   else the `user` entry). Agents directory = `plugin.json` `agents` field (string or array) if present,
   else `<installPath>/agents`. Name = `<pluginName>:<frontmatter name or file stem>`.

This scans exactly one install per plugin, so there are no stale cached versions and no `docs/*/agents`
translations. Frontmatter parser: single-line `key: value`, quoted values, and `|`/`>` block scalars.
Descriptions have `<example>` blocks and newlines stripped and are cut to 240 characters.
Unreadable or malformed files are skipped. **Cache**: `<dataDir>/catalog.json`, keyed by the mtimes of
every scanned directory plus the settings and installed-plugins files; rebuilt only when that key changes.

### 5.2 `shortlist.js`: `shortlist(agents, prompt, k=12) → Agent[]`
BM25 over `name + description`: lowercase, split on non-alphanumerics, drop stop-words, and strip light
suffixes (`s`, `es`, `ing`, `ed`). Each result carries its `score`. `Explore`, `jev-router:scout` and
`jev-router:quick` are always included. This keeps the JEV `choice` question small (limit 255 options)
and more accurate.

### 5.3 `jev.js`: `decide({apiKey, baseUrl, timeoutMs, prompt, candidates}) → Decision | null`
One request with three parallel questions:

```json
{
  "model": "jev-latest",
  "state": { "request": "<prompt, first 4000 chars>" },
  "questions": {
    "difficulty": { "type": "score",
      "instructions": "How much reasoning and work does this coding-assistant request need?",
      "criteria": [
        "Trivial: greeting, acknowledgement, or a one-fact answer",
        "Simple: a lookup, search, or small single-file edit",
        "Moderate: a multi-step change across a few files, or debugging with clear leads",
        "Hard: architecture, ambiguous debugging, or large multi-file work" ] },
    "agent": { "type": "choice",
      "instructions": "Which specialist should do the bulk of this request? Choose main if the main conversation should handle it directly.",
      "criteria": { "main": "The main assistant handles it directly", "a1": "<agent 1 description>", "...": "..." } },
    "verbose": { "type": "noul",
      "instructions": "Does the user explicitly ask for a detailed explanation, walkthrough, or teaching?" }
  }
}
```

Choice keys are opaque (`a1..aN`) and mapped back to agent names, so names containing `:` never reach JEV.
`Decision = {source: "jev", difficulty: 0..3, difficultyConf, agent: name|null, agentConf, verbose: bool, latencyMs}`.
Difficulty level = the index with the highest probability when `probabilities` is present; otherwise it is
derived from `score` (treated as already on the 0..3 index scale if > 1, else scaled by 3). The parser
tolerates both shapes and is tested against each. Requests time out through `AbortController`
(`timeoutMs`). A 429/529 gets one retry after 250 ms if time remains. Any other failure returns `null`
and records an error class (`auth`, `invalid`, `rate`, `overload`, `timeout`, `network`, `parse`).

### 5.4 `heuristics.js`: `decide({prompt, candidates}) → Decision` (`source: "heuristic"`)
- **Difficulty**: starts from prompt length; **up** for signals such as architect, design, refactor, migrate,
  why, debug, investigate, or more than 2 file paths; **down** for what is, where, find, list, rename,
  typo, thanks.
- **Agent**: the top shortlist agent if its BM25 score is at least 1.5× the runner-up's and above a
  floor; otherwise `null`.
- **Verbose**: matches explain, walk me through, teach, in detail, or step by step.
- Confidences are fixed at 0.6 so the policy can tell a heuristic decision from a JEV one.

### 5.5 `policy.js`: `toHint(decision, {agentsByName}) → string | null`
Default rules (tunable; this is where the savings strategy lives):
- Prompt is a slash command, under 4 characters, or a pure acknowledgement → `null` (checked before the JEV call).
- `agent` set and `agentConf ≥ 0.55` → `delegate: Task(subagent_type="<agent>")` plus the agent's model.
- Difficulty ≤ 1 with no agent → `delegate file search/reading to jev-router:scout (haiku)`.
- `verbose=false` and difficulty ≤ 1 → `answer tersely`.
- Difficulty 3 → nothing extra (hard work belongs to the main model).
- Nothing applies, or every confidence is < 0.5 → `null`.
- Output format is one line capped at 300 characters, e.g.
  `[jev-router] simple (0.82) · delegate: Task(subagent_type="Explore") [haiku] · answer tersely`.

### 5.6 `guard-rules.js`: `evaluate(toolName, toolInput, ctx) → {deny: reason} | null`
- **Read**: no `offset`/`limit`; the file exists and has more than `read_line_cap` lines (lines counted over
  the first 8 MB); the extension is not an image, PDF or ipynb.
  Reason: `<file> has N lines (~T tokens). Grep for the section, then Read with offset/limit.`
- **Bash** (checked per command segment split on `&&`, `;` and `|`; a later `| head`, `| tail`, `| grep`,
  `> file` or `| wc` counts as already bounded):
  - `npm|pnpm|yarn install|i|ci|add` without a quiet flag
  - `cat <file>` above the line cap
  - `git log` without `-n`, `-<num>`, `--max-count` or `--oneline`
  - `find` without `-maxdepth`
  - `ls -R`
  - `docker logs` without `--tail`
  - `journalctl` without `-n`

  Each reason names the cheaper form.
- **Grep**: `output_mode: "content"` with `head_limit: 0`.
- Every reason ends with: `Re-issue the identical call to proceed anyway.`

### 5.7 `ledger.js`: deny once, allow on repeat
Key = sha1(tool_name + canonical JSON(tool_input)), stored in
`<dataDir>/ledger/<session_id>.json`. On first match the call is denied and recorded; an identical repeat
in the same session produces no output, so the call goes through the **normal permission flow**. The
guard **never returns `allow`**, because that would bypass the user's own permission rules. Ledger files
older than 48 hours are pruned on write.

### 5.8 `trim-output.js`: PostToolUse (Bash)
If the Bash result text is longer than `trim_output_lines` lines, return `updatedToolOutput` with the first
150 lines, a marker (`… [jev-router trimmed N lines; re-run with grep/head/tail to see them] …`), and the
last 100 lines. The result's structure is kept (only text fields are rewritten). **Gate:** the exact
`tool_response` / `updatedToolOutput` shape for Bash is confirmed in the headless integration run before this
hook is enabled by default. If it can't be confirmed, the hook is shipped disabled (`trim_output_lines: 0`)
and the README says so.

### 5.9 `log.js`
Appends `{ts, session, source, difficulty, agent, conf, hintChars, latencyMs, error?}` to
`<dataDir>/decisions.jsonl` and trims it to the newest 500 lines once it passes 600.
**Prompt text is never logged**; only its length and a sha1 prefix are.

### 5.10 `hookio.js`: fail-open wrapper
Each entrypoint runs `main()` inside try/catch, with a hard timer (7 s for routing, 4 s for guard and trim)
that forces a silent `exit 0`. Errors are written to `<dataDir>/errors.log` and never to stdout. A failure
therefore means *no hint* or *no guard*, and never a blocked prompt or tool.

## 6. Hook wiring

| Event | Matcher | Script | timeout (s) |
|---|---|---|---|
| UserPromptSubmit | — | route-prompt.js | 8 |
| PreToolUse | `Read\|Bash\|Grep` | guard-tool.js | 5 |
| PostToolUse | `Bash` | trim-output.js | 5 |

`mode=off` makes every script a no-op. `mode=guard-only` makes route-prompt a no-op.

## 7. Agents and command

- `jev-router:quick` (haiku; tools Read, Edit, Write, Grep, Glob, Bash) handles small, well-specified
  edits and one-fact lookups. It returns a brief summary.
- `jev-router:scout` (haiku; tools Read, Grep, Glob) does read-only search and summaries. It returns
  paths, line numbers and a short summary, never whole files.
- `/jev-router:doctor` runs `doctor.js`, which reports:
  - Node version, mode, and key present (masked),
  - a live JEV ping (one tiny request, clearly labelled), with the error class if it fails,
  - catalog counts by source, plus any duplicate names,
  - the last 10 decisions, and the counts of guard denies and trims.

## 8. Error handling summary

| Failure | Behaviour |
|---|---|
| No key / 401 | heuristic fallback; the doctor shows why |
| 429/529 | one retry, then heuristic |
| JEV slow | abort at `JEV_TIMEOUT_MS`, then heuristic |
| Catalog error | proceed with built-ins only |
| Any exception or hook timer | silent exit 0, logged to errors.log |

## 9. Testing

- **Unit** (`node --test`):
  - catalog: fixture config dir containing enabled and disabled plugins, stale cached versions,
    translation folders, a plugin.json custom agents path, project-scope entries and malformed frontmatter,
  - shortlist ranking, heuristics, policy (table-driven),
  - guard rules (positive and negative case for every rule, including bounded pipes),
  - ledger (deny, then allow on repeat, isolated per session, pruning),
  - jev parser (both score shapes, choice-key mapping), jev client error classes (mock fetch), log capping.
- **Hook integration**: spawn each script with stdin fixtures, a temporary `CLAUDE_CONFIG_DIR` and
  `CLAUDE_PLUGIN_DATA`, and `JEV_BASE_URL` pointing at a local mock JEV server. Covers the success path,
  401, 429 then success, timeout, and malformed JSON. Asserts exit code 0 and stdout JSON shape in every case.
- **Plugin checks**: `claude plugin validate` on the plugin and the marketplace; install through
  `claude plugin marketplace add <repo path>` + `claude plugin install jev-router@claude-token-plugins`
  into a throwaway `CLAUDE_CONFIG_DIR`.
- **Headless end to end**: `claude --plugin-dir plugins/jev-router -p "<prompt>"` with the mock JEV
  server, asserting that `decisions.jsonl` gained an entry and that a >800-line Read was denied once and
  allowed on retry. The same run confirms the PostToolUse shape (§5.8 gate).
- **Live JEV**: only if a key is available. Otherwise it is reported as *not verified live*.

## 10. Non-goals

Model switching, a request proxy, an MCP "decide" tool, and savings dashboards. Cortex (persistent memory)
is a separate plugin with its own spec.
