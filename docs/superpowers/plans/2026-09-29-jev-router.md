# jev-router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `jev-router`, a Claude Code plugin that routes each prompt to the cheapest capable subagent with a fully local JEV-style engine, and guards token-heavy tool calls.

**Architecture:** Thin hook entrypoints (`scripts/`) parse stdin, call pure modules in `lib/`, and print hook JSON. A fail-open wrapper means no failure ever blocks the user. The local engine (all-MiniLM-L6-v2 on onnxruntime-node) answers JEV-style `choice`/`score`/`noul` questions by cosine similarity. It is installed on demand by `/jev-router:setup` into `${CLAUDE_PLUGIN_DATA}`, pinned and checksum-verified. Until it is installed, routing is off (hard gate) and the tool guard still works.

**Tech Stack:** Node ≥ 18 (CommonJS, zero runtime deps in plugin code), `node:test`, onnxruntime-node 1.30.0 (engine only), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-29-jev-router-design.md` (rev 2)

## Global Constraints

- Plugin code: CommonJS, **no runtime dependencies**; only `engine/package.json` may list `onnxruntime-node@1.30.0`. No `package.json` at the plugin root (marketplace installs auto-run `npm install` there).
- Hooks must **never** block: every entrypoint exits 0; errors go to `<dataDir>/errors.log`, never stdout.
- The guard **never** returns `permissionDecision: "allow"`, only `"deny"` or nothing.
- Hint ≤ 300 characters, one line; `null` when nothing useful applies.
- No prompt text is ever written to disk (only length and a sha1 prefix).
- Network: none after setup. `JEV_BASE_URL` is honoured **only** for `127.0.0.1`, `::1` or `localhost`; fetch uses `redirect: "error"`.
- Model pin: `Xenova/all-MiniLM-L6-v2` @ `751bff37182d3f1213fa05d7196b954e230abad9`; `onnx/model_quantized.onnx` sha256 `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1` (22972370 B); `tokenizer.json` sha256 `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0` (711661 B).
- Timeouts (seconds, in hooks.json): SessionStart 5, UserPromptSubmit 8, PreToolUse 5, PostToolUse 5. Internal budgets: route 7000 ms, guard/trim 4000 ms, session-start 3000 ms, engine 2500 ms.
- `trim_output_lines` defaults to **0** until Task 13 confirms the Bash `updatedToolOutput` shape.
- User-invocable entry points are **skills** (`skills/<name>/SKILL.md` → `/jev-router:<name>`); `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are substituted in skill content.
- Commit after every task, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Files use LF line endings (`.gitattributes`).

## Review Focus

1. **Agent files with CRLF line endings or a BOM** (common on Windows) must parse like LF files → catalog test in Task 5.
2. **Read / cat paths with spaces, relative paths or quotes** must resolve against the hook's `cwd` → guard test in Task 3.
3. **Binary or huge files** passed to Read or `cat` must not be misreported or slow to scan (8 MB cap, NUL sniff) → guard test in Task 3.
4. **Very long (100 KB) or non-English prompts** must still produce a decision within budget without crashing → Task 10 (long prompt through the hook) and Task 12 (Hindi/CJK through the real engine).
5. **Concurrent sessions writing shared files** (`vectors.json`) must never leave corrupt JSON → Task 7 concurrency test.

---

### Task 1: Repository scaffolding, manifests, config

**Files:**
- Create: `.gitattributes`, `.gitignore`, `LICENSE`, `package.json`, `scripts/run-tests.js`
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/jev-router/.claude-plugin/plugin.json`
- Create: `plugins/jev-router/lib/config.js`
- Test: `plugins/jev-router/test/config.test.js`, `plugins/jev-router/test/helpers.js`

**Interfaces:**
- Produces: `loadConfig(env?) → {mode, readLineCap, trimOutputLines, configDir, dataDir, jevBaseUrl, engineTimeoutMs}`; `isLoopbackUrl(url) → boolean`; test helpers `tmpDir, write, runScript, SCRIPTS, hookEnv`.

- [ ] **Step 1: Scaffolding files**

`.gitattributes`
```
* text=auto eol=lf
*.onnx binary
```

`.gitignore`
```
node_modules/
.engine-test/
*.tmp
```

`LICENSE`: standard MIT text, `Copyright (c) 2026 Aneesh-IncuBrix`.

`package.json` (repo root, the marketplace, not the plugin)
```json
{
  "name": "claude-token-plugins",
  "private": true,
  "version": "0.1.0",
  "description": "Claude Code plugins that reduce token and credit usage",
  "license": "MIT",
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node scripts/run-tests.js",
    "test:engine": "node scripts/run-tests.js engine"
  }
}
```

`scripts/run-tests.js`
```js
#!/usr/bin/env node
'use strict';
// Portable test runner: node --test glob support differs across Node versions.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'plugins', 'jev-router', 'test');
const engine = process.argv[2] === 'engine';
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js') && f.includes('.integration.') === engine)
  .map(f => path.join(dir, f));
