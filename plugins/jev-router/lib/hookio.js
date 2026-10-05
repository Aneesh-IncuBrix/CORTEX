'use strict';
const fs = require('fs');
const path = require('path');

function readStdin(stream = process.stdin) {
  return new Promise(resolve => {
    let s = '';
    stream.setEncoding('utf8');
    stream.on('data', d => { s += d; });
    stream.on('end', () => resolve(s));
    stream.on('error', () => resolve(s));
  });
}

function logError(dataDir, name, err) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'errors.log'), `${new Date().toISOString()} [${name}] ${(err && err.stack) || err}\n`);
  } catch {
    // The logger must never throw.
  }
}

function parseInput(raw) {
  try {
    const v = raw && raw.trim() ? JSON.parse(raw) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function finish(out) {
  if (out) process.stdout.write(JSON.stringify(out), () => process.exit(0));
  else process.exit(0);
}

function nodeSupported(version = process.versions.node) {
  return Number(String(version).split('.')[0]) >= 18;
}

// Fail-open hook runner: whatever happens, exit 0 within budgetMs.
function runHook(name, budgetMs, main, dataDir) {
  if (!nodeSupported()) process.exit(0); // U2: never crash old Node; doctor explains
  const timer = setTimeout(() => process.exit(0), budgetMs);
  readStdin().then(async raw => {
    let out = null;
    try {
      out = await main(parseInput(raw));
    } catch (e) {
      logError(dataDir, name, e);
    }
    clearTimeout(timer);
    finish(out);
  });
}

module.exports = { runHook, nodeSupported, logError, parseInput, readStdin };
