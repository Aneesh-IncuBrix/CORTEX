'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_AGE_MS = 48 * 3600 * 1000;

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

function keyFor(toolName, toolInput) {
  return crypto.createHash('sha1').update(`${toolName}\n${canonical(toolInput || {})}`).digest('hex');
}

function safeSession(id) {
  return String(id || 'nosession').replace(/[^\w-]/g, '_').slice(0, 80) || 'nosession';
}

function prune(dir, now) {
  for (const f of fs.readdirSync(dir)) {
    try {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS) fs.unlinkSync(p);
    } catch {
      // Another session may have removed it.
    }
  }
}

// Deny-once memory: returns true when this exact call was already seen this session.
function seenBefore(dataDir, sessionId, key, now = Date.now()) {
  const dir = path.join(dataDir, 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  prune(dir, now);
  const file = path.join(dir, `${safeSession(sessionId)}.json`);
  let keys = [];
  try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { keys = []; }
  if (!Array.isArray(keys)) keys = [];
  if (keys.includes(key)) return true;
  keys.push(key);
  fs.writeFileSync(file, JSON.stringify(keys.slice(-500)));
  return false;
}

// Circuit breaker counter (U3): how many denials this session has seen.
function denyFile(dataDir, sessionId) {
  return path.join(dataDir, 'ledger', `${safeSession(sessionId)}.denies`);
}

function deniesSoFar(dataDir, sessionId) {
  try { return Number(fs.readFileSync(denyFile(dataDir, sessionId), 'utf8')) || 0; } catch { return 0; }
}

function bumpDenies(dataDir, sessionId) {
  const n = deniesSoFar(dataDir, sessionId) + 1;
  fs.mkdirSync(path.join(dataDir, 'ledger'), { recursive: true });
  fs.writeFileSync(denyFile(dataDir, sessionId), String(n));
  return n;
}

module.exports = { keyFor, canonical, seenBefore, safeSession, deniesSoFar, bumpDenies };
