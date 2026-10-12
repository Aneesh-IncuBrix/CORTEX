'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { knnDifficulty } = require('../lib/engine/knn');
const { combine } = require('../lib/engine');
const { readTurns, usageCost, promptText } = require('../lib/transcripts');
const { report } = require('../scripts/savings-report');

test('knn picks the level of the nearest labelled prompts', () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push({ l: 1, v: [1, 0] }, { l: 3, v: [0, 1] });
  assert.strictEqual(knnDifficulty([0.9, 0.1], items, 10).level, 1);
  assert.strictEqual(knnDifficulty([0.1, 0.9], items, 10).level, 3);
});

test('combine ignores the keyword heuristic when difficulty came from kNN', () => {
  const engine = { source: 'engine-knn', difficultyDist: [0, 0.3, 0.45, 0.25] };
  assert.strictEqual(combine(engine, { difficulty: 1 }).difficulty, 2);
  assert.strictEqual(combine({ ...engine, source: 'engine' }, { difficulty: 1 }).difficulty, 1);
});

test('usageCost prices cache writes and reads', () => {
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } };
  assert.strictEqual(usageCost('claude-opus-5-5', u), 4 + 20 + 0.2 + 8);
});

test('promptText accepts IDE text blocks and rejects tool results and tags', () => {
  const u = content => ({ type: 'user', message: { content } });
  assert.strictEqual(promptText(u([{ type: 'text', text: '<ide_selection>x</ide_selection>' }, { type: 'text', text: 'fix it' }])), 'fix it');
  assert.strictEqual(promptText(u([{ type: 'tool_result', content: 'x' }])), null);
  assert.strictEqual(promptText(u('<task-notification>')), null);
});

function writeSession(dir, session, prompt, model) {
  const rows = [
    { type: 'user', sessionId: session, timestamp: '2026-10-10T00:00:00Z', message: { content: prompt } },
    { type: 'assistant', sessionId: session, message: { id: `m-${session}`, model, usage: { output_tokens: 1e6 }, content: [{ type: 'tool_use' }] } },
    { type: 'assistant', sessionId: session, message: { id: `m-${session}`, model, usage: { output_tokens: 1e6 }, content: [{ type: 'text' }] } },
  ];
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n'));
}

test('readTurns counts each response once and savings report splits arms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-tx-'));
  writeSession(dir, 'a', 'hello there', 'claude-opus-5-5');
  writeSession(dir, 'b', 'hello again', 'claude-haiku-5-5');
  const [t] = readTurns(path.join(dir, 'a.jsonl'));
  assert.strictEqual(t.cost, 20);
  assert.strictEqual(t.tools, 1);
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), JSON.stringify({ session: 'b', hintChars: 40 }));
  const r = report({ projectsDir: dir, dataDir: dir });
  assert.strictEqual(r.arms.routed.prompts, 1);
  assert.strictEqual(r.arms.baseline.cost, 20);
  assert.ok(r.savingPct > 90);
  fs.rmSync(dir, { recursive: true, force: true });
});