if (!files.length) { console.log('no test files'); process.exit(0); }
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
```

`.claude-plugin/marketplace.json`
```json
{
  "name": "claude-token-plugins",
  "owner": { "name": "Aneesh-IncuBrix" },
  "plugins": [
    {
      "name": "jev-router",
      "source": "./plugins/jev-router",
      "description": "Fully local, JEV-style prompt router and token guard for Claude Code"
    }
  ]
}
```

`plugins/jev-router/.claude-plugin/plugin.json`
```json
{
  "name": "jev-router",
  "version": "0.1.0",
  "description": "Routes each prompt to the cheapest capable subagent with a fully local JEV-style engine, and blocks token-heavy tool calls. No API key; nothing leaves your machine.",
  "author": { "name": "Aneesh-IncuBrix" },
  "repository": "https://github.com/Aneesh-IncuBrix/CORTEX",
  "license": "MIT",
  "keywords": ["tokens", "cost", "routing", "subagents", "local", "jev"],
  "userConfig": {
    "mode": {
      "type": "string",
      "title": "Mode",
      "description": "advise (routing + guard), guard-only, or off",
      "default": "advise"
    },
    "read_line_cap": {
      "type": "number",
      "title": "Read guard line cap",
      "description": "Deny (once) a full Read of files longer than this many lines",
      "default": 800,
      "min": 50
    },
    "trim_output_lines": {
      "type": "number",
      "title": "Bash output trim threshold",
      "description": "Trim Bash output longer than this many lines to head+tail; 0 disables",
      "default": 0,
      "min": 0
    }
  }
}
```

- [ ] **Step 2: Test helpers**

`plugins/jev-router/test/helpers.js`
```js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function tmpDir(prefix = 'jr-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function runScript(script, input, env = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const t = setTimeout(() => { child.kill(); reject(new Error(`timeout: ${script}`)); }, timeoutMs);
    child.on('close', code => {
      clearTimeout(t);
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch { json = undefined; }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// Isolated plugin data + Claude config dirs so tests never touch the real ~/.claude.
function hookEnv(extra = {}) {
  const data = tmpDir('jr-data-');
  const config = tmpDir('jr-config-');
  return {
    data,
    config,
    env: {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_CONFIG_DIR: config,
      JEV_BASE_URL: '',
      CLAUDE_PLUGIN_OPTION_MODE: '',
      CLAUDE_PLUGIN_OPTION_READ_LINE_CAP: '',
      CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES: '',
      ...extra,
    },
  };
}

module.exports = { SCRIPTS, tmpDir, write, runScript, hookEnv };
```

- [ ] **Step 3: Write the failing config test**

`plugins/jev-router/test/config.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadConfig, isLoopbackUrl } = require('../lib/config');

test('defaults', () => {
  const c = loadConfig({ CLAUDE_CONFIG_DIR: '/cfg' });
  assert.equal(c.mode, 'advise');
  assert.equal(c.readLineCap, 800);
  assert.equal(c.trimOutputLines, 0);
  assert.equal(c.engineTimeoutMs, 2500);
  assert.equal(c.jevBaseUrl, '');
  assert.equal(c.configDir, '/cfg');
  assert.equal(c.dataDir, path.join('/cfg', 'plugins', 'data', 'jev-router-local'));
});

test('reads plugin options and data dir', () => {
  const c = loadConfig({
    CLAUDE_PLUGIN_OPTION_MODE: 'guard-only',
    CLAUDE_PLUGIN_OPTION_READ_LINE_CAP: '1200',
    CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES: '600',
    CLAUDE_PLUGIN_DATA: '/data',
    JEV_TIMEOUT_MS: '900',
  });
  assert.equal(c.mode, 'guard-only');
  assert.equal(c.readLineCap, 1200);
  assert.equal(c.trimOutputLines, 600);
  assert.equal(c.dataDir, '/data');
  assert.equal(c.engineTimeoutMs, 900);
});

test('invalid values fall back safely', () => {
  const c = loadConfig({ CLAUDE_PLUGIN_OPTION_MODE: 'bogus', CLAUDE_PLUGIN_OPTION_READ_LINE_CAP: 'abc', CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES: '-5' });
  assert.equal(c.mode, 'advise');
  assert.equal(c.readLineCap, 800);
  assert.equal(c.trimOutputLines, 0);
  assert.equal(loadConfig({ CLAUDE_PLUGIN_OPTION_READ_LINE_CAP: '10' }).readLineCap, 50);
});

test('isLoopbackUrl accepts only loopback http(s)', () => {
  for (const u of ['http://127.0.0.1:8000', 'http://localhost:1', 'http://[::1]:9', 'https://localhost/x']) assert.equal(isLoopbackUrl(u), true, u);
  for (const u of ['https://api.typesafe.ai', 'http://127.0.0.1.evil.com', 'http://10.0.0.5:80', 'ftp://localhost', 'garbage', '', 'http://localhost.attacker.io']) assert.equal(isLoopbackUrl(u), false, u);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../lib/config'`

- [ ] **Step 5: Implement config**

`plugins/jev-router/lib/config.js`
```js
'use strict';
const os = require('os');
const path = require('path');

const MODES = ['advise', 'guard-only', 'off'];

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    mode: MODES.includes(env.CLAUDE_PLUGIN_OPTION_MODE) ? env.CLAUDE_PLUGIN_OPTION_MODE : 'advise',
    readLineCap: Math.max(50, num(env.CLAUDE_PLUGIN_OPTION_READ_LINE_CAP, 800)),
    trimOutputLines: Math.max(0, num(env.CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES, 0)),
    configDir,
    dataDir: env.CLAUDE_PLUGIN_DATA || path.join(configDir, 'plugins', 'data', 'jev-router-local'),
    jevBaseUrl: env.JEV_BASE_URL || '',
    engineTimeoutMs: num(env.JEV_TIMEOUT_MS, 2500),
  };
}

function isLoopbackUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  } catch {
    return false;
  }
}

module.exports = { loadConfig, isLoopbackUrl, MODES };
```

- [ ] **Step 6: Run tests and validate manifests**

Run: `npm test` → Expected: 4 passing.
Run: `claude plugin validate plugins/jev-router` and `claude plugin validate .` → Expected: no errors. If the validator rejects `min` on number options, remove `min` (loadConfig clamps anyway) and re-run.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(jev-router): scaffold marketplace, plugin manifest and config" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Hook I/O, capped logs, deny-once ledger

**Files:**
- Create: `plugins/jev-router/lib/hookio.js`, `lib/log.js`, `lib/ledger.js`
- Test: `plugins/jev-router/test/hookio.test.js`, `test/log-ledger.test.js`

**Interfaces:**
- Produces: `runHook(name, budgetMs, main(input) → out|null, dataDir)`; `logError(dataDir, name, err)`; `parseInput(raw) → object`; `appendCapped(file, record, max=500, trimAt=600)`; `readTail(file, n) → object[]`; `fingerprint(text) → {len, sha}`; `keyFor(toolName, toolInput) → hex`; `canonical(value) → string`; `seenBefore(dataDir, sessionId, key, now?) → boolean`.

- [ ] **Step 1: Write the failing tests**

`plugins/jev-router/test/log-ledger.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { appendCapped, readTail, fingerprint } = require('../lib/log');
const { keyFor, seenBefore, canonical } = require('../lib/ledger');

test('appendCapped trims to newest 500 once over 600', () => {
  const f = path.join(tmpDir(), 'd.jsonl');
  for (let i = 0; i < 601; i++) appendCapped(f, { i });
  const rows = readTail(f, 1000);
  assert.equal(rows.length, 500);
  assert.equal(rows[0].i, 101);
  assert.equal(rows[rows.length - 1].i, 600);
});

test('readTail tolerates missing files and bad lines', () => {
  const dir = tmpDir();
  assert.deepEqual(readTail(path.join(dir, 'nope.jsonl'), 5), []);
  const f = path.join(dir, 'x.jsonl');
  fs.writeFileSync(f, '{"a":1}\nnot json\n{"a":2}\n');
  assert.deepEqual(readTail(f, 5), [{ a: 1 }, { a: 2 }]);
});

test('fingerprint never contains the text', () => {
  const fp = fingerprint('my secret prompt');
  assert.equal(fp.len, 16);
  assert.match(fp.sha, /^[0-9a-f]{10}$/);
  assert.ok(!JSON.stringify(fp).includes('secret'));
});

test('keyFor is order-insensitive for object keys', () => {
  assert.equal(keyFor('Read', { a: 1, b: 2 }), keyFor('Read', { b: 2, a: 1 }));
  assert.notEqual(keyFor('Read', { a: 1 }), keyFor('Bash', { a: 1 }));
  assert.equal(canonical({ b: [1, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[1,{"c":2,"d":1}]}');
});

test('seenBefore: first call records, repeat returns true, sessions isolated', () => {
  const dir = tmpDir();
  const k = keyFor('Read', { file_path: 'x' });
  assert.equal(seenBefore(dir, 's1', k), false);
  assert.equal(seenBefore(dir, 's1', k), true);
  assert.equal(seenBefore(dir, 's2', k), false);
  assert.equal(seenBefore(dir, '../evil/..', k), false);
  assert.ok(fs.readdirSync(path.join(dir, 'ledger')).every(f => /^[\w-]+\.json$/.test(f)));
});

test('seenBefore prunes ledger files older than 48h', () => {
  const dir = tmpDir();
  seenBefore(dir, 'old', 'k1');
  const old = path.join(dir, 'ledger', 'old.json');
  const past = (Date.now() - 49 * 3600 * 1000) / 1000;
  fs.utimesSync(old, past, past);
  seenBefore(dir, 'new', 'k2');
  assert.equal(fs.existsSync(old), false);
});
```

`plugins/jev-router/test/hookio.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, write, runScript } = require('./helpers');
const { parseInput } = require('../lib/hookio');

const HOOKIO = JSON.stringify(path.join(__dirname, '..', 'lib', 'hookio.js'));

function fixture(body) {
  const dir = tmpDir();
  const script = write(path.join(dir, 'hook.js'), `const { runHook } = require(${HOOKIO});\nrunHook('t', 1500, ${body}, ${JSON.stringify(dir)});\n`);
  return { dir, script };
}

test('parseInput handles empty, invalid and valid JSON', () => {
  assert.deepEqual(parseInput(''), {});
  assert.deepEqual(parseInput('nope'), {});
  assert.deepEqual(parseInput('"str"'), {});
  assert.deepEqual(parseInput('{"a":1}'), { a: 1 });
});

test('returned object is printed as JSON, exit 0', async () => {
  const { script } = fixture('async (i) => ({ echo: i.x })');
  const r = await runScript(script, { x: 7 });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { echo: 7 });
});

test('null result prints nothing', async () => {
  const { script } = fixture('async () => null');
  const r = await runScript(script, {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('exceptions are logged, never printed, exit 0', async () => {
  const { dir, script } = fixture("async () => { throw new Error('boom'); }");
  const r = await runScript(script, {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(fs.readFileSync(path.join(dir, 'errors.log'), 'utf8'), /boom/);
});

test('hanging main is cut off by the budget, exit 0', async () => {
  const { script } = fixture('() => new Promise(() => {})');
  const t0 = Date.now();
  const r = await runScript(script, {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(Date.now() - t0 < 5000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test` → Expected: FAIL, modules `../lib/log`, `../lib/ledger` and `../lib/hookio` not found.

- [ ] **Step 3: Implement**

`plugins/jev-router/lib/hookio.js`
```js
'use strict';
const fs = require('fs');
const path = require('path');

function readStdin(stream = process.stdin) {
  return new Promise(resolve => {
    let s = '';
    stream.setEncoding('utf8');
    stream.on('data', d => { s += d; });
    stream.on('end', () => resolve(s));
    stream.on('error', () => resolve(s));
  });
}

function logError(dataDir, name, err) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'errors.log'), `${new Date().toISOString()} [${name}] ${(err && err.stack) || err}\n`);
  } catch {
    // The logger must never throw.
  }
}

function parseInput(raw) {
  try {
    const v = raw && raw.trim() ? JSON.parse(raw) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function finish(out) {
  if (out) process.stdout.write(JSON.stringify(out), () => process.exit(0));
  else process.exit(0);
}

// Fail-open hook runner: whatever happens, exit 0 within budgetMs.
function runHook(name, budgetMs, main, dataDir) {
  const timer = setTimeout(() => process.exit(0), budgetMs);
  readStdin().then(async raw => {
    let out = null;
    try {
      out = await main(parseInput(raw));
    } catch (e) {
      logError(dataDir, name, e);
    }
    clearTimeout(timer);
    finish(out);
  });
}

module.exports = { runHook, logError, parseInput, readStdin };
```

`plugins/jev-router/lib/log.js`
```js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function appendCapped(file, record, max = 500, trimAt = 600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length > trimAt) fs.writeFileSync(file, lines.slice(-max).join('\n') + '\n');
}

function readTail(file, n) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).slice(-n).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function fingerprint(text) {
  const s = String(text || '');
  return { len: s.length, sha: crypto.createHash('sha1').update(s).digest('hex').slice(0, 10) };
}

module.exports = { appendCapped, readTail, fingerprint };
```

`plugins/jev-router/lib/ledger.js`
```js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_AGE_MS = 48 * 3600 * 1000;

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

function keyFor(toolName, toolInput) {
  return crypto.createHash('sha1').update(`${toolName}\n${canonical(toolInput || {})}`).digest('hex');
}

function safeSession(id) {
  return String(id || 'nosession').replace(/[^\w-]/g, '_').slice(0, 80) || 'nosession';
}

function prune(dir, now) {
  for (const f of fs.readdirSync(dir)) {
    try {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS) fs.unlinkSync(p);
    } catch {
      // Another session may have removed it.
    }
  }
}

// Deny-once memory: returns true when this exact call was already seen this session.
function seenBefore(dataDir, sessionId, key, now = Date.now()) {
  const dir = path.join(dataDir, 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  prune(dir, now);
  const file = path.join(dir, `${safeSession(sessionId)}.json`);
  let keys = [];
  try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { keys = []; }
  if (!Array.isArray(keys)) keys = [];
  if (keys.includes(key)) return true;
  keys.push(key);
  fs.writeFileSync(file, JSON.stringify(keys.slice(-500)));
  return false;
}

module.exports = { keyFor, canonical, seenBefore, safeSession };
```

- [ ] **Step 4: Run tests** → `npm test` → Expected: all passing.
- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(jev-router): fail-open hook runner, capped logs, deny-once ledger" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: Tool guard (PreToolUse)

**Files:**
- Create: `plugins/jev-router/lib/guard-rules.js`, `scripts/guard-tool.js`, `hooks/hooks.json`
- Test: `plugins/jev-router/test/guard-rules.test.js`, `test/guard-hook.test.js`

**Interfaces:**
- Consumes: `loadConfig`, `runHook`, `keyFor`, `seenBefore`, `appendCapped`.
- Produces: `evaluate(toolName, toolInput, ctx?) → {deny: string} | null` where `ctx = {readLineCap, cwd, countLines}`; `countLines(file) → {lines, bytes, truncated, binary} | null`.

- [ ] **Step 1: Write the failing rule tests**

`plugins/jev-router/test/guard-rules.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir, write } = require('./helpers');
const { evaluate, countLines } = require('../lib/guard-rules');

const dir = tmpDir('jr guard ');            // space in path on purpose (Review Focus 2)
const big = write(path.join(dir, 'sub dir', 'big.log'), 'line\n'.repeat(1000));
const small = write(path.join(dir, 'small.txt'), 'a\nb\n');
const bin = write(path.join(dir, 'blob.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(5000, 10)]));
const ctx = { readLineCap: 800, cwd: dir };

test('Read: denies full read of a big file, with size and token estimate', () => {
  const r = evaluate('Read', { file_path: big }, ctx);
  assert.match(r.deny, /big\.log has 1001 lines \(~1,250 tokens\)/);
  assert.match(r.deny, /Re-issue the identical call to proceed anyway\.$/);
});

test('Read: relative path resolves against cwd', () => {
  assert.ok(evaluate('Read', { file_path: path.join('sub dir', 'big.log') }, ctx));
});

test('Read: allowed with offset/limit, small files, images, binaries, missing files', () => {
  assert.equal(evaluate('Read', { file_path: big, limit: 100 }, ctx), null);
  assert.equal(evaluate('Read', { file_path: big, offset: 1 }, ctx), null);
  assert.equal(evaluate('Read', { file_path: small }, ctx), null);
  assert.equal(evaluate('Read', { file_path: path.join(dir, 'x.png') }, ctx), null);
  assert.equal(evaluate('Read', { file_path: bin }, ctx), null);
  assert.equal(evaluate('Read', { file_path: path.join(dir, 'missing.txt') }, ctx), null);
  assert.equal(evaluate('Read', {}, ctx), null);
});

test('countLines detects binary and reports bytes', () => {
  assert.equal(countLines(bin).binary, true);
  assert.equal(countLines(big).bytes, 5000);
  assert.equal(countLines(path.join(dir, 'nope')), null);
});

test('Grep: head_limit 0 with content mode is denied; others allowed', () => {
  assert.ok(evaluate('Grep', { pattern: 'x', output_mode: 'content', head_limit: 0 }, ctx));
  assert.equal(evaluate('Grep', { pattern: 'x', output_mode: 'content', head_limit: 50 }, ctx), null);
  assert.equal(evaluate('Grep', { pattern: 'x' }, ctx), null);
});

const denied = [
  'npm install',
  'npm i -D typescript',
  'pnpm add lodash',
  'yarn',
  'cd app && npm ci',
  `cat "${big}"`,
  'git log',
  'git -C repo log --stat',
  'find . -name "*.js"',
  'ls -lR src',
  'docker logs api',
  'journalctl -u nginx',
  'FOO=1 sudo npm install',
];
const allowed = [
  'npm install --silent',
  'npm ci --loglevel=error',
  'npm run build',
  'yarn add x --silent',
  `cat "${small}"`,
  `cat "${big}" | head -50`,
  'git log -n 20',
  'git log --oneline',
  'git log -5',
  'git status',
  'find . -maxdepth 2 -name "*.js"',
  'find . -name "*.js" | head',
  'ls -la',
  'docker logs --tail 200 api',
  'journalctl -n 100',
  'npm install > install.log 2>&1',
  'echo hi',
];
for (const c of denied) test(`Bash denied: ${c}`, () => assert.ok(evaluate('Bash', { command: c }, ctx), c));
for (const c of allowed) test(`Bash allowed: ${c}`, () => assert.equal(evaluate('Bash', { command: c }, ctx), null, c));

test('Bash: background commands and unknown tools are ignored', () => {
  assert.equal(evaluate('Bash', { command: 'npm install', run_in_background: true }, ctx), null);
  assert.equal(evaluate('Edit', { file_path: big }, ctx), null);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test` → FAIL: `Cannot find module '../lib/guard-rules'`.

- [ ] **Step 3: Implement the rules**

`plugins/jev-router/lib/guard-rules.js`
```js
'use strict';
const fs = require('fs');
const path = require('path');

const SUFFIX = ' Re-issue the identical call to proceed anyway.';
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.ipynb']);
const SCAN_LIMIT = 8 * 1024 * 1024;
const BOUNDING = /^(head|tail|grep|egrep|fgrep|rg|wc|less|more|sort|uniq|awk|sed|jq|cut|tee|xargs)$/;
const QUIET = /(^|\s)(--silent|-s|--quiet|-q|--loglevel(=|\s+)(silent|error|warn)|--reporter(=|\s+)silent)(\s|$)/;

function countLines(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(64 * 1024);
    let lines = 0;
    let read = 0;
    let n;
    while (read < SCAN_LIMIT && (n = fs.readSync(fd, buf, 0, buf.length, read)) > 0) {
      if (read === 0 && buf.subarray(0, Math.min(n, 8192)).includes(0)) {
        return { lines: 0, bytes: fs.fstatSync(fd).size, truncated: false, binary: true };
      }
      for (let i = 0; i < n; i++) if (buf[i] === 10) lines++;
      read += n;
    }
    const bytes = fs.fstatSync(fd).size;
    return { lines: lines + 1, bytes, truncated: bytes > SCAN_LIMIT, binary: false };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function resolvePath(p, cwd) {
  const clean = String(p).replace(/^["']|["']$/g, '');
  return path.isAbsolute(clean) ? clean : path.resolve(cwd || process.cwd(), clean);
}

function checkRead(input, ctx) {
  if (!input || typeof input.file_path !== 'string') return null;
  if (input.offset != null || input.limit != null) return null;
  if (SKIP_EXT.has(path.extname(input.file_path).toLowerCase())) return null;
  const info = ctx.countLines(resolvePath(input.file_path, ctx.cwd));
  if (!info || info.binary || info.lines <= ctx.readLineCap) return null;
  const tokens = Math.round(info.bytes / 4).toLocaleString('en-US');
  return { deny: `${path.basename(input.file_path)} has ${info.lines}${info.truncated ? '+' : ''} lines (~${tokens} tokens). Grep for the section you need, then Read with offset/limit.${SUFFIX}` };
}

function checkGrep(input) {
  if (input && input.output_mode === 'content' && input.head_limit === 0) {
    return { deny: `Grep with output_mode "content" and head_limit 0 returns every matching line. Set head_limit (e.g. 100) or narrow the pattern/glob.${SUFFIX}` };
  }
  return null;
}

// Quote-unaware splitting: good enough for spotting noisy producers.
function splitPipelines(command) {
  return command.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean);
}

function splitStages(pipeline) {
  return pipeline.split('|').map(s => s.trim()).filter(Boolean);
}

// Quote-aware word split so `cat "C:\dir with spaces\f.log"` stays one argument.
function words(stage) {
  const w = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(stage))) w.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  while (w.length && (/^\w+=/.test(w[0]) || ['sudo', 'command', 'time', 'exec'].includes(w[0]))) w.shift();
  return w;
}

function redirectsStdout(pipeline) {
  return /(^|[^0-9&>])>{1,2}\s*[^&\s]/.test(pipeline);
}

function gitSubcommand(args) {
  let j = 0;
  while (j < args.length && args[j].startsWith('-')) j += (args[j] === '-C' || args[j] === '-c') ? 2 : 1;
  return { sub: args[j], rest: args.slice(j + 1) };
}

function checkStage(w, stageText, ctx) {
  const cmd = path.basename(w[0] || '').replace(/\.(exe|cmd|bat)$/i, '');
  const args = w.slice(1);

  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') {
    const sub = args.find(a => !a.startsWith('-'));
    const installs = cmd === 'yarn' ? (sub === undefined || sub === 'install' || sub === 'add') : ['install', 'i', 'ci', 'add'].includes(sub);
    if (installs && !QUIET.test(stageText)) return `${cmd} ${sub || 'install'} prints long progress output. Add --silent (or --loglevel=error).`;
  }
  if (cmd === 'cat') {
    for (const a of args.filter(x => !x.startsWith('-'))) {
      const info = ctx.countLines(resolvePath(a, ctx.cwd));
      if (info && !info.binary && info.lines > ctx.readLineCap) return `cat ${path.basename(a.replace(/["']/g, ''))} dumps ${info.lines}${info.truncated ? '+' : ''} lines. Use Read with offset/limit, or grep/head.`;
    }
  }
  if (cmd === 'git') {
    const { sub, rest } = gitSubcommand(args);
    if (sub === 'log' && !/(^|\s)(-n\s*\d+|-\d+|--max-count(=|\s+)\d+|--oneline)(\s|$)/.test(rest.join(' '))) {
      return 'git log without a limit can print thousands of lines. Add -n 20 (or --oneline -n 50).';
    }
  }
  if (cmd === 'find' && !args.includes('-maxdepth') && !args.includes('-quit')) return 'find without -maxdepth can walk huge trees. Add -maxdepth N, or pipe to head.';
  if (cmd === 'ls' && args.some(a => a === '--recursive' || /^-[a-zA-Z]*R/.test(a))) return 'ls -R lists every nested file. Use Glob or find -maxdepth instead.';
  if (cmd === 'docker' && args[0] === 'logs' && !args.some(a => /^(--tail|-n)(=|$)/.test(a))) return 'docker logs without --tail prints the whole log. Add --tail 200.';
  if (cmd === 'journalctl' && !args.some(a => /^(-n|--lines)(=|$)|^-n\d+$/.test(a))) return 'journalctl without -n prints the whole journal. Add -n 200.';
  return null;
}

function checkBash(input, ctx) {
  const command = input && typeof input.command === 'string' ? input.command : '';
  if (!command || input.run_in_background) return null;
  for (const pipeline of splitPipelines(command)) {
    const stages = splitStages(pipeline);
    const bounded = stages.slice(1).some(s => BOUNDING.test(path.basename(words(s)[0] || ''))) || redirectsStdout(pipeline);
    if (bounded) continue;
    const reason = checkStage(words(stages[0]), stages[0], ctx);
    if (reason) return { deny: reason + SUFFIX };
  }
  return null;
}

function evaluate(toolName, input, ctx = {}) {
  const c = { readLineCap: 800, cwd: process.cwd(), countLines, ...ctx };
  if (toolName === 'Read') return checkRead(input, c);
  if (toolName === 'Grep') return checkGrep(input);
  if (toolName === 'Bash') return checkBash(input, c);
  return null;
}

module.exports = { evaluate, countLines, splitPipelines, splitStages };
```

- [ ] **Step 4: Run rule tests** → `npm test` → all rule tests pass.

- [ ] **Step 5: Write the failing hook test**

`plugins/jev-router/test/guard-hook.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SCRIPTS, runScript, hookEnv, write } = require('./helpers');

const script = path.join(SCRIPTS, 'guard-tool.js');

test('denies once, then lets the identical call through', async () => {
  const h = hookEnv();
  const big = write(path.join(h.data, 'big.txt'), 'x\n'.repeat(2000));
  const input = { session_id: 's1', tool_name: 'Read', tool_input: { file_path: big }, cwd: h.data };
  const first = await runScript(script, input, h.env);
  assert.equal(first.code, 0);
  assert.equal(first.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(first.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /^\[jev-router\] big\.txt has 2001 lines/);
  const second = await runScript(script, input, h.env);
  assert.equal(second.code, 0);
  assert.equal(second.stdout, '');
  const log = fs.readFileSync(path.join(h.data, 'guard.jsonl'), 'utf8');
  assert.match(log, /"action":"deny"/);
  assert.match(log, /"action":"allowed-repeat"/);
});

test('never emits allow, and mode=off disables the guard', async () => {
  const h = hookEnv({ CLAUDE_PLUGIN_OPTION_MODE: 'off' });
  const r = await runScript(script, { session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm install' } }, h.env);
  assert.equal(r.stdout, '');
  const h2 = hookEnv();
  const ok = await runScript(script, { session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo hi' } }, h2.env);
  assert.equal(ok.stdout, '');
});

test('garbage stdin exits 0 silently', async () => {
  const h = hookEnv();
  const r = await runScript(script, 'not json', h.env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});
```

- [ ] **Step 6: Implement the hook and wiring**

`plugins/jev-router/scripts/guard-tool.js`
```js
#!/usr/bin/env node
'use strict';
const path = require('path');
const { loadConfig } = require('../lib/config');
const { runHook } = require('../lib/hookio');
const { evaluate } = require('../lib/guard-rules');
const { keyFor, seenBefore } = require('../lib/ledger');
const { appendCapped } = require('../lib/log');

const cfg = loadConfig();

runHook('guard-tool', 4000, async (input) => {
  if (cfg.mode === 'off') return null;
  const rule = evaluate(input.tool_name, input.tool_input || {}, { readLineCap: cfg.readLineCap, cwd: input.cwd });
  if (!rule) return null;
  const repeat = seenBefore(cfg.dataDir, input.session_id, keyFor(input.tool_name, input.tool_input));
  appendCapped(path.join(cfg.dataDir, 'guard.jsonl'), { ts: new Date().toISOString(), tool: input.tool_name, action: repeat ? 'allowed-repeat' : 'deny' });
  if (repeat) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[jev-router] ${rule.deny}`,
    },
  };
}, cfg.dataDir);
```

`plugins/jev-router/hooks/hooks.json` (the other events are added in Tasks 4 and 10)
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Bash|Grep",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/guard-tool.js\"", "timeout": 5 }
        ]
      }
    ]
  }
}
```

- [ ] **Step 7: Run tests** → `npm test` → all passing. Then run `claude plugin validate plugins/jev-router` → no errors.
- [ ] **Step 8: Commit** → `git add -A && git commit -m "feat(jev-router): deny-once tool guard for Read, Bash and Grep" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 4: Bash output trimming (PostToolUse)

**Files:**
- Create: `plugins/jev-router/lib/trim.js`, `scripts/trim-output.js`
- Modify: `plugins/jev-router/hooks/hooks.json` (add PostToolUse)
- Test: `plugins/jev-router/test/trim.test.js`

**Interfaces:**
- Produces: `trimText(text, limit) → string`; `trimResponse(resp, limit) → string | object | null` (`null` = unchanged).

- [ ] **Step 1: Write the failing test**

`plugins/jev-router/test/trim.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { trimText, trimResponse } = require('../lib/trim');
const { SCRIPTS, runScript, hookEnv } = require('./helpers');

const lines = n => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');

test('trimText keeps head 150 + marker + tail 100', () => {
  const out = trimText(lines(1000), 600).split('\n');
  assert.equal(out.length, 251);
  assert.equal(out[0], 'l0');
  assert.equal(out[149], 'l149');
  assert.match(out[150], /trimmed 750 lines/);
  assert.equal(out[out.length - 1], 'l999');
});

test('trimText leaves short or limit=0 output alone, and never expands', () => {
  assert.equal(trimText(lines(500), 600), lines(500));
  assert.equal(trimText(lines(5000), 0), lines(5000));
  assert.equal(trimText(lines(240), 100), lines(240));
});

test('trimResponse handles strings and stdout/stderr objects', () => {
  assert.equal(trimResponse('short', 600), null);
  const obj = trimResponse({ stdout: lines(1000), stderr: 'err', interrupted: false }, 600);
  assert.match(obj.stdout, /trimmed 750 lines/);
  assert.equal(obj.stderr, 'err');
  assert.equal(obj.interrupted, false);
  assert.equal(trimResponse({ stdout: 'x' }, 600), null);
  assert.equal(trimResponse(42, 600), null);
});

test('hook: disabled by default (0), trims when configured', async () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: lines(1000), stderr: '' } };
  const off = await runScript(path.join(SCRIPTS, 'trim-output.js'), input, hookEnv().env);
  assert.equal(off.stdout, '');
  const on = await runScript(path.join(SCRIPTS, 'trim-output.js'), input, hookEnv({ CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES: '600' }).env);
  assert.equal(on.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(on.json.hookSpecificOutput.updatedToolOutput.stdout, /trimmed 750 lines/);
});

test('hook: debug dump records only keys, never content', async () => {
  const h = hookEnv({ JEV_ROUTER_DUMP_POSTTOOL: '1' });
  await runScript(path.join(SCRIPTS, 'trim-output.js'), { tool_name: 'Bash', tool_response: { stdout: 'SECRET' } }, h.env);
  const dump = fs.readFileSync(path.join(h.data, 'posttool-sample.json'), 'utf8');
  assert.match(dump, /"stdout"/);
  assert.ok(!dump.includes('SECRET'));
});
```

- [ ] **Step 2: Run to verify failure** → `npm test` → FAIL: `Cannot find module '../lib/trim'`.

- [ ] **Step 3: Implement**

`plugins/jev-router/lib/trim.js`
```js
'use strict';
const HEAD = 150;
const TAIL = 100;

function trimText(text, limit) {
  if (typeof text !== 'string' || !limit) return text;
  const lines = text.split('\n');
  if (lines.length <= Math.max(limit, HEAD + TAIL + 1)) return text;
  const cut = lines.length - HEAD - TAIL;
  return [...lines.slice(0, HEAD), `… [jev-router trimmed ${cut} lines; re-run with grep/head/tail to see them] …`, ...lines.slice(-TAIL)].join('\n');
}

function trimResponse(resp, limit) {
  if (!limit) return null;
  if (typeof resp === 'string') {
    const t = trimText(resp, limit);
    return t === resp ? null : t;
  }
  if (resp && typeof resp === 'object' && !Array.isArray(resp)) {
    const out = { ...resp };
    let changed = false;
    for (const k of ['stdout', 'stderr', 'output']) {
      if (typeof out[k] !== 'string') continue;
      const t = trimText(out[k], limit);
      if (t !== out[k]) { out[k] = t; changed = true; }
    }
    return changed ? out : null;
  }
  return null;
}

module.exports = { trimText, trimResponse, HEAD, TAIL };
```

`plugins/jev-router/scripts/trim-output.js`
```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { runHook } = require('../lib/hookio');
const { trimResponse } = require('../lib/trim');
const { appendCapped } = require('../lib/log');

const cfg = loadConfig();

function dumpShape(input) {
  const resp = input.tool_response;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.dataDir, 'posttool-sample.json'), JSON.stringify({
    inputKeys: Object.keys(input),
    toolName: input.tool_name,
    responseType: Array.isArray(resp) ? 'array' : typeof resp,
    responseKeys: resp && typeof resp === 'object' ? Object.keys(resp) : null,
  }, null, 2));
}

runHook('trim-output', 4000, async (input) => {
  if (process.env.JEV_ROUTER_DUMP_POSTTOOL === '1') dumpShape(input);
  if (cfg.mode === 'off' || !cfg.trimOutputLines || input.tool_name !== 'Bash') return null;
  const updated = trimResponse(input.tool_response, cfg.trimOutputLines);
  if (!updated) return null;
  appendCapped(path.join(cfg.dataDir, 'guard.jsonl'), { ts: new Date().toISOString(), tool: 'Bash', action: 'trim' });
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } };
}, cfg.dataDir);
```

Add to `hooks/hooks.json` under `"hooks"`:
```json
"PostToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/trim-output.js\"", "timeout": 5 }
    ]
  }
]
```

- [ ] **Step 4: Run tests** → `npm test` → all passing.
- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(jev-router): opt-in Bash output trimming (PostToolUse)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 5: Agent catalog

**Files:**
- Create: `plugins/jev-router/lib/catalog.js`
- Test: `plugins/jev-router/test/catalog.test.js`

**Interfaces:**
- Produces: `loadCatalog({configDir, projectDir, dataDir?, pluginRoot?}) → {signature, agents: Agent[], counts: {builtin, user, project, plugin}, duplicates: string[]}` with `Agent = {name, description, model, source}`; `parseFrontmatter(text) → {data, body}`; `cleanDescription(s, max=240) → string`; `BUILTINS`.

- [ ] **Step 1: Write the failing test**

`plugins/jev-router/test/catalog.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, write } = require('./helpers');
const { loadCatalog, parseFrontmatter, cleanDescription } = require('../lib/catalog');

const agent = (name, desc, extra = '') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\nBody\n`;

function fixture() {
  const config = tmpDir('jr-cfg-');
  const project = tmpDir('jr-proj-');
  const other = tmpDir('jr-other-');
  const cache = path.join(config, 'plugins', 'cache');
  const A1 = path.join(cache, 'mk', 'alpha', '1.0.0');
  const A2 = path.join(cache, 'mk', 'alpha', '2.0.0');
  write(path.join(A1, 'agents', 'stale.md'), agent('stale', 'Old version agent'));
  write(path.join(A2, 'agents', 'reviewer.md'), agent('reviewer', 'Reviews code for bugs'));
  write(path.join(A2, 'agents', 'sub', 'deep.md'), agent('deep', 'Nested agent'));
  write(path.join(A2, 'docs', 'ja', 'agents', 'reviewer.md'), agent('reviewer-ja', 'Translated copy'));
  const B = path.join(cache, 'mk', 'beta', '1.0.0');
  write(path.join(B, 'agents', 'x.md'), agent('x', 'Disabled plugin agent'));
  const G = path.join(cache, 'mk', 'gamma', '1.0.0');
  write(path.join(G, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'gamma-renamed', agents: './custom' }));
  write(path.join(G, 'custom', 'c.md'), agent('c', 'Custom path agent', 'model: haiku\n'));
  const P1 = path.join(cache, 'mk', 'proj', 'p1');
  const P2 = path.join(cache, 'mk', 'proj', 'p2');
  write(path.join(P1, 'agents', 'scoped.md'), agent('scoped', 'Other project install'));
  write(path.join(P2, 'agents', 'global.md'), agent('global', 'User scope install'));
  write(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'alpha@mk': [{ scope: 'user', installPath: A2 }],
      'beta@mk': [{ scope: 'user', installPath: B }],
      'gamma@mk': [{ scope: 'user', installPath: G }],
      'proj@mk': [{ scope: 'project', projectPath: other, installPath: P1 }, { scope: 'user', installPath: P2 }],
    },
  }));
  write(path.join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'alpha@mk': true, 'beta@mk': true, 'gamma@mk': true, 'proj@mk': true } }));
  write(path.join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'beta@mk': false } }));
  // CRLF + BOM + block scalar + <example> (Review Focus 1)
  write(path.join(config, 'agents', 'mine.md'), '﻿---\r\nname: mine\r\ndescription: |\r\n  User agent that plans work.\r\n  <example>user: hi</example>\r\nmodel: sonnet\r\n---\r\nBody\r\n');
  write(path.join(config, 'agents', 'broken.md'), 'no frontmatter here');
  write(path.join(project, '.claude', 'agents', 'mine.md'), agent('mine', 'Project override of mine'));
  return { config, project, other };
}

