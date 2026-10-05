#!/usr/bin/env node
/**
 * Fails the build if a secret is committed, or if a signing key is reachable
 * from the browser bundle.
 *
 * Three independent checks:
 *   1. No tracked file contains a credential-shaped literal.
 *   2. No tracked .env file (other than .env.example) exists.
 *   3. The bot signing-key env vars are referenced ONLY by the one module
 *      allowed to read them, and never anywhere under apps/web.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SECRET_SHAPES = [
  { re: /\bjup_[0-9a-f]{40,}/i, why: 'Jupiter API key' },
  { re: /\balch_[A-Za-z0-9_-]{20,}/, why: 'Alchemy API key' },
  { re: /\b\d{8,12}:AA[A-Za-z0-9_-]{30,}/, why: 'Telegram bot token' },
  { re: /\bre_[A-Za-z0-9_]{8,}_[A-Za-z0-9]{16,}/, why: 'Resend API key' },
  { re: /api-key=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, why: 'Helius API key' },
  { re: /postgres(ql)?:\/\/[^\s:'"]+:[^\s@'"]{6,}@/i, why: 'Postgres URL with password' },
  { re: /redis:\/\/[^\s:'"]+:[^\s@'"]{6,}@/i, why: 'Redis URL with password' },
  { re: /\bAVNS_[A-Za-z0-9]{10,}/, why: 'DigitalOcean DB password' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'PEM private key' },
  { re: /https:\/\/[0-9a-f]{32}@o\d+\.ingest/i, why: 'Sentry DSN' },
];

/**
 * A bare 32-byte hex string is only suspicious in key-ish context. EVM source
 * is full of 32-byte literals that are event-topic hashes, function selectors
 * and role identifiers; flagging all of them would make this audit noise, and a
 * noisy security check is one people learn to ignore.
 */
const HEX32 = /\b0x[0-9a-fA-F]{64}\b/;
const KEY_CONTEXT = /\b(private|secret|mnemonic|seed|signer|wallet|keypair|priv)\w*\b/i;

const SKIP_SECRET_SCAN =
  /(^|\/)(package-lock\.json|\.env\.example|node_modules\/|dist\/|generated\/)|scripts\/audit-secrets\.mjs$/;

const SIGNING_ENV_VARS = ['SOLANA_BOT_PRIVATE_KEY', 'EVM_BOT_PRIVATE_KEY'];
const SIGNER_ALLOWLIST = [
  'packages/core/src/security/signer.ts',
  'packages/core/src/config/env.ts',
  '.env.example',
  'scripts/audit-secrets.mjs',
];

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const violations = [];

// 1 — credential-shaped literals in tracked files.
for (const file of tracked) {
  if (SKIP_SECRET_SCAN.test(file)) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue; // binary
  }
  content.split('\n').forEach((line, i) => {
    if (/copyra-audit-allow:/.test(line)) return;
    for (const { re, why } of SECRET_SHAPES) {
      if (re.test(line)) {
        violations.push({ file, line: i + 1, why: `committed secret (${why})` });
        return;
      }
    }
    if (HEX32.test(line) && KEY_CONTEXT.test(line)) {
      violations.push({ file, line: i + 1, why: 'committed secret (32-byte hex in key context)' });
    }
  });
}

// 2 — a real .env must never be tracked.
for (const file of tracked) {
  const base = file.split('/').pop();
  if (base && base.startsWith('.env') && base !== '.env.example') {
    violations.push({ file, line: 0, why: 'tracked .env file' });
  }
}

// 3 — signing keys must not be reachable from the frontend or read outside the
// signer. Only executable code is checked: documentation has to be able to name
// the variable in order to tell an operator where to set it.
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

for (const file of tracked) {
  if (SIGNER_ALLOWLIST.includes(file)) continue;
  if (SKIP_SECRET_SCAN.test(file)) continue;
  if (!CODE_FILE.test(file)) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const v of SIGNING_ENV_VARS) {
    if (content.includes(v)) {
      violations.push({
        file,
        line: 0,
        why: `${v} referenced outside the signer module (only packages/core/src/security/signer.ts may read it)`,
      });
    }
  }
  if (file.startsWith('apps/web/') && /privateKey|secretKey|mnemonic|seedPhrase/i.test(content)) {
    violations.push({ file, line: 0, why: 'frontend references private-key material' });
  }
}

if (violations.length > 0) {
  console.error(`\n✗ secret audit FAILED — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}${v.line ? ':' + v.line : ''}  — ${v.why}`);
  }
  console.error('\nRemove the secret, rotate it, and load it from the environment instead.\n');
  process.exit(1);
}

console.log('✓ secret audit passed — no committed credentials, no frontend key exposure.');
