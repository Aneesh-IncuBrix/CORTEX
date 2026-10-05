'use strict';
const os = require('os');
const path = require('path');

const MODES = ['advise', 'guard-only', 'off'];

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    mode: MODES.includes(env.CLAUDE_PLUGIN_OPTION_MODE) ? env.CLAUDE_PLUGIN_OPTION_MODE : 'advise',
    readLineCap: Math.max(50, num(env.CLAUDE_PLUGIN_OPTION_READ_LINE_CAP, 800)),
    trimOutputLines: Math.max(0, num(env.CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES, 0)),
    configDir,
    dataDir: env.CLAUDE_PLUGIN_DATA || path.join(configDir, 'plugins', 'data', 'jev-router-local'),
    jevBaseUrl: env.JEV_BASE_URL || '',
    engineTimeoutMs: num(env.JEV_TIMEOUT_MS, 2500),
  };
}

function isLoopbackUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  } catch {
    return false;
  }
}

module.exports = { loadConfig, isLoopbackUrl, MODES };
