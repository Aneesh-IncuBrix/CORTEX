'use strict';
const path = require('path');
const { readReady } = require('./manifest');
const { VectorCache } = require('./vectors');
const { choice, score, noul, dot } = require('./questions');
const { isLoopbackUrl } = require('../config');
const { loadLabels, knnDifficulty } = require('./knn');

const LEVELS = [
  ['a greeting, thanks, ok, or an acknowledgement', 'thanks!', 'ok got it'],
  ['a quick lookup, finding or listing something, a one-fact question, or a tiny single-file edit like a typo or rename', 'where is the login handler defined?', 'fix the typo in the readme'],
  ['a multi-step change across a few files, writing tests, or debugging with clear leads', 'add validation to the signup endpoint and update its tests', 'the build fails with a type error in the api module'],
  ['architecture or system design, ambiguous debugging, a large refactor, or a migration', 'design a multi-region failover architecture', 'refactor the billing module into services and migrate the data'],
];
const VERBOSE = {
  true: 'explain in detail, walk me through it step by step, teach me how this works',
  false: 'just do it, make the change, give a short direct answer',
};
const MAIN = 'general conversation, answering a question directly, discussing options and deciding';
const TOP_SEMANTIC = 12;
const MAX_NEW_AGENT_EMBEDS = 40; // U14: warm big catalogs gradually instead of timing out forever

function agentText(a) {
  return `${a.name.replace(/^[^:]+:/, '').replace(/[-_:]/g, ' ')}: ${a.description}`;
}

async function decideLocal({ prompt, agents, shortlisted, embedder, cache, labels }) {
  const t0 = Date.now();
  let fresh = 0;
  const vec = async text => {
    const hit = cache.get(text);
    if (hit) return hit;
    const v = await embedder.embed(text);
    cache.set(text, v);
    if (++fresh % 20 === 0) cache.save(); // progress survives a hook timeout
    return v;
  };
  const sv = await embedder.embed(String(prompt).slice(0, 4000));
  const scored = [];
  let skippedAgents = 0;
  let newAgentEmbeds = 0;
  for (const a of agents) {
    const text = agentText(a);
    if (!cache.get(text)) {
      if (newAgentEmbeds >= MAX_NEW_AGENT_EMBEDS) { skippedAgents++; continue; }
      newAgentEmbeds++;
    }
    scored.push({ a, s: dot(sv, await vec(text)) });
  }
  cache.save();
  scored.sort((x, y) => y.s - x.s);
  const pool = new Map();
  for (const { a } of scored.slice(0, TOP_SEMANTIC)) pool.set(a.name, a);
  for (const a of shortlisted || []) pool.set(a.name, a);
  const keyToName = {};
  const criteria = { main: MAIN };
  let i = 0;
  for (const a of pool.values()) {
    const k = `a${++i}`;
    keyToName[k] = a.name;
    criteria[k] = agentText(a);
  }
  const ag = await choice(vec, sv, criteria);
  const df = labels ? knnDifficulty(sv, labels) : await score(vec, sv, LEVELS);
  const vb = await noul(vec, sv, VERBOSE);
  return {
    source: labels ? 'engine-knn' : 'engine',
    difficulty: df.level,
    difficultyDist: df.probabilities,
    difficultyConf: df.confidence,
    agent: ag.choice === 'main' ? null : keyToName[ag.choice],
    agentConf: ag.confidence,
    verboseP: vb.noul,
    verbose: vb.noul >= 0.7,
    skippedAgents,
    latencyMs: Date.now() - t0,
  };
}

