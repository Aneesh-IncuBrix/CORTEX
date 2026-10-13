'use strict';
const LEVELS = ['trivial', 'simple', 'moderate', 'hard'];

// Savings strategy: say as little as possible, and only when it is likely right.
function toHint(d, { agentsByName }) {
  if (!d) return null;
  const parts = [];
  const confidentLevel = d.difficultyConf >= 0.5;
  // Agent names come from installed files; only plain names may reach Claude's context.
  const safeAgent = typeof d.agent === 'string' && /^[\w.:-]{1,64}$/.test(d.agent);
  if (safeAgent && d.agentConf >= 0.55) {
    const a = agentsByName && agentsByName.get(d.agent);
    const model = a && a.model && a.model !== 'inherit' ? ` [${a.model}]` : '';
    parts.push(`delegate to subagent "${d.agent}"${model}`); // tool-neutral: the tool was renamed Task → Agent (U7)
  } else if (d.difficulty <= 1 && confidentLevel) {
    parts.push('delegate file search/reading to jev-router:scout [haiku]');
  }
  if (d.difficulty <= 1 && confidentLevel && !d.verbose) parts.push('answer tersely');
  if (!parts.length) return null;
  const line = `[jev-router] ${LEVELS[d.difficulty] || 'unknown'} (${Number(d.difficultyConf || 0).toFixed(2)}) · ${parts.join(' · ')}`;
  return line.slice(0, 300);
}

module.exports = { toHint, LEVELS };
