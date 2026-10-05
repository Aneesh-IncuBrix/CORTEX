'use strict';
// JEV-style typed questions over normalised embeddings (cosine = dot product).

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function softmax(xs, T = 0.05) {
  const m = Math.max(...xs);
  const e = xs.map(x => Math.exp((x - m) / T));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / s);
}

function argmax(xs) {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

async function choice(vec, stateVec, criteria, T = 0.05) {
  const keys = Object.keys(criteria);
  const sims = [];
  for (const k of keys) sims.push(dot(stateVec, await vec(criteria[k])));
  const p = softmax(sims, T);
  const i = argmax(p);
  return { choice: keys[i], probabilities: Object.fromEntries(keys.map((k, j) => [k, p[j]])), confidence: p[i] };
}

async function score(vec, stateVec, levels, T = 0.05) {
  const sims = [];
  for (const texts of levels) {
    let best = -Infinity;
    for (const t of [].concat(texts)) best = Math.max(best, dot(stateVec, await vec(t)));
    sims.push(best);
  }
  const p = softmax(sims, T);
  const i = argmax(p);
  return { score: p.reduce((s, x, j) => s + x * j, 0), level: i, probabilities: p, confidence: p[i] };
}

async function noul(vec, stateVec, criteria, T = 0.05) {
  const p = softmax([dot(stateVec, await vec(criteria.true)), dot(stateVec, await vec(criteria.false))], T);
  return { noul: p[0] };
}

module.exports = { dot, softmax, argmax, choice, score, noul };
