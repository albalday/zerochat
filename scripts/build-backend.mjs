#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(python, [path.join(root, 'scripts', 'build-backend.py'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
