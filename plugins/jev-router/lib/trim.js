'use strict';
const HEAD = 150;
const TAIL = 100;

function trimText(text, limit) {
  if (typeof text !== 'string' || !limit) return text;
  const lines = text.split('\n');
  if (lines.length <= Math.max(limit, HEAD + TAIL + 1)) return text;
  const cut = lines.length - HEAD - TAIL;
  return [...lines.slice(0, HEAD), `… [jev-router trimmed ${cut} lines; re-run with grep/head/tail to see them] …`, ...lines.slice(-TAIL)].join('\n');
}

function trimResponse(resp, limit) {
  if (!limit) return null;
  if (typeof resp === 'string') {
    const t = trimText(resp, limit);
    return t === resp ? null : t;
  }
  if (resp && typeof resp === 'object' && !Array.isArray(resp)) {
    const out = { ...resp };
    let changed = false;
    for (const k of ['stdout', 'stderr', 'output']) {
      if (typeof out[k] !== 'string') continue;
      const t = trimText(out[k], limit);
      if (t !== out[k]) { out[k] = t; changed = true; }
    }
    return changed ? out : null;
  }
  return null;
}

module.exports = { trimText, trimResponse, HEAD, TAIL };
