#!/usr/bin/env node
'use strict';
// Dev tool: real hook wall-clock time (process spawn + engine load) on this machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const data = path.resolve(process.argv[2] || '.engine-test');
const scripts = path.join(__dirname, '..', 'plugins', 'jev-router', 'scripts');
const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, JEV_BASE_URL: '' };
const big = path.join(os.tmpdir(), 'jr-bench-big.txt');
fs.writeFileSync(big, 'x\n'.repeat(5000));

function time(script, input, n = 20) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [path.join(scripts, script)], { input: JSON.stringify({ ...input, session_id: `bench-${i}` }), env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${script} exited ${r.status}: ${r.stderr}`);
    t.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  t.sort((a, b) => a - b);
  return { p50: Math.round(t[Math.floor(n / 2)]), p95: Math.round(t[Math.min(n - 1, Math.floor(n * 0.95))]) };
}

const route = time('route-prompt.js', { prompt: 'where is the rate limiter implemented?', cwd: process.cwd() });
const guard = time('guard-tool.js', { tool_name: 'Read', tool_input: { file_path: big }, cwd: process.cwd() });
fs.rmSync(big, { force: true });
const cpu = os.cpus()[0];
console.log(JSON.stringify({ machine: `${cpu ? cpu.model : 'cpu'} · ${os.cpus().length} threads · ${Math.round(os.totalmem() / 2 ** 30)} GB · ${process.platform}`, route, guard }, null, 2));
if (route.p95 > 1200 || guard.p95 > 200) {
  console.error('Latency budget exceeded (route p95 ≤ 1200 ms, guard p95 ≤ 200 ms).');
  process.exit(1);
}
