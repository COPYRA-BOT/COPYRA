#!/usr/bin/env node
/**
 * Fails the build if simulated/mock blockchain functionality appears in
 * production source. This is the mechanical enforcement of COPYRA's core rule:
 * no fake balances, no fake prices, no fake signatures, no simulated execution.
 *
 * Test files are allowed to use fixtures — that is what tests are for — but
 * production code under src/ is not.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BANNED = [
  { re: /\bmock(ed|ing)?\b/i, why: 'mock' },
  { re: /\bsimulat(e|ed|ing|ion)\b/i, why: 'simulation' },
  { re: /\bfake\b/i, why: 'fake' },
  { re: /\bplaceholder\b/i, why: 'placeholder' },
  { re: /\bdummy\b/i, why: 'dummy' },
  { re: /\bstub(bed)?\b/i, why: 'stub' },
  { re: /\bTODO\b/, why: 'TODO' },
  { re: /\bFIXME\b/, why: 'FIXME' },
  { re: /\bHACK\b/, why: 'HACK' },
  { re: /\bdemo\s*(data|mode|balance|trade|wallet)\b/i, why: 'demo data' },
  { re: /\bsample\s*data\b/i, why: 'sample data' },
  { re: /\bhardcoded?\s*(balance|price)\b/i, why: 'hardcoded balance/price' },
  { re: /\btest\s*wallet\b/i, why: 'test wallet' },
  { re: /\bsetTimeout\(\s*[^,]*,\s*\d{3,}\s*\)/, why: 'suspicious artificial delay' },
];

/**
 * Lines carrying this marker are deliberate, reviewed exceptions. Each must
 * state a reason. Used for things like `simulateTransaction` (a *real* RPC
 * method whose name contains a banned word).
 */
const ALLOW_MARKER = /copyra-audit-allow:\s*\S+/;

const INCLUDE = /^(apps|packages)\/.+\.(ts|tsx)$/;
const EXCLUDE =
  /(\.spec\.ts|\.test\.ts|\/__tests__\/|\/tests\/|\/node_modules\/|\/dist\/|\/generated\/|\.d\.ts$)/;

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return out.split('\n').filter((f) => f && INCLUDE.test(f) && !EXCLUDE.test(f));
}

const violations = [];
for (const file of trackedFiles()) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (ALLOW_MARKER.test(line)) return;
    for (const { re, why } of BANNED) {
      if (re.test(line)) {
        violations.push({ file, line: i + 1, why, text: line.trim().slice(0, 140) });
        break;
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`\n✗ mock/simulation audit FAILED — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.why}]`);
    console.error(`      ${v.text}`);
  }
  console.error(
    '\nProduction source must not contain mocks, stubs, placeholders or TODOs.\n' +
      'If a real API genuinely contains a banned word (e.g. simulateTransaction),\n' +
      'append a reviewed exception comment: // copyra-audit-allow: <reason>\n',
  );
  process.exit(1);
}

console.log('✓ mock/simulation audit passed — no simulated blockchain functionality found.');