function parseRemote(json, keyToName) {
  const a = (json && json.answers) || {};
  const d = a.difficulty || {};
  let dist = null;
  if (d.probabilities && typeof d.probabilities === 'object') {
    const vals = Array.isArray(d.probabilities) ? d.probabilities : Object.values(d.probabilities);
    if (vals.length === 4 && vals.every(Number.isFinite)) dist = vals;
  }
  if (!dist && Number.isFinite(d.score)) {
    const lvl = Math.max(0, Math.min(3, Math.round(d.score > 1 ? d.score : d.score * 3)));
    dist = [0, 0, 0, 0];
    dist[lvl] = 1;
  }
  if (!dist) return null;
  const lvl = dist.indexOf(Math.max(...dist));
  const ch = a.agent || {};
  const vp = a.verbose && Number.isFinite(a.verbose.noul) ? a.verbose.noul : 0;
  return {
    source: 'remote',
    difficulty: lvl,
    difficultyDist: dist,
    difficultyConf: Number.isFinite(d.confidence) ? d.confidence : dist[lvl],
    agent: ch.choice && ch.choice !== 'main' ? keyToName[ch.choice] || null : null,
    agentConf: Number.isFinite(ch.confidence) ? ch.confidence : 0,
    verboseP: vp,
    verbose: vp >= 0.7,
  };
}

async function decideRemote({ baseUrl, prompt, shortlisted, timeoutMs }) {
  if (!isLoopbackUrl(baseUrl)) throw new Error('refusing non-loopback JEV_BASE_URL');
  const keyToName = {};
  const criteria = { main: MAIN };
  (shortlisted || []).forEach((a, i) => { keyToName[`a${i + 1}`] = a.name; criteria[`a${i + 1}`] = agentText(a); });
  const body = {
    model: 'jev-latest',
    state: { request: String(prompt).slice(0, 4000) },
    questions: {
      difficulty: { type: 'score', instructions: 'How much reasoning and work does this coding-assistant request need?', criteria: LEVELS.map(l => l[0]) },
      agent: { type: 'choice', instructions: 'Which specialist should do the bulk of this request? Choose main if the main conversation should handle it directly.', criteria },
      verbose: { type: 'noul', instructions: 'Does the user explicitly ask for a detailed explanation, walkthrough, or teaching?' },
    },
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(new URL('/v1/systemone', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
      redirect: 'error',
    });
    if (!r.ok) throw new Error(`remote status ${r.status}`);
    const d = parseRemote(await r.json(), keyToName);
    if (d) d.latencyMs = Date.now() - t0;
    return d;
  } finally {
    clearTimeout(timer);
  }
}

function combine(engine, heur) {
  const dist = [0, 1, 2, 3].map(i => {
    const e = engine.difficultyDist ? engine.difficultyDist[i] : (i === engine.difficulty ? 1 : 0);
    // kNN learned from this user's history; the keyword heuristic only helps the untrained scorer.
    const hw = engine.source === 'engine-knn' ? 0 : 0.4;
    return (1 - hw) * e + hw * (i === heur.difficulty ? 1 : 0);
  });
  const lvl = dist.indexOf(Math.max(...dist));
  return { ...engine, difficulty: lvl, difficultyConf: dist[lvl], verbose: Boolean(heur.verbose || engine.verboseP >= 0.7) };
}

async function decide({ prompt, agents, shortlisted, cfg, useRemote, createEmbedder, isReady }) {
  const work = (async () => {
    if (useRemote) return decideRemote({ baseUrl: cfg.jevBaseUrl, prompt, shortlisted, timeoutMs: cfg.engineTimeoutMs });
    if (!(isReady || readReady)(cfg.dataDir)) return null;
    const make = createEmbedder || (dir => require('./local').LocalEmbedder.create(dir));
    const embedder = await make(cfg.dataDir);
    const cache = new VectorCache(path.join(cfg.dataDir, 'vectors.json'));
    try {
      return await decideLocal({ prompt, agents, shortlisted, embedder, cache, labels: loadLabels(cfg.dataDir) });
    } finally {
      cache.save();
    }
  })();
  work.catch(() => {});
  let timer;
  const timeout = new Promise(res => { timer = setTimeout(() => res(null), cfg.engineTimeoutMs); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { decide, decideLocal, decideRemote, parseRemote, combine, agentText, LEVELS };
