#!/usr/bin/env node
'use strict';
// Builds labels.json for kNN difficulty from your own past sessions.
// Each typed prompt is labelled by what the turn actually cost: tool calls and output tokens.
// Only embedding vectors and levels are stored, never prompt text.
// Usage: node build-labels.js [--data <dir>] [--projects <dir>] [--max 400]
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { listTranscripts, readTurns } = require('../lib/transcripts');
const { isTrivialPrompt } = require('../lib/heuristics');
const { knnDifficulty } = require('../lib/engine/knn');
const { score } = require('../lib/engine/questions');
const { LEVELS } = require('../lib/engine');

// ponytail: fixed thresholds from one user's history; revisit if label counts are badly skewed.
function labelOf(t) {
  if (t.delegated) return 3;
  const base = t.tools <= 2 && t.outTokens < 1500 ? 1 : t.tools > 20 || t.outTokens > 20000 ? 3 : 2;
  return t.corrected ? Math.min(3, base + 1) : base; // the user had to push back: it was harder than it looked
}

function arg(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}

// Deterministic shuffle so reruns give the same split.
function shuffled(a) {
  let s = 42;
  const r = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  return a.map(x => [r(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
}

async function main() {
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  const dataDir = arg(argv, '--data', cfg.dataDir);
  const projectsDir = arg(argv, '--projects', path.join(cfg.configDir, 'projects'));
  const maxPerLevel = Number(arg(argv, '--max', 400));

  const byLevel = { 1: [], 2: [], 3: [] };
  for (const f of listTranscripts(projectsDir)) {
    if (f.includes(`${path.sep}subagents${path.sep}`)) continue;
    for (const t of readTurns(f)) {
      if (isTrivialPrompt(t.prompt) || t.prompt.length > 4000) continue;
      byLevel[labelOf(t)].push(t.prompt);
    }
  }
  console.log(`labelled prompts: simple=${byLevel[1].length} moderate=${byLevel[2].length} hard=${byLevel[3].length}`);

  const { LocalEmbedder } = require('../lib/engine/local');
  const embedder = await LocalEmbedder.create(dataDir);
  const items = [];
  for (const l of [1, 2, 3]) {
    for (const p of shuffled(byLevel[l]).slice(0, maxPerLevel)) {
      items.push({ l, v: Array.from(await embedder.embed(p), x => Math.round(x * 1e3) / 1e3) });
    }
  }

  // Held-out check: 20% test, compare kNN against the old description-similarity scorer.
  const all = shuffled(items);
  const cut = Math.floor(all.length * 0.8);
  const train = all.slice(0, cut);
  const test = all.slice(cut);
  const descCache = new Map();
  const vec = async t => {
    if (!descCache.has(t)) descCache.set(t, await embedder.embed(t));
    return descCache.get(t);
  };
  let knnOk = 0;
  let oldOk = 0;
  for (const it of test) {
    if (knnDifficulty(it.v, train).level === it.l) knnOk++;
    if ((await score(vec, it.v, LEVELS)).level === it.l) oldOk++;
  }
  const pct = n => (test.length ? ((n / test.length) * 100).toFixed(1) : 'n/a');
  console.log(`held-out accuracy on ${test.length} prompts: kNN ${pct(knnOk)}% vs old scorer ${pct(oldOk)}% (chance ~33%)`);

  fs.writeFileSync(path.join(dataDir, 'labels.json'), JSON.stringify({ v: 1, built: new Date().toISOString(), items }));
  console.log(`wrote ${items.length} labels to ${path.join(dataDir, 'labels.json')}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { labelOf };
