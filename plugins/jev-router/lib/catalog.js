'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUILTINS = [
  { name: 'general-purpose', description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks', model: 'inherit', source: 'builtin' },
  { name: 'Explore', description: 'Fast read-only search agent that locates code and files and answers where-is questions across many files', model: 'haiku', source: 'builtin' },
  { name: 'Plan', description: 'Software architect agent that designs implementation plans and weighs architectural trade-offs', model: 'inherit', source: 'builtin' },
];

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function parseFrontmatter(text) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src };
  const lines = src.slice(4, end).split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let value = (m[2] || '').trim();
    if (/^[|>][-+]?$/.test(value)) {
      const folded = value[0] === '>';
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      data[key] = block.join(folded ? ' ' : '\n').trim();
    } else {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*-\s/.test(lines[i + 1])) value += ' ' + lines[++i].trim();
      data[key] = unquote(value);
    }
  }
  return { data, body: src.slice(end + 4) };
}

function cleanDescription(s, max = 240) {
  const t = String(s || '')
    .replace(/<example>[\s\S]*?<\/example>/gi, ' ')
    .replace(/<commentary>[\s\S]*?<\/commentary>/gi, ' ')
    .replace(/<example>[\s\S]*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function listMarkdown(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel.concat(e.name));
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push({ file: p, rel });
    }
  };
  walk(dir, []);
  return out;
}

function collectTarget(target) {
  try {
    if (fs.statSync(target).isFile()) return target.toLowerCase().endsWith('.md') ? [{ file: target, rel: [] }] : [];
  } catch {
    return [];
  }
  return listMarkdown(target);
}

function settingsFiles(configDir, projectDir) {
  return [
    path.join(configDir, 'settings.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
  ];
}

function enabledPlugins(configDir, projectDir) {
  const merged = {};
  for (const f of settingsFiles(configDir, projectDir)) {
    const s = readJson(f);
    if (s && s.enabledPlugins && typeof s.enabledPlugins === 'object') Object.assign(merged, s.enabledPlugins);
  }
  return Object.keys(merged).filter(k => merged[k] !== false && merged[k] != null);
}

function samePath(a, b) {
  if (!a || !b) return false;
  const n = p => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function pickInstall(entries, projectDir) {
  if (!Array.isArray(entries)) return null;
  return entries.find(e => (e.scope === 'project' || e.scope === 'local') && samePath(e.projectPath, projectDir))
    || entries.find(e => e.scope === 'user')
    || null;
}

// Current install of every enabled plugin: [{id, plugin, installPath, manifest}]. Also used by doctor (U19).
function enabledPluginInstalls(configDir, projectDir) {
  const installed = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
  const table = (installed && installed.plugins) || {};
  const out = [];
  for (const id of enabledPlugins(configDir, projectDir)) {
    const entry = pickInstall(table[id], projectDir);
    if (!entry || !entry.installPath) continue;
    const manifest = readJson(path.join(entry.installPath, '.claude-plugin', 'plugin.json')) || {};
    out.push({ id, plugin: manifest.name || id.split('@')[0], installPath: entry.installPath, manifest });
  }
  return out;
}

function pluginSources(configDir, projectDir) {
  return enabledPluginInstalls(configDir, projectDir).map(({ plugin, installPath, manifest }) => {
    const declared = manifest.agents ? [].concat(manifest.agents) : null;
    const targets = declared ? declared.map(p => path.resolve(installPath, p)) : [path.join(installPath, 'agents')];
    return { plugin, targets, source: 'plugin' };
  });
}

function agentFromFile(f) {
  let text;
  try { text = fs.readFileSync(f.file, 'utf8'); } catch { return null; }
  const { data } = parseFrontmatter(text);
  const description = cleanDescription(data.description);
  if (!description) return null;
  const base = (data.name && String(data.name).trim()) || path.basename(f.file, path.extname(f.file));
  const name = f.plugin ? [f.plugin, ...f.rel, base].join(':') : base;
  return { name, description, model: (data.model && String(data.model).trim()) || 'inherit', source: f.source };
}

function loadCatalog({ configDir, projectDir, dataDir, pluginRoot }) {
  const plugins = pluginSources(configDir, projectDir);
  const sources = [
    { plugin: null, targets: [path.join(projectDir, '.claude', 'agents')], source: 'project' },
    { plugin: null, targets: [path.join(configDir, 'agents')], source: 'user' },
    ...plugins,
  ];
  if (pluginRoot && !plugins.some(p => p.plugin === 'jev-router')) {
    sources.push({ plugin: 'jev-router', targets: [path.join(pluginRoot, 'agents')], source: 'plugin' });
  }
  const files = [];
  for (const s of sources) for (const t of s.targets) for (const f of collectTarget(t)) files.push({ ...f, plugin: s.plugin, source: s.source });

  const sig = [...settingsFiles(configDir, projectDir), path.join(configDir, 'plugins', 'installed_plugins.json')]
    .map(p => `${p}:${mtime(p)}`)
    .concat(files.map(f => `${f.file}:${mtime(f.file)}:${f.plugin}:${f.source}`));
  const signature = crypto.createHash('sha1').update(sig.join('\n')).digest('hex');
  const cacheFile = dataDir ? path.join(dataDir, 'catalog.json') : null;
  if (cacheFile) {
    const cached = readJson(cacheFile);
    if (cached && cached.signature === signature && Array.isArray(cached.agents)) return cached;
  }

  const byName = new Map(BUILTINS.map(a => [a.name, a]));
  const duplicates = [];
  for (const f of files) {
    const a = agentFromFile(f);
    if (!a) continue;
    if (byName.has(a.name)) { duplicates.push(a.name); continue; }
    byName.set(a.name, a);
  }
  const agents = [...byName.values()];
  const counts = { builtin: 0, user: 0, project: 0, plugin: 0 };
  for (const a of agents) counts[a.source] += 1;
  const result = { signature, agents, counts, duplicates };
  if (cacheFile) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(result));
      fs.renameSync(tmp, cacheFile);
    } catch {
      // Cache is an optimisation only.
    }
  }
  return result;
}

module.exports = { loadCatalog, parseFrontmatter, cleanDescription, enabledPluginInstalls, BUILTINS };
