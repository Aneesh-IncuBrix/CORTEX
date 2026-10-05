'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { appendCapped, readTail, fingerprint } = require('../lib/log');
const { keyFor, seenBefore, canonical, deniesSoFar, bumpDenies } = require('../lib/ledger');

test('appendCapped trims to newest 500 once over 600', () => {
  const f = path.join(tmpDir(), 'd.jsonl');
  for (let i = 0; i < 601; i++) appendCapped(f, { i });
  const rows = readTail(f, 1000);
  assert.equal(rows.length, 500);
  assert.equal(rows[0].i, 101);
  assert.equal(rows[rows.length - 1].i, 600);
});

test('readTail tolerates missing files and bad lines', () => {
  const dir = tmpDir();
  assert.deepEqual(readTail(path.join(dir, 'nope.jsonl'), 5), []);
  const f = path.join(dir, 'x.jsonl');
  fs.writeFileSync(f, '{"a":1}\nnot json\n{"a":2}\n');
  assert.deepEqual(readTail(f, 5), [{ a: 1 }, { a: 2 }]);
});

test('fingerprint never contains the text', () => {
  const fp = fingerprint('my secret prompt');
  assert.equal(fp.len, 16);
  assert.match(fp.sha, /^[0-9a-f]{10}$/);
  assert.ok(!JSON.stringify(fp).includes('secret'));
});

test('keyFor is order-insensitive for object keys', () => {
  assert.equal(keyFor('Read', { a: 1, b: 2 }), keyFor('Read', { b: 2, a: 1 }));
  assert.notEqual(keyFor('Read', { a: 1 }), keyFor('Bash', { a: 1 }));
  assert.equal(canonical({ b: [1, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[1,{"c":2,"d":1}]}');
});

test('seenBefore: first call records, repeat returns true, sessions isolated', () => {
  const dir = tmpDir();
  const k = keyFor('Read', { file_path: 'x' });
  assert.equal(seenBefore(dir, 's1', k), false);
  assert.equal(seenBefore(dir, 's1', k), true);
  assert.equal(seenBefore(dir, 's2', k), false);
  assert.equal(seenBefore(dir, '../evil/..', k), false);
  assert.ok(fs.readdirSync(path.join(dir, 'ledger')).every(f => /^[\w-]+\.json$/.test(f)));
});

test('seenBefore prunes ledger files older than 48h', () => {
  const dir = tmpDir();
  seenBefore(dir, 'old', 'k1');
  const old = path.join(dir, 'ledger', 'old.json');
  const past = (Date.now() - 49 * 3600 * 1000) / 1000;
  fs.utimesSync(old, past, past);
  seenBefore(dir, 'new', 'k2');
  assert.equal(fs.existsSync(old), false);
});

test('deny counter is per session and starts at zero (circuit breaker, U3)', () => {
  const dir = tmpDir();
  assert.equal(deniesSoFar(dir, 's1'), 0);
  assert.equal(bumpDenies(dir, 's1'), 1);
  assert.equal(bumpDenies(dir, 's1'), 2);
  assert.equal(deniesSoFar(dir, 's1'), 2);
  assert.equal(deniesSoFar(dir, 's2'), 0);
});
