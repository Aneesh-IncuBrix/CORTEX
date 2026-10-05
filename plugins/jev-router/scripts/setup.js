#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../lib/config');
const { MODEL, ENGINE_VERSION, enginePaths, fileUrl, sha256File } = require('../lib/engine/manifest');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const say = m => process.stdout.write(m + '\n');

function parseArgs(argv) {
  const a = { data: null, uninstall: false, lite: false, modelDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') a.data = argv[++i] || null;
    else if (argv[i] === '--uninstall') a.uninstall = true;
    else if (argv[i] === '--lite') a.lite = true;
    else if (argv[i] === '--model-dir') a.modelDir = argv[++i] || null;
  }
  return a;
}

const MIN_FREE_BYTES = 300 * 1024 * 1024;

// U2/U10: catch the common blockers before downloading anything.
function preflight(dataDir, { needNpm = true, spawn = spawnSync } = {}) {
  const problems = [];
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) problems.push(`Node ${process.version} is too old — jev-router needs Node 18+. Install the current LTS from https://nodejs.org and re-run.`);
  if (needNpm) {
    const npm = spawn('npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (!npm || npm.status !== 0) problems.push('npm was not found on PATH. Install Node.js (it includes npm) and re-run — or run setup with --lite for rule-based routing without the engine.');
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
  } catch (e) {
    problems.push(`Cannot write to ${dataDir} (${e.code || e.message}). Check that folder's permissions and re-run.`);
  }
  if (typeof fs.statfsSync === 'function') {
    try {
      const s = fs.statfsSync(dataDir);
      const free = Number(s.bavail) * Number(s.bsize);
      if (free < MIN_FREE_BYTES) problems.push(`Only ${Math.round(free / 1048576)} MB free at ${dataDir}; setup needs about 300 MB. Free some space and re-run.`);
    } catch {
      // statfs unsupported on this filesystem: skip the disk check.
    }
  }
  return problems;
}

// U10: one setup at a time; a crashed setup's lock expires after 10 minutes.
function acquireLock(root, now = Date.now()) {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, '.setup.lock');
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (now - fs.statSync(lock).mtimeMs < 10 * 60 * 1000) {
      throw new Error(`Another jev-router setup is already running. Wait for it to finish, or delete ${lock} if it crashed.`);
    }
    fs.rmSync(lock, { force: true });
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  }
  return () => fs.rmSync(lock, { force: true });
}

// U8: onnxruntime-node ships binaries only for some OS/arch pairs (e.g. no Intel macOS).
function platformSupported(ortDir, platform = process.platform, arch = process.arch) {
  try {
    return fs.readdirSync(path.join(ortDir, 'bin')).some(napi => fs.existsSync(path.join(ortDir, 'bin', napi, platform, arch)));
  } catch {
    return false;
  }
}

