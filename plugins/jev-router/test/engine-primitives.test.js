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
const { MODEL, enginePaths, readReady, readinessState, fileUrl, ENGINE_VERSION } = require('../lib/engine/manifest');

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

test('manifest: pinned revision, URLs (incl. mirror) and READY validation', () => {
  assert.equal(MODEL.revision, '751bff37182d3f1213fa05d7196b954e230abad9');
  assert.equal(fileUrl(MODEL.files[0], ''), 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/onnx/model_quantized.onnx');
  assert.equal(fileUrl(MODEL.files[1], 'https://hf-mirror.example/'), 'https://hf-mirror.example/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer.json');
  const data = tmpDir();
  assert.equal(readReady(data), null);
  const p = enginePaths(data);
  write(p.model, 'x'); write(p.tokenizer, '{}'); write(path.join(p.ortModule, 'package.json'), '{}');
  write(p.ready, JSON.stringify({ engineVersion: ENGINE_VERSION, revision: MODEL.revision }));
  assert.ok(readReady(data));
  write(p.ready, JSON.stringify({ engineVersion: ENGINE_VERSION, revision: 'other' }));
  assert.equal(readReady(data), null);
});

test('readinessState distinguishes missing, stale, broken, lite and ready (U12)', () => {
  const data = tmpDir();
  const p = enginePaths(data);
  assert.equal(readinessState(data).state, 'missing');
  write(p.ready, JSON.stringify({ engineVersion: ENGINE_VERSION - 1, revision: MODEL.revision }));
  assert.equal(readinessState(data).state, 'stale');
  write(p.ready, JSON.stringify({ engineVersion: ENGINE_VERSION, revision: MODEL.revision }));
  assert.equal(readinessState(data).state, 'broken');
  write(p.ready, JSON.stringify({ engineVersion: ENGINE_VERSION, mode: 'lite', reason: 'no binary' }));
  assert.equal(readinessState(data).state, 'lite');
  write(p.ready, JSON.stringify({ engineVersion: ENGINE_VERSION, revision: MODEL.revision }));
  write(p.model, 'x'); write(p.tokenizer, '{}'); write(path.join(p.ortModule, 'package.json'), '{}');
  assert.equal(readinessState(data).state, 'ready');
});
