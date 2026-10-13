#!/usr/bin/env node
'use strict';
// Builds a self-contained local HTML dashboard: token use and cost before vs after jev-router, and quality.
// Usage: node dashboard.js [--data <dir>] [--projects <dir>] [--days 60] [--out <file.html>] [--open]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('../lib/config');
const { listTranscripts, readTurns, costRows } = require('../lib/transcripts');
const { oldestFirst } = require('./savings-report');
const { readArms } = require('../lib/experiment');
const { readTail } = require('../lib/log');

const SUB = `${path.sep}subagents${path.sep}`;
const MIN_PROMPTS = 100;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

function arg(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}

// First moment the plugin acted: earliest arm assignment or engine decision.
function installedAt(dataDir) {
  const ts = [];
  try {
    for (const line of fs.readFileSync(path.join(dataDir, 'arms.jsonl'), 'utf8').split('\n')) {
      try { ts.push(JSON.parse(line).ts); } catch { /* skip */ }
    }
  } catch { /* none yet */ }
  for (const d of readTail(path.join(dataDir, 'decisions.jsonl'), 1000)) if (d.source) ts.push(d.ts);
  const first = ts.filter(t => ISO.test(t || '')).sort()[0];
  // The hook logs just after the prompt that triggered it is written; step back so that prompt counts as "after".
  return first ? new Date(Date.parse(first) - 60000).toISOString() : null;
}

function blank() { return { prompts: 0, cost: 0, tokens: 0, corrections: 0 }; }

function finish(p) {
  p.perPrompt = p.prompts ? p.cost / p.prompts : 0;
  p.tokensPerPrompt = p.prompts ? p.tokens / p.prompts : 0;
  p.pushback = p.prompts ? p.corrections / p.prompts : 0;
  const accepted = p.prompts - p.corrections;
  p.perAccepted = accepted > 0 ? p.cost / accepted : 0; // cost of an answer the user did not push back on
  return p;
}

// Compare routed with the fairest reference available: the random holdout, else the period before install.
function verdict(ph) {
  const ref = ph.holdout.prompts >= MIN_PROMPTS ? 'holdout' : 'before';
  const r = ph.routed;
  const b = ph[ref];
  if (r.prompts < MIN_PROMPTS || !b.prompts || !b.perAccepted) {
    return { ready: false, ref, text: `Collecting data: ${r.prompts}/${MIN_PROMPTS} prompts with the plugin. No saving is claimed until there is enough.` };
  }
  const saving = 1 - r.perAccepted / b.perAccepted;
  const qualityPts = (r.pushback - b.pushback) * 100;
  const held = qualityPts <= 1;
  return {
    ready: true, ref, saving, qualityPts,
    text: `${(Math.abs(saving) * 100).toFixed(1)}% ${saving >= 0 ? 'cheaper' : 'MORE expensive'} per accepted answer than ${ref === 'holdout' ? 'the random holdout' : 'before install'}; quality ${held ? 'held' : 'DROPPED'} (pushback ${qualityPts >= 0 ? '+' : ''}${qualityPts.toFixed(1)} pts).`,
  };
}

