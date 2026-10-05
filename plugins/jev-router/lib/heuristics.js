'use strict';
const ACK = /^(thanks?|thank you|thx|ty|ok(ay)?|k|cool|great|nice|perfect|got it|sounds good|yes|yep|no|nope|sure|lgtm|done)[\s.!]*$/i;
const UP = /\b(architect\w*|design\w*|refactor\w*|migrat\w*|why|debug\w*|investigat\w*|root cause|race condition|deadlock|intermittent\w*|performance|optimi[sz]\w*|scal(e|ing|ability)|redesign\w*|security audit|across the (repo|codebase|project))\b/gi;
const DOWN = /\b(what is|what's|where is|where's|which file|find|list|show me|rename|typo|spelling|version of)\b/gi;
const VERBOSE = /\b(explain|walk me through|teach me|in detail|step[- ]by[- ]step|help me understand|deep dive)\b/i;
const FILE_PATH = /(?:^|\s)[\w./\\-]+\.[a-z0-9]{1,6}\b/gi;

function count(re, s) {
  return (s.match(re) || []).length;
}

function isTrivialPrompt(prompt) {
  const p = String(prompt || '').trim();
  return p.length < 4 || p.startsWith('/') || ACK.test(p);
}

function difficultyLevel(prompt) {
  const p = String(prompt || '');
  if (ACK.test(p.trim())) return 0;
  let s = 1;
  if (p.length > 400) s++;
  if (p.length > 1500) s++;
  if (count(FILE_PATH, p) > 2) s++;
  s += Math.min(2, count(UP, p));
  s -= Math.min(1, count(DOWN, p));
  return Math.max(1, Math.min(3, s));
}

function pickAgent(candidates) {
  const scored = (candidates || []).filter(c => typeof c.score === 'number' && c.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const [top, second] = scored;
  if (top.score < 2) return null;
  if (second && top.score < 1.5 * second.score) return null;
  return top.name;
}

function decide({ prompt, candidates }) {
  const agent = pickAgent(candidates);
  return {
    source: 'heuristic',
    difficulty: difficultyLevel(prompt),
    difficultyConf: 0.6,
    agent,
    agentConf: agent ? 0.6 : 0,
    verbose: VERBOSE.test(String(prompt || '')),
    latencyMs: 0,
  };
}

module.exports = { decide, difficultyLevel, isTrivialPrompt, pickAgent };
