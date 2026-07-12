#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, '../src/index.ts');

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve('tsx');

const result = spawnSync(
  process.execPath,
  ['--import', tsxLoader, entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 0);