function collect({ projectsDir, dataDir, days, now = new Date() }) {
  const since = new Date(now.getTime() - days * 864e5).toISOString();
  const install = installedAt(dataDir);
  const arms = readArms(dataDir);
  const phases = { before: blank(), routed: blank(), holdout: blank(), off: blank() };
  const daily = {};
  const seenResponses = new Set();
  const seenPrompts = new Set();
  // Every billed response counts once (main thread, subagents, compaction); prompts and pushback come from typed turns.
  const bucket = (ts, session) => {
    if (!ISO.test(ts || '') || ts < since) return null; // only well-formed dates reach the page's HTML
    const phase = !install || ts < install ? 'before' : arms.get(session) || 'off';
    const key = `${ts.slice(0, 10)}|${phase}`;
    daily[key] = daily[key] || blank();
    return [phases[phase], daily[key]];
  };
  for (const f of oldestFirst(listTranscripts(projectsDir))) {
    if (!f.includes(SUB)) {
      for (const t of readTurns(f, seenPrompts)) {
        for (const target of bucket(t.ts, t.session) || []) {
          target.prompts++;
          if (t.corrected) target.corrections++;
        }
      }
    }
    for (const r of costRows(f, seenResponses)) {
      for (const target of bucket(r.ts, r.session) || []) {
        target.cost += r.cost;
        target.tokens += r.tokens;
      }
    }
  }
  for (const p of Object.values(phases)) finish(p);
  const series = Object.entries(daily)
    .map(([key, v]) => ({ day: key.split('|')[0], phase: key.split('|')[1], ...finish(v) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  return { generatedAt: now.toISOString(), days, install, phases, series, verdict: verdict(phases), calibration: readCalibration(dataDir) };
}

// Written by reconcile-cost.js; numbers only, sanitised because they reach the page.
function readCalibration(dataDir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'calibration.json'), 'utf8'));
    if (!['anthropic', 'bedrock'].includes(c.source) || !/^\d{4}-\d{2}-\d{2}$/.test(c.from) || !/^\d{4}-\d{2}-\d{2}$/.test(c.to)) return null;
    return { source: c.source, from: c.from, to: c.to, estimated: Number(c.estimated) || 0, billed: Number(c.billed) || 0, factor: Number(c.factor) || null };
  } catch {
    return null;
  }
}

