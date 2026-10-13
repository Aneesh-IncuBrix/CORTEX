'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir, write } = require('./helpers');
const { collect, verdict, html } = require('../scripts/dashboard');

const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n');
function session(id, day, n, costEach, pushEvery) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ type: 'user', sessionId: id, timestamp: `${day}T10:${String(i % 60).padStart(2, '0')}:00.000Z`, message: { content: pushEvery && i % pushEvery === pushEvery - 1 ? 'no, wrong' : `task ${i}` } });
    rows.push({ type: 'assistant', sessionId: id, message: { id: `${id}-${i}`, model: 'claude-opus-5-5', usage: { output_tokens: costEach * 50000 }, content: [] } });
  }
  return jsonl(rows);
}

test('collect splits before/after install by time and arm, and the verdict uses cost per accepted answer', () => {
  const dir = tmpDir();
  write(path.join(dir, 'p', 'old.jsonl'), session('old', '2026-10-01', 120, 2, 10));
  write(path.join(dir, 'p', 'new.jsonl'), session('new', '2026-10-10', 120, 1, 10));
  write(path.join(dir, 'p', 'bad.jsonl'), jsonl([{ type: 'user', sessionId: 'x', timestamp: '<img src=x onerror=alert(1)>', message: { content: 'hi there' } }]));
  write(path.join(dir, 'arms.jsonl'), jsonl([{ ts: '2026-10-05T00:00:00.000Z', session: 'new', arm: 'routed' }]));
  const d = collect({ projectsDir: path.join(dir, 'p'), dataDir: dir, days: 60, now: new Date('2026-10-13T00:00:00Z') });
  assert.equal(d.install, '2026-10-04T23:59:00.000Z');
  assert.equal(d.phases.before.prompts, 120);
  assert.equal(d.phases.routed.prompts, 120);
  assert.equal(d.verdict.ready, true);
  assert.equal(Math.round(d.verdict.saving * 100), 50);
  assert.equal(d.verdict.qualityPts, 0);
  assert.match(d.verdict.text, /50\.0% cheaper.*quality held/);
  assert.ok(!html(d).includes('onerror'), 'malformed timestamp must not reach the page');
});

test('collect counts every billed response once: subagents, no-prompt calls, resumed copies, web search', () => {
  const dir = tmpDir();
  const ts = '2026-10-10T10:00:00.000Z';
  const resp = (id, out, extra = {}) => ({ type: 'assistant', sessionId: 's', timestamp: ts, message: { id, model: 'claude-opus-5-5', usage: { output_tokens: out, ...extra }, content: [] } });
  const main = [
    resp('compact', 50000), // before any typed prompt (e.g. compaction): $1
    { type: 'user', uuid: 'u1', sessionId: 's', timestamp: ts, message: { content: 'do the thing' } },
    resp('a', 100000), // $2
    resp('a', 100000), // same response, second content block: not billed twice
    resp('w', 0, { server_tool_use: { web_search_requests: 3 } }), // $0.03
  ];
  write(path.join(dir, 'p', 's.jsonl'), jsonl(main));
  write(path.join(dir, 'p', 's', 'subagents', 'agent-1.jsonl'), jsonl([resp('sub', 25000)])); // $0.50
  const resumed = write(path.join(dir, 'p', 'resumed.jsonl'), jsonl(main)); // resume copies history
  const later = new Date(Date.now() + 5000);
  require('fs').utimesSync(resumed, later, later);
  const d = collect({ projectsDir: path.join(dir, 'p'), dataDir: dir, days: 60, now: new Date('2026-10-13T00:00:00Z') });
  assert.equal(d.phases.before.prompts, 1);
  assert.equal(Math.round(d.phases.before.cost * 100), 353);
});

test('verdict refuses to claim a saving on little data, and flags a quality drop', () => {
  const p = (prompts, cost, corrections) => ({ prompts, cost, corrections, pushback: corrections / prompts, perAccepted: cost / (prompts - corrections) });
  assert.equal(verdict({ before: p(200, 200, 2), routed: p(20, 5, 0), holdout: p(0, 0, 0) }).ready, false);
  assert.match(verdict({ before: p(200, 200, 2), routed: p(200, 100, 20), holdout: p(0, 0, 0) }).text, /quality DROPPED/);
});
