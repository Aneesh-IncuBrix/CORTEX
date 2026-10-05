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
