#!/usr/bin/env node
'use strict';
// Measures cost per prompt in sessions where jev-router gave a hint vs sessions where it did not.
// Usage: node savings-report.js [--data <plugin data dir>] [--projects <dir>] [--since 2026-10-01] [--budget <usd/month>] [--json]
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { listTranscripts, readTurns, fileCost } = require('../lib/transcripts');

const MIN_PROMPTS = 100;
const SUB =`${path.sep}subagents${path.sep}`;

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function hintedSessions(dataDir) {
  const s = new Set();
  let raw = '';
  try { raw = fs.readFileSync(path.join(dataDir, 'decisions.jsonl'), 'utf8'); } catch { return s; }
  for (const line of raw.split('\n')) {
    try { const d = JSON.parse(line); if (d.hintChars > 0 && d.session) s.add(d.session); } catch { /* skip */ }
  }
  return s;
}

function blank() { return { sessions: 0, prompts: 0, cost: 0, byModel: {} }; }
function add(a, model, c) {
  const fam = (String(model).match(/fable|opus|sonnet|haiku/) || ['other'])[0];
  a.cost += c;
  a.byModel[fam] = (a.byModel[fam] || 0) + c;
}

function report({ projectsDir, dataDir, since }) {
  const hinted = hintedSessions(dataDir);
  const arms = { routed: blank(), baseline: blank() };
  const sessionArm = new Map();
  const files = listTranscripts(projectsDir);
  // Main transcripts first so every session has an arm before its subagent files are counted.
  for (const f of files.filter(f => !f.includes(SUB))) {
    const turns = readTurns(f).filter(t => !since || (t.ts || '') >= since);
    if (!turns.length) continue;
    const arm = hinted.has(turns[0].session) ? 'routed' : 'baseline';
    sessionArm.set(turns[0].session, arm);
    const a = arms[arm];
    a.sessions++;
    a.prompts += turns.length;
    for (const t of turns) for (const [m, c] of Object.entries(t.byModel)) add(a, m, c);
  }
  for (const f of files.filter(f => f.includes(SUB))) {
    const { session, byModel, ts } = fileCost(f);
    if (since && (ts || '') < since) continue;
    const arm = sessionArm.get(session);
    if (arm) for (const [m, c] of Object.entries(byModel)) add(arms[arm], m, c);
  }
  for (const a of Object.values(arms)) {
    a.perPrompt = a.prompts ? a.cost / a.prompts : 0;
    a.cheapShare = a.cost ? (a.byModel.haiku || 0) / a.cost : 0;
  }
  const b = arms.baseline.perPrompt;
  const savingPct = b && arms.routed.prompts ? (1 - arms.routed.perPrompt / b) * 100 : null;
  return { since: since || null, hintedSessions: hinted.size, arms, savingPct };
}

function print(r) {
  const row = (n, a) => `${n.padEnd(9)} ${String(a.sessions).padStart(8)} ${String(a.prompts).padStart(8)} ${('$' + a.cost.toFixed(2)).padStart(11)} ${('$' + a.perPrompt.toFixed(3)).padStart(10)} ${(a.cheapShare * 100).toFixed(1).padStart(6)}%`;
  console.log(`jev-router savings report${r.since ? ` since ${r.since}` : ''} (first-party list prices)`);
  console.log('arm       sessions  prompts        cost   $/prompt  haiku$');
  console.log(row('routed', r.arms.routed));
  console.log(row('baseline', r.arms.baseline));
  if (r.savingPct !== null && r.arms.routed.prompts < MIN_PROMPTS) console.log(`\nToo little routed data (${r.arms.routed.prompts} prompts, need ${MIN_PROMPTS}): no saving can be claimed yet.`);
  else if (r.savingPct === null) console.log('\nNo routed sessions in range: enable the router and use it before reading a saving.');
  else console.log(`\nRouted sessions cost ${Math.abs(r.savingPct).toFixed(1)}% ${r.savingPct >= 0 ? 'less' : 'MORE'} per prompt than baseline.`);
  console.log('Caveat: sessions are not randomised; compare like-for-like periods (--since) before quoting a number.');
  if (r.budget) {
    const b = r.budget;
    console.log(`\nBudget: $${b.spent.toFixed(2)} of $${b.limit.toFixed(2)} spent this month (${b.day}/${b.daysInMonth} days); projected $${b.projected.toFixed(2)} → ${b.projected > b.limit ? 'OVER budget: lower the default model/effort or route more to cheap subagents' : 'within budget'}.`);
  }
}

// Month-to-date spend from all sessions, projected linearly to month end.
function monthStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Pass the main report when it already covers exactly this month, so logs are read once.
function budgetStatus(projectsDir, dataDir, limit, now = new Date(), monthReport = null) {
  const r = monthReport || report({ projectsDir, dataDir, since: monthStart(now) });
  const spent = r.arms.routed.cost + r.arms.baseline.cost;
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { limit, spent, day, daysInMonth, projected: (spent / day) * daysInMonth };
}

if (require.main === module) {
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  const projectsDir = arg(argv, '--projects') || path.join(cfg.configDir, 'projects');
  const dataDir = arg(argv, '--data') || cfg.dataDir;
  const limit = Number(arg(argv, '--budget'));
  const since = arg(argv, '--since') || (limit > 0 ? monthStart(new Date()) : null);
  const r = report({ projectsDir, dataDir, since });
  const sameMonth = since && monthStart(new Date()).startsWith(since.slice(0, 10)) ? r : null;
  if (limit > 0) r.budget = budgetStatus(projectsDir, dataDir, limit, new Date(), sameMonth);
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else print(r);
}

module.exports = { report, budgetStatus };
