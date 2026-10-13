#!/usr/bin/env node
'use strict';
// Portable test runner: node --test glob support differs across Node versions.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'plugins', 'jev-router', 'test');
const engine = process.argv[2] === 'engine';
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js') && f.includes('.integration.') === engine)
  .map(f => path.join(dir, f));
if (!files.length) { console.log('no test files'); process.exit(0); }
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
