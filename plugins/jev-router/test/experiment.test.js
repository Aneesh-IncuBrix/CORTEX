'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SCRIPTS, runScript, hookEnv, write, tmpDir } = require('./helpers');
const { armOf, readArms, recordArm, contextNote } = require('../lib/experiment');
const { lastContextTokens, readTurns } = require('../lib/transcripts');
const { labelOf } = require('../scripts/build-labels');
const { report } = require('../scripts/savings-report');

const route = path.join(SCRIPTS, 'route-prompt.js');
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n');
const usageRow = (tokens, extra = {}) => ({ type: 'assistant', message: { id: `m${Math.random()}`, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, output_tokens: 5 }, content: [] }, ...extra });

test('armOf is stable per session and close to the requested share', () => {
  assert.equal(armOf('abc', 10), armOf('abc', 10));
  assert.equal(armOf('abc', 0), 'routed');
  assert.equal(armOf(undefined, 50), 'routed');
  let held = 0;
  for (let i = 0; i < 2000; i++) if (armOf(`s-${i}`, 10) === 'holdout') held++;
  assert.ok(held > 140 && held < 260, `holdout share ${held}/2000`);
});

test('recordArm writes each session once', () => {
  const dir = tmpDir();
  recordArm(dir, 's1', 'holdout');
  recordArm(dir, 's1', 'routed');
  recordArm(dir, 's2', 'routed');
  assert.deepEqual([...readArms(dir)], [['s1', 'holdout'], ['s2', 'routed']]);
});

test('contextNote warns at the threshold, then once per new 50k band', () => {
  assert.equal(contextNote(100000, 150000, 0, 0.2), null);
  const a = contextNote(160000, 150000, 0, 0.2);
  assert.equal(a.band, 3);
  assert.match(a.note, /160k tokens.*\$0\.03/);
  assert.equal(contextNote(170000, 150000, 3, 0.2), null);
  assert.equal(contextNote(205000, 150000, 3, 0.2).band, 4);
  assert.equal(contextNote(900000, 0, 0, 0.2), null);
});

test('lastContextTokens reads the last main-thread response from the file tail', () => {
  const dir = tmpDir();
  const f = write(path.join(dir, 't.jsonl'), jsonl([usageRow(1000), usageRow(180000), usageRow(50, { isSidechain: true })]));
  assert.deepEqual(lastContextTokens(f), { model: 'claude-opus-5-5', tokens: 180000 });
  assert.deepEqual(lastContextTokens(path.join(dir, 'missing.jsonl')), { model: null, tokens: 0 });
});

test('a pushback prompt marks the previous turn corrected and raises its label', () => {
  const dir = tmpDir();
  const f = write(path.join(dir, 's.jsonl'), jsonl([
    { type: 'user', sessionId: 's', message: { content: 'rename foo to bar' } }, usageRow(100),
    { type: 'user', sessionId: 's', message: { content: "no, that's wrong, it broke the build" } }, usageRow(100),
    { type: 'user', sessionId: 's', message: { content: 'thanks, now add docs' } }, usageRow(100),
  ]));
  assert.deepEqual(readTurns(f).map(t => Boolean(t.corrected)), [true, false, false]);
  assert.equal(labelOf({ tools: 1, outTokens: 100, corrected: true }), 2);
  assert.equal(labelOf({ tools: 30, outTokens: 100, corrected: true }), 3);
});

test('report compares against the holdout once it has enough prompts, with quality', () => {
  const dir = tmpDir();
  const rows = (s, n, cost) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ type: 'user', sessionId: s, timestamp: '2026-10-10T00:00:00Z', message: { content: i % 10 === 9 ? 'no, wrong' : `task ${i}` } });
      out.push({ type: 'assistant', sessionId: s, message: { id: `${s}-${i}`, model: 'claude-opus-5-5', usage: { output_tokens: cost * 50000 }, content: [] } });
    }
    return jsonl(out);
  };
  write(path.join(dir, 'r.jsonl'), rows('r', 120, 1));
  write(path.join(dir, 'h.jsonl'), rows('h', 120, 2));
  write(path.join(dir, 'arms.jsonl'), jsonl([{ session: 'r', arm: 'routed' }, { session: 'h', arm: 'holdout' }]));
  const r = report({ projectsDir: dir, dataDir: dir });
  assert.equal(r.controlled, true);
  assert.equal(Math.round(r.savingPct), 50);
  assert.equal(r.arms.routed.corrections, 12);
  assert.equal(r.qualityDelta, 0);
});

test('hook: holdout sessions get nothing; routed sessions get the context warning even before setup', async () => {
  const h = hookEnv({ CLAUDE_PLUGIN_OPTION_HOLDOUT_PERCENT: '50' });
  const t = write(path.join(h.data, 'big.jsonl'), jsonl([usageRow(200000)]));
  let routed;
  let holdout;
  for (let i = 0; i < 40; i++) {
    if (armOf(`x${i}`, 50) === 'holdout') holdout = holdout || `x${i}`;
    else routed = routed || `x${i}`;
  }
  const a = await runScript(route, { prompt: 'refactor the billing module', session_id: routed, transcript_path: t, cwd: h.data }, h.env);
  assert.match(a.json.hookSpecificOutput.additionalContext, /context ~200k tokens/);
  const again = await runScript(route, { prompt: 'and the tests', session_id: routed, transcript_path: t, cwd: h.data }, h.env);
  assert.equal(again.json, null, 'same band must not warn twice');
  const b = await runScript(route, { prompt: 'refactor the billing module', session_id: holdout, transcript_path: t, cwd: h.data }, h.env);
  assert.equal(b.json, null);
  assert.deepEqual([...readArms(h.data)].map(x => x[1]).sort(), ['holdout', 'routed']);
  fs.rmSync(h.data, { recursive: true, force: true });
});
