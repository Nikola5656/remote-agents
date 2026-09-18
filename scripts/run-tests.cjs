#!/usr/bin/env node
// Select compiled tests from source files so deleted/stale dist tests cannot run.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.cwd();
function tests(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return tests(file);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [file] : [];
  });
}
const files = tests(path.join(root, 'src')).sort().map(file => path.join(root, 'dist', path.relative(path.join(root, 'src'), file).replace(/\.ts$/, '.js')));
if (!files.length || files.some(file => !fs.existsSync(file))) throw new Error('No compiled tests or build incomplete; build this workspace first');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