test('collects built-in, user, project and enabled plugin agents only', () => {
  const { config, project } = fixture();
  const cat = loadCatalog({ configDir: config, projectDir: project });
  const names = cat.agents.map(a => a.name);
  for (const n of ['Explore', 'general-purpose', 'Plan', 'mine', 'alpha:reviewer', 'alpha:sub:deep', 'gamma-renamed:c', 'proj:global']) assert.ok(names.includes(n), `missing ${n}`);
  for (const n of ['alpha:stale', 'alpha:reviewer-ja', 'beta:x', 'proj:scoped', 'broken']) assert.ok(!names.includes(n), `unexpected ${n}`);
  const mine = cat.agents.find(a => a.name === 'mine');
  assert.equal(mine.source, 'project');
  assert.equal(mine.description, 'Project override of mine');
  assert.deepEqual(cat.duplicates, ['mine']);
  assert.equal(cat.agents.find(a => a.name === 'gamma-renamed:c').model, 'haiku');
  assert.equal(cat.counts.plugin, 4);
});

test('project-scoped install is used when projectDir matches', () => {
  const { config, other } = fixture();
  const cat = loadCatalog({ configDir: config, projectDir: other });
  assert.ok(cat.agents.some(a => a.name === 'proj:scoped'));
});

test('CRLF/BOM block scalar parses and <example> is stripped', () => {
  const { data } = parseFrontmatter('﻿---\r\nname: mine\r\ndescription: |\r\n  Line one.\r\n  <example>x</example>\r\n---\r\n');
  assert.equal(data.name, 'mine');
  assert.equal(cleanDescription(data.description), 'Line one.');
});

test('frontmatter: quoted escapes, colons in values, folded scalars, continuation', () => {
  const { data } = parseFrontmatter('---\na: "x\\ny: z"\nb: plain: with colon\nc: >\n  folded\n  text\nd: first\n  second\n---\n');
  assert.equal(data.a, 'x\ny: z');
  assert.equal(data.b, 'plain: with colon');
  assert.equal(data.c, 'folded text');
  assert.equal(data.d, 'first second');
  assert.equal(cleanDescription('x'.repeat(300)).length, 240);
});

test('cache: second call returns cached result; adding an agent invalidates it', () => {
  const { config, project } = fixture();
  const data = tmpDir('jr-data-');
  const first = loadCatalog({ configDir: config, projectDir: project, dataDir: data });
  assert.ok(fs.existsSync(path.join(data, 'catalog.json')));
  const second = loadCatalog({ configDir: config, projectDir: project, dataDir: data });
  assert.equal(second.signature, first.signature);
  write(path.join(config, 'agents', 'extra.md'), agent('extra', 'Added later'));
  const third = loadCatalog({ configDir: config, projectDir: project, dataDir: data });
  assert.notEqual(third.signature, first.signature);
  assert.ok(third.agents.some(a => a.name === 'extra'));
});

test('pluginRoot agents are added for --plugin-dir sessions', () => {
  const { config, project } = fixture();
  const root = tmpDir('jr-root-');
  write(path.join(root, 'agents', 'quick.md'), agent('quick', 'Small edits', 'model: haiku\n'));
  const cat = loadCatalog({ configDir: config, projectDir: project, pluginRoot: root });
  assert.ok(cat.agents.some(a => a.name === 'jev-router:quick'));
});

test('missing config dir still returns built-ins', () => {
  const cat = loadCatalog({ configDir: path.join(tmpDir(), 'none'), projectDir: tmpDir() });
  assert.deepEqual(cat.agents.map(a => a.name).sort(), ['Explore', 'Plan', 'general-purpose']);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test` → FAIL: `Cannot find module '../lib/catalog'`.

- [ ] **Step 3: Implement**

`plugins/jev-router/lib/catalog.js`
```js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUILTINS = [
  { name: 'general-purpose', description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks', model: 'inherit', source: 'builtin' },
  { name: 'Explore', description: 'Fast read-only search agent that locates code and files and answers where-is questions across many files', model: 'haiku', source: 'builtin' },
  { name: 'Plan', description: 'Software architect agent that designs implementation plans and weighs architectural trade-offs', model: 'inherit', source: 'builtin' },
];

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function parseFrontmatter(text) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src };
  const lines = src.slice(4, end).split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let value = (m[2] || '').trim();
    if (/^[|>][-+]?$/.test(value)) {
      const folded = value[0] === '>';
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      data[key] = block.join(folded ? ' ' : '\n').trim();
    } else {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*-\s/.test(lines[i + 1])) value += ' ' + lines[++i].trim();
      data[key] = unquote(value);
    }
  }
  return { data, body: src.slice(end + 4) };
}

function cleanDescription(s, max = 240) {
  const t = String(s || '')
    .replace(/<example>[\s\S]*?<\/example>/gi, ' ')
    .replace(/<commentary>[\s\S]*?<\/commentary>/gi, ' ')
    .replace(/<example>[\s\S]*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function listMarkdown(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel.concat(e.name));
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push({ file: p, rel });
    }
  };
  walk(dir, []);
  return out;
}

function collectTarget(target) {
  try {
    if (fs.statSync(target).isFile()) return target.toLowerCase().endsWith('.md') ? [{ file: target, rel: [] }] : [];
  } catch {
    return [];
  }
  return listMarkdown(target);
}

