#!/usr/bin/env node
/**
 * Gate before git push / App Platform deploy. Fails fast on lint, types, tests, build.
 */
import { spawnSync } from 'node:child_process';

const steps = [
  ['npm', ['run', 'audit:all']],
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'build', '-w', '@copyra/db']],
  ['npm', ['run', 'db:generate']],
  ['npm', ['run', 'build', '-w', '@copyra/core']],
  ['npm', ['run', 'typecheck']],
  ['npm', ['run', 'test']],
  ['npm', ['run', 'build']],
];

for (const [cmd, args] of steps) {
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    console.error(`\n✗ deploy-verify failed at: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

console.log('\n✓ deploy-verify passed — safe to push (GitHub → DigitalOcean autodeploy).');
