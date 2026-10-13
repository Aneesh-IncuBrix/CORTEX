#!/usr/bin/env node
'use strict';
const path = require('path');
const { loadConfig } = require('../lib/config');
const { runHook } = require('../lib/hookio');
const { evaluate } = require('../lib/guard-rules');
const { keyFor, seenBefore, deniesSoFar, bumpDenies } = require('../lib/ledger');
const { appendCapped } = require('../lib/log');

const cfg = loadConfig();
const MAX_DENIES_PER_SESSION = 5; // U3: never trap a session in a loop of denials

runHook('guard-tool', 4000, async (input) => {
  if (cfg.mode === 'off') return null;
  const rule = evaluate(input.tool_name, input.tool_input || {}, { readLineCap: cfg.readLineCap, cwd: input.cwd });
  if (!rule) return null;
  const log = action => appendCapped(path.join(cfg.dataDir, 'guard.jsonl'), {
    ts: new Date().toISOString(),
    tool: input.tool_name,
    agent: input.agent_type || null,
    action,
  });
  if (deniesSoFar(cfg.dataDir, input.session_id) >= MAX_DENIES_PER_SESSION) { log('breaker-open'); return null; }
  const repeat = seenBefore(cfg.dataDir, input.session_id, keyFor(input.tool_name, input.tool_input));
  log(repeat ? 'allowed-repeat' : 'deny');
  if (repeat) return null;
  bumpDenies(cfg.dataDir, input.session_id);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[jev-router] ${rule.deny}`,
    },
  };
}, cfg.dataDir);
