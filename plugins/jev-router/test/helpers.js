'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function tmpDir(prefix = 'jr-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function runScript(script, input, env = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const t = setTimeout(() => { child.kill(); reject(new Error(`timeout: ${script}`)); }, timeoutMs);
    child.on('close', code => {
      clearTimeout(t);
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch { json = undefined; }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// Isolated plugin data + Claude config dirs so tests never touch the real ~/.claude.
function hookEnv(extra = {}) {
  const data = tmpDir('jr-data-');
  const config = tmpDir('jr-config-');
  return {
    data,
    config,
    env: {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_CONFIG_DIR: config,
      JEV_BASE_URL: '',
      CLAUDE_PLUGIN_OPTION_MODE: '',
      CLAUDE_PLUGIN_OPTION_READ_LINE_CAP: '',
      CLAUDE_PLUGIN_OPTION_TRIM_OUTPUT_LINES: '',
      ...extra,
    },
  };
}

module.exports = { SCRIPTS, tmpDir, write, runScript, hookEnv };
