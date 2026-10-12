'use strict';
// Difficulty by nearest labelled past prompts (labels.json from scripts/build-labels.js).
// Replaces similarity-to-level-descriptions, which MiniLM cannot separate (everything scored "simple").
const fs = require('fs');
const path = require('path');
const { dot } = require('./questions');

const K = 15;

function loadLabels(dataDir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dataDir, 'labels.json'), 'utf8'));
    return Array.isArray(d.items) && d.items.length >= K ? d.items : null;
  } catch {
    return null;
  }
}

function knnDifficulty(sv, items, k = K) {
  const near = items.map(it => ({ l: it.l, s: dot(sv, it.v) })).sort((a, b) => b.s - a.s).slice(0, k);
  const w = [0, 0, 0, 0];
  for (const n of near) w[n.l] += Math.max(0, n.s);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const probabilities = w.map(x => x / total);
  const level = probabilities.indexOf(Math.max(...probabilities));
  return { level, probabilities, confidence: probabilities[level] };
}

module.exports = { loadLabels, knnDifficulty, K };
