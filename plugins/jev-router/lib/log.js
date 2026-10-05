'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function appendCapped(file, record, max = 500, trimAt = 600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length > trimAt) fs.writeFileSync(file, lines.slice(-max).join('\n') + '\n');
}

function readTail(file, n) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).slice(-n).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function fingerprint(text) {
  const s = String(text || '');
  return { len: s.length, sha: crypto.createHash('sha1').update(s).digest('hex').slice(0, 10) };
}

module.exports = { appendCapped, readTail, fingerprint };
