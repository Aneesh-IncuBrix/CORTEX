'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpDir, write } = require('./helpers');
const { pruneOtherPlatforms, downloadVerified, parseArgs, preflight, acquireLock, platformSupported, importFromDir, downloadHelp } = require('../scripts/setup');

const bytes = Buffer.from('model-bytes');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const okFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--data', '/d', '--uninstall']), { data: '/d', uninstall: true, lite: false, modelDir: null });
  assert.deepEqual(parseArgs([]), { data: null, uninstall: false, lite: false, modelDir: null });
  assert.deepEqual(parseArgs(['--lite', '--model-dir', 'm']), { data: null, uninstall: false, lite: true, modelDir: 'm' });
});

test('preflight: npm check, writability (U2, U10)', () => {
  const dir = tmpDir();
  assert.deepEqual(preflight(dir, { spawn: () => ({ status: 0 }) }), []);
  assert.match(preflight(dir, { spawn: () => ({ status: 1 }) }).join('\n'), /npm was not found.*--lite/);
  assert.deepEqual(preflight(dir, { needNpm: false, spawn: () => { throw new Error('must not spawn'); } }), []);
  const file = write(path.join(dir, 'a-file'), 'x');
  assert.match(preflight(path.join(file, 'sub'), { needNpm: false }).join('\n'), /Cannot write to/);
});

test('acquireLock: exclusive, stale locks expire, release frees it (U10)', () => {
  const root = tmpDir();
  const release = acquireLock(root);
  assert.throws(() => acquireLock(root), /already running/);
  release();
  const again = acquireLock(root);
  const lock = path.join(root, '.setup.lock');
  const old = (Date.now() - 11 * 60 * 1000) / 1000;
  fs.utimesSync(lock, old, old);
  const stolen = acquireLock(root);
  stolen();
  assert.equal(fs.existsSync(lock), false);
  again();
});

test('platformSupported reads the shipped binary folders (U8)', () => {
  const ort = tmpDir();
  write(path.join(ort, 'bin', 'napi-v6', 'darwin', 'arm64', 'x.node'), 'x');
  assert.equal(platformSupported(ort, 'darwin', 'arm64'), true);
  assert.equal(platformSupported(ort, 'darwin', 'x64'), false);
  assert.equal(platformSupported(path.join(ort, 'none'), 'linux', 'x64'), false);
});

test('importFromDir copies only checksum-matching files (U9)', () => {
  const src = tmpDir();
  const dest = path.join(tmpDir(), 'model', 'model.onnx');
  const f = { remote: 'onnx/model_quantized.onnx', local: 'model.onnx', sha256: sha };
  write(path.join(src, 'model_quantized.onnx'), bytes);
  importFromDir(src, dest, f);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'model-bytes');
  assert.throws(() => importFromDir(src, dest, { ...f, sha256: '0'.repeat(64) }), /checksum mismatch/);
  assert.throws(() => importFromDir(tmpDir(), dest, f), /not found/);
});

test('downloadHelp gives proxy, mirror and manual-download guidance (U9)', () => {
  const msg = downloadHelp(new Error('ECONNRESET'), { HTTPS_PROXY: 'http://proxy:8080' });
  assert.match(msg, /NODE_USE_ENV_PROXY=1/);
  assert.match(msg, /HF_ENDPOINT/);
  assert.match(msg, /resolve\/751bff37182d3f1213fa05d7196b954e230abad9\/tokenizer\.json/);
  assert.doesNotMatch(downloadHelp(new Error('x'), {}), /NODE_USE_ENV_PROXY/);
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
