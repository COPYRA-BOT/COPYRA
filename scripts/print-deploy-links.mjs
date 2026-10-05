#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const urls = JSON.parse(readFileSync(join(root, 'docs/live-urls.json'), 'utf8'));

async function probe(url) {
  try {
    const r = await fetch(`${url}${urls.healthPath}`, { redirect: 'follow' });
    return r.status;
  } catch {
    return 0;
  }
}

const production = urls.production;
const platform = urls.platform || production;

console.log('\nCOPYRA live URLs (same deployment — real on-chain RPCs when env is set):\n');
console.log(`  Production:  ${production}`);
console.log(`  Platform:    ${platform}`);
console.log(`  Health:      ${production}${urls.healthPath}`);
console.log(`  API status:  ${production}${urls.statusPath}\n`);

const [a, b] = await Promise.all([probe(production), probe(platform)]);
console.log(`  Health check: production=${a || 'unreachable'} platform=${b || 'unreachable'}\n`);
