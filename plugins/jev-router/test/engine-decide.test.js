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

test('big catalogs warm up at most 40 new agent vectors per call (U14)', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `agent-${i}`, description: `specialist number ${i} for topic${i}`, model: 'inherit', source: 'plugin' }));
  const cache = new VectorCache(path.join(tmpDir(), 'v.json'));
  const first = await decideLocal({ prompt: 'help with topic7', agents: many, shortlisted: [], embedder: fakeEmbedder, cache });
  assert.equal(first.skippedAgents, 20);
  const second = await decideLocal({ prompt: 'help with topic7', agents: many, shortlisted: [], embedder: fakeEmbedder, cache });
  assert.equal(second.skippedAgents, 0);
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
