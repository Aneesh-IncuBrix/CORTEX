'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, tier } = require('../scripts/scan-llm');

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-scan-'));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

test('tier: gemini is not "mini"; premium and cheap families', () => {
  assert.strictEqual(tier('gemini-2.5-flash'), 'mid');
  assert.strictEqual(tier('gpt-4o-mini'), 'cheap');
  assert.strictEqual(tier('claude-opus-5-5'), 'premium');
  assert.strictEqual(tier('claude-haiku-5-5'), 'cheap');
  assert.strictEqual(tier(null), 'unknown');
});

test('scan finds call sites, loop + premium advice, legacy gemini via helper, never key values', () => {
  const dir = repo({
    'app/agent.py': 'import anthropic\nclient = anthropic.Anthropic()\nfor doc in docs:\n    r = client.messages.create(model="claude-opus-5-5", messages=[])\n',
    'app/helper.py': 'import google.generativeai as genai\ndef get(): return genai\n',
    'app/vision.py': 'from app.helper import get\nGEMINI_API_KEY = os.environ["GEMINI_API_KEY"]\nm = get().GenerativeModel("gemini-2.5-flash")\nm.generate_content(x)\n',
    'web/routes.js': 'fetch("/api/generate", {method: "POST"})\n',
    'node_modules/x/index.js': 'import OpenAI from "openai"; client.chat.completions.create({})\n',
    '.env': 'GEMINI_API_KEY=sk-secret-value-123\nOTHER=1\n',
  });
  const r = scan(dir, path.join(dir, 'no-config'), {});
  const out = JSON.stringify(r);
  assert.ok(!out.includes('sk-secret-value-123'), 'key value leaked');
  assert.deepStrictEqual(r.keyEnvNames, ['GEMINI_API_KEY']);
  assert.deepStrictEqual(r.sites.map(s => s.file).sort(), ['app/agent.py', 'app/vision.py']);
  const a = r.sites.find(s => s.file === 'app/agent.py');
  assert.ok(a.loop);
  assert.ok(a.recommendations.some(x => x.id === 'batch'));
  assert.ok(a.recommendations.some(x => x.id === 'model-tier' && x.ask));
  const g = r.sites.find(s => s.file === 'app/vision.py');
  assert.ok(g.legacyGemini);
  assert.ok(g.recommendations.find(x => x.id === 'thinking-cap').text.includes('legacy'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scan reports existing routers from env and settings', () => {
  const dir = repo({ '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128' }, enabledPlugins: { 'omniroute@x': true, 'jev-router@y': true } }) });
  const r = scan(dir, path.join(dir, 'no-config'), { ANTHROPIC_BASE_URL: 'http://localhost:4000' });
  const names = r.routers.map(x => x.name);
  assert.ok(names.includes('ANTHROPIC_BASE_URL'));
  assert.ok(names.includes('omniroute@x'));
  assert.ok(!names.some(n => n.startsWith('jev-router')));
  fs.rmSync(dir, { recursive: true, force: true });
});
