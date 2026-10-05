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

test('circuit breaker: after 5 denials in a session the guard stands down (U3)', async () => {
  const h = hookEnv();
  const files = [1, 2, 3, 4, 5, 6].map(i => write(path.join(h.data, `big${i}.txt`), 'x\n'.repeat(2000)));
  const outs = [];
  for (const f of files) outs.push(await runScript(script, { session_id: 'b1', tool_name: 'Read', tool_input: { file_path: f }, cwd: h.data }, h.env));
  assert.equal(outs.slice(0, 5).filter(o => o.json && o.json.hookSpecificOutput.permissionDecision === 'deny').length, 5);
  assert.equal(outs[5].stdout, '');
  assert.match(fs.readFileSync(path.join(h.data, 'guard.jsonl'), 'utf8'), /"action":"breaker-open"/);
  const fresh = await runScript(script, { session_id: 'b2', tool_name: 'Read', tool_input: { file_path: files[5] }, cwd: h.data }, h.env);
  assert.equal(fresh.json.hookSpecificOutput.permissionDecision, 'deny');
});

test('guard log records the subagent type when a subagent made the call (U6)', async () => {
  const h = hookEnv();
  const big = write(path.join(h.data, 'big.txt'), 'x\n'.repeat(2000));
  await runScript(script, { session_id: 's', agent_id: 'a1', agent_type: 'Explore', tool_name: 'Read', tool_input: { file_path: big }, cwd: h.data }, h.env);
  assert.match(fs.readFileSync(path.join(h.data, 'guard.jsonl'), 'utf8'), /"agent":"Explore"/);
});
