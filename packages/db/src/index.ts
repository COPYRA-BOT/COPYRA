import { PrismaClient, Prisma } from '../generated/client/index.js';

export * from '../generated/client/index.js';
export { Prisma };

declare global {
  // eslint-disable-next-line no-var
  var __copyraPrisma: PrismaClient | undefined;
}

/**
 * Cap pool size per process. App Platform runs API + worker as two Node
 * processes against a small managed Postgres; Prisma's default
 * (num_cpus*2+1 each) exhausts DO connection slots and surfaces as
 * intermittent /api/funds 504s and "remaining connection slots are reserved".
 */
function datasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', process.env.PRISMA_CONNECTION_LIMIT?.trim() || '5');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', process.env.PRISMA_POOL_TIMEOUT?.trim() || '10');
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function create(): PrismaClient {
  const url = datasourceUrl();
  return new PrismaClient({
    datasources: url ? { db: { url } } : undefined,
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
