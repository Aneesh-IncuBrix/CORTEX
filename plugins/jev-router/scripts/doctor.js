#!/usr/bin/env node
'use strict';
const path = require('path');
const { loadConfig, isLoopbackUrl } = require('../lib/config');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { readinessState, enginePaths, MODEL, sha256File } = require('../lib/engine/manifest');
const { loadCatalog, enabledPluginInstalls } = require('../lib/catalog');
const { readTail } = require('../lib/log');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function argData(argv) {
  const i = argv.indexOf('--data');
  return i >= 0 ? argv[i + 1] : null;
}

function npmVersion() {
  const r = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  return r.status === 0 ? r.stdout.trim() : 'not found';
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* vanished */ } }
    }
  };
  walk(dir);
  return Math.round(total / 1048576);
}

function percentile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

// U19: other enabled plugins that hook the same tools/events.
function hookNeighbours(cfg) {
  const out = { pre: [], postBash: [] };
  for (const p of enabledPluginInstalls(cfg.configDir, process.cwd())) {
    if (p.plugin === 'jev-router') continue;
    let hooks;
    try { hooks = JSON.parse(fs.readFileSync(path.join(p.installPath, 'hooks', 'hooks.json'), 'utf8')).hooks || {}; } catch { continue; }
    const matches = (matcher, tool) => {
      // No RegExp from other plugins' input (ReDoS): compare the '|'-separated names literally.
      return String(matcher).split('|').map(s => s.trim()).some(s => s === tool || s === '*' || s === '.*');
    };
    const touches = (event, tool) => (hooks[event] || []).some(h => !h.matcher || matches(h.matcher, tool));
    if (['Read', 'Bash', 'Grep'].some(t => touches('PreToolUse', t))) out.pre.push(p.plugin);
    if (touches('PostToolUse', 'Bash')) out.postBash.push(p.plugin);
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const dataDir = path.resolve(argData(process.argv.slice(2)) || cfg.dataDir);
  const out = [
    'jev-router doctor',
    `node ${process.version} · npm ${npmVersion()} · ${process.platform}-${process.arch} · mode ${cfg.mode}`,
    `data ${dataDir}`,
  ];
  if (Number(process.versions.node.split('.')[0]) < 18) out.push('  ✗ Node 18+ is required; hooks are inactive on this Node. Install the current LTS from https://nodejs.org');

  const { state, ready } = readinessState(dataDir);
  const manual = `node "${path.join(PLUGIN_ROOT, 'scripts', 'setup.js')}" --data "${dataDir}"`;
  if (state === 'missing') {
    out.push('engine: NOT INSTALLED — run /jev-router:setup (prompt routing is off; the tool guard still works)');
    out.push(`  if setup is blocked in-session, run it in your own terminal: ${manual}`);
  } else if (state === 'stale') {
    out.push('engine: UPDATE REQUIRED — the plugin was updated; run /jev-router:setup (routing is paused)');
    out.push(`  or in your terminal: ${manual}`);
  } else if (state === 'broken') {
    out.push('engine: DAMAGED — files are missing; run /jev-router:setup to repair (routing is paused)');
    out.push(`  or in your terminal: ${manual}`);
  } else if (state === 'lite') {
    out.push(`engine: LITE MODE — routing uses built-in rules (reason: ${ready.reason || 'unknown'})`);
    out.push('  to try the full engine again: /jev-router:setup');
  } else {
    const p = enginePaths(dataDir);
    const bad = MODEL.files.filter(f => {
      try { return sha256File(path.join(p.modelDir, f.local)) !== f.sha256; } catch { return true; }
    }).map(f => f.local);
    out.push(`engine: ready (revision ${ready.revision.slice(0, 7)}, installed ${ready.installedAt}, ${ready.platform})`);
    out.push(bad.length ? `  ✗ checksum mismatch: ${bad.join(', ')} — re-run /jev-router:setup` : '  ✓ model files match pinned checksums');
    try {
      const { LocalEmbedder } = require('../lib/engine/local');
      const t0 = Date.now();
      const e = await LocalEmbedder.create(dataDir);
      const t1 = Date.now();
      await e.embed('where is the rate limiter implemented?');
      out.push(`  ✓ self-test: model load ${t1 - t0} ms, one prompt ${Date.now() - t1} ms`);
    } catch (e) {
      out.push(`  ✗ self-test failed: ${e.message} — re-run /jev-router:setup (it falls back to lite mode if the engine can't run here)`);
    }
    out.push(`  disk: ${dirSizeMb(p.root)} MB in ${p.root} (removed automatically when you uninstall the plugin)`);
  }

  if (cfg.jevBaseUrl) {
    out.push(`JEV_BASE_URL: ${isLoopbackUrl(cfg.jevBaseUrl) ? 'loopback ✓ (used instead of the built-in engine)' : 'REFUSED — not a loopback address'}`);
  }

  const cat = loadCatalog({ configDir: cfg.configDir, projectDir: process.cwd(), dataDir, pluginRoot: PLUGIN_ROOT });
  const counts = Object.entries(cat.counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
  const dups = [...new Set(cat.duplicates)];
  out.push(`agents: ${cat.agents.length} (${counts})${dups.length ? ` · duplicates skipped: ${dups.join(', ')}` : ''}`);

  const decisions = readTail(path.join(dataDir, 'decisions.jsonl'), 10);
  out.push(`last ${decisions.length} decisions:`);
  for (const d of decisions) {
    out.push(`  ${d.ts} ${d.source} diff=${d.difficulty} (${d.conf}) agent=${d.agent || '-'} (${d.agentConf}) hint=${d.hintChars}c ${d.latencyMs}ms${d.error ? ` error=${d.error}` : ''}`);
  }

  const recent = readTail(path.join(dataDir, 'decisions.jsonl'), 200).filter(d => d.source === 'engine').map(d => d.latencyMs);
  if (recent.length) out.push(`engine latency (last ${recent.length}): p50 ${percentile(recent, 0.5)} ms, p95 ${percentile(recent, 0.95)} ms`);

  const guard = readTail(path.join(dataDir, 'guard.jsonl'), 500);
  const c = guard.reduce((m, g) => { m[g.action] = (m[g.action] || 0) + 1; return m; }, {});
  out.push(`guard: ${c.deny || 0} denied, ${c['allowed-repeat'] || 0} allowed on repeat, ${c['breaker-open'] || 0} after the per-session limit, ${c.trim || 0} outputs trimmed`);

  const n = hookNeighbours(cfg);
  if (n.pre.length) out.push(`other plugins also hooking Read/Bash/Grep: ${n.pre.join(', ')} (fine; jev-router never auto-approves)`);
  if (n.postBash.length && cfg.trimOutputLines) out.push(`  ⚠ output trimming is on and ${n.postBash.join(', ')} also rewrite Bash output — set trim_output_lines to 0 if results look odd`);
  out.push('privacy: no prompt text is stored; the engine runs offline after setup.');
  process.stdout.write(out.join('\n') + '\n');
}

main().then(() => process.exit(0), e => { process.stdout.write(`jev-router doctor error: ${e.message}\n`); process.exit(0); });