function settingsFiles(configDir, projectDir) {
  return [
    path.join(configDir, 'settings.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
  ];
}

function enabledPlugins(configDir, projectDir) {
  const merged = {};
  for (const f of settingsFiles(configDir, projectDir)) {
    const s = readJson(f);
    if (s && s.enabledPlugins && typeof s.enabledPlugins === 'object') Object.assign(merged, s.enabledPlugins);
  }
  return Object.keys(merged).filter(k => merged[k] !== false && merged[k] != null);
}

function samePath(a, b) {
  if (!a || !b) return false;
  const n = p => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function pickInstall(entries, projectDir) {
  if (!Array.isArray(entries)) return null;
  return entries.find(e => (e.scope === 'project' || e.scope === 'local') && samePath(e.projectPath, projectDir))
    || entries.find(e => e.scope === 'user')
    || null;
}

function pluginSources(configDir, projectDir) {
  const installed = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
  const table = (installed && installed.plugins) || {};
  const out = [];
  for (const id of enabledPlugins(configDir, projectDir)) {
    const entry = pickInstall(table[id], projectDir);
    if (!entry || !entry.installPath) continue;
    const manifest = readJson(path.join(entry.installPath, '.claude-plugin', 'plugin.json')) || {};
    const plugin = manifest.name || id.split('@')[0];
    const declared = manifest.agents ? [].concat(manifest.agents) : null;
    const targets = declared ? declared.map(p => path.resolve(entry.installPath, p)) : [path.join(entry.installPath, 'agents')];
    out.push({ plugin, targets, source: 'plugin' });
  }
  return out;
}

function agentFromFile(f) {
  let text;
  try { text = fs.readFileSync(f.file, 'utf8'); } catch { return null; }
  const { data } = parseFrontmatter(text);
  const description = cleanDescription(data.description);
  if (!description) return null;
  const base = (data.name && String(data.name).trim()) || path.basename(f.file, path.extname(f.file));
  const name = f.plugin ? [f.plugin, ...f.rel, base].join(':') : base;
  return { name, description, model: (data.model && String(data.model).trim()) || 'inherit', source: f.source };
}

function loadCatalog({ configDir, projectDir, dataDir, pluginRoot }) {
  const plugins = pluginSources(configDir, projectDir);
  const sources = [
    { plugin: null, targets: [path.join(projectDir, '.claude', 'agents')], source: 'project' },
    { plugin: null, targets: [path.join(configDir, 'agents')], source: 'user' },
    ...plugins,
  ];
  if (pluginRoot && !plugins.some(p => p.plugin === 'jev-router')) {
    sources.push({ plugin: 'jev-router', targets: [path.join(pluginRoot, 'agents')], source: 'plugin' });
  }
  const files = [];
  for (const s of sources) for (const t of s.targets) for (const f of collectTarget(t)) files.push({ ...f, plugin: s.plugin, source: s.source });

  const sig = [...settingsFiles(configDir, projectDir), path.join(configDir, 'plugins', 'installed_plugins.json')]
    .map(p => `${p}:${mtime(p)}`)
    .concat(files.map(f => `${f.file}:${mtime(f.file)}:${f.plugin}:${f.source}`));
  const signature = crypto.createHash('sha1').update(sig.join('\n')).digest('hex');
  const cacheFile = dataDir ? path.join(dataDir, 'catalog.json') : null;
  if (cacheFile) {
    const cached = readJson(cacheFile);
    if (cached && cached.signature === signature && Array.isArray(cached.agents)) return cached;
  }

  const byName = new Map(BUILTINS.map(a => [a.name, a]));
  const duplicates = [];
  for (const f of files) {
    const a = agentFromFile(f);
    if (!a) continue;
    if (byName.has(a.name)) { duplicates.push(a.name); continue; }
    byName.set(a.name, a);
  }
  const agents = [...byName.values()];
  const counts = { builtin: 0, user: 0, project: 0, plugin: 0 };
  for (const a of agents) counts[a.source] += 1;
  const result = { signature, agents, counts, duplicates };
  if (cacheFile) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(result));
      fs.renameSync(tmp, cacheFile);
    } catch {
      // Cache is an optimisation only.
    }
  }
  return result;
}

module.exports = { loadCatalog, parseFrontmatter, cleanDescription, BUILTINS };
```

- [ ] **Step 4: Run tests** → `npm test` → all passing.
- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(jev-router): agent catalog across built-in, user, project and enabled plugins" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 6: Shortlist, heuristics, policy

**Files:**
- Create: `plugins/jev-router/lib/shortlist.js`, `lib/heuristics.js`, `lib/policy.js`
- Test: `plugins/jev-router/test/decision-logic.test.js`

**Interfaces:**
- Consumes: `Agent` from Task 5.
- Produces: `shortlist(agents, prompt, k=12) → (Agent & {score})[]`; `tokenize(s) → string[]`; `heuristics.decide({prompt, candidates}) → Decision`; `isTrivialPrompt(prompt) → boolean`; `difficultyLevel(prompt) → 0..3`; `toHint(decision, {agentsByName: Map}) → string | null`.
- `Decision = {source, difficulty: 0..3, difficultyConf, agent: string|null, agentConf, verbose: boolean, latencyMs}`.

- [ ] **Step 1: Write the failing test**

`plugins/jev-router/test/decision-logic.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shortlist, tokenize } = require('../lib/shortlist');
const heuristics = require('../lib/heuristics');
const { toHint } = require('../lib/policy');

const agents = [
  { name: 'Explore', description: 'Fast read-only search that locates code and files', model: 'haiku', source: 'builtin' },
  { name: 'jev-router:scout', description: 'Read-only search and short summaries', model: 'haiku', source: 'plugin' },
  { name: 'jev-router:quick', description: 'Small edits like renames and typo fixes', model: 'haiku', source: 'plugin' },
  { name: 'database-reviewer', description: 'PostgreSQL query optimisation, indexes and schema migrations', model: 'inherit', source: 'plugin' },
  { name: 'doc-updater', description: 'Updates README files and documentation', model: 'inherit', source: 'plugin' },
  { name: 'tdd-guide', description: 'Writes tests first, test-driven development', model: 'inherit', source: 'plugin' },
];

test('tokenize lowercases, drops stop-words and stems', () => {
  assert.deepEqual(tokenize('The Indexes are Slowing queries'), ['index', 'slow', 'queri']);
});

test('shortlist ranks lexical matches and always includes cheap helpers', () => {
  const s = shortlist(agents, 'add an index to speed up the postgresql query', 2);
  assert.equal(s[0].name, 'database-reviewer');
  for (const n of ['Explore', 'jev-router:scout', 'jev-router:quick']) assert.ok(s.some(a => a.name === n));
});

test('isTrivialPrompt', () => {
  for (const p of ['thanks!', 'ok', '/clear', 'hi', 'LGTM.', 'thank you']) assert.equal(heuristics.isTrivialPrompt(p), true, p);
  for (const p of ['where is the rate limiter?', 'fix the typo in README']) assert.equal(heuristics.isTrivialPrompt(p), false, p);
});

test('difficultyLevel', () => {
  assert.equal(heuristics.difficultyLevel('thanks'), 0);
  assert.equal(heuristics.difficultyLevel('where is the rate limiter implemented?'), 1);
  assert.equal(heuristics.difficultyLevel('fix the typo in README line 3'), 1);
  assert.equal(heuristics.difficultyLevel('why does the worker hang after 30 minutes?'), 2);
  assert.equal(heuristics.difficultyLevel('design a multi-region failover architecture'), 3);
});

test('heuristic decide: agent only with a clear lexical margin', () => {
  const d = heuristics.decide({ prompt: 'explain in detail how postgresql indexes work', candidates: shortlist(agents, 'postgresql indexes schema migrations', 12) });
  assert.equal(d.source, 'heuristic');
  assert.equal(d.verbose, true);
  assert.equal(d.agent, 'database-reviewer');
  assert.equal(d.agentConf, 0.6);
  const none = heuristics.decide({ prompt: 'hello there friend', candidates: shortlist(agents, 'hello there friend', 12) });
  assert.equal(none.agent, null);
});

const byName = new Map(agents.map(a => [a.name, a]));
const base = { source: 'engine', difficulty: 1, difficultyConf: 0.7, agent: null, agentConf: 0, verbose: false, latencyMs: 5 };
const cases = [
  ['null decision', null, null],
  ['confident agent with model', { ...base, agent: 'Explore', agentConf: 0.8 }, /delegate: Task\(subagent_type="Explore"\) \[haiku\] · answer tersely$/],
  ['inherit model has no bracket', { ...base, difficulty: 2, agent: 'doc-updater', agentConf: 0.9 }, /subagent_type="doc-updater"\)$/],
  ['low agent conf, simple → scout + terse', { ...base, agent: 'Explore', agentConf: 0.5 }, /scout \[haiku\] · answer tersely$/],
  ['simple but verbose → scout only', { ...base, verbose: true }, /scout \[haiku\]$/],
  ['moderate, no agent → silent', { ...base, difficulty: 2 }, null],
  ['hard, no agent → silent', { ...base, difficulty: 3 }, null],
  ['low difficulty confidence → silent', { ...base, difficultyConf: 0.4 }, null],
];
for (const [name, d, expected] of cases) {
  test(`toHint: ${name}`, () => {
    const h = toHint(d, { agentsByName: byName });
    if (expected === null) assert.equal(h, null);
    else { assert.match(h, expected); assert.match(h, /^\[jev-router\] /); assert.ok(h.length <= 300); assert.ok(!h.includes('\n')); }
  });
}
```

- [ ] **Step 2: Run to verify failure** → `npm test` → FAIL: `Cannot find module '../lib/shortlist'`.

- [ ] **Step 3: Implement**

`plugins/jev-router/lib/shortlist.js`
```js
'use strict';
const STOP = new Set('a an and are as at be by can do does for from has have how i in is it its me my of on or our please should so that the their them then this to use used uses using we what when where which who why will with you your agent agents task tasks'.split(' '));
const ALWAYS = ['Explore', 'jev-router:scout', 'jev-router:quick'];

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w)).map(stem);
}

function bm25Scores(docs, query, k1 = 1.2, b = 0.75) {
  const N = docs.length || 1;
  const avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const q = [...new Set(query)];
  return docs.map(d => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
    }
    return s;
  });
}

function shortlist(agents, prompt, k = 12) {
  const docs = agents.map(a => tokenize(`${a.name.replace(/[:_-]/g, ' ')} ${a.description}`));
  const scores = bm25Scores(docs, tokenize(prompt));
  const ranked = agents.map((a, i) => ({ ...a, score: scores[i] })).sort((x, y) => y.score - x.score);
  const top = ranked.filter(a => a.score > 0).slice(0, k);
  for (const name of ALWAYS) {
    if (top.some(a => a.name === name)) continue;
    const a = ranked.find(r => r.name === name);
    if (a) top.push(a);
  }
  return top;
}

module.exports = { shortlist, tokenize, bm25Scores, ALWAYS };
```

(`queries` → `ies` rule → `queri`, `indexes` → `index`, `slowing` → `slow`.)

`plugins/jev-router/lib/heuristics.js`
```js
'use strict';
const ACK = /^(thanks?|thank you|thx|ty|ok(ay)?|k|cool|great|nice|perfect|got it|sounds good|yes|yep|no|nope|sure|lgtm|done)[\s.!]*$/i;
const UP = /\b(architect\w*|design\w*|refactor\w*|migrat\w*|why|debug\w*|investigat\w*|root cause|race condition|deadlock|intermittent\w*|performance|optimi[sz]\w*|scal(e|ing|ability)|redesign\w*|security audit|across the (repo|codebase|project))\b/gi;
const DOWN = /\b(what is|what's|where is|where's|which file|find|list|show me|rename|typo|spelling|version of)\b/gi;
const VERBOSE = /\b(explain|walk me through|teach me|in detail|step[- ]by[- ]step|help me understand|deep dive)\b/i;
const FILE_PATH = /(?:^|\s)[\w./\\-]+\.[a-z0-9]{1,6}\b/gi;

function count(re, s) {
  return (s.match(re) || []).length;
}

function isTrivialPrompt(prompt) {
  const p = String(prompt || '').trim();
  return p.length < 4 || p.startsWith('/') || ACK.test(p);
}

function difficultyLevel(prompt) {
  const p = String(prompt || '');
  if (ACK.test(p.trim())) return 0;
  let s = 1;
  if (p.length > 400) s++;
  if (p.length > 1500) s++;
  if (count(FILE_PATH, p) > 2) s++;
  s += Math.min(2, count(UP, p));
  s -= Math.min(1, count(DOWN, p));
  return Math.max(1, Math.min(3, s));
}

function pickAgent(candidates) {
  const scored = (candidates || []).filter(c => typeof c.score === 'number' && c.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const [top, second] = scored;
  if (top.score < 2) return null;
  if (second && top.score < 1.5 * second.score) return null;
  return top.name;
}

function decide({ prompt, candidates }) {
  const agent = pickAgent(candidates);
  return {
    source: 'heuristic',
    difficulty: difficultyLevel(prompt),
    difficultyConf: 0.6,
    agent,
    agentConf: agent ? 0.6 : 0,
    verbose: VERBOSE.test(String(prompt || '')),
    latencyMs: 0,
  };
}

module.exports = { decide, difficultyLevel, isTrivialPrompt, pickAgent };
```

`plugins/jev-router/lib/policy.js`
```js
'use strict';
const LEVELS = ['trivial', 'simple', 'moderate', 'hard'];

// Savings strategy: say as little as possible, and only when it is likely right.
function toHint(d, { agentsByName }) {
  if (!d) return null;
  const parts = [];
  const confidentLevel = d.difficultyConf >= 0.5;
  if (d.agent && d.agentConf >= 0.55) {
    const a = agentsByName && agentsByName.get(d.agent);
    const model = a && a.model && a.model !== 'inherit' ? ` [${a.model}]` : '';
    parts.push(`delegate: Task(subagent_type="${d.agent}")${model}`);
  } else if (d.difficulty <= 1 && confidentLevel) {
    parts.push('delegate file search/reading to jev-router:scout [haiku]');
  }
  if (d.difficulty <= 1 && confidentLevel && !d.verbose) parts.push('answer tersely');
  if (!parts.length) return null;
  const line = `[jev-router] ${LEVELS[d.difficulty] || 'unknown'} (${Number(d.difficultyConf || 0).toFixed(2)}) · ${parts.join(' · ')}`;
  return line.slice(0, 300);
}

module.exports = { toHint, LEVELS };
```

- [ ] **Step 4: Run tests** → `npm test` → all passing. If `tokenize` yields a different stem list, fix `stem()`, not the test; the expected output is the contract.
- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(jev-router): BM25 shortlist, heuristic fallback and hint policy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: Engine primitives (manifest, tokenizer, vector cache, typed questions)

**Files:**
- Create: `plugins/jev-router/lib/engine/manifest.js`, `lib/engine/wordpiece.js`, `lib/engine/vectors.js`, `lib/engine/questions.js`
- Test: `plugins/jev-router/test/engine-primitives.test.js`, `test/fake-embedder.js`

**Interfaces:**
- Produces: `MODEL`, `ENGINE_VERSION`, `enginePaths(dataDir) → {root, modelDir, model, tokenizer, ready, ortModule}`, `fileUrl(file)`, `sha256File(path)`, `readReady(dataDir) → object|null`; `new WordPiece(tokenizerJson).encode(text, maxLen=256) → number[]`; `new VectorCache(file, max=3000)` with `get(text)`, `set(text, Float32Array)`, `save()`; `dot, softmax, argmax`, `choice(vec, stateVec, criteria)`, `score(vec, stateVec, levels)`, `noul(vec, stateVec, {true,false})`, where `vec: async (text) → Float32Array`.

- [ ] **Step 1: Write the failing tests**

`plugins/jev-router/test/fake-embedder.js`
```js
'use strict';
// Deterministic bag-of-words embedder for engine logic tests (no model needed).
function fakeEmbed(text, dim = 64) {
  const v = new Float32Array(dim);
  for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}
const fakeEmbedder = { embed: async t => fakeEmbed(t) };
module.exports = { fakeEmbed, fakeEmbedder };
```

`plugins/jev-router/test/engine-primitives.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir, write } = require('./helpers');
const { fakeEmbed } = require('./fake-embedder');
const { WordPiece } = require('../lib/engine/wordpiece');
const { VectorCache } = require('../lib/engine/vectors');
const { softmax, choice, score, noul } = require('../lib/engine/questions');
const { MODEL, enginePaths, readReady, fileUrl, ENGINE_VERSION } = require('../lib/engine/manifest');

const tok = new WordPiece({ model: { vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, hello: 4, world: 5, play: 6, '##ing': 7, ',': 8, cafe: 9, '中': 10 }, unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100 } });

test('wordpiece: lowercases, splits punctuation, subwords, accents, unknowns, CJK', () => {
  assert.deepEqual(tok.encode('Hello, World'), [2, 4, 8, 5, 3]);
  assert.deepEqual(tok.encode('playing'), [2, 6, 7, 3]);
  assert.deepEqual(tok.encode('Café'), [2, 9, 3]);
  assert.deepEqual(tok.encode('xyz'), [2, 1, 3]);
  assert.deepEqual(tok.encode('中文'), [2, 10, 1, 3]);
  assert.deepEqual(tok.encode('hello\u0000\tworld'), [2, 4, 5, 3]);
});

