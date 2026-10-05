#!/usr/bin/env node
'use strict';
// Fails a PR that changes shipped plugin files without bumping plugin.json "version":
// Claude Code only delivers an update to users when that string changes.
const fs = require('fs');
const { execSync } = require('child_process');

const MANIFEST = 'plugins/jev-router/.claude-plugin/plugin.json';

function isShipped(file) {
  return file.startsWith('plugins/jev-router/')
    && !file.startsWith('plugins/jev-router/test/')
    && !/\/README\.md$/.test(file);
}

function needsBump({ changed, headVersion, baseVersion }) {
  const shipped = changed.filter(isShipped);
  if (!shipped.length) return { ok: true, message: 'no shipped plugin files changed' };
  if (baseVersion === null) return { ok: true, message: 'plugin is new on this branch' };
  if (headVersion === baseVersion) {
    return { ok: false, message: `${shipped.length} shipped file(s) changed but the version is still ${headVersion}. Bump "version" in ${MANIFEST} and add a CHANGELOG.md entry.` };
  }
  return { ok: true, message: `version ${baseVersion} → ${headVersion}` };
}

if (require.main === module) {
  const base = process.argv[2] || 'origin/main';
  const changed = execSync(`git diff --name-only ${base}...HEAD`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const headVersion = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version;
  let baseVersion = null;
  try { baseVersion = JSON.parse(execSync(`git show ${base}:${MANIFEST}`, { encoding: 'utf8' })).version; } catch { baseVersion = null; }
  const r = needsBump({ changed, headVersion, baseVersion });
  (r.ok ? console.log : console.error)(r.message);
  process.exit(r.ok ? 0 : 1);
}

module.exports = { needsBump, isShipped };
