'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SCRIPTS, runScript, hookEnv, write } = require('./helpers');
const { enginePaths, ENGINE_VERSION } = require('../lib/engine/manifest');

const route = path.join(SCRIPTS, 'route-prompt.js');
const start = path.join(SCRIPTS, 'session-start.js');

function jevServer(reply) {
  return new Promise(res => {
    const s = http.createServer((req, resp) => {
      let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
        const out = reply(JSON.parse(raw));
        resp.statusCode = out.status || 200;
        resp.setHeader('content-type', 'application/json');
        resp.end(JSON.stringify(out.body || {}));
      });
    }).listen(0, '127.0.0.1', () => res(s));
  });
}

test('session-start shows the setup reminder until the engine is ready', async () => {
  const h = hookEnv();
  const r = await runScript(start, { hook_event_name: 'SessionStart', source: 'startup' }, h.env);
  assert.match(r.json.systemMessage, /run \/jev-router:setup/);
  const off = await runScript(start, {}, hookEnv({ CLAUDE_PLUGIN_OPTION_MODE: 'guard-only' }).env);
  assert.equal(off.stdout, '');
});

test('reminder is throttled to once per day per state; a new state shows at once (U12, U13)', async () => {
  const h = hookEnv();
  const first = await runScript(start, {}, h.env);
  assert.match(first.json.systemMessage, /routing is off/);
  const second = await runScript(start, {}, h.env);
  assert.equal(second.stdout, '');
  const p = enginePaths(h.data);
  write(p.ready, JSON.stringify({ engineVersion: 0, revision: 'old' }));
  const stale = await runScript(start, {}, h.env);
  assert.match(stale.json.systemMessage, /was updated/);
  fs.writeFileSync(path.join(h.data, 'reminder.json'), JSON.stringify({ state: 'stale', ts: Date.now() - 25 * 3600 * 1000 }));
  const nextDay = await runScript(start, {}, h.env);
  assert.match(nextDay.json.systemMessage, /was updated/);
});

test('lite mode: no reminder, and prompts are routed on built-in rules (U8)', async () => {
  const h = hookEnv();
  write(enginePaths(h.data).ready, JSON.stringify({ engineVersion: ENGINE_VERSION, mode: 'lite', reason: 'test' }));
  const s = await runScript(start, {}, h.env);
  assert.equal(s.stdout, '');
  const r = await runScript(route, { prompt: 'where is the rate limiter implemented?', session_id: 's', cwd: h.config }, h.env);
  assert.match(r.json.hookSpecificOutput.additionalContext, /^\[jev-router\] simple \(0\.60\)/);
  const rec = JSON.parse(fs.readFileSync(path.join(h.data, 'decisions.jsonl'), 'utf8').trim());
  assert.equal(rec.source, 'heuristic');
});

test('route-prompt is silent (hard gate) before setup and logs nothing', async () => {
  const h = hookEnv();
  const r = await runScript(route, { prompt: 'where is the rate limiter implemented?', session_id: 's', cwd: h.config }, h.env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(h.data, 'decisions.jsonl')), false);
});

test('route-prompt ignores trivial prompts and slash commands', async () => {
  const s = await jevServer(() => ({ body: {} }));
  const h = hookEnv({ JEV_BASE_URL: `http://127.0.0.1:${s.address().port}` });
  for (const p of ['thanks!', '/clear', 'ok']) {
    const r = await runScript(route, { prompt: p, session_id: 's', cwd: h.config }, h.env);
    assert.equal(r.stdout, '', p);
  }
  s.close();
});

test('route-prompt with a loopback JEV-compatible server emits a hint and logs a fingerprint only', async () => {
  const s = await jevServer(body => {
    const crit = body.questions.agent.criteria;
    const key = Object.keys(crit).find(k => crit[k].startsWith('Explore'));
    return { body: { answers: { difficulty: { probabilities: [0.05, 0.85, 0.05, 0.05], confidence: 0.85 }, agent: { choice: key, confidence: 0.9 }, verbose: { noul: 0.1 } } } };
  });
  const h = hookEnv({ JEV_BASE_URL: `http://127.0.0.1:${s.address().port}` });
  const prompt = 'where is the secret-rate-limiter implemented?';
  const r = await runScript(route, { prompt, session_id: 's1', cwd: h.config }, h.env);
  s.close();
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(r.json.hookSpecificOutput.additionalContext, /^\[jev-router\] simple .*delegate to subagent "Explore"/);
  const log = fs.readFileSync(path.join(h.data, 'decisions.jsonl'), 'utf8');
  assert.match(log, /"source":"remote"/);
  assert.ok(!log.includes('secret-rate-limiter'));
});

test('remote failure falls back to heuristics, logs the error, still exits 0', async () => {
  const s = await jevServer(() => ({ status: 500 }));
  const h = hookEnv({ JEV_BASE_URL: `http://127.0.0.1:${s.address().port}` });
  const r = await runScript(route, { prompt: 'fix the typo in README line 3', session_id: 's', cwd: h.config }, h.env);
  s.close();
  assert.equal(r.code, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(h.data, 'decisions.jsonl'), 'utf8').trim());
  assert.equal(rec.source, 'heuristic-fallback');
  assert.match(rec.error, /500/);
});

test('non-loopback JEV_BASE_URL is refused (treated as not ready)', async () => {
  const h = hookEnv({ JEV_BASE_URL: 'https://api.typesafe.ai' });
  const r = await runScript(route, { prompt: 'where is the rate limiter implemented?', session_id: 's', cwd: h.config }, h.env);
  assert.equal(r.stdout, '');
  assert.match(fs.readFileSync(path.join(h.data, 'errors.log'), 'utf8'), /non-loopback/);
});

test('a 100 KB prompt completes within budget (Review Focus 4)', async () => {
  const s = await jevServer(() => ({ body: { answers: { difficulty: { score: 2.2 }, agent: { choice: 'main', confidence: 0.9 }, verbose: { noul: 0.1 } } } }));
  const h = hookEnv({ JEV_BASE_URL: `http://127.0.0.1:${s.address().port}` });
  const t0 = Date.now();
  const r = await runScript(route, { prompt: 'refactor this module please '.repeat(4000), session_id: 's', cwd: h.config }, h.env);
  s.close();
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 7500);
});
