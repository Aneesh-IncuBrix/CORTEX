'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookEnv, write, SCRIPTS } = require('./helpers');
const { enginePaths, ENGINE_VERSION } = require('../lib/engine/manifest');

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
  assert.match(r.stdout, /guard: 1 denied, 1 allowed on repeat, 0 after the per-session limit, 1 outputs trimmed/);
  assert.match(r.stdout, /run it in your own terminal: node ".*setup\.js" --data "/);
  assert.match(r.stdout, /npm .+ · (win32|linux|darwin)-/);
});

test('doctor names lite and stale states with their next step (U8, U12)', () => {
  const h = hookEnv();
  const run = () => spawnSync(process.execPath, [path.join(SCRIPTS, 'doctor.js'), '--data', h.data], { env: { ...process.env, ...h.env }, encoding: 'utf8', cwd: h.config }).stdout;
  const ready = enginePaths(h.data).ready;
  write(ready, JSON.stringify({ engineVersion: ENGINE_VERSION, mode: 'lite', reason: 'no binary for darwin-x64' }));
  assert.match(run(), /LITE MODE — routing uses built-in rules \(reason: no binary for darwin-x64\)/);
  write(ready, JSON.stringify({ engineVersion: ENGINE_VERSION - 1, revision: 'old' }));
  assert.match(run(), /UPDATE REQUIRED/);
});

test('doctor warns about other plugins rewriting Bash output when trimming is on (U19)', () => {
  const h = hookEnv({ CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES: '600' });
  const other = path.join(h.config, 'plugins', 'cache', 'mk', 'rewriter', '1.0.0');
  write(path.join(other, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash|Edit', hooks: [] }] } }));
  write(path.join(h.config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'rewriter@mk': [{ scope: 'user', installPath: other }] } }));
  write(path.join(h.config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'rewriter@mk': true } }));
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'doctor.js'), '--data', h.data], { env: { ...process.env, ...h.env }, encoding: 'utf8', cwd: h.config });
  assert.match(r.stdout, /⚠ output trimming is on and rewriter also rewrite Bash output/);
});
