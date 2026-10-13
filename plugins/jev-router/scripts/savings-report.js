#!/usr/bin/env node
'use strict';
// Measures cost per prompt in sessions where jev-router gave a hint vs sessions where it did not.
// Usage: node savings-report.js [--data <plugin data dir>] [--projects <dir>] [--since 2026-10-01] [--budget <usd/month>] [--json]
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { listTranscripts, readTurns, costRows } = require('../lib/transcripts');
const { readArms } = require('../lib/experiment');

const MIN_PROMPTS = 100;
const SUB =`${path.sep}subagents${path.sep}`;

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

// Session → arm. arms.jsonl is authoritative; sessions from before it existed fall back to "got a hint".
function sessionArms(dataDir) {
  const arms = readArms(dataDir);
  let raw = '';
  try { raw = fs.readFileSync(path.join(dataDir, 'decisions.jsonl'), 'utf8'); } catch { return arms; }
  for (const line of raw.split('\n')) {
    try { const d = JSON.parse(line); if (d.hintChars > 0 && d.session && !arms.has(d.session)) arms.set(d.session, 'routed'); } catch { /* skip */ }
  }
  return arms;
}

function oldestFirst(files) {
  const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  return files.map(f => [mtime(f), f]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
}

function blank() { return { sessions: 0, prompts: 0, corrections: 0, cost: 0, byModel: {} }; }
function add(a, model, c) {
  const fam = (String(model).match(/fable|opus|sonnet|haiku/) || ['other'])[0];
  a.cost += c;
  a.byModel[fam] = (a.byModel[fam] || 0) + c;
}

function report({ projectsDir, dataDir, since }) {
  const known = sessionArms(dataDir);
  const arms = { routed: blank(), holdout: blank(), baseline: blank() };
  const armOfSession = s => known.get(s) || 'baseline';
  const inRange = ts => !since || (ts || '') >= since;
  const seenResponses = new Set();
  const seenPrompts = new Set();
  const sessions = new Set();
  // Oldest file first, so a resumed session's copied history is owned by the session that produced it.
  for (const f of oldestFirst(listTranscripts(projectsDir))) {
    if (!f.includes(SUB)) {
      for (const t of readTurns(f, seenPrompts)) {
        if (!inRange(t.ts)) continue;
        const a = arms[armOfSession(t.session)];
        if (!sessions.has(t.session)) { sessions.add(t.session); a.sessions++; }
        a.prompts++;
        if (t.corrected) a.corrections++;
      }
    }
    // Cost: every billed response once, main thread and subagents, including calls with no typed prompt.
    for (const r of costRows(f, seenResponses)) if (inRange(r.ts)) add(arms[armOfSession(r.session)], r.model, r.cost);
  }
  for (const a of Object.values(arms)) {
    a.perPrompt = a.prompts ? a.cost / a.prompts : 0;
    a.cheapShare = a.cost ? (a.byModel.haiku || 0) / a.cost : 0;
    a.correctionRate = a.prompts ? a.corrections / a.prompts : 0;
  }
  // Holdout is the fair comparison (same plugin, same period, random sessions); baseline only as a fallback.
  const controlled = arms.holdout.prompts >= MIN_PROMPTS;
  const ref = controlled ? arms.holdout : arms.baseline;
  const savingPct = ref.perPrompt && arms.routed.prompts ? (1 - arms.routed.perPrompt / ref.perPrompt) * 100 : null;
  return { since: since || null, arms, controlled, savingPct, qualityDelta: arms.routed.correctionRate - ref.correctionRate };
}

function print(r) {
  const row = (n, a) => `${n.padEnd(9)} ${String(a.sessions).padStart(8)} ${String(a.prompts).padStart(8)} ${('$' + a.cost.toFixed(2)).padStart(11)} ${('$' + a.perPrompt.toFixed(3)).padStart(10)} ${(a.cheapShare * 100).toFixed(1).padStart(6)}% ${(a.correctionRate * 100).toFixed(1).padStart(7)}%`;
  console.log(`jev-router savings report${r.since ? ` since ${r.since}` : ''} (first-party list prices)`);
  console.log('arm       sessions  prompts        cost   $/prompt  haiku$  pushback');
  for (const n of ['routed', 'holdout', 'baseline']) console.log(row(n, r.arms[n]));
  const vs = r.controlled ? 'the random holdout' : 'baseline (not randomised)';
  if (r.savingPct !== null && r.arms.routed.prompts < MIN_PROMPTS) console.log(`\nToo little routed data (${r.arms.routed.prompts} prompts, need ${MIN_PROMPTS}): no saving can be claimed yet.`);
  else if (r.savingPct === null) console.log('\nNo routed sessions in range: enable the router and use it before reading a saving.');
  else {
    console.log(`\nRouted sessions cost ${Math.abs(r.savingPct).toFixed(1)}% ${r.savingPct >= 0 ? 'less' : 'MORE'} per prompt than ${vs}.`);
    console.log(`Quality: user pushback is ${Math.abs(r.qualityDelta * 100).toFixed(1)} points ${r.qualityDelta > 0 ? 'HIGHER' : 'lower or equal'} in routed sessions.`);
  }
  if (!r.controlled) console.log(`Caveat: holdout has ${r.arms.holdout.prompts} prompts; the comparison is randomised once it reaches ${MIN_PROMPTS}.`);
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
  const spent = Object.values(r.arms).reduce((s, a) => s + a.cost, 0);
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

module.exports = { report, budgetStatus, oldestFirst };
