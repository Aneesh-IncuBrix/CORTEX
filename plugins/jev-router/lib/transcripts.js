'use strict';
// Reads Claude Code session transcripts (~/.claude/projects/**.jsonl) into per-prompt turns with token cost.
const fs = require('fs');
const path = require('path');

// $ per 1M tokens: [input, output, cacheRead]. Source: Claude API pricing table cached 2026-10-06.
// ponytail: unknown models price at Opus rates; update this table when prices change.
const PRICES = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01], // cache read not in the source table: assumed 10% of input
};
const DEFAULT_PRICE = PRICES['claude-opus-5-5'];

function priceOf(model) {
  const key = Object.keys(PRICES).find(k => String(model || '').startsWith(k));
  return key ? PRICES[key] : DEFAULT_PRICE;
}

function usageCost(model, u) {
  const [inp, out, read] = priceOf(model);
  const c = u.cache_creation || {};
  const w1h = c.ephemeral_1h_input_tokens || 0;
  const w5m = c.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
  return ((u.input_tokens || 0) * inp + (u.output_tokens || 0) * out + (u.cache_read_input_tokens || 0) * read
    + w5m * inp * 1.25 + w1h * inp * 2) / 1e6;
}

function listTranscripts(root) {
  const out = [];
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

function readLines(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* partial line from a live session */ }
  }
  return rows;
}

// A real typed prompt: string content, not a tool result, not a harness notification.
function promptText(row) {
  if (row.type !== 'user' || row.isSidechain || !row.message) return null;
  const c = row.message.content;
  // IDE prompts arrive as text blocks next to <ide_selection>-style context blocks; tool results are not prompts.
  const blocks = typeof c === 'string' ? [c] : Array.isArray(c) && !c.some(b => b.type === 'tool_result')
    ? c.filter(b => b.type === 'text').map(b => b.text) : [];
  const t = blocks.map(s => String(s).trim()).filter(s => s && !s.startsWith('<')).join('\n');
  return t || null;
}

// The user pushing back on the previous answer: the outcome signal that the last turn fell short.
const CORRECTION = /^(no\b|nope|wrong|incorrect|that'?s (not|wrong)|not what i|(it )?(doesn'?t|didn'?t|still (doesn'?t|isn'?t|not)) work|still (broken|failing|wrong)|try again|revert|undo|you (broke|missed|forgot))/i;

// Context the next request re-sends: input + cache read + cache write of the last main-thread response.
// Reads only the file tail so the hook stays fast on long sessions.
function lastContextTokens(file, tailBytes = 262144) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let r;
      try { r = JSON.parse(lines[i]); } catch { continue; }
      const u = r.type === 'assistant' && !r.isSidechain && r.message && r.message.usage;
      if (u) return { model: r.message.model, tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) };
    }
    return { model: null, tokens: 0 };
  } catch {
    return { model: null, tokens: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Assistant rows repeat usage on every content block of one response: count each response once.
function* responses(rows) {
  const seen = new Set();
  for (const row of rows) {
    const m = row.message;
    if (row.type !== 'assistant' || !m || !m.usage) continue;
    const id = m.id || row.requestId;
    const first = !id || !seen.has(id);
    if (id) seen.add(id);
    yield { row, m, first };
  }
}

// Main-thread turns: one per typed prompt, with cost, output tokens and tool calls until the next prompt.
function readTurns(file) {
  const turns = [];
  let cur = null;
  const rows = readLines(file);
  const idx = new Map(rows.map((r, i) => [r, i]));
  const starts = [];
  rows.forEach((r, i) => { const p = promptText(r); if (p) starts.push([i, { session: r.sessionId, ts: r.timestamp, prompt: p, cost: 0, tokens: 0, outTokens: 0, tools: 0, byModel: {} }]); });
  let s = 0;
  for (const { row, m, first } of responses(rows)) {
    const i = idx.get(row);
    while (s < starts.length && starts[s][0] < i) { cur = starts[s][1]; markCorrection(turns, cur); turns.push(cur); s++; }
    if (!cur || row.isSidechain) continue;
    for (const b of m.content || []) {
      if (b.type !== 'tool_use') continue;
      cur.tools++;
      // Subagent work lives in another file; a hand-off means the real work was not small.
      if (/^(Agent|Task|Workflow)$/.test(b.name)) cur.delegated = true;
    }
    if (!first) continue;
    const c = usageCost(m.model, m.usage);
    cur.cost += c;
    cur.byModel[m.model] = (cur.byModel[m.model] || 0) + c;
    cur.outTokens += m.usage.output_tokens || 0;
    const u = m.usage;
    cur.tokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  }
  while (s < starts.length) { markCorrection(turns, starts[s][1]); turns.push(starts[s++][1]); }
  return turns;
}

function markCorrection(turns, next) {
  if (turns.length && CORRECTION.test(next.prompt)) turns[turns.length - 1].corrected = true;
}

// Whole-file cost by model (used for subagent transcripts and session totals).
function fileCost(file) {
  let session = null;
  let ts = null;
  const byModel = {};
  const rows = readLines(file);
  for (const r of rows) if (r.sessionId) { session = r.sessionId; ts = r.timestamp; break; }
  for (const { m, first } of responses(rows)) {
    if (first) byModel[m.model] = (byModel[m.model] || 0) + usageCost(m.model, m.usage);
  }
  return { session, ts, byModel };
}

module.exports = { usageCost, listTranscripts, promptText, readTurns, fileCost, lastContextTokens, priceOf };
