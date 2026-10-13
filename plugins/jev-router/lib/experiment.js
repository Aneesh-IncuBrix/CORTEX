'use strict';
// Holdout arm assignment and context-size warnings for the route hook.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendCapped } = require('./log');

const ARMS_FILE = 'arms.jsonl';
const BAND = 50000; // warn again only after context grows another 50k tokens

// Whole sessions are held out (not single prompts): cost is shared across a session's prompts.
function armOf(session, percent) {
  if (!session || percent <= 0) return 'routed';
  const n = crypto.createHash('sha1').update(String(session)).digest().readUInt32BE(0) % 100;
  return n < percent ? 'holdout' : 'routed';
}

function readArms(dataDir) {
  const arms = new Map();
  let raw = '';
  try { raw = fs.readFileSync(path.join(dataDir, ARMS_FILE), 'utf8'); } catch { return arms; }
  for (const line of raw.split('\n')) {
    try { const r = JSON.parse(line); if (r.session) arms.set(r.session, r.arm); } catch { /* skip */ }
  }
  return arms;
}

// Separate from decisions.jsonl (capped at 500 rows) so measurement keeps old sessions.
function recordArm(dataDir, session, arm) {
  if (!session || readArms(dataDir).has(session)) return;
  appendCapped(path.join(dataDir, ARMS_FILE), { ts: new Date().toISOString(), session, arm }, 20000, 25000);
}

// One line, only when context crosses a new 50k band at or above the threshold.
function contextNote(tokens, warnAt, lastBand, cacheReadPerM) {
  if (!warnAt || tokens < warnAt) return null;
  const band = Math.floor(tokens / BAND);
  if (band <= lastBand) return null;
  const perPrompt = (tokens * cacheReadPerM) / 1e6;
  const note = `[jev-router] context ~${Math.round(tokens / 1000)}k tokens is re-sent with every prompt (re-reading it alone costs ~$${perPrompt.toFixed(2)} per prompt at list price, before any new work). If the next task is unrelated, suggest /clear or a new session; if related, /compact.`;
  return { band, note };
}

module.exports = { armOf, readArms, recordArm, contextNote, BAND };
