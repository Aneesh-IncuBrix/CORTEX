'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, write } = require('./helpers');
const { loadCatalog, parseFrontmatter, cleanDescription } = require('../lib/catalog');

const agent = (name, desc, extra = '') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\nBody\n`;

function fixture() {
  const config = tmpDir('jr-cfg-');
  const project = tmpDir('jr-proj-');
  const other = tmpDir('jr-other-');
  const cache = path.join(config, 'plugins', 'cache');
  const A1 = path.join(cache, 'mk', 'alpha', '1.0.0');
  const A2 = path.join(cache, 'mk', 'alpha', '2.0.0');
  write(path.join(A1, 'agents', 'stale.md'), agent('stale', 'Old version agent'));
  write(path.join(A2, 'agents', 'reviewer.md'), agent('reviewer', 'Reviews code for bugs'));
  write(path.join(A2, 'agents', 'sub', 'deep.md'), agent('deep', 'Nested agent'));
  write(path.join(A2, 'docs', 'ja', 'agents', 'reviewer.md'), agent('reviewer-ja', 'Translated copy'));
  const B = path.join(cache, 'mk', 'beta', '1.0.0');
  write(path.join(B, 'agents', 'x.md'), agent('x', 'Disabled plugin agent'));
  const G = path.join(cache, 'mk', 'gamma', '1.0.0');
  write(path.join(G, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'gamma-renamed', agents: './custom' }));
  write(path.join(G, 'custom', 'c.md'), agent('c', 'Custom path agent', 'model: haiku\n'));
  const P1 = path.join(cache, 'mk', 'proj', 'p1');
  const P2 = path.join(cache, 'mk', 'proj', 'p2');
  write(path.join(P1, 'agents', 'scoped.md'), agent('scoped', 'Other project install'));
  write(path.join(P2, 'agents', 'global.md'), agent('global', 'User scope install'));
  write(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'alpha@mk': [{ scope: 'user', installPath: A2 }],
      'beta@mk': [{ scope: 'user', installPath: B }],
      'gamma@mk': [{ scope: 'user', installPath: G }],
      'proj@mk': [{ scope: 'project', projectPath: other, installPath: P1 }, { scope: 'user', installPath: P2 }],
    },
  }));
  write(path.join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'alpha@mk': true, 'beta@mk': true, 'gamma@mk': true, 'proj@mk': true } }));
  write(path.join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'beta@mk': false } }));
  // CRLF + BOM + block scalar + <example> (Review Focus 1)
  write(path.join(config, 'agents', 'mine.md'), '﻿---\r\nname: mine\r\ndescription: |\r\n  User agent that plans work.\r\n  <example>user: hi</example>\r\nmodel: sonnet\r\n---\r\nBody\r\n');
  write(path.join(config, 'agents', 'broken.md'), 'no frontmatter here');
  write(path.join(project, '.claude', 'agents', 'mine.md'), agent('mine', 'Project override of mine'));
  return { config, project, other };
}

test('collects built-in, user, project and enabled plugin agents only', () => {
  const { config, project } = fixture();
  const cat = loadCatalog({ configDir: config, projectDir: project });
  const names = cat.agents.map(a => a.name);
  for (const n of ['Explore', 'general-purpose', 'Plan', 'mine', 'alpha:reviewer', 'alpha:sub:deep', 'gamma-renamed:c', 'proj:global']) assert.ok(names.includes(n), `missing ${n}`);
  for (const n of ['alpha:stale', 'alpha:reviewer-ja', 'beta:x', 'proj:scoped', 'broken']) assert.ok(!names.includes(n), `unexpected ${n}`);
  const mine = cat.agents.find(a => a.name === 'mine');
  assert.equal(mine.source, 'project');
  assert.equal(mine.description, 'Project override of mine');
  assert.deepEqual(cat.duplicates, ['mine']);
  assert.equal(cat.agents.find(a => a.name === 'gamma-renamed:c').model, 'haiku');
  assert.equal(cat.counts.plugin, 4);
});

test('project-scoped install is used when projectDir matches', () => {
  const { config, other } = fixture();
  const cat = loadCatalog({ configDir: config, projectDir: other });
  assert.ok(cat.agents.some(a => a.name === 'proj:scoped'));
});

test('CRLF/BOM block scalar parses and <example> is stripped', () => {
  const { data } = parseFrontmatter('﻿---\r\nname: mine\r\ndescription: |\r\n  Line one.\r\n  <example>x</example>\r\n---\r\n');
  assert.equal(data.name, 'mine');
  assert.equal(cleanDescription(data.description), 'Line one.');
});

test('frontmatter: quoted escapes, colons in values, folded scalars, continuation', () => {
  const { data } = parseFrontmatter('---\na: "x\\ny: z"\nb: plain: with colon\nc: >\n  folded\n  text\nd: first\n  second\n---\n');
  assert.equal(data.a, 'x\ny: z');
  assert.equal(data.b, 'plain: with colon');
  assert.equal(data.c, 'folded text');
  assert.equal(data.d, 'first second');
  assert.equal(cleanDescription('x'.repeat(300)).length, 240);
});

test('cache: second call returns cached result; adding an agent invalidates it', () => {
  const { config, project } = fixture();
  const data = tmpDir('jr-data-');
  const first = loadCatalog({ configDir: config, projectDir: project, dataDir: data });
  assert.ok(fs.existsSync(path.join(data, 'catalog.json')));
  const second = loadCatalog({ configDir: config, projectDir: project, dataDir: data });
  assert.equal(second.signature, first.signature);
  write(path.join(config, 'agents', 'extra.md'), agent('extra', 'Added later'));
  const third = loadCatalog({ configDir: config, projectDir: project, dataDir: data });
  assert.notEqual(third.signature, first.signature);
  assert.ok(third.agents.some(a => a.name === 'extra'));
});

test('pluginRoot agents are added for --plugin-dir sessions', () => {
  const { config, project } = fixture();
  const root = tmpDir('jr-root-');
  write(path.join(root, 'agents', 'quick.md'), agent('quick', 'Small edits', 'model: haiku\n'));
  const cat = loadCatalog({ configDir: config, projectDir: project, pluginRoot: root });
  assert.ok(cat.agents.some(a => a.name === 'jev-router:quick'));
});

test('missing config dir still returns built-ins', () => {
  const cat = loadCatalog({ configDir: path.join(tmpDir(), 'none'), projectDir: tmpDir() });
  assert.deepEqual(cat.agents.map(a => a.name).sort(), ['Explore', 'Plan', 'general-purpose']);
});
