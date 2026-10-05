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
