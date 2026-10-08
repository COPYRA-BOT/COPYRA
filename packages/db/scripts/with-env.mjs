#!/usr/bin/env node
/**
 * Runs the Prisma CLI with the monorepo-root `.env` loaded.
 *
 * Prisma only looks for `.env` next to the schema or in cwd. COPYRA keeps a
 * single root `.env` so the API, worker and migrations cannot drift onto
 * different databases. In production no `.env` exists and the host's injected
 * environment is used unchanged.
 *
 * When DATABASE_URL points at PgBouncer, DIRECT_URL must be the direct host
 * for `migrate` / `db push`. If DIRECT_URL is unset we derive a best-effort
 * direct URL from DATABASE_URL (strip pgbouncer params).
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

function ensureDirectUrl() {
  if (process.env.DIRECT_URL?.trim()) return;
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return;
  try {
    const url = new URL(raw);
    url.searchParams.delete('pgbouncer');
    url.searchParams.delete('statement_cache_size');
    url.searchParams.delete('connection_limit');
    url.searchParams.delete('pool_timeout');
    // DO pooled hostnames often contain "pool" / "pooler" — operators should
    // set DIRECT_URL explicitly. Fallback keeps local/dev migrate working.
    process.env.DIRECT_URL = url.toString();
  } catch {
    process.env.DIRECT_URL = raw;
  }
}

ensureDirectUrl();

const child = spawn('npx', ['prisma', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: resolve(here, '..'),
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
