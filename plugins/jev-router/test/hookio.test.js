'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, write, runScript } = require('./helpers');
const { parseInput, nodeSupported } = require('../lib/hookio');

test('nodeSupported requires Node 18+ (U2)', () => {
  assert.equal(nodeSupported('16.20.2'), false);
  assert.equal(nodeSupported('18.0.0'), true);
  assert.equal(nodeSupported('25.5.0'), true);
});

const HOOKIO = JSON.stringify(path.join(__dirname, '..', 'lib', 'hookio.js'));

function fixture(body) {
  const dir = tmpDir();
  const script = write(path.join(dir, 'hook.js'), `const { runHook } = require(${HOOKIO});\nrunHook('t', 1500, ${body}, ${JSON.stringify(dir)});\n`);
  return { dir, script };
}

test('parseInput handles empty, invalid and valid JSON', () => {
  assert.deepEqual(parseInput(''), {});
  assert.deepEqual(parseInput('nope'), {});
  assert.deepEqual(parseInput('"str"'), {});
  assert.deepEqual(parseInput('{"a":1}'), { a: 1 });
});

test('returned object is printed as JSON, exit 0', async () => {
  const { script } = fixture('async (i) => ({ echo: i.x })');
  const r = await runScript(script, { x: 7 });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { echo: 7 });
});

test('null result prints nothing', async () => {
  const { script } = fixture('async () => null');
  const r = await runScript(script, {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('exceptions are logged, never printed, exit 0', async () => {
  const { dir, script } = fixture("async () => { throw new Error('boom'); }");
  const r = await runScript(script, {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(fs.readFileSync(path.join(dir, 'errors.log'), 'utf8'), /boom/);
});

test('hanging main is cut off by the budget, exit 0', async () => {
  const { script } = fixture('() => new Promise(() => {})');
  const t0 = Date.now();
  const r = await runScript(script, {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(Date.now() - t0 < 5000);
});
