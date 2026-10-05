import { PrismaClient, Prisma } from '../generated/client/index.js';

export * from '../generated/client/index.js';
export { Prisma };

declare global {
  // eslint-disable-next-line no-var
  var __copyraPrisma: PrismaClient | undefined;
}

function create(): PrismaClient {
  return new PrismaClient({
    log:
      process.env.PRISMA_LOG === 'query'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  });
}

/**
 * Shared client. Reused across hot reloads so a dev restart does not exhaust
 * the Postgres connection pool.
 */
export const prisma: PrismaClient = globalThis.__copyraPrisma ?? create();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__copyraPrisma = prisma;
}

export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

/** Postgres unique-violation. Used to turn races into clean skips. */
export const UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}

/**
 * Raised by the database when two concurrent signals try to open a position in
 * the same token. Surfaces as a `POSITION_ALREADY_OPEN` skip rather than an
 * error, because losing that race is the correct outcome.
 */
export const OPEN_POSITION_INDEX = 'positions_one_open_per_token';

export function isOpenPositionRace(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== UNIQUE_VIOLATION) return false;
  return JSON.stringify(error.meta ?? {}).includes(OPEN_POSITION_INDEX);
}