test('wordpiece truncates to maxLen including CLS/SEP', () => {
  const ids = tok.encode('hello '.repeat(500), 16);
  assert.equal(ids.length, 16);
  assert.equal(ids[0], 2);
  assert.equal(ids[ids.length - 1], 3);
});

test('softmax sums to 1 and sharpens with low temperature', () => {
  const p = softmax([0.9, 0.5, 0.1], 0.05);
  assert.ok(Math.abs(p.reduce((a, b) => a + b) - 1) < 1e-9);
  assert.ok(p[0] > 0.99);
});

const vec = async t => fakeEmbed(t);

test('choice picks the lexically closest option with a distribution', async () => {
  const sv = fakeEmbed('fix postgres index query');
  const r = await choice(vec, sv, { main: 'general chat', a1: 'postgres index query tuning', a2: 'write readme docs' });
  assert.equal(r.choice, 'a1');
  assert.ok(Math.abs(Object.values(r.probabilities).reduce((a, b) => a + b) - 1) < 1e-9);
  assert.equal(r.confidence, r.probabilities.a1);
});

test('score returns level, weighted score and confidence; exemplars use max', async () => {
  const sv = fakeEmbed('design new architecture');
  const r = await score(vec, sv, [['thanks ok'], ['find a file'], ['multi step change'], ['design architecture', 'large migration']]);
  assert.equal(r.level, 3);
  assert.ok(r.score > 2 && r.score <= 3);
  assert.equal(r.probabilities.length, 4);
});

test('noul returns p(true)', async () => {
  const r = await noul(vec, fakeEmbed('explain step by step'), { true: 'explain step by step', false: 'just do it' });
  assert.ok(r.noul > 0.9);
});

test('VectorCache round-trips Float32Array and survives reload', () => {
  const f = path.join(tmpDir(), 'v.json');
  const c = new VectorCache(f);
  c.set('hello', Float32Array.from([0.5, -0.25, 1]));
  c.save();
  const d = new VectorCache(f);
  assert.deepEqual(Array.from(d.get('hello')), [0.5, -0.25, 1]);
  assert.equal(d.get('missing'), null);
});

test('VectorCache: corrupt file is ignored; max size evicts oldest', () => {
  const f = write(path.join(tmpDir(), 'v.json'), '{not json');
  const c = new VectorCache(f, 2);
  c.set('a', Float32Array.from([1])); c.set('b', Float32Array.from([2])); c.set('c', Float32Array.from([3]));
  assert.equal(c.get('a'), null);
  assert.deepEqual(Array.from(c.get('c')), [3]);
});

test('VectorCache: concurrent writers never leave invalid JSON (Review Focus 5)', async () => {
  const f = path.join(tmpDir(), 'v.json');
  const mod = JSON.stringify(path.join(__dirname, '..', 'lib', 'engine', 'vectors.js'));
  const code = `const { VectorCache } = require(${mod}); for (let i = 0; i < 40; i++) { const c = new VectorCache(${JSON.stringify(f)}); c.set('k' + process.pid + i, Float32Array.from([i])); c.save(); }`;
  await Promise.all([1, 2, 3, 4].map(() => new Promise(res => spawn(process.execPath, ['-e', code], { stdio: 'ignore' }).on('close', res))));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, 'utf8')));
});

test('manifest: pinned revision, URLs and READY validation', () => {
  assert.equal(MODEL.revision, '751bff37182d3f1213fa05d7196b954e230abad9');
  assert.equal(fileUrl(MODEL.files[0]), 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/onnx/model_quantized.onnx');
  const data = tmpDir();
  assert.equal(readReady(data), null);
  const p = enginePaths(data);
  write(p.model, 'x'); write(p.tokenizer, '{}'); write(path.join(p.ortModule, 'package.json'), '{}');
  write(p.ready, JSON.stringify({ engineVersion: ENGINE_VERSION, revision: MODEL.revision }));
  assert.ok(readReady(data));
  write(p.ready, JSON.stringify({ engineVersion: ENGINE_VERSION, revision: 'other' }));
  assert.equal(readReady(data), null);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test` → FAIL: engine modules not found.

- [ ] **Step 3: Implement**

`plugins/jev-router/lib/engine/manifest.js`
```js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENGINE_VERSION = 1;
const MODEL = {
  repo: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dim: 384,
  files: [
    { remote: 'onnx/model_quantized.onnx', local: 'model.onnx', sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1', size: 22972370 },
    { remote: 'tokenizer.json', local: 'tokenizer.json', sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0', size: 711661 },
  ],
};

function enginePaths(dataDir) {
  const root = path.join(dataDir, 'engine');
  const modelDir = path.join(root, 'model');
  return {
    root,
    modelDir,
    model: path.join(modelDir, 'model.onnx'),
    tokenizer: path.join(modelDir, 'tokenizer.json'),
    ready: path.join(root, 'READY.json'),
    ortModule: path.join(root, 'node_modules', 'onnxruntime-node'),
  };
}

function fileUrl(f) {
  return `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${f.remote}`;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readReady(dataDir) {
  const p = enginePaths(dataDir);
  try {
    const r = JSON.parse(fs.readFileSync(p.ready, 'utf8'));
    if (r.engineVersion !== ENGINE_VERSION || r.revision !== MODEL.revision) return null;
    if (!fs.existsSync(p.model) || !fs.existsSync(p.tokenizer) || !fs.existsSync(p.ortModule)) return null;
    return r;
  } catch {
    return null;
  }
}

module.exports = { ENGINE_VERSION, MODEL, enginePaths, fileUrl, sha256File, readReady };
```

`plugins/jev-router/lib/engine/wordpiece.js`
```js
'use strict';
// Zero-dependency BERT WordPiece tokenizer matching all-MiniLM-L6-v2's tokenizer.json
// (BertNormalizer lowercase + strip accents, BertPreTokenizer, WordPiece "##").

function isPunct(cp) {
  return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)
    || /\p{P}/u.test(String.fromCodePoint(cp));
}

function isChinese(cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF)
    || (cp >= 0x2A700 && cp <= 0x2B73F) || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF)
    || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
}

class WordPiece {
  constructor(tokenizerJson) {
    const m = tokenizerJson && tokenizerJson.model;
    if (!m || !m.vocab) throw new Error('tokenizer.json has no WordPiece vocab');
    this.vocab = new Map(Object.entries(m.vocab));
    this.prefix = m.continuing_subword_prefix || '##';
    this.maxChars = m.max_input_chars_per_word || 100;
    const id = t => {
      const v = this.vocab.get(t);
      if (v === undefined) throw new Error(`vocab is missing ${t}`);
      return v;
    };
    this.unk = id(m.unk_token || '[UNK]');
    this.cls = id('[CLS]');
    this.sep = id('[SEP]');
  }

  normalize(text) {
    let out = '';
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp === 0 || cp === 0xFFFD) continue;
      if (/\s/u.test(ch)) { out += ' '; continue; }
      if (/\p{Cc}/u.test(ch)) continue;
      out += isChinese(cp) ? ` ${ch} ` : ch;
    }
    return out.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  }

  preTokenize(text) {
    const words = [];
    for (const chunk of text.split(' ')) {
      if (!chunk) continue;
      let cur = '';
      for (const ch of chunk) {
        if (isPunct(ch.codePointAt(0))) {
          if (cur) words.push(cur);
          words.push(ch);
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur) words.push(cur);
    }
    return words;
  }

  wordPiece(word) {
    const chars = [...word];
    if (chars.length > this.maxChars) return [this.unk];
    const ids = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found = null;
      while (start < end) {
        const sub = (start > 0 ? this.prefix : '') + chars.slice(start, end).join('');
        const v = this.vocab.get(sub);
        if (v !== undefined) { found = v; break; }
        end--;
      }
      if (found === null) return [this.unk];
      ids.push(found);
      start = end;
    }
    return ids;
  }

  encode(text, maxLen = 256) {
    const ids = [];
    for (const w of this.preTokenize(this.normalize(text))) {
      for (const id of this.wordPiece(w)) ids.push(id);
      if (ids.length >= maxLen - 2) break;
    }
    return [this.cls, ...ids.slice(0, maxLen - 2), this.sep];
  }
}

module.exports = { WordPiece };
```

`plugins/jev-router/lib/engine/vectors.js`
```js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class VectorCache {
  constructor(file, max = 3000) {
    this.file = file;
    this.max = max;
    this.map = new Map();
    this.dirty = false;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, b64] of Object.entries(j.entries || {})) this.map.set(k, b64);
    } catch {
      // Missing or corrupt cache: start empty.
    }
  }

  static key(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
  }

  get(text) {
    const b64 = this.map.get(VectorCache.key(text));
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    const out = new Float32Array(buf.byteLength / 4);
    new Uint8Array(out.buffer).set(buf);
    return out;
  }

  set(text, vec) {
    const k = VectorCache.key(text);
    this.map.delete(k);
    this.map.set(k, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64'));
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    this.dirty = true;
  }

  save() {
    if (!this.dirty) return;
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(this.map) }));
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.renameSync(tmp, this.file);
          this.dirty = false;
          return;
        } catch (e) {
          if (attempt === 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        }
      }
    } catch {
      // Cache is an optimisation; never fail the hook over it.
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
}

module.exports = { VectorCache };
```

`plugins/jev-router/lib/engine/questions.js`
```js
'use strict';
// JEV-style typed questions over normalised embeddings (cosine = dot product).

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function softmax(xs, T = 0.05) {
  const m = Math.max(...xs);
  const e = xs.map(x => Math.exp((x - m) / T));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / s);
}

function argmax(xs) {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

async function choice(vec, stateVec, criteria, T = 0.05) {
  const keys = Object.keys(criteria);
  const sims = [];
  for (const k of keys) sims.push(dot(stateVec, await vec(criteria[k])));
  const p = softmax(sims, T);
  const i = argmax(p);
  return { choice: keys[i], probabilities: Object.fromEntries(keys.map((k, j) => [k, p[j]])), confidence: p[i] };
}

async function score(vec, stateVec, levels, T = 0.05) {
  const sims = [];
  for (const texts of levels) {
    let best = -Infinity;
    for (const t of [].concat(texts)) best = Math.max(best, dot(stateVec, await vec(t)));
    sims.push(best);
  }
  const p = softmax(sims, T);
  const i = argmax(p);
  return { score: p.reduce((s, x, j) => s + x * j, 0), level: i, probabilities: p, confidence: p[i] };
}

async function noul(vec, stateVec, criteria, T = 0.05) {
  const p = softmax([dot(stateVec, await vec(criteria.true)), dot(stateVec, await vec(criteria.false))], T);
  return { noul: p[0] };
}

module.exports = { dot, softmax, argmax, choice, score, noul };
```

- [ ] **Step 4: Run tests** → `npm test` → all passing.
- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(jev-router): engine primitives — pinned manifest, WordPiece, vector cache, typed questions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: Engine decision layer (local, loopback remote, hybrid)

**Files:**
- Create: `plugins/jev-router/lib/engine/local.js`, `lib/engine/index.js`
- Test: `plugins/jev-router/test/engine-decide.test.js`

**Interfaces:**
- Consumes: Task 7 primitives, `isLoopbackUrl`, `Agent`.
- Produces: `LocalEmbedder.create(dataDir) → {embed(text) → Float32Array}`; `decideLocal({prompt, agents, shortlisted, embedder, cache}) → EngineDecision`; `decideRemote({baseUrl, prompt, shortlisted, timeoutMs}) → EngineDecision|null`; `parseRemote(json, keyToName)`; `combine(engineDecision, heuristicDecision) → Decision`; `decide({prompt, agents, shortlisted, cfg, useRemote, createEmbedder?, isReady?}) → EngineDecision|null`; `agentText(agent) → string`.
- `EngineDecision = Decision & {difficultyDist: number[4], verboseP: number}`.

- [ ] **Step 1: Write the failing test**

`plugins/jev-router/test/engine-decide.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { tmpDir } = require('./helpers');
const { fakeEmbedder } = require('./fake-embedder');
const { VectorCache } = require('../lib/engine/vectors');
const { decideLocal, decideRemote, parseRemote, combine, decide, agentText } = require('../lib/engine');

const agents = [
  { name: 'Explore', description: 'read only search locate files where is code', model: 'haiku', source: 'builtin' },
  { name: 'db:database-reviewer', description: 'postgres index query schema migration', model: 'inherit', source: 'plugin' },
  { name: 'doc-updater', description: 'readme documentation docs update', model: 'inherit', source: 'plugin' },
];

test('agentText strips the plugin prefix and punctuation from names', () => {
  assert.equal(agentText(agents[1]), 'database reviewer: postgres index query schema migration');
});

test('decideLocal chooses an agent, scores difficulty, caches label vectors', async () => {
  const cache = new VectorCache(path.join(tmpDir(), 'v.json'));
  const d = await decideLocal({ prompt: 'add a postgres index to the query', agents, shortlisted: [], embedder: fakeEmbedder, cache });
  assert.equal(d.source, 'engine');
  assert.equal(d.agent, 'db:database-reviewer');
  assert.ok(d.agentConf > 0 && d.agentConf <= 1);
  assert.equal(d.difficultyDist.length, 4);
  assert.ok(d.difficulty >= 0 && d.difficulty <= 3);
  assert.equal(typeof d.verbose, 'boolean');
  assert.ok(cache.get(agentText(agents[1])));
});

test('combine blends 0.6 engine + 0.4 heuristic and ORs verbose', () => {
  const engine = { source: 'engine', difficulty: 3, difficultyDist: [0, 0, 0.4, 0.6], difficultyConf: 0.6, agent: null, agentConf: 0.2, verboseP: 0.2, verbose: false };
  const heur = { difficulty: 1, verbose: true };
  const c = combine(engine, heur);
  assert.equal(c.difficulty, 1);
  assert.ok(Math.abs(c.difficultyConf - 0.4) < 1e-9);
  assert.equal(c.verbose, true);
  assert.equal(c.source, 'engine');
});

test('parseRemote accepts probabilities or score-only answers', () => {
  const k = { a1: 'Explore' };
  const p = parseRemote({ answers: { difficulty: { probabilities: { t: 0.1, s: 0.7, m: 0.1, h: 0.1 }, confidence: 0.7 }, agent: { choice: 'a1', confidence: 0.8 }, verbose: { noul: 0.9 } } }, k);
  assert.deepEqual([p.difficulty, p.agent, p.verbose], [1, 'Explore', true]);
  const s = parseRemote({ answers: { difficulty: { score: 2.6 }, agent: { choice: 'main', confidence: 0.9 }, verbose: { noul: 0.1 } } }, k);
  assert.deepEqual([s.difficulty, s.agent, s.verbose], [3, null, false]);
  assert.equal(parseRemote({ answers: {} }, k), null);
});

function server(handler) {
  return new Promise(res => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });
}

test('decideRemote refuses non-loopback URLs', async () => {
  await assert.rejects(decideRemote({ baseUrl: 'https://api.typesafe.ai', prompt: 'x', shortlisted: [], timeoutMs: 500 }), /non-loopback/);
});

test('decideRemote talks JEV wire format to a loopback server and refuses redirects', async () => {
  let body;
  const s = await server((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ answers: { difficulty: { score: 0.4 }, agent: { choice: 'a1', confidence: 0.9 }, verbose: { noul: 0.1 } } }));
    });
  });
  const d = await decideRemote({ baseUrl: `http://127.0.0.1:${s.address().port}`, prompt: 'find the file', shortlisted: [agents[0]], timeoutMs: 2000 });
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(Object.keys(body.questions), ['difficulty', 'agent', 'verbose']);
  assert.equal(d.agent, 'Explore');
  s.close();
  const r = await server((req, res) => { res.statusCode = 302; res.setHeader('location', 'https://example.com/'); res.end(); });
  await assert.rejects(decideRemote({ baseUrl: `http://127.0.0.1:${r.address().port}`, prompt: 'x', shortlisted: [], timeoutMs: 2000 }));
  r.close();
});

test('decide returns null when the engine is not installed or too slow', async () => {
  const cfg = { dataDir: tmpDir(), engineTimeoutMs: 200, jevBaseUrl: '' };
  assert.equal(await decide({ prompt: 'x', agents, shortlisted: [], cfg, useRemote: false }), null);
  const slow = await decide({ prompt: 'x', agents, shortlisted: [], cfg, useRemote: false, isReady: () => true, createEmbedder: () => new Promise(() => {}) });
  assert.equal(slow, null);
});

