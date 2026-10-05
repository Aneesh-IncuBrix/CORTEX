'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadConfig, isLoopbackUrl } = require('../lib/config');

test('defaults', () => {
  const c = loadConfig({ CLAUDE_CONFIG_DIR: '/cfg' });
  assert.equal(c.mode, 'advise');
  assert.equal(c.readLineCap, 800);
  assert.equal(c.trimOutputLines, 0);
  assert.equal(c.engineTimeoutMs, 2500);
  assert.equal(c.jevBaseUrl, '');
  assert.equal(c.configDir, '/cfg');
  assert.equal(c.dataDir, path.join('/cfg', 'plugins', 'data', 'jev-router-local'));
});

test('reads plugin options and data dir', () => {
  const c = loadConfig({
    CLAUDE_PLUGIN_OPTION_MODE: 'guard-only',
    CLAUDE_PLUGIN_OPTION_READ_LINE_CAP: '1200',
    CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES: '600',
    CLAUDE_PLUGIN_DATA: '/data',
    JEV_TIMEOUT_MS: '900',
  });
  assert.equal(c.mode, 'guard-only');
  assert.equal(c.readLineCap, 1200);
  assert.equal(c.trimOutputLines, 600);
  assert.equal(c.dataDir, '/data');
  assert.equal(c.engineTimeoutMs, 900);
});

test('invalid values fall back safely', () => {
  const c = loadConfig({ CLAUDE_PLUGIN_OPTION_MODE: 'bogus', CLAUDE_PLUGIN_OPTION_READ_LINE_CAP: 'abc', CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES: '-5' });
  assert.equal(c.mode, 'advise');
  assert.equal(c.readLineCap, 800);
  assert.equal(c.trimOutputLines, 0);
  assert.equal(loadConfig({ CLAUDE_PLUGIN_OPTION_READ_LINE_CAP: '10' }).readLineCap, 50);
});

test('isLoopbackUrl accepts only loopback http(s)', () => {
  for (const u of ['http://127.0.0.1:8000', 'http://localhost:1', 'http://[::1]:9', 'https://localhost/x']) assert.equal(isLoopbackUrl(u), true, u);
  for (const u of ['https://api.typesafe.ai', 'http://127.0.0.1.evil.com', 'http://10.0.0.5:80', 'ftp://localhost', 'garbage', '', 'http://localhost.attacker.io']) assert.equal(isLoopbackUrl(u), false, u);
});
