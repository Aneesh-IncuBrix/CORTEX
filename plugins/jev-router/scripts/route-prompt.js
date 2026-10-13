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
const { appendCapped, fingerprint, readTail } = require('../lib/log');
const { armOf, recordArm, contextNote } = require('../lib/experiment');
const { lastContextTokens, priceOf } = require('../lib/transcripts');

const cfg = loadConfig();
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const round = x => Number((x || 0).toFixed(2));
const ROUTABLE = ['ready', 'lite', 'remote'];

const DECISIONS = () => path.join(cfg.dataDir, 'decisions.jsonl');
const out = text => (text ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } : null);

// Context warning works without the engine: it only reads the transcript tail.
function contextWarning(input) {
  if (!cfg.ctxWarnTokens || typeof input.transcript_path !== 'string') return null;
  const { tokens, model } = lastContextTokens(input.transcript_path);
  const last = readTail(DECISIONS(), 50).filter(d => d.session === input.session_id && d.ctxBand).pop();
  const c = contextNote(tokens, cfg.ctxWarnTokens, last ? last.ctxBand : 0, priceOf(model)[2]);
  if (c) appendCapped(DECISIONS(), { ts: new Date().toISOString(), session: input.session_id, ctxTokens: tokens, ctxBand: c.band });
  return c && c.note;
}

runHook('route-prompt', 7000, async (input) => {
  if (cfg.mode !== 'advise') return null;
  const arm = armOf(input.session_id, cfg.holdoutPercent);
  recordArm(cfg.dataDir, input.session_id, arm);
  if (arm === 'holdout') return null; // control group: no hints at all, so the saving can be measured
  const ctx = contextWarning(input);
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (heuristics.isTrivialPrompt(prompt)) return out(ctx);
  const useRemote = Boolean(cfg.jevBaseUrl) && isLoopbackUrl(cfg.jevBaseUrl);
  if (cfg.jevBaseUrl && !useRemote) {
    logError(cfg.dataDir, 'route-prompt', new Error('ignored non-loopback JEV_BASE_URL'));
    return out(ctx);
  }
  const state = useRemote ? 'remote' : readinessState(cfg.dataDir).state;
  if (!ROUTABLE.includes(state)) return out(ctx); // hard gate: missing / stale / broken

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
  appendCapped(DECISIONS(), {
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
  return out([hint, ctx].filter(Boolean).join('\n'));
}, cfg.dataDir);
