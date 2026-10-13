'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir, write } = require('./helpers');
const { evaluate, countLines } = require('../lib/guard-rules');

const dir = tmpDir('jr guard ');            // space in path on purpose (Review Focus 2)
const big = write(path.join(dir, 'sub dir', 'big.log'), 'line\n'.repeat(1000));
const small = write(path.join(dir, 'small.txt'), 'a\nb\n');
const bin = write(path.join(dir, 'blob.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(5000, 10)]));
const ctx = { readLineCap: 800, cwd: dir };

test('Read: denies full read of a big file, with size and token estimate', () => {
  const r = evaluate('Read', { file_path: big }, ctx);
  assert.match(r.deny, /big\.log has 1001 lines \(~1,250 tokens\)/);
  assert.match(r.deny, /or the user asked for it\), re-issue the identical call to proceed\.$/);
});

test('Read: relative path resolves against cwd', () => {
  assert.ok(evaluate('Read', { file_path: path.join('sub dir', 'big.log') }, ctx));
});

test('Read: allowed with offset/limit, small files, images, binaries, missing files', () => {
  assert.equal(evaluate('Read', { file_path: big, limit: 100 }, ctx), null);
  assert.equal(evaluate('Read', { file_path: big, offset: 1 }, ctx), null);
  assert.equal(evaluate('Read', { file_path: small }, ctx), null);
  assert.equal(evaluate('Read', { file_path: path.join(dir, 'x.png') }, ctx), null);
  assert.equal(evaluate('Read', { file_path: bin }, ctx), null);
  assert.equal(evaluate('Read', { file_path: path.join(dir, 'missing.txt') }, ctx), null);
  assert.equal(evaluate('Read', {}, ctx), null);
});

test('countLines detects binary and reports bytes', () => {
  assert.equal(countLines(bin).binary, true);
  assert.equal(countLines(big).bytes, 5000);
  assert.equal(countLines(path.join(dir, 'nope')), null);
});

test('Grep: head_limit 0 with content mode is denied; others allowed', () => {
  assert.ok(evaluate('Grep', { pattern: 'x', output_mode: 'content', head_limit: 0 }, ctx));
  assert.equal(evaluate('Grep', { pattern: 'x', output_mode: 'content', head_limit: 50 }, ctx), null);
  assert.equal(evaluate('Grep', { pattern: 'x' }, ctx), null);
});

const denied = [
  'npm install',
  'npm i -D typescript',
  'pnpm add lodash',
  'yarn',
  'cd app && npm ci',
  `cat "${big}"`,
  'git log',
  'git -C repo log --stat',
  'find . -name "*.js"',
  'ls -lR src',
  'docker logs api',
  'journalctl -u nginx',
  'FOO=1 sudo npm install',
];
const allowed = [
  'npm install --silent',
  'npm ci --loglevel=error',
  'npm run build',
  'yarn add x --silent',
  `cat "${small}"`,
  `cat "${big}" | head -50`,
  'git log -n 20',
  'git log --oneline',
  'git log -5',
  'git status',
  'find . -maxdepth 2 -name "*.js"',
  'find . -name "*.js" | head',
  'find . -name "*.tmp" -delete',
  'find . -name "*.js" -exec wc -l {} +',
  'ls -la',
  'docker logs --tail 200 api',
  'journalctl -n 100',
  'npm install > install.log 2>&1',
  'echo hi',
];
for (const c of denied) test(`Bash denied: ${c}`, () => assert.ok(evaluate('Bash', { command: c }, ctx), c));
for (const c of allowed) test(`Bash allowed: ${c}`, () => assert.equal(evaluate('Bash', { command: c }, ctx), null, c));

test('Bash: background commands and unknown tools are ignored', () => {
  assert.equal(evaluate('Bash', { command: 'npm install', run_in_background: true }, ctx), null);
  assert.equal(evaluate('Edit', { file_path: big }, ctx), null);
});

test('never opens UNC/network paths (no credential leak to remote SMB hosts)', () => {
  let opened = false;
  const spy = () => { opened = true; return { lines: 5000, bytes: 1, truncated: false, binary: false }; };
  for (const p of [String.raw`\\attacker\share\x.log`, '//attacker/share/x.log']) {
    assert.equal(evaluate('Read', { file_path: p }, { ...ctx, countLines: spy }), null, p);
    assert.equal(evaluate('Bash', { command: `cat ${p}` }, { ...ctx, countLines: spy }), null, p);
  }
  assert.equal(opened, false);
});
