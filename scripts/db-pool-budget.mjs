#!/usr/bin/env node
/**
 * Connection-budget load check (no live DB required).
 *
 * Verifies that api+worker Prisma pools stay under assumed Postgres max
 * connections in steady state and during a rolling deploy overlap.
 */
import { prismaPoolBudget, PRISMA_DEFAULT_CONNECTION_LIMIT } from '../packages/db/dist/index.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
}

const budget = prismaPoolBudget();
const reserved = 3;
const usable = budget.assumedPgMax - reserved;

console.log('COPYRA Prisma connection budget');
console.log(JSON.stringify({ ...budget, reserved, usable }, null, 2));

assert(budget.perProcessLimit <= 10, `per-process limit ${budget.perProcessLimit} looks unbounded`);
assert(
  budget.perProcessLimit === PRISMA_DEFAULT_CONNECTION_LIMIT || budget.pgbouncer,
  `expected default limit ${PRISMA_DEFAULT_CONNECTION_LIMIT} without pgbouncer (got ${budget.perProcessLimit})`,
);
assert(budget.steadyTotal <= usable, `steady ${budget.steadyTotal} exceeds usable ${usable}`);
assert(
  budget.rollingTotal <= usable,
  `rolling deploy ${budget.rollingTotal} exceeds usable ${usable} — lower PRISMA_CONNECTION_LIMIT or enable PgBouncer`,
);
assert(budget.headroomRolling >= 0, `negative rolling headroom: ${budget.headroomRolling}`);

// Simulated concurrent query pressure: each process runs ≤ (limit - 1) heavy loops.
const heavyPerProcess = Math.max(1, budget.perProcessLimit - 1);
const simulatedInflight = heavyPerProcess * budget.rollingProcesses;
assert(
  simulatedInflight <= usable,
  `simulated in-flight queries ${simulatedInflight} exceed usable ${usable}`,
);

console.log(
  `✓ Budget OK — steady ${budget.steadyTotal}, rolling ${budget.rollingTotal}, usable ${usable}, sim in-flight ${simulatedInflight}`,
);
