'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SCRIPTS, runScript, tmpDir } = require('./helpers');
const { anthropicBilled, bedrockBilled, compare } = require('../scripts/reconcile-cost');

const KEY = 'sk-ant-admin01-TESTSECRET-do-not-leak';

function server(handler) {
  return new Promise(res => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });
}

test('anthropic: sends the admin key only as a header, follows pages, converts cents to dollars', async () => {
  const seen = [];
  const s = await server((req, resp) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'] });
    const first = !new URL(req.url, 'http://x').searchParams.get('page');
    resp.setHeader('content-type', 'application/json');
    resp.end(JSON.stringify(first
      ? { data: [{ starting_at: '2026-10-01T00:00:00Z', results: [{ amount: '12345.6', currency: 'USD' }, { amount: '54.4', currency: 'USD' }] }], has_more: true, next_page: 'p2' }
      : { data: [{ starting_at: '2026-10-02T00:00:00Z', results: [{ amount: '250', currency: 'USD' }] }], has_more: false, next_page: null }));
  });
  const out = await anthropicBilled({ key: KEY, from: '2026-10-01', to: '2026-10-03', base: `http://127.0.0.1:${s.address().port}` });
  s.close();
  assert.deepEqual(out, { '2026-10-01': 124, '2026-10-02': 2.5 });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(x => x.key === KEY && x.version === '2023-06-01'));
  assert.ok(seen.every(x => !x.url.includes(KEY)), 'key must never be in the URL');
  assert.match(seen[0].url, /starting_at=2026-10-01T00%3A00%3A00Z.*bucket_width=1d/);
  assert.match(seen[1].url, /page=p2/);
});

test('anthropic: refuses to send the key to a non-Anthropic remote host, and needs a key', async () => {
  await assert.rejects(anthropicBilled({ key: KEY, from: '2026-10-01', to: '2026-10-02', base: 'https://evil.example.com' }), /refusing/);
  await assert.rejects(anthropicBilled({ key: '', from: '2026-10-01', to: '2026-10-02' }), /ANTHROPIC_ADMIN_KEY is not set/);
});

test('bedrock: sums only Claude services, follows NextPageToken, rejects odd profile names', async () => {
  const calls = [];
  const run = async args => {
    calls.push(args);
    return JSON.stringify(args.includes('--next-page-token')
      ? { ResultsByTime: [{ TimePeriod: { Start: '2026-10-02' }, Groups: [{ Keys: ['Claude Opus 5.5 (Amazon Bedrock Edition)'], Metrics: { UnblendedCost: { Amount: '3.5' } } }] }] }
      : { ResultsByTime: [{ TimePeriod: { Start: '2026-10-01' }, Groups: [
        { Keys: ['Claude Sonnet 5.5 (Amazon Bedrock Edition)'], Metrics: { UnblendedCost: { Amount: '10.25' } } },
        { Keys: ['Amazon Elastic Compute Cloud - Compute'], Metrics: { UnblendedCost: { Amount: '999' } } },
      ] }], NextPageToken: 't2' });
  };
  const out = await bedrockBilled({ from: '2026-10-01', to: '2026-10-03', profile: 'dev', run });
  assert.deepEqual(out, { '2026-10-01': 10.25, '2026-10-02': 3.5 });
  assert.ok(calls[0].includes('--profile') && calls[0].includes('dev'));
  await assert.rejects(bedrockBilled({ from: '2026-10-01', to: '2026-10-02', profile: 'x; rm -rf /', run }), /invalid --aws-profile/);
});

test('compare totals and factor', () => {
  const c = compare({ '2026-10-01': 10, '2026-10-02': 10 }, { '2026-10-01': 8, '2026-10-03': 1 }, 'anthropic', '2026-10-01', '2026-10-04');
  assert.equal(c.estimated, 20);
  assert.equal(c.billed, 9);
  assert.equal(c.factor, 0.45);
  assert.deepEqual(c.rows.map(r => r.day), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('end to end: the key never appears in output or calibration.json, also on a 401', async () => {
  const data = tmpDir('jr-rec-');
  const config = tmpDir('jr-cfg-'); // empty projects dir: never scans the real ~/.claude
  let fail = false;
  const s = await server((req, resp) => {
    resp.setHeader('content-type', 'application/json');
    if (fail) { resp.statusCode = 401; return resp.end(JSON.stringify({ error: { type: 'authentication_error', message: `bad key ${KEY}` } })); }
    return resp.end(JSON.stringify({ data: [{ starting_at: `${new Date().toISOString().slice(0, 10)}T00:00:00Z`, results: [{ amount: '100', currency: 'USD' }] }], has_more: false }));
  });
  const env = { ANTHROPIC_ADMIN_KEY: KEY, ANTHROPIC_ADMIN_BASE_URL: `http://127.0.0.1:${s.address().port}`, CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: config };
  const script = path.join(SCRIPTS, 'reconcile-cost.js');
  const ok = await runScript(script, '', env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /billed \$1\.00/);
  const cal = fs.readFileSync(path.join(data, 'calibration.json'), 'utf8');
  assert.equal(JSON.parse(cal).billed, 1);
  fail = true;
  const bad = await runScript(script, '', env);
  s.close();
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /401 \(authentication_error\)/);
  for (const text of [ok.stdout, ok.stderr, cal, bad.stdout, bad.stderr]) assert.ok(!text.includes('TESTSECRET'), 'admin key leaked');
});