test('decide uses an injected embedder when ready', async () => {
  const cfg = { dataDir: tmpDir(), engineTimeoutMs: 2000, jevBaseUrl: '' };
  const d = await decide({ prompt: 'update the readme docs', agents, shortlisted: [], cfg, useRemote: false, isReady: () => true, createEmbedder: async () => fakeEmbedder });
  assert.equal(d.agent, 'doc-updater');
});
```

- [ ] **Step 2: Run to verify failure** → `npm test` → FAIL: `Cannot find module '../lib/engine'`.

- [ ] **Step 3: Implement**

`plugins/jev-router/lib/engine/local.js`
```js
'use strict';
const fs = require('fs');
const { enginePaths } = require('./manifest');
const { WordPiece } = require('./wordpiece');

class LocalEmbedder {
  static async create(dataDir) {
    const p = enginePaths(dataDir);
    const ort = require(p.ortModule);
    const tokenizer = new WordPiece(JSON.parse(fs.readFileSync(p.tokenizer, 'utf8')));
    const session = await ort.InferenceSession.create(p.model, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    });
    return new LocalEmbedder(ort, tokenizer, session);
  }

  constructor(ort, tokenizer, session) {
    this.ort = ort;
    this.tokenizer = tokenizer;
    this.session = session;
  }

  async embed(text) {
    const ids = this.tokenizer.encode(text, 256);
    const n = ids.length;
    const tensor = arr => new this.ort.Tensor('int64', BigInt64Array.from(arr, x => BigInt(x)), [1, n]);
    const feeds = { input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)) };
    if (this.session.inputNames.includes('token_type_ids')) feeds.token_type_ids = tensor(ids.map(() => 0));
    const out = await this.session.run(feeds);
    const t = out.last_hidden_state || out[this.session.outputNames[0]];
    const dim = t.dims[t.dims.length - 1];
    const data = t.data;
    const v = new Float32Array(dim);
    for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) v[j] += data[i * dim + j];
    let norm = 0;
    for (let j = 0; j < dim; j++) { v[j] /= n; norm += v[j] * v[j]; }
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dim; j++) v[j] /= norm;
    return v;
  }
}

module.exports = { LocalEmbedder };
```

`plugins/jev-router/lib/engine/index.js`
```js
'use strict';
const path = require('path');
const { readReady } = require('./manifest');
const { VectorCache } = require('./vectors');
const { choice, score, noul, dot } = require('./questions');
const { isLoopbackUrl } = require('../config');

const LEVELS = [
  ['a greeting, thanks, ok, or an acknowledgement', 'thanks!', 'ok got it'],
  ['a quick lookup, finding or listing something, a one-fact question, or a tiny single-file edit like a typo or rename', 'where is the login handler defined?', 'fix the typo in the readme'],
  ['a multi-step change across a few files, writing tests, or debugging with clear leads', 'add validation to the signup endpoint and update its tests', 'the build fails with a type error in the api module'],
  ['architecture or system design, ambiguous debugging, a large refactor, or a migration', 'design a multi-region failover architecture', 'refactor the billing module into services and migrate the data'],
];
const VERBOSE = {
  true: 'explain in detail, walk me through it step by step, teach me how this works',
  false: 'just do it, make the change, give a short direct answer',
};
const MAIN = 'general conversation, answering a question directly, discussing options and deciding';
const TOP_SEMANTIC = 12;

function agentText(a) {
  return `${a.name.replace(/^[^:]+:/, '').replace(/[-_:]/g, ' ')}: ${a.description}`;
}

async function decideLocal({ prompt, agents, shortlisted, embedder, cache }) {
  const t0 = Date.now();
  const vec = async text => {
    const hit = cache.get(text);
    if (hit) return hit;
    const v = await embedder.embed(text);
    cache.set(text, v);
    return v;
  };
  const sv = await embedder.embed(String(prompt).slice(0, 4000));
  const scored = [];
  for (const a of agents) scored.push({ a, s: dot(sv, await vec(agentText(a))) });
  cache.save();
  scored.sort((x, y) => y.s - x.s);
  const pool = new Map();
  for (const { a } of scored.slice(0, TOP_SEMANTIC)) pool.set(a.name, a);
  for (const a of shortlisted || []) pool.set(a.name, a);
  const keyToName = {};
  const criteria = { main: MAIN };
  let i = 0;
  for (const a of pool.values()) {
    const k = `a${++i}`;
    keyToName[k] = a.name;
    criteria[k] = agentText(a);
  }
  const ag = await choice(vec, sv, criteria);
  const df = await score(vec, sv, LEVELS);
  const vb = await noul(vec, sv, VERBOSE);
  return {
    source: 'engine',
    difficulty: df.level,
    difficultyDist: df.probabilities,
    difficultyConf: df.confidence,
    agent: ag.choice === 'main' ? null : keyToName[ag.choice],
    agentConf: ag.confidence,
    verboseP: vb.noul,
    verbose: vb.noul >= 0.7,
    latencyMs: Date.now() - t0,
  };
}

function parseRemote(json, keyToName) {
  const a = (json && json.answers) || {};
  const d = a.difficulty || {};
  let dist = null;
  if (d.probabilities && typeof d.probabilities === 'object') {
    const vals = Array.isArray(d.probabilities) ? d.probabilities : Object.values(d.probabilities);
    if (vals.length === 4 && vals.every(Number.isFinite)) dist = vals;
  }
  if (!dist && Number.isFinite(d.score)) {
    const lvl = Math.max(0, Math.min(3, Math.round(d.score > 1 ? d.score : d.score * 3)));
    dist = [0, 0, 0, 0];
    dist[lvl] = 1;
  }
  if (!dist) return null;
  const lvl = dist.indexOf(Math.max(...dist));
  const ch = a.agent || {};
  const vp = a.verbose && Number.isFinite(a.verbose.noul) ? a.verbose.noul : 0;
  return {
    source: 'remote',
    difficulty: lvl,
    difficultyDist: dist,
    difficultyConf: Number.isFinite(d.confidence) ? d.confidence : dist[lvl],
    agent: ch.choice && ch.choice !== 'main' ? keyToName[ch.choice] || null : null,
    agentConf: Number.isFinite(ch.confidence) ? ch.confidence : 0,
    verboseP: vp,
    verbose: vp >= 0.7,
  };
}

async function decideRemote({ baseUrl, prompt, shortlisted, timeoutMs }) {
  if (!isLoopbackUrl(baseUrl)) throw new Error('refusing non-loopback JEV_BASE_URL');
  const keyToName = {};
  const criteria = { main: MAIN };
  (shortlisted || []).forEach((a, i) => { keyToName[`a${i + 1}`] = a.name; criteria[`a${i + 1}`] = agentText(a); });
  const body = {
    model: 'jev-latest',
    state: { request: String(prompt).slice(0, 4000) },
    questions: {
      difficulty: { type: 'score', instructions: 'How much reasoning and work does this coding-assistant request need?', criteria: LEVELS.map(l => l[0]) },
      agent: { type: 'choice', instructions: 'Which specialist should do the bulk of this request? Choose main if the main conversation should handle it directly.', criteria },
      verbose: { type: 'noul', instructions: 'Does the user explicitly ask for a detailed explanation, walkthrough, or teaching?' },
    },
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(new URL('/v1/systemone', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
      redirect: 'error',
    });
    if (!r.ok) throw new Error(`remote status ${r.status}`);
    const d = parseRemote(await r.json(), keyToName);
    if (d) d.latencyMs = Date.now() - t0;
    return d;
  } finally {
    clearTimeout(timer);
  }
}

function combine(engine, heur) {
  const dist = [0, 1, 2, 3].map(i => {
    const e = engine.difficultyDist ? engine.difficultyDist[i] : (i === engine.difficulty ? 1 : 0);
    return 0.6 * e + 0.4 * (i === heur.difficulty ? 1 : 0);
  });
  const lvl = dist.indexOf(Math.max(...dist));
  return { ...engine, difficulty: lvl, difficultyConf: dist[lvl], verbose: Boolean(heur.verbose || engine.verboseP >= 0.7) };
}

async function decide({ prompt, agents, shortlisted, cfg, useRemote, createEmbedder, isReady }) {
  const work = (async () => {
    if (useRemote) return decideRemote({ baseUrl: cfg.jevBaseUrl, prompt, shortlisted, timeoutMs: cfg.engineTimeoutMs });
    if (!(isReady || readReady)(cfg.dataDir)) return null;
    const make = createEmbedder || (dir => require('./local').LocalEmbedder.create(dir));
    const embedder = await make(cfg.dataDir);
    const cache = new VectorCache(path.join(cfg.dataDir, 'vectors.json'));
    try {
      return await decideLocal({ prompt, agents, shortlisted, embedder, cache });
    } finally {
      cache.save();
    }
  })();
  work.catch(() => {});
  let timer;
  const timeout = new Promise(res => { timer = setTimeout(() => res(null), cfg.engineTimeoutMs); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { decide, decideLocal, decideRemote, parseRemote, combine, agentText, LEVELS };
```

(`work.catch(() => {})` only silences the unhandled rejection. `Promise.race` still rejects when `work` rejects first, so `route-prompt` can log the error and fall back.)

- [ ] **Step 4: Run tests** → `npm test` → all passing.
- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(jev-router): local and loopback-remote decision engine with hybrid difficulty" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 9: Engine setup (`/jev-router:setup`)

**Files:**
- Create: `plugins/jev-router/engine/package.json`, `engine/package-lock.json` (generated)
- Create: `plugins/jev-router/scripts/setup.js`, `skills/setup/SKILL.md`
- Test: `plugins/jev-router/test/setup.test.js`

**Interfaces:**
- Consumes: manifest, `LocalEmbedder`, `dot`, `loadCatalog`, `VectorCache`, `agentText`.
- Produces: `pruneOtherPlatforms(ortDir, platform?, arch?) → number`; `downloadVerified(url, dest, sha256, fetchImpl?)`; `parseArgs(argv) → {data, uninstall}`; CLI `node scripts/setup.js --data <dir> [--uninstall]`.

- [ ] **Step 1: Engine package and lockfile**

`plugins/jev-router/engine/package.json`
```json
{
  "name": "jev-router-engine",
  "private": true,
  "version": "1.0.0",
  "description": "Pinned runtime for jev-router's local engine. Installed by /jev-router:setup into the plugin data dir, not at plugin install.",
  "license": "MIT",
  "dependencies": {
    "onnxruntime-node": "1.30.0"
  }
}
```

Run: `cd plugins/jev-router/engine && npm install --package-lock-only --ignore-scripts --no-audit --no-fund`
Expected: `package-lock.json` created with `integrity` hashes. No `node_modules/` is created.

- [ ] **Step 2: Write the failing test**

`plugins/jev-router/test/setup.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpDir, write } = require('./helpers');
const { pruneOtherPlatforms, downloadVerified, parseArgs } = require('../scripts/setup');

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--data', '/d', '--uninstall']), { data: '/d', uninstall: true });
  assert.deepEqual(parseArgs([]), { data: null, uninstall: false });
});

test('pruneOtherPlatforms keeps only the host platform/arch', () => {
  const ort = tmpDir();
  for (const p of ['win32/x64', 'win32/arm64', 'linux/x64', 'darwin/arm64']) write(path.join(ort, 'bin', 'napi-v6', p, 'x.node'), 'x');
  const removed = pruneOtherPlatforms(ort, 'linux', 'x64');
  assert.equal(removed, 2);
  assert.ok(fs.existsSync(path.join(ort, 'bin', 'napi-v6', 'linux', 'x64', 'x.node')));
  assert.ok(!fs.existsSync(path.join(ort, 'bin', 'napi-v6', 'win32')));
  assert.equal(pruneOtherPlatforms(path.join(ort, 'missing')), 0);
});

const bytes = Buffer.from('model-bytes');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const okFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

test('downloadVerified writes the file only when the checksum matches', async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'm', 'model.onnx');
  await downloadVerified('https://x', dest, sha, okFetch);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'model-bytes');
  const bad = path.join(dir, 'bad.onnx');
  await assert.rejects(downloadVerified('https://x', bad, '0'.repeat(64), okFetch), /checksum mismatch/);
  assert.equal(fs.existsSync(bad), false);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.download')), []);
  await assert.rejects(downloadVerified('https://x', bad, sha, async () => ({ ok: false, status: 404 })), /404/);
});
```

- [ ] **Step 3: Run to verify failure** → `npm test` → FAIL: `Cannot find module '../scripts/setup'`.

- [ ] **Step 4: Implement setup and its skill**

`plugins/jev-router/scripts/setup.js`
```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../lib/config');
const { MODEL, ENGINE_VERSION, enginePaths, fileUrl, sha256File } = require('../lib/engine/manifest');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const say = m => process.stdout.write(m + '\n');

function parseArgs(argv) {
  const a = { data: null, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') a.data = argv[++i] || null;
    else if (argv[i] === '--uninstall') a.uninstall = true;
  }
  return a;
}

function pruneOtherPlatforms(ortDir, platform = process.platform, arch = process.arch) {
  const binRoot = path.join(ortDir, 'bin');
  let removed = 0;
  let napis;
  try { napis = fs.readdirSync(binRoot); } catch { return 0; }
  for (const napi of napis) {
    const napiDir = path.join(binRoot, napi);
    let plats;
    try { plats = fs.readdirSync(napiDir); } catch { continue; }
    for (const plat of plats) {
      const platDir = path.join(napiDir, plat);
      if (plat !== platform) { fs.rmSync(platDir, { recursive: true, force: true }); removed++; continue; }
      for (const ar of fs.readdirSync(platDir)) {
        if (ar !== arch) { fs.rmSync(path.join(platDir, ar), { recursive: true, force: true }); removed++; }
      }
    }
  }
  return removed;
}