// U9: offline / air-gapped install from manually downloaded files, still checksum-verified.
function importFromDir(srcDir, dest, f) {
  const candidates = [path.join(srcDir, f.local), path.join(srcDir, path.basename(f.remote))];
  const src = candidates.find(c => fs.existsSync(c));
  if (!src) throw new Error(`--model-dir: ${f.local} (or ${path.basename(f.remote)}) not found in ${srcDir}`);
  const got = sha256File(src);
  if (got !== f.sha256) throw new Error(`checksum mismatch for ${src}: expected ${f.sha256}, got ${got}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function downloadHelp(err, env = process.env) {
  const lines = [`Download failed: ${err.message}`];
  if (env.HTTPS_PROXY || env.https_proxy) lines.push('A proxy is configured: Node uses it only with NODE_USE_ENV_PROXY=1 (Node 24+). Re-run with that set, or use --model-dir.');
  lines.push('If Hugging Face is blocked, set HF_ENDPOINT to a mirror (files are still checksum-verified), or download these two files by hand and re-run with --model-dir <folder>:');
  for (const f of MODEL.files) lines.push(`  ${fileUrl(f, '')}`);
  return lines.join('\n');
}

function pruneOtherPlatforms(ortDir, platform = process.platform, arch = process.arch) {
  const binRoot = path.join(ortDir, 'bin');
  let removed = 0;
  let napis;
  try { napis = fs.readdirSync(binRoot); } catch { return 0; }
  for (const napi of napis) {
    const napiDir = path.join(binRoot, napi);
    let plats;
    try { plats = fs.readdirSync(napiDir); } catch { continue; }
    for (const plat of plats) {
      const platDir = path.join(napiDir, plat);
      if (plat !== platform) { fs.rmSync(platDir, { recursive: true, force: true }); removed++; continue; }
      for (const ar of fs.readdirSync(platDir)) {
        if (ar !== arch) { fs.rmSync(path.join(platDir, ar), { recursive: true, force: true }); removed++; }
      }
    }
  }
  return removed;
}

async function downloadVerified(url, dest, expectedSha, fetchImpl = fetch) {
  const tmp = `${dest}.${process.pid}.download`;
  try {
    const r = await fetchImpl(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`download failed (${r.status}) for ${url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== expectedSha) throw new Error(`checksum mismatch for ${path.basename(dest)}: expected ${expectedSha}, got ${got}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function npmCi(root) {
  const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`npm ci failed (exit ${r.status})`);
}

async function selfTest(dataDir) {
  const { LocalEmbedder } = require('../lib/engine/local');
  const { dot } = require('../lib/engine/questions');
  const t0 = Date.now();
  const e = await LocalEmbedder.create(dataDir);
  const a = await e.embed('where is the login handler defined');
  const b = await e.embed('find the authentication function');
  const c = await e.embed('bake a chocolate cake');
  if (a.length !== MODEL.dim) throw new Error(`unexpected vector size ${a.length}`);
  if (!(dot(a, b) > dot(a, c))) throw new Error('self-test similarity ordering failed');
  return { ms: Date.now() - t0, embedder: e };
}

async function warmCatalog(dataDir, embedder) {
  const { loadCatalog } = require('../lib/catalog');
  const { VectorCache } = require('../lib/engine/vectors');
  const { agentText } = require('../lib/engine');
  const cfg = loadConfig();
  const { agents } = loadCatalog({ configDir: cfg.configDir, projectDir: process.cwd(), dataDir, pluginRoot: PLUGIN_ROOT });
  const cache = new VectorCache(path.join(dataDir, 'vectors.json'));
  for (const a of agents) {
    const text = agentText(a);
    if (!cache.get(text)) cache.set(text, await embedder.embed(text));
  }
  cache.save();
  return agents.length;
}

function writeReady(p, extra = {}) {
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.ready, JSON.stringify({
    engineVersion: ENGINE_VERSION,
    revision: MODEL.revision,
    installedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ...extra,
  }, null, 2));
}

// U8: when the native engine can't run here, routing still works on built-in rules.
function goLite(p, reason) {
  writeReady(p, { mode: 'lite', reason });
  say(`• lite mode: ${reason}`);
  say('jev-router: routing will use built-in rules (less accurate than the engine). The tool guard is fully active. Run /jev-router:doctor for details.');
}

async function install(dataDir, { lite = false, modelDir = null } = {}) {
  const p = enginePaths(dataDir);
  if (lite) { goLite(p, 'requested with --lite'); return; }
  say(`jev-router setup → ${p.root}`);
  say('One-time downloads: onnxruntime-node from npm and all-MiniLM-L6-v2 (23 MB) from Hugging Face, pinned and checksum-verified. Nothing about you or your code is uploaded.');
  const release = acquireLock(p.root);
  try {
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(PLUGIN_ROOT, 'engine', f), path.join(p.root, f));
    if (fs.existsSync(path.join(p.ortModule, 'package.json'))) {
      say('• onnxruntime-node already installed');
    } else {
      say('• npm ci (install scripts disabled)…');
      npmCi(p.root);
    }
    if (!platformSupported(p.ortModule)) { goLite(p, `onnxruntime has no binary for ${process.platform}-${process.arch}`); return; }
    say(`• pruned ${pruneOtherPlatforms(p.ortModule)} binary folders for other platforms`);
    for (const f of MODEL.files) {
      const dest = path.join(p.modelDir, f.local);
      if (fs.existsSync(dest) && sha256File(dest) === f.sha256) { say(`• ${f.local}: checksum OK`); continue; }
      if (modelDir) {
        importFromDir(modelDir, dest, f);
      } else {
        say(`• downloading ${f.remote} @ ${MODEL.revision.slice(0, 7)}…`);
        try { await downloadVerified(fileUrl(f), dest, f.sha256); } catch (e) { throw new Error(downloadHelp(e)); }
      }
      say(`• ${f.local}: checksum OK`);
    }
    let tested;
    try {
      tested = await selfTest(dataDir);
    } catch (e) {
      goLite(p, `the engine could not start on this machine (${String(e.message).split('\n')[0]}), e.g. blocked by Smart App Control/antivirus or an unsupported C library`);
      return;
    }
    say(`• self-test passed (${tested.ms} ms including model load)`);
    say(`• pre-computed vectors for ${await warmCatalog(dataDir, tested.embedder)} agents`);
    writeReady(p);
    say('jev-router: local engine ready. Prompt routing is active; nothing leaves this machine.');
  } finally {
    release();
  }
}

function uninstall(dataDir) {
  const p = enginePaths(dataDir);
  fs.rmSync(p.root, { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, 'vectors.json'), { force: true });
  say(`jev-router: engine removed from ${p.root}. Routing is off until you run /jev-router:setup again.`);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args.data || loadConfig().dataDir);
  const problems = args.uninstall ? [] : preflight(dataDir, { needNpm: !args.lite });
  if (problems.length) {
    process.stderr.write(`jev-router setup cannot continue:\n${problems.map(p => `  ✗ ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  Promise.resolve()
    .then(() => (args.uninstall ? uninstall(dataDir) : install(dataDir, args)))
    .then(() => process.exit(0))
    .catch(e => {
      process.stderr.write(`jev-router setup failed:\n${e.message}\nNext step: run /jev-router:doctor, or re-run setup (it resumes safely).\n`);
      process.exit(1);
    });
}

module.exports = { pruneOtherPlatforms, downloadVerified, parseArgs, preflight, acquireLock, platformSupported, importFromDir, downloadHelp };