function html(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token Savings Dashboard</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#5f5f5a;--line:#e3e2dd;--before:#8a8a85;--routed:#2f6fde;--holdout:#c77d12;--off:#b9b8b2;--good:#1f7a3f;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#f0efe9;--muted:#a9a8a1;--line:#33322f;--before:#8f8f88;--routed:#6ea1ff;--holdout:#f0a83a;--off:#5c5b56;--good:#5cc98a;--bad:#ff7b6b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.verdict{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--muted);border-radius:8px;padding:14px 16px;margin-bottom:20px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}.card h2{font-size:13px;font-weight:600;color:var(--muted);margin:0 0 8px}
.vs{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.big{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}.small{color:var(--muted);font-size:13px}
.delta{font-size:13px;font-weight:600}.good{color:var(--good)}.bad{color:var(--bad)}
.chart{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:20px;overflow-x:auto}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin-bottom:8px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:14px}th,td{text-align:right;padding:8px 6px;border-bottom:1px solid var(--line);white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600}
footer{color:var(--muted);font-size:13px}
</style></head><body><main>
<h1>Token savings</h1><p class="sub" id="sub"></p>
<div class="verdict" id="verdict"></div>
<p class="sub" id="cal"></p>
<div class="grid" id="kpis"></div>
<div class="chart"><h2 class="small" style="margin:0 0 6px">Cost per prompt by day</h2><div class="legend" id="legend"></div><div id="bars"></div></div>
<div class="card" style="margin-bottom:20px"><h2>All groups</h2><div class="tw"><table id="tbl"></table></div></div>
<footer>List prices for first-party API usage; subscription or proxy-routed usage is billed differently. Cost covers every billed Claude Code response: main conversation, subagents, compaction and web searches, each counted once even when a resumed session repeats it. It does not include model calls your own application makes (see /jev-router:optimize for those). "Pushback" means your next prompt said the answer was wrong; "cost per accepted answer" spreads the cost over answers you did not push back on, so cheaper-but-worse does not look like a saving. Holdout = sessions randomly given no hints, the fair comparison.</footer>
</main>
<script type="application/json" id="data">${json}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent);
const $=n=>'$'+n.toFixed(n<1?3:2), k=n=>n>=1e6?(n/1e6).toFixed(1)+'M':Math.round(n/1e3)+'k', pc=n=>(n*100).toFixed(1)+'%';
const ref=D.phases[D.verdict.ref], r=D.phases.routed, name={before:'Before plugin',routed:'With plugin',holdout:'Holdout (no hints)',off:'Plugin off'};
document.getElementById('sub').textContent='Last '+D.days+' days · plugin first active '+(D.install?D.install.slice(0,10):'not yet')+' · generated '+D.generatedAt.slice(0,16).replace('T',' ')+' UTC';
const v=document.getElementById('verdict');v.textContent=D.verdict.text;
const C=D.calibration;document.getElementById('cal').textContent=C?'Real bill ('+(C.source==='bedrock'?'AWS Bedrock':'Anthropic')+', '+C.from+' to '+C.to+'): $'+C.billed.toFixed(2)+' billed vs $'+C.estimated.toFixed(2)+' list-price estimate'+(C.factor?' (×'+C.factor.toFixed(2)+'). Dollar figures below are list-price estimates; multiply by '+C.factor.toFixed(2)+' for your real rate.':'.'):'Dollar figures are list-price estimates. Run /jev-router:reconcile with billing access to compare with your real bill.';
if(D.verdict.ready)v.style.borderLeftColor=D.verdict.saving>=0&&D.verdict.qualityPts<=1?'var(--good)':'var(--bad)';
function kpi(title,a,b,fmt){const has=a&&r.prompts;const d=has?(b-a)/a:0;
return '<div class="card"><h2>'+title+'</h2><div class="vs"><div><div class="small">'+name[D.verdict.ref]+'</div><div class="big">'+fmt(a)+'</div></div><div><div class="small">With plugin</div><div class="big">'+(r.prompts?fmt(b):'—')+'</div></div></div>'+(has?'<div class="delta '+(!D.verdict.ready?'small':d<=0?'good':'bad')+'">'+(D.verdict.ready?'':'early: ')+(d>=0?'+':'')+(d*100).toFixed(1)+'%</div>':'')+'</div>'}
document.getElementById('kpis').innerHTML=kpi('Cost per prompt',ref.perPrompt,r.perPrompt,$)+kpi('Tokens per prompt',ref.tokensPerPrompt,r.tokensPerPrompt,k)+kpi('Pushback rate (lower = better quality)',ref.pushback,r.pushback,pc)+kpi('Cost per accepted answer',ref.perAccepted,r.perAccepted,$);
const phases=['before','routed','holdout','off'];
document.getElementById('legend').innerHTML=phases.map(p=>'<span><i style="background:var(--'+p+')"></i>'+name[p]+'</span>').join('');
const S=D.series, max=Math.max(...S.map(s=>s.perPrompt),0.001), W=Math.max(600,S.length*16), H=180;
let svg='<svg width="'+W+'" height="'+(H+24)+'" role="img" aria-label="Daily cost per prompt">';
S.forEach((s,i)=>{const h=Math.max(1,s.perPrompt/max*H);svg+='<rect x="'+(i*16+2)+'" y="'+(H-h)+'" width="12" height="'+h+'" rx="2" fill="var(--'+s.phase+')"><title>'+s.day+' · '+name[s.phase]+' · '+$(s.perPrompt)+'/prompt · '+s.prompts+' prompts · pushback '+pc(s.pushback)+'</title></rect>';
if(i%7===0)svg+='<text x="'+(i*16)+'" y="'+(H+16)+'" font-size="11" fill="var(--muted)">'+s.day.slice(5)+'</text>'});
document.getElementById('bars').innerHTML=S.length?svg+'</svg>':'<p class="small">No sessions in range.</p>';
document.getElementById('tbl').innerHTML='<tr><th>Group</th><th>Prompts</th><th>Cost</th><th>$/prompt</th><th>Tokens/prompt</th><th>Pushback</th><th>$/accepted</th></tr>'+phases.map(p=>{const x=D.phases[p];return '<tr><td>'+name[p]+'</td><td>'+x.prompts+'</td><td>'+$(x.cost)+'</td><td>'+$(x.perPrompt)+'</td><td>'+k(x.tokensPerPrompt)+'</td><td>'+pc(x.pushback)+'</td><td>'+$(x.perAccepted)+'</td></tr>'}).join('');
</script></body></html>`;
}

function open(file) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

if (require.main === module) {
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  const dataDir = arg(argv, '--data', cfg.dataDir);
  const data = collect({ projectsDir: arg(argv, '--projects', path.join(cfg.configDir, 'projects')), dataDir, days: Number(arg(argv, '--days', 60)) });
  const out = path.resolve(arg(argv, '--out', path.join(dataDir, 'dashboard.html')));
  fs.writeFileSync(out, html(data));
  console.log(`${data.verdict.text}\nDashboard: ${out}`);
  if (argv.includes('--open')) open(out);
}

module.exports = { collect, verdict, html };