async function downloadVerified(url, dest, expectedSha, fetchImpl = fetch) {
  const tmp = `${dest}.${process.pid}.download`;
  try {
    const r = await fetchImpl(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`download failed (${r.status}) for ${url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== expectedSha) throw new Error(`checksum mismatch for ${path.basename(dest)}: expected ${expectedSha}, got ${got}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function npmCi(root) {
  const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`npm ci failed (exit ${r.status})`);
}

async function selfTest(dataDir) {
  const { LocalEmbedder } = require('../lib/engine/local');
  const { dot } = require('../lib/engine/questions');
  const t0 = Date.now();
  const e = await LocalEmbedder.create(dataDir);
  const a = await e.embed('where is the login handler defined');
  const b = await e.embed('find the authentication function');
  const c = await e.embed('bake a chocolate cake');
  if (a.length !== MODEL.dim) throw new Error(`unexpected vector size ${a.length}`);
  if (!(dot(a, b) > dot(a, c))) throw new Error('self-test similarity ordering failed');
  return { ms: Date.now() - t0, embedder: e };
}

async function warmCatalog(dataDir, embedder) {
  const { loadCatalog } = require('../lib/catalog');
  const { VectorCache } = require('../lib/engine/vectors');
  const { agentText } = require('../lib/engine');
  const cfg = loadConfig();
  const { agents } = loadCatalog({ configDir: cfg.configDir, projectDir: process.cwd(), dataDir, pluginRoot: PLUGIN_ROOT });
  const cache = new VectorCache(path.join(dataDir, 'vectors.json'));
  for (const a of agents) {
    const text = agentText(a);
    if (!cache.get(text)) cache.set(text, await embedder.embed(text));
  }
  cache.save();
  return agents.length;
}

async function install(dataDir) {
  const p = enginePaths(dataDir);
  say(`jev-router setup → ${p.root}`);
  say('One-time downloads: onnxruntime-node from npm and all-MiniLM-L6-v2 (23 MB) from Hugging Face, pinned and checksum-verified. Nothing about you or your code is uploaded.');
  fs.mkdirSync(p.root, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(PLUGIN_ROOT, 'engine', f), path.join(p.root, f));
  if (fs.existsSync(path.join(p.ortModule, 'package.json'))) {
    say('• onnxruntime-node already installed');
  } else {
    say('• npm ci (install scripts disabled)…');
    npmCi(p.root);
  }
  say(`• pruned ${pruneOtherPlatforms(p.ortModule)} binary folders for other platforms`);
  for (const f of MODEL.files) {
    const dest = path.join(p.modelDir, f.local);
    if (fs.existsSync(dest) && sha256File(dest) === f.sha256) { say(`• ${f.local}: checksum OK`); continue; }
    say(`• downloading ${f.remote} @ ${MODEL.revision.slice(0, 7)}…`);
    await downloadVerified(fileUrl(f), dest, f.sha256);
    say(`• ${f.local}: checksum OK`);
  }
  const { ms, embedder } = await selfTest(dataDir);
  say(`• self-test passed (${ms} ms including model load)`);
  say(`• pre-computed vectors for ${await warmCatalog(dataDir, embedder)} agents`);
  fs.writeFileSync(p.ready, JSON.stringify({
    engineVersion: ENGINE_VERSION,
    revision: MODEL.revision,
    installedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
  }, null, 2));
  say('jev-router: local engine ready. Prompt routing is active; nothing leaves this machine.');
}

function uninstall(dataDir) {
  const p = enginePaths(dataDir);
  fs.rmSync(p.root, { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, 'vectors.json'), { force: true });
  say(`jev-router: engine removed from ${p.root}. Routing is off until you run /jev-router:setup again.`);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args.data || loadConfig().dataDir);
  Promise.resolve()
    .then(() => (args.uninstall ? uninstall(dataDir) : install(dataDir)))
    .then(() => process.exit(0))
    .catch(e => { process.stderr.write(`jev-router setup failed: ${e.message}\n`); process.exit(1); });
}

module.exports = { pruneOtherPlatforms, downloadVerified, parseArgs };
```

`plugins/jev-router/skills/setup/SKILL.md`
```markdown
---
description: Install (or remove with --uninstall) jev-router's local decision engine. One-time ~100 MB download of pinned, checksum-verified files; afterwards routing runs fully offline. Run only when the user invokes /jev-router:setup.
disable-model-invocation: true
argument-hint: "[--uninstall]"
---

Run exactly this command with the Bash tool (timeout 600000 ms) and then show the user its output verbatim. Do not change the command or retry it with different flags. If it fails, show the error and suggest `/jev-router:doctor`.

node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" --data "${CLAUDE_PLUGIN_DATA}" $ARGUMENTS
```

- [ ] **Step 5: Run unit tests** → `npm test` → all passing.

- [ ] **Step 6: Real setup run (network, local machine)**

Run: `node plugins/jev-router/scripts/setup.js --data .engine-test`
Expected, in order:
- `npm ci` completes;
- `pruned N binary folders`, with N ≥ 3;
- both files report `checksum OK`;
- `self-test passed (<2000 ms …)`;
- `pre-computed vectors for M agents`;
- `local engine ready`.

Run it again. Expected: `already installed` and both `checksum OK`, with no downloads.
Then run `node plugins/jev-router/scripts/setup.js --data .engine-test --uninstall` followed by a fresh install. Expected: the engine dir is removed, then reinstalled.
**If onnxruntime-node fails to load with `--ignore-scripts`:** inspect `node_modules/onnxruntime-node/script/install.js`. Only if the CPU binaries are genuinely missing from the tarball, drop `--ignore-scripts`, record why in spec §3, and re-run.

- [ ] **Step 7: Commit** → `git add -A && git commit -m "feat(jev-router): /jev-router:setup installs the pinned local engine" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 10: Prompt routing and hard-gate hooks, helper agents

**Files:**
- Create: `plugins/jev-router/scripts/route-prompt.js`, `scripts/session-start.js`, `agents/quick.md`, `agents/scout.md`
- Modify: `plugins/jev-router/hooks/hooks.json` (add SessionStart, UserPromptSubmit)
- Test: `plugins/jev-router/test/route-hooks.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: the UserPromptSubmit hook output `{hookSpecificOutput:{hookEventName:'UserPromptSubmit', additionalContext}}`, the SessionStart hook output `{systemMessage}`, and `decisions.jsonl` records `{ts, session, prompt:{len,sha}, source, difficulty, conf, agent, agentConf, hintChars, latencyMs, error?}`.

- [ ] **Step 1: Write the failing test**

`plugins/jev-router/test/route-hooks.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SCRIPTS, runScript, hookEnv } = require('./helpers');

const route = path.join(SCRIPTS, 'route-prompt.js');
const start = path.join(SCRIPTS, 'session-start.js');

function jevServer(reply) {
  return new Promise(res => {
    const s = http.createServer((req, resp) => {
      let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
        const out = reply(JSON.parse(raw));
        resp.statusCode = out.status || 200;
        resp.setHeader('content-type', 'application/json');
        resp.end(JSON.stringify(out.body || {}));
      });
    }).listen(0, '127.0.0.1', () => res(s));
  });
}

test('session-start shows the setup reminder until the engine is ready', async () => {
  const h = hookEnv();
  const r = await runScript(start, { hook_event_name: 'SessionStart', source: 'startup' }, h.env);
  assert.match(r.json.systemMessage, /run \/jev-router:setup/);
  const off = await runScript(start, {}, hookEnv({ CLAUDE_PLUGIN_OPTION_MODE: 'guard-only' }).env);
  assert.equal(off.stdout, '');
});

test('route-prompt is silent (hard gate) before setup and logs nothing', async () => {
  const h = hookEnv();
  const r = await runScript(route, { prompt: 'where is the rate limiter implemented?', session_id: 's', cwd: h.config }, h.env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(h.data, 'decisions.jsonl')), false);
});

test('route-prompt ignores trivial prompts and slash commands', async () => {
  const s = await jevServer(() => ({ body: {} }));
  const h = hookEnv({ JEV_BASE_URL: `http://127.0.0.1:${s.address().port}` });
  for (const p of ['thanks!', '/clear', 'ok']) {
    const r = await runScript(route, { prompt: p, session_id: 's', cwd: h.config }, h.env);
    assert.equal(r.stdout, '', p);
  }
  s.close();
});

test('route-prompt with a loopback JEV-compatible server emits a hint and logs a fingerprint only', async () => {
  const s = await jevServer(body => {
    const crit = body.questions.agent.criteria;
    const key = Object.keys(crit).find(k => crit[k].startsWith('Explore'));
    return { body: { answers: { difficulty: { probabilities: [0.05, 0.85, 0.05, 0.05], confidence: 0.85 }, agent: { choice: key, confidence: 0.9 }, verbose: { noul: 0.1 } } } };
  });
  const h = hookEnv({ JEV_BASE_URL: `http://127.0.0.1:${s.address().port}` });
  const prompt = 'where is the secret-rate-limiter implemented?';
  const r = await runScript(route, { prompt, session_id: 's1', cwd: h.config }, h.env);
  s.close();
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(r.json.hookSpecificOutput.additionalContext, /^\[jev-router\] simple .*subagent_type="Explore"/);
  const log = fs.readFileSync(path.join(h.data, 'decisions.jsonl'), 'utf8');
  assert.match(log, /"source":"remote"/);
  assert.ok(!log.includes('secret-rate-limiter'));
});

test('remote failure falls back to heuristics, logs the error, still exits 0', async () => {
  const s = await jevServer(() => ({ status: 500 }));
  const h = hookEnv({ JEV_BASE_URL: `http://127.0.0.1:${s.address().port}` });
  const r = await runScript(route, { prompt: 'fix the typo in README line 3', session_id: 's', cwd: h.config }, h.env);
  s.close();
  assert.equal(r.code, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(h.data, 'decisions.jsonl'), 'utf8').trim());
  assert.equal(rec.source, 'heuristic-fallback');
  assert.match(rec.error, /500/);
});

test('non-loopback JEV_BASE_URL is refused (treated as not ready)', async () => {
  const h = hookEnv({ JEV_BASE_URL: 'https://api.typesafe.ai' });
  const r = await runScript(route, { prompt: 'where is the rate limiter implemented?', session_id: 's', cwd: h.config }, h.env);
  assert.equal(r.stdout, '');
  assert.match(fs.readFileSync(path.join(h.data, 'errors.log'), 'utf8'), /non-loopback/);
});

test('a 100 KB prompt completes within budget (Review Focus 4)', async () => {
  const s = await jevServer(() => ({ body: { answers: { difficulty: { score: 2.2 }, agent: { choice: 'main', confidence: 0.9 }, verbose: { noul: 0.1 } } } }));
  const h = hookEnv({ JEV_BASE_URL: `http://127.0.0.1:${s.address().port}` });
  const t0 = Date.now();
  const r = await runScript(route, { prompt: 'refactor this module please '.repeat(4000), session_id: 's', cwd: h.config }, h.env);
  s.close();
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 7500);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test` → FAIL: scripts missing.

- [ ] **Step 3: Implement hooks, agents and wiring**

`plugins/jev-router/scripts/route-prompt.js`
```js
#!/usr/bin/env node
'use strict';
const path = require('path');
const { loadConfig, isLoopbackUrl } = require('../lib/config');
const { runHook, logError } = require('../lib/hookio');
const { loadCatalog } = require('../lib/catalog');
const { shortlist } = require('../lib/shortlist');
const heuristics = require('../lib/heuristics');
const { toHint } = require('../lib/policy');
const { decide, combine } = require('../lib/engine');
const { readReady } = require('../lib/engine/manifest');
const { appendCapped, fingerprint } = require('../lib/log');

const cfg = loadConfig();
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const round = x => Number((x || 0).toFixed(2));

runHook('route-prompt', 7000, async (input) => {
  if (cfg.mode !== 'advise') return null;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (heuristics.isTrivialPrompt(prompt)) return null;
  const useRemote = Boolean(cfg.jevBaseUrl) && isLoopbackUrl(cfg.jevBaseUrl);
  if (cfg.jevBaseUrl && !useRemote) {
    logError(cfg.dataDir, 'route-prompt', new Error('ignored non-loopback JEV_BASE_URL'));
    return null;
  }
  if (!useRemote && !readReady(cfg.dataDir)) return null;

  const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { agents } = loadCatalog({ configDir: cfg.configDir, projectDir, dataDir: cfg.dataDir, pluginRoot: PLUGIN_ROOT });
  const shortlisted = shortlist(agents, prompt, 12);
  const heur = heuristics.decide({ prompt, candidates: shortlisted });

  let final = null;
  let error;
  try {
    const d = await decide({ prompt, agents, shortlisted, cfg, useRemote });
    if (d) final = combine(d, heur);
  } catch (e) {
    error = e.message;
  }
  if (!final) final = { ...heur, source: 'heuristic-fallback' };

  const hint = toHint(final, { agentsByName: new Map(agents.map(a => [a.name, a])) });
  appendCapped(path.join(cfg.dataDir, 'decisions.jsonl'), {
    ts: new Date().toISOString(),
    session: input.session_id,
    prompt: fingerprint(prompt),
    source: final.source,
    difficulty: final.difficulty,
    conf: round(final.difficultyConf),
    agent: final.agent,
    agentConf: round(final.agentConf),
    hintChars: hint ? hint.length : 0,
    latencyMs: final.latencyMs || 0,
    ...(error ? { error } : {}),
  });
  return hint ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: hint } } : null;
}, cfg.dataDir);
```

`plugins/jev-router/scripts/session-start.js`
```js
#!/usr/bin/env node
'use strict';
const { loadConfig, isLoopbackUrl } = require('../lib/config');
const { runHook } = require('../lib/hookio');
const { readReady } = require('../lib/engine/manifest');

const cfg = loadConfig();

runHook('session-start', 3000, async () => {
  if (cfg.mode !== 'advise') return null;
  if (cfg.jevBaseUrl && isLoopbackUrl(cfg.jevBaseUrl)) return null;
  if (readReady(cfg.dataDir)) return null;
  return {
    systemMessage: 'jev-router: prompt routing is off until you run /jev-router:setup (one-time ~100 MB local engine; nothing leaves your machine). The tool guard is already active.',
  };
}, cfg.dataDir);
```

`plugins/jev-router/agents/quick.md`
```markdown
---
name: quick
description: Small, well-specified edits and one-fact lookups, such as renames, typo fixes, single-line changes, or "what does X return". Cheap and fast; reports back in two lines.
model: haiku
tools: Read, Edit, Write, Grep, Glob, Bash
---

You make small, precise changes at minimum cost.

- Locate before reading: Grep or Glob first, then Read only the lines you need (offset/limit).
- Make the smallest edit that satisfies the request. Do not refactor, reformat, or add features.
- If the task is bigger than a few lines, ambiguous, or risky, stop and report that instead of guessing.
- Reply in at most two lines: what changed and where (`path:line`), or the one fact that was asked for.
```

`plugins/jev-router/agents/scout.md`
```markdown
---
name: scout
description: Read-only search and short summaries. Finds where things are defined or used across many files and returns paths, line numbers and a brief summary, never whole files.
model: haiku
tools: Read, Grep, Glob
---

You find things in a codebase cheaply and report concisely.

- Use Grep and Glob to locate candidates; Read only small ranges (offset/limit) to confirm.
- Never paste whole files. Quote at most three short lines per finding.
- Reply with a list of `path:line — what is there`, then at most five bullet points of summary.
- If nothing is found, say which patterns you searched so the caller can adjust.
```

Add to `hooks/hooks.json` under `"hooks"`:
```json
"SessionStart": [
  {
    "matcher": "startup|resume|clear",
    "hooks": [
      { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.js\"", "timeout": 5 }
    ]
  }
],
"UserPromptSubmit": [
  {
    "hooks": [
      { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/route-prompt.js\"", "timeout": 8 }
    ]
  }
]
```

- [ ] **Step 4: Run tests** → `npm test` → all passing. Then run `claude plugin validate plugins/jev-router` → no errors.
- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(jev-router): prompt routing hook with hard gate, helper agents" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 11: Doctor

**Files:**
- Create: `plugins/jev-router/scripts/doctor.js`, `skills/doctor/SKILL.md`
- Test: `plugins/jev-router/test/doctor.test.js`

**Interfaces:**
- Consumes: config, manifest, catalog, `readTail`, `LocalEmbedder`.
- Produces: CLI `node scripts/doctor.js --data <dir>`, which prints a plain-text report and exits 0.

- [ ] **Step 1: Write the failing test**

`plugins/jev-router/test/doctor.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookEnv, write, SCRIPTS } = require('./helpers');

