'use strict';
const fs = require('fs');
const path = require('path');

const SUFFIX = ' If you need all of it (or the user asked for it), re-issue the identical call to proceed.';
const FIND_OK = ['-maxdepth', '-quit', '-delete', '-exec', '-execdir', '-ok', '-okdir'];
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.ipynb']);
const SCAN_LIMIT = 8 * 1024 * 1024;
const BOUNDING = /^(head|tail|grep|egrep|fgrep|rg|wc|less|more|sort|uniq|awk|sed|jq|cut|tee|xargs)$/;
const QUIET = /(^|\s)(--silent|-s|--quiet|-q|--loglevel(=|\s+)(silent|error|warn)|--reporter(=|\s+)silent)(\s|$)/;

function countLines(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(64 * 1024);
    let lines = 0;
    let read = 0;
    let n;
    while (read < SCAN_LIMIT && (n = fs.readSync(fd, buf, 0, buf.length, read)) > 0) {
      if (read === 0 && buf.subarray(0, Math.min(n, 8192)).includes(0)) {
        return { lines: 0, bytes: fs.fstatSync(fd).size, truncated: false, binary: true };
      }
      for (let i = 0; i < n; i++) if (buf[i] === 10) lines++;
      read += n;
    }
    const bytes = fs.fstatSync(fd).size;
    return { lines: lines + 1, bytes, truncated: bytes > SCAN_LIMIT, binary: false };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function resolvePath(p, cwd) {
  const clean = String(p).replace(/^["']|["']$/g, '');
  return path.isAbsolute(clean) ? clean : path.resolve(cwd || process.cwd(), clean);
}

function checkRead(input, ctx) {
  if (!input || typeof input.file_path !== 'string') return null;
  if (input.offset != null || input.limit != null) return null;
  if (SKIP_EXT.has(path.extname(input.file_path).toLowerCase())) return null;
  const info = ctx.countLines(resolvePath(input.file_path, ctx.cwd));
  if (!info || info.binary || info.lines <= ctx.readLineCap) return null;
  const tokens = Math.round(info.bytes / 4).toLocaleString('en-US');
  return { deny: `${path.basename(input.file_path)} has ${info.lines}${info.truncated ? '+' : ''} lines (~${tokens} tokens). Grep for the section you need, then Read with offset/limit.${SUFFIX}` };
}

function checkGrep(input) {
  if (input && input.output_mode === 'content' && input.head_limit === 0) {
    return { deny: `Grep with output_mode "content" and head_limit 0 returns every matching line. Set head_limit (e.g. 100) or narrow the pattern/glob.${SUFFIX}` };
  }
  return null;
}

// Quote-unaware splitting: good enough for spotting noisy producers.
function splitPipelines(command) {
  return command.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean);
}

function splitStages(pipeline) {
  return pipeline.split('|').map(s => s.trim()).filter(Boolean);
}

// Quote-aware word split so `cat "C:\dir with spaces\f.log"` stays one argument.
function words(stage) {
  const w = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(stage))) w.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  while (w.length && (/^\w+=/.test(w[0]) || ['sudo', 'command', 'time', 'exec'].includes(w[0]))) w.shift();
  return w;
}

function redirectsStdout(pipeline) {
  return /(^|[^0-9&>])>{1,2}\s*[^&\s]/.test(pipeline);
}

function gitSubcommand(args) {
  let j = 0;
  while (j < args.length && args[j].startsWith('-')) j += (args[j] === '-C' || args[j] === '-c') ? 2 : 1;
  return { sub: args[j], rest: args.slice(j + 1) };
}

function checkStage(w, stageText, ctx) {
  const cmd = path.basename(w[0] || '').replace(/\.(exe|cmd|bat)$/i, '');
  const args = w.slice(1);

  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') {
    const sub = args.find(a => !a.startsWith('-'));
    const installs = cmd === 'yarn' ? (sub === undefined || sub === 'install' || sub === 'add') : ['install', 'i', 'ci', 'add'].includes(sub);
    if (installs && !QUIET.test(stageText)) return `${cmd} ${sub || 'install'} prints long progress output. Add --silent (or --loglevel=error).`;
  }
  if (cmd === 'cat') {
    for (const a of args.filter(x => !x.startsWith('-'))) {
      const info = ctx.countLines(resolvePath(a, ctx.cwd));
      if (info && !info.binary && info.lines > ctx.readLineCap) return `cat ${path.basename(a.replace(/["']/g, ''))} dumps ${info.lines}${info.truncated ? '+' : ''} lines. Use Read with offset/limit, or grep/head.`;
    }
  }
  if (cmd === 'git') {
    const { sub, rest } = gitSubcommand(args);
    if (sub === 'log' && !/(^|\s)(-n\s*\d+|-\d+|--max-count(=|\s+)\d+|--oneline)(\s|$)/.test(rest.join(' '))) {
      return 'git log without a limit can print thousands of lines. Add -n 20 (or --oneline -n 50).';
    }
  }
  if (cmd === 'find' && !args.some(a => FIND_OK.includes(a))) return 'find without -maxdepth can list huge trees. Add -maxdepth N, or pipe to head.';
  if (cmd === 'ls' && args.some(a => a === '--recursive' || /^-[a-zA-Z]*R/.test(a))) return 'ls -R lists every nested file. Use Glob or find -maxdepth instead.';
  if (cmd === 'docker' && args[0] === 'logs' && !args.some(a => /^(--tail|-n)(=|$)/.test(a))) return 'docker logs without --tail prints the whole log. Add --tail 200.';
  if (cmd === 'journalctl' && !args.some(a => /^(-n|--lines)(=|$)|^-n\d+$/.test(a))) return 'journalctl without -n prints the whole journal. Add -n 200.';
  return null;
}

function checkBash(input, ctx) {
  const command = input && typeof input.command === 'string' ? input.command : '';
  if (!command || input.run_in_background) return null;
  for (const pipeline of splitPipelines(command)) {
    const stages = splitStages(pipeline);
    const bounded = stages.slice(1).some(s => BOUNDING.test(path.basename(words(s)[0] || ''))) || redirectsStdout(pipeline);
    if (bounded) continue;
    const reason = checkStage(words(stages[0]), stages[0], ctx);
    if (reason) return { deny: reason + SUFFIX };
  }
  return null;
}

function evaluate(toolName, input, ctx = {}) {
  const c = { readLineCap: 800, cwd: process.cwd(), countLines, ...ctx };
  if (toolName === 'Read') return checkRead(input, c);
  if (toolName === 'Grep') return checkGrep(input);
  if (toolName === 'Bash') return checkBash(input, c);
  return null;
}

module.exports = { evaluate, countLines, splitPipelines, splitStages };
