#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig, isLoopbackUrl } = require('../lib/config');
const { runHook } = require('../lib/hookio');
const { readinessState } = require('../lib/engine/manifest');

const cfg = loadConfig();
const DAY_MS = 24 * 3600 * 1000;
// U12: one message per state, each with its own next step. lite/ready stay silent.
const MESSAGES = {
  missing: 'jev-router: prompt routing is off until you run /jev-router:setup (one-time ~100 MB local engine; nothing leaves your machine). The tool guard is already active.',
  stale: 'jev-router was updated and its local engine needs a refresh: run /jev-router:setup (routing is paused until then).',
  broken: 'jev-router: the local engine files are missing or damaged. Run /jev-router:setup to repair them (routing is paused).',
};

// U13: at most once per 24 h for the same state, so headless/cloud sessions aren't spammed.
function shouldRemind(state, now = Date.now()) {
  const file = path.join(cfg.dataDir, 'reminder.json');
  let last = null;
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { last = null; }
  if (last && last.state === state && now - last.ts < DAY_MS) return false;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ state, ts: now }));
  return true;
}

runHook('session-start', 3000, async () => {
  if (cfg.mode !== 'advise') return null;
  if (cfg.jevBaseUrl && isLoopbackUrl(cfg.jevBaseUrl)) return null;
  const { state } = readinessState(cfg.dataDir);
  if (!MESSAGES[state] || !shouldRemind(state)) return null;
  return { systemMessage: MESSAGES[state] };
}, cfg.dataDir);