test('doctor reports engine state, agents, decisions and guard counts', () => {
  const h = hookEnv({ JEV_BASE_URL: 'https://api.typesafe.ai' });
  write(path.join(h.data, 'decisions.jsonl'), JSON.stringify({ ts: 't', source: 'heuristic-fallback', difficulty: 1, conf: 0.6, agent: null, agentConf: 0, hintChars: 40, latencyMs: 3, prompt: { len: 9, sha: 'abc' } }) + '\n');
  write(path.join(h.data, 'guard.jsonl'), '{"action":"deny"}\n{"action":"allowed-repeat"}\n{"action":"trim"}\n');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'doctor.js'), '--data', h.data], { env: { ...process.env, ...h.env }, encoding: 'utf8', cwd: h.config });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /engine: NOT INSTALLED/);
  assert.match(r.stdout, /JEV_BASE_URL: REFUSED/);
  assert.match(r.stdout, /agents: \d+ \(builtin 3/);
  assert.match(r.stdout, /heuristic-fallback diff=1/);
  assert.match(r.stdout, /guard: 1 denied, 1 allowed on repeat, 1 outputs trimmed/);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test` → FAIL: script missing.

- [ ] **Step 3: Implement**

`plugins/jev-router/scripts/doctor.js`
```js
#!/usr/bin/env node
'use strict';
const path = require('path');
const { loadConfig, isLoopbackUrl } = require('../lib/config');
const { readReady, enginePaths, MODEL, sha256File } = require('../lib/engine/manifest');
const { loadCatalog } = require('../lib/catalog');
const { readTail } = require('../lib/log');

function argData(argv) {
  const i = argv.indexOf('--data');
  return i >= 0 ? argv[i + 1] : null;
}

async function main() {
  const cfg = loadConfig();
  const dataDir = path.resolve(argData(process.argv.slice(2)) || cfg.dataDir);
  const out = ['jev-router doctor', `node ${process.version} · mode ${cfg.mode} · data ${dataDir}`];

  const ready = readReady(dataDir);
  if (!ready) {
    out.push('engine: NOT INSTALLED — run /jev-router:setup (prompt routing is off; the tool guard still works)');
  } else {
    const p = enginePaths(dataDir);
    const bad = MODEL.files.filter(f => {
      try { return sha256File(path.join(p.modelDir, f.local)) !== f.sha256; } catch { return true; }
    }).map(f => f.local);
    out.push(`engine: ready (revision ${ready.revision.slice(0, 7)}, installed ${ready.installedAt}, ${ready.platform})`);
    out.push(bad.length ? `  ✗ checksum mismatch: ${bad.join(', ')} — re-run /jev-router:setup` : '  ✓ model files match pinned checksums');
    try {
      const { LocalEmbedder } = require('../lib/engine/local');
      const t0 = Date.now();
      const e = await LocalEmbedder.create(dataDir);
      const t1 = Date.now();
      await e.embed('where is the rate limiter implemented?');
      out.push(`  ✓ self-test: model load ${t1 - t0} ms, one prompt ${Date.now() - t1} ms`);
    } catch (e) {
      out.push(`  ✗ self-test failed: ${e.message}`);
    }
  }

  if (cfg.jevBaseUrl) {
    out.push(`JEV_BASE_URL: ${isLoopbackUrl(cfg.jevBaseUrl) ? 'loopback ✓ (used instead of the built-in engine)' : 'REFUSED — not a loopback address'}`);
  }

  const cat = loadCatalog({ configDir: cfg.configDir, projectDir: process.cwd(), dataDir, pluginRoot: path.resolve(__dirname, '..') });
  const counts = Object.entries(cat.counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
  const dups = [...new Set(cat.duplicates)];
  out.push(`agents: ${cat.agents.length} (${counts})${dups.length ? ` · duplicates skipped: ${dups.join(', ')}` : ''}`);

  const decisions = readTail(path.join(dataDir, 'decisions.jsonl'), 10);
  out.push(`last ${decisions.length} decisions:`);
  for (const d of decisions) {
    out.push(`  ${d.ts} ${d.source} diff=${d.difficulty} (${d.conf}) agent=${d.agent || '-'} (${d.agentConf}) hint=${d.hintChars}c ${d.latencyMs}ms${d.error ? ` error=${d.error}` : ''}`);
  }

  const guard = readTail(path.join(dataDir, 'guard.jsonl'), 500);
  const c = guard.reduce((m, g) => { m[g.action] = (m[g.action] || 0) + 1; return m; }, {});
  out.push(`guard: ${c.deny || 0} denied, ${c['allowed-repeat'] || 0} allowed on repeat, ${c.trim || 0} outputs trimmed`);
  out.push('privacy: no prompt text is stored; the engine runs offline after setup.');
  process.stdout.write(out.join('\n') + '\n');
}

main().then(() => process.exit(0), e => { process.stdout.write(`jev-router doctor error: ${e.message}\n`); process.exit(0); });
```

`plugins/jev-router/skills/doctor/SKILL.md`
```markdown
---
description: Show jev-router's health — engine status and checksums, agent catalog size, recent routing decisions, guard activity. Use when the user invokes /jev-router:doctor or asks whether jev-router is working.
---

Run exactly this command with the Bash tool and show the user its output verbatim, then add one sentence on anything marked ✗ or NOT INSTALLED.

node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.js" --data "${CLAUDE_PLUGIN_DATA}"
```

- [ ] **Step 4: Run tests** → `npm test` → all passing. Then run `node plugins/jev-router/scripts/doctor.js --data .engine-test` → Expected: `engine: ready`, `✓ model files match`, `✓ self-test`.
- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(jev-router): /jev-router:doctor health report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 12: Engine integration tests and CI

**Files:**
- Create: `plugins/jev-router/test/engine.integration.test.js`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: a real engine installed at `JEV_ENGINE_DATA` (default `<repo>/.engine-test`).

- [ ] **Step 1: Write the integration test**

`plugins/jev-router/test/engine.integration.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { tmpDir } = require('./helpers');
const { readReady, enginePaths } = require('../lib/engine/manifest');
const { WordPiece } = require('../lib/engine/wordpiece');
const { VectorCache } = require('../lib/engine/vectors');
const { decideLocal } = require('../lib/engine');
const { shortlist } = require('../lib/shortlist');

const DATA = path.resolve(process.env.JEV_ENGINE_DATA || path.join(__dirname, '..', '..', '..', '.engine-test'));
const skip = readReady(DATA) ? false : `engine not installed at ${DATA} (run scripts/setup.js --data ${DATA})`;

const AGENTS = [
  ['Explore', 'Fast read-only search agent that locates code and files and answers where-is questions across many files', 'haiku'],
  ['jev-router:scout', 'Read-only search and short summaries with file paths and line numbers', 'haiku'],
  ['jev-router:quick', 'Small, well-specified edits such as renames, typo fixes and single-line changes', 'haiku'],
  ['code-reviewer', 'Reviews code changes for bugs, security and maintainability', 'inherit'],
  ['security-reviewer', 'Finds vulnerabilities, secrets, injection and OWASP issues', 'inherit'],
  ['build-error-resolver', 'Fixes build and type errors with minimal diffs', 'inherit'],
  ['tdd-guide', 'Writes tests first and enforces test-driven development', 'inherit'],
  ['planner', 'Produces implementation plans for complex features and migrations', 'inherit'],
  ['database-reviewer', 'PostgreSQL query optimisation, indexes, schema design and migrations', 'inherit'],
  ['doc-updater', 'Updates README files and documentation', 'inherit'],
  ['e2e-runner', 'Writes and runs Playwright end-to-end browser tests', 'inherit'],
].map(([name, description, model]) => ({ name, description, model, source: 'plugin' }));

const GOLDEN = [
  ['fix the typo in README line 3', ['jev-router:quick']],
  ['review my last commit for security problems', ['code-reviewer', 'security-reviewer']],
  ['the build fails with TS2345 in api/user.ts', ['build-error-resolver']],
  ['write tests for the idempotency layer before we refactor it', ['tdd-guide']],
  ['add an index to speed up the jobs query by status and created_at', ['database-reviewer']],
  ['rename getUser to fetchUser across the repo', ['jev-router:quick']],
  ['update the docs for the new env vars', ['doc-updater']],
  ['run the checkout flow e2e test and fix whatever breaks', ['e2e-runner']],
  ['plan the migration from REST to gRPC for internal services', ['planner']],
  ["is this SQL safe from injection? SELECT * FROM t WHERE id = '${id}'", ['security-reviewer']],
  ['find every place we read S3_CLIPS_BUCKET', ['Explore', 'jev-router:scout']],
  ['where is the rate limiter implemented?', ['Explore', 'jev-router:scout']],
  ['list all TODO comments', ['Explore', 'jev-router:scout']],
  ['design a multi-region failover architecture for our queue workers', ['planner', null]],
];

let embedder;
async function getEmbedder() {
  if (!embedder) embedder = await require('../lib/engine/local').LocalEmbedder.create(DATA);
  return embedder;
}

test('real tokenizer matches known BERT ids', { skip }, () => {
  const tok = new WordPiece(JSON.parse(fs.readFileSync(enginePaths(DATA).tokenizer, 'utf8')));
  assert.deepEqual(tok.encode('hello world'), [101, 7592, 2088, 102]);
});

test('golden routing set: precision of confident picks and warm latency', { skip }, async () => {
  const e = await getEmbedder();
  const cache = new VectorCache(path.join(tmpDir(), 'v.json'));
  let confident = 0;
  let correct = 0;
  const lat = [];
  for (const [prompt, allowed] of GOLDEN) {
    const d = await decideLocal({ prompt, agents: AGENTS, shortlisted: shortlist(AGENTS, prompt, 12), embedder: e, cache });
    lat.push(d.latencyMs);
    if (d.agentConf >= 0.55) {
      confident++;
      if (allowed.includes(d.agent)) correct++;
      else console.log(`  miss: "${prompt}" → ${d.agent} (${d.agentConf.toFixed(2)})`);
    }
  }
  const warm = lat.slice(1).sort((a, b) => a - b);
  const p95 = warm[Math.min(warm.length - 1, Math.floor(warm.length * 0.95))];
  console.log(`  confident ${confident}/${GOLDEN.length}, precision ${(correct / Math.max(1, confident)).toFixed(2)}, warm p50 ${warm[Math.floor(warm.length / 2)]} ms, p95 ${p95} ms`);
  assert.ok(confident >= 6, `only ${confident} confident picks`);
  assert.ok(correct / confident >= 0.8, `precision ${correct}/${confident}`);
  assert.ok(p95 < 150, `warm p95 ${p95} ms`);
});

test('non-English prompts do not crash the engine (Review Focus 4)', { skip }, async () => {
  const e = await getEmbedder();
  const cache = new VectorCache(path.join(tmpDir(), 'v.json'));
  for (const prompt of ['रेट लिमिटर कहाँ लागू किया गया है?', '把登录函数重命名为 signIn', 'Où est défini le gestionnaire de connexion ?']) {
    const d = await decideLocal({ prompt, agents: AGENTS, shortlisted: [], embedder: e, cache });
    assert.ok(d.difficulty >= 0 && d.difficulty <= 3);
  }
});

test('engine makes no network calls (privacy guarantee)', { skip }, async () => {
  const e = await getEmbedder();
  const boom = () => { throw new Error('network call attempted'); };
  const saved = { fetch: globalThis.fetch, http: http.request, https: https.request, connect: net.connect };
  globalThis.fetch = boom; http.request = boom; https.request = boom; net.connect = boom;
  try {
    const d = await decideLocal({ prompt: 'update the readme', agents: AGENTS, shortlisted: [], embedder: e, cache: new VectorCache(path.join(tmpDir(), 'v.json')) });
    assert.ok(d);
  } finally {
    globalThis.fetch = saved.fetch; http.request = saved.http; https.request = saved.https; net.connect = saved.connect;
  }
});
```

- [ ] **Step 2: Run it locally**

Run: `npm run test:engine`
Expected: 4 passing, plus a printed line such as `confident N/14, precision ≥0.80, warm p50 … p95 …`.
**If precision is below 0.8:** read the printed misses and tune, in order: (a) the `MAIN` description, (b) the softmax temperature used for `choice` (try 0.04 and 0.07), (c) the 0.55 delegate threshold in `policy.js` together with the threshold in this test. Re-run, and record the chosen values in spec §6.3. Do not lower the 0.8 precision bar.

- [ ] **Step 3: CI workflow**

`.github/workflows/ci.yml`
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - name: Unit and hook tests
        run: npm test
      - name: Engine setup (run twice to prove idempotence)
        run: |
          node plugins/jev-router/scripts/setup.js --data .engine-test
          node plugins/jev-router/scripts/setup.js --data .engine-test
      - name: Engine integration tests
        run: npm run test:engine
        env:
          JEV_ENGINE_DATA: .engine-test
      - name: Doctor smoke test
        run: node plugins/jev-router/scripts/doctor.js --data .engine-test

  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Validate plugin and marketplace manifests
        run: |
          npx -y @anthropic-ai/claude-code plugin validate --strict plugins/jev-router
          npx -y @anthropic-ai/claude-code plugin validate --strict .
```

Run locally: `claude plugin validate --strict plugins/jev-router` and `claude plugin validate --strict .` → Expected: clean. Fix anything `--strict` flags before committing.

- [ ] **Step 4: Commit** → `git add -A && git commit -m "test(jev-router): real-engine integration tests and CI on Linux and Windows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 13: End-to-end verification, docs, PR

**Files:**
- Create: `plugins/jev-router/README.md`
- Modify: `README.md` (install instructions); `plugins/jev-router/.claude-plugin/plugin.json`, `lib/config.js` and the affected tests (`trim_output_lines` default, only if Step 3 confirms the shape); spec §7 (trim status)

- [ ] **Step 1: Install from the repo path into a throwaway config**

Run (bash):
```bash
T=$(mktemp -d) && CLAUDE_CONFIG_DIR=$T claude plugin marketplace add "$PWD" && CLAUDE_CONFIG_DIR=$T claude plugin install jev-router@claude-token-plugins && CLAUDE_CONFIG_DIR=$T claude plugin list; rm -rf "$T"
```
Expected: jev-router is listed as installed and enabled. Record the output.

- [ ] **Step 2: Headless end to end: before setup**

```bash
claude --plugin-dir plugins/jev-router --model haiku -p "reply with the single word ok" --output-format stream-json --verbose > "$TMPDIR/jr-e2e-1.jsonl"
grep -c "prompt routing is off" "$TMPDIR/jr-e2e-1.jsonl"; ls ~/.claude/plugins/data/
```
Expected: count ≥ 1 (the SessionStart systemMessage appears in the stream). Note the inline plugin's data dir name from the listing (expected `jev-router-inline`) and use it as `$D` below. If the reminder is not in the stream, confirm the hook fired from `claude --debug` output instead.

- [ ] **Step 3: Headless end to end: guard, routing, PostToolUse shape**

```bash
D="$HOME/.claude/plugins/data/jev-router-inline"
node plugins/jev-router/scripts/setup.js --data "$D"
node -e "require('fs').writeFileSync(require('os').tmpdir()+'/jr-big.txt','line\n'.repeat(2000))"
JEV_ROUTER_DUMP_POSTTOOL=1 claude --plugin-dir plugins/jev-router --model haiku -p "Read the file $(node -p "require('os').tmpdir()")/jr-big.txt in full with the Read tool, without offset or limit. If it is refused, repeat exactly the same Read call once. Then run the bash command: seq 1 5. Reply with the number of lines you saw." --output-format stream-json --verbose --allowedTools "Read,Bash(seq:*)" > "$TMPDIR/jr-e2e-2.jsonl"
cat "$D/guard.jsonl"; cat "$D/decisions.jsonl"; cat "$D/posttool-sample.json"
```
Expected:
- `guard.jsonl`: one `deny` followed by one `allowed-repeat`;
- `decisions.jsonl`: at least one record with `"source":"engine"` and no prompt text;
- `posttool-sample.json`: the real Bash `tool_response` shape.

**Trim gate:** if `responseKeys` include `stdout`, or `responseType` is `string`, the shape matches `trimResponse`. In that case:
- set the `trim_output_lines` default to `600` in `plugin.json`, and the `loadConfig` default to `600`;
- update the tests: config `trimOutputLines` becomes 600, and the "disabled by default" trim hook test now passes `CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES: '0'` for the off case, with `hookEnv()` defaulting to trimming;
- set spec §7 to "enabled (shape confirmed 2026-09-29)".

Otherwise leave it at `0` and write the observed shape in spec §7. Re-run `npm test`.

- [ ] **Step 4: Docs**

`plugins/jev-router/README.md` sections:
- **What it does**: routing hints (example hint line), the guard rules table, and deny-once behaviour.
- **Install**:
  - `/plugin marketplace add Aneesh-IncuBrix/CORTEX`
  - `/plugin install jev-router@claude-token-plugins`
  - `/jev-router:setup`
- **Privacy**: nothing leaves the device after setup; the setup downloads (npm + Hugging Face, pinned and checksummed); Claude Code itself still talks to Anthropic.
- **Configuration**: the userConfig table and `JEV_BASE_URL` (loopback-only).
- **Commands**: `/jev-router:setup [--uninstall]`, `/jev-router:doctor`.
- **Troubleshooting**:
  - the setup reminder keeps appearing (run setup and check the doctor);
  - Windows Smart App Control (onnxruntime binaries are Microsoft-signed);
  - offline machines (copy `engine/` from a machine with the same OS/arch);
  - `errors.log` location.
- **Known limitations**:
  - hooks cannot switch the model; hints are advice Claude may ignore;
  - accuracy figures come from a 14-prompt golden set, not a benchmark;
  - quote-unaware Bash parsing.

Root `README.md`: set the jev-router status to "Available", and add the three install commands and a link to the plugin README.

- [ ] **Step 5: Full verification before pushing (universal rule §9)**

Run: `npm test && npm run test:engine && claude plugin validate --strict plugins/jev-router && claude plugin validate --strict .`
Expected: everything passes. Check `git status` for strays, and confirm `.engine-test/` is ignored.

- [ ] **Step 6: Commit, push, open the PR, watch CI**

```bash
git add -A && git commit -m "docs(jev-router): README, e2e-verified defaults" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/jev-router
gh pr create --base main --title "jev-router: local JEV-style prompt router and token guard" --body "<summary + verification results + 🤖 Generated with [Claude Code](https://claude.com/claude-code)>"
gh pr checks --watch
```
Expected: all four `test` matrix jobs plus `validate` are green. If a job fails, fix it on the branch and push again. "Done" means green CI plus the verified headless run.
