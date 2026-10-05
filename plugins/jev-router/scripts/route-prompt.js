#!/usr/bin/env node
'use strict';
const path = require('path');
const { loadConfig, isLoopbackUrl } = require('../lib/config');
const { runHook, logError } = require('../lib/hookio');
const { loadCatalog } = require('../lib/catalog');
const { shortlist } = require('../lib/shortlist');
const heuristics = require('../lib/heuristics');
const { toHint } = require('../lib/policy');
const { decide, combine } = require('../lib/engine');
const { readinessState } = require('../lib/engine/manifest');
const { appendCapped, fingerprint } = require('../lib/log');

const cfg = loadConfig();
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const round = x => Number((x || 0).toFixed(2));
const ROUTABLE = ['ready', 'lite', 'remote'];

runHook('route-prompt', 7000, async (input) => {
  if (cfg.mode !== 'advise') return null;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (heuristics.isTrivialPrompt(prompt)) return null;
  const useRemote = Boolean(cfg.jevBaseUrl) && isLoopbackUrl(cfg.jevBaseUrl);
  if (cfg.jevBaseUrl && !useRemote) {
    logError(cfg.dataDir, 'route-prompt', new Error('ignored non-loopback JEV_BASE_URL'));
    return null;
  }
  const state = useRemote ? 'remote' : readinessState(cfg.dataDir).state;
  if (!ROUTABLE.includes(state)) return null; // hard gate: missing / stale / broken

  const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { agents } = loadCatalog({ configDir: cfg.configDir, projectDir, dataDir: cfg.dataDir, pluginRoot: PLUGIN_ROOT });
  const shortlisted = shortlist(agents, prompt, 12);
  const heur = heuristics.decide({ prompt, candidates: shortlisted });

  let final = null;
  let error;
  if (state !== 'lite') { // U8: lite mode routes on built-in rules only
    try {
      const d = await decide({ prompt, agents, shortlisted, cfg, useRemote });
      if (d) final = combine(d, heur);
    } catch (e) {
      error = e.message;
    }
  }
  if (!final) final = { ...heur, source: state === 'lite' ? 'heuristic' : 'heuristic-fallback' };

  const hint = toHint(final, { agentsByName: new Map(agents.map(a => [a.name, a])) });
  appendCapped(path.join(cfg.dataDir, 'decisions.jsonl'), {
    ts: new Date().toISOString(),
    session: input.session_id,
    prompt: fingerprint(prompt),
    source: final.source,
    difficulty: final.difficulty,
    conf: round(final.difficultyConf),
    agent: final.agent,
    agentConf: round(final.agentConf),
    hintChars: hint ? hint.length : 0,
    latencyMs: final.latencyMs || 0,
    ...(error ? { error } : {}),
  });
  return hint ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: hint } } : null;
}, cfg.dataDir);
