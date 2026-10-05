'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { needsBump } = require('../../../scripts/check-version-bump');

test('no shipped files changed → ok', () => {
  assert.equal(needsBump({ changed: ['README.md', 'plugins/jev-router/test/x.test.js', 'plugins/jev-router/README.md'], headVersion: '0.1.0', baseVersion: '0.1.0' }).ok, true);
});

test('shipped file changed without a bump → fails with a clear message', () => {
  const r = needsBump({ changed: ['plugins/jev-router/lib/policy.js'], headVersion: '0.1.0', baseVersion: '0.1.0' });
  assert.equal(r.ok, false);
  assert.match(r.message, /Bump "version" in plugins\/jev-router\/\.claude-plugin\/plugin\.json/);
});

test('skills and agents count as shipped; a bump passes; a new plugin passes', () => {
  assert.equal(needsBump({ changed: ['plugins/jev-router/skills/setup/SKILL.md'], headVersion: '0.1.0', baseVersion: '0.1.0' }).ok, false);
  assert.equal(needsBump({ changed: ['plugins/jev-router/lib/policy.js'], headVersion: '0.1.1', baseVersion: '0.1.0' }).ok, true);
  assert.equal(needsBump({ changed: ['plugins/jev-router/lib/policy.js'], headVersion: '0.1.0', baseVersion: null }).ok, true);
});
