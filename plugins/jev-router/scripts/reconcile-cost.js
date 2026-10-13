#!/usr/bin/env node
'use strict';
// Compares the plugin's list-price estimate with what you were actually billed, per day.
// Read-only. Keys come from the environment / AWS profile and are never printed or stored.
//
//   Anthropic API:  ANTHROPIC_ADMIN_KEY=sk-ant-admin01-... node reconcile-cost.js --source anthropic
//   Amazon Bedrock: node reconcile-cost.js --source bedrock [--aws-profile name]
//   Options: [--days 30] [--data <plugin data dir>] [--projects <dir>] [--json]
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { loadConfig, isLoopbackUrl } = require('../lib/config');
const { listTranscripts, costRows } = require('../lib/transcripts');
const { oldestFirst } = require('./savings-report');

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const CLAUDE_SERVICE = /claude|anthropic/i; // Bedrock bills Claude as "Claude … (Amazon Bedrock Edition)"

function arg(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}

const day = d => d.toISOString().slice(0, 10);

// List-price estimate per UTC day from this machine's Claude Code logs.
function estimateByDay(projectsDir, from, to) {
  const out = {};
  const seen = new Set();
  for (const f of oldestFirst(listTranscripts(projectsDir))) {
    for (const r of costRows(f, seen)) {
      const d = (r.ts || '').slice(0, 10);
      if (d >= from && d < to) out[d] = (out[d] || 0) + r.cost;
    }
  }
  return out;
}

// Anthropic Usage & Cost Admin API: amounts are decimal strings in cents.
async function anthropicBilled({ key, from, to, base = ANTHROPIC_BASE, fetchImpl = fetch }) {
  if (!key) throw new Error('ANTHROPIC_ADMIN_KEY is not set (needs an Admin API key, sk-ant-admin01-…; normal API keys are rejected).');
  if (base !== ANTHROPIC_BASE && !isLoopbackUrl(base)) throw new Error('refusing a non-Anthropic, non-loopback base URL for the admin key');
  const out = {};
  let page = null;
  for (let i = 0; i < 50; i++) {
    const u = new URL('/v1/organizations/cost_report', base);
    u.searchParams.set('starting_at', `${from}T00:00:00Z`);
    u.searchParams.set('ending_at', `${to}T00:00:00Z`);
    u.searchParams.set('bucket_width', '1d');
    u.searchParams.set('limit', '31');
    if (page) u.searchParams.set('page', page);
    const r = await fetchImpl(u, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'user-agent': 'jev-router-reconcile' }, redirect: 'error' });
    if (!r.ok) {
      let detail = '';
      try { const b = await r.json(); detail = (b.error && b.error.type) || ''; } catch { /* no body */ }
      throw new Error(`cost_report returned ${r.status}${detail ? ` (${detail})` : ''}${r.status === 401 || r.status === 403 ? ': check it is an Admin API key for the right organization' : ''}`);
    }
    const body = await r.json();
    for (const b of body.data || []) {
      const d = String(b.starting_at || '').slice(0, 10);
      for (const x of b.results || []) out[d] = (out[d] || 0) + Number(x.amount || 0) / 100;
    }
    if (!body.has_more || !body.next_page) return out;
    page = body.next_page;
  }
  throw new Error('cost_report pagination did not finish after 50 pages');
}

