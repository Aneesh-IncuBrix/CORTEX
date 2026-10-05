#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { runHook } = require('../lib/hookio');
const { trimResponse } = require('../lib/trim');
const { appendCapped } = require('../lib/log');

const cfg = loadConfig();

function dumpShape(input) {
  const resp = input.tool_response;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.dataDir, 'posttool-sample.json'), JSON.stringify({
    inputKeys: Object.keys(input),
    toolName: input.tool_name,
    responseType: Array.isArray(resp) ? 'array' : typeof resp,
    responseKeys: resp && typeof resp === 'object' ? Object.keys(resp) : null,
  }, null, 2));
}

runHook('trim-output', 4000, async (input) => {
  if (process.env.JEV_ROUTER_DUMP_POSTTOOL === '1') dumpShape(input);
  if (cfg.mode === 'off' || !cfg.trimOutputLines || input.tool_name !== 'Bash') return null;
  const updated = trimResponse(input.tool_response, cfg.trimOutputLines);
  if (!updated) return null;
  appendCapped(path.join(cfg.dataDir, 'guard.jsonl'), { ts: new Date().toISOString(), tool: 'Bash', action: 'trim' });
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } };
}, cfg.dataDir);
