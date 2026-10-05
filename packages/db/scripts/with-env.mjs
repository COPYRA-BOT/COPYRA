#!/usr/bin/env node
/**
 * Runs the Prisma CLI with the monorepo-root `.env` loaded.
 *
 * Prisma only looks for `.env` next to the schema or in cwd. COPYRA keeps a
 * single root `.env` so the API, worker and migrations cannot drift onto
 * different databases. In production no `.env` exists and the host's injected
 * environment is used unchanged.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function findRootEnv() {
  let dir = resolve(here);
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const envFile = findRootEnv();
if (envFile) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
  }
}

const child = spawn('npx', ['prisma', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: resolve(here, '..'),
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