function awsCli(args) {
  return new Promise((resolve, reject) => {
    execFile('aws', args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`aws ce failed: ${String(stderr || err.message).split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}

// AWS Cost Explorer (Bedrock): daily unblended cost of the Claude services only.
async function bedrockBilled({ from, to, profile, run = awsCli }) {
  if (profile && !/^[\w.+-]{1,64}$/.test(profile)) throw new Error('invalid --aws-profile name');
  const out = {};
  let token = null;
  for (let i = 0; i < 50; i++) {
    const args = ['ce', 'get-cost-and-usage', '--time-period', `Start=${from},End=${to}`, '--granularity', 'DAILY',
      '--metrics', 'UnblendedCost', '--group-by', 'Type=DIMENSION,Key=SERVICE', '--region', 'us-east-1', '--output', 'json'];
    if (profile) args.push('--profile', profile);
    if (token) args.push('--next-page-token', token);
    const body = JSON.parse(await run(args));
    for (const t of body.ResultsByTime || []) {
      const d = t.TimePeriod.Start;
      for (const g of t.Groups || []) {
        if (CLAUDE_SERVICE.test(g.Keys[0])) out[d] = (out[d] || 0) + Number(g.Metrics.UnblendedCost.Amount || 0);
      }
    }
    if (!body.NextPageToken) return out;
    token = body.NextPageToken;
  }
  throw new Error('Cost Explorer pagination did not finish after 50 pages');
}

function compare(estimated, billed, source, from, to) {
  const days = [...new Set([...Object.keys(estimated), ...Object.keys(billed)])].sort();
  const rows = days.map(d => ({ day: d, estimated: estimated[d] || 0, billed: billed[d] || 0 }));
  const est = rows.reduce((s, r) => s + r.estimated, 0);
  const bil = rows.reduce((s, r) => s + r.billed, 0);
  return { source, from, to, at: new Date().toISOString(), estimated: est, billed: bil, factor: est ? bil / est : null, rows };
}

function print(c) {
  console.log(`Billed vs estimated (${c.source}, ${c.from} to ${c.to}, UTC days)`);
  console.log('day          estimate      billed');
  for (const r of c.rows) console.log(`${r.day}  ${('$' + r.estimated.toFixed(2)).padStart(10)}  ${('$' + r.billed.toFixed(2)).padStart(10)}`);
  console.log(`\nTotal: estimated $${c.estimated.toFixed(2)} at list price, billed $${c.billed.toFixed(2)}${c.factor ? ` (×${c.factor.toFixed(2)})` : ''}.`);
  if (c.factor && c.factor > 1.3) console.log('Billed is well above the estimate: the bill likely includes other users, apps or machines on the same account, not only this machine\'s Claude Code.');
  if (c.factor && c.factor < 0.7) console.log('Billed is well below the estimate: check for discounts, credits, or Claude Code usage not billed to this account (e.g. a subscription).');
  console.log('Billed data can lag by a few minutes (Anthropic) to ~24 hours (AWS); the last day may be incomplete.');
}

async function main() {
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  const dataDir = arg(argv, '--data', cfg.dataDir);
  const days = Math.min(365, Math.max(1, Number(arg(argv, '--days', 30)) || 30));
  const source = arg(argv, '--source', process.env.ANTHROPIC_ADMIN_KEY ? 'anthropic' : null);
  if (!['anthropic', 'bedrock'].includes(source)) throw new Error('choose --source anthropic (with ANTHROPIC_ADMIN_KEY set) or --source bedrock (AWS CLI + ce:GetCostAndUsage).');
  const now = new Date();
  const to = day(new Date(now.getTime() + 864e5)); // include today
  const from = day(new Date(now.getTime() - (days - 1) * 864e5));
  const billed = source === 'anthropic'
    ? await anthropicBilled({ key: process.env.ANTHROPIC_ADMIN_KEY, from, to, base: process.env.ANTHROPIC_ADMIN_BASE_URL || ANTHROPIC_BASE })
    : await bedrockBilled({ from, to, profile: arg(argv, '--aws-profile', null) });
  const c = compare(estimateByDay(arg(argv, '--projects', path.join(cfg.configDir, 'projects')), from, to), billed, source, from, to);
  fs.mkdirSync(dataDir, { recursive: true });
  const { rows, ...summary } = c;
  fs.writeFileSync(path.join(dataDir, 'calibration.json'), JSON.stringify(summary, null, 2)); // totals only, never the key
  if (argv.includes('--json')) console.log(JSON.stringify(c, null, 2));
  else print(c);
}

if (require.main === module) main().catch(e => { console.error(`reconcile-cost: ${e.message}`); process.exit(1); });

module.exports = { anthropicBilled, bedrockBilled, compare, estimateByDay };
