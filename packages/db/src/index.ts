import { PrismaClient, Prisma } from '../generated/client/index.js';

export * from '../generated/client/index.js';
export { Prisma };

declare global {
  // eslint-disable-next-line no-var
  var __copyraPrisma: PrismaClient | undefined;
}

/**
 * Connection budget (DigitalOcean managed Postgres basic ≈ 22–25 max clients;
 * ~3 reserved for superuser/admin → ~19–22 usable):
 *
 * | Process              | Instances (steady) | Instances (rolling) | Default pool | Steady | Rolling |
 * |----------------------|--------------------|---------------------|--------------|--------|---------|
 * | api (Node)           | 1                  | 2                   | 3            | 3      | 6       |
 * | worker (Node)        | 1                  | 2                   | 3            | 3      | 6       |
 * | migrate/push (boot)  | 0–1 short-lived    | 0–1                 | 1            | ≤1     | ≤1      |
 * | **Total**            |                    |                     |              | **≤7** | **≤13** |
 *
 * Rolling deploy must stay under ~19 usable slots. Default pool=3 does.
 * Pool=8 × 4 processes = 32 → FATAL too many clients (production incident).
 *
 * With DigitalOcean PgBouncer (transaction pooler): set DATABASE_URL to the
 * pooled URL and DIRECT_URL to the direct host; client pools may be larger
 * because server-side connections are multiplexed.
 */
export const PRISMA_DEFAULT_CONNECTION_LIMIT = 3;
export const PRISMA_DEFAULT_POOL_TIMEOUT_SEC = 15;
/** Safer higher client pool only when talking through PgBouncer. */
export const PRISMA_PGBOUNCER_CONNECTION_LIMIT = 10;

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const n = v.trim().toLowerCase();
  return n === 'true' || n === '1' || n === 'yes' || n === 'on';
}

function looksLikePooler(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h.includes('pooler') ||
    h.includes('pgbouncer') ||
    h.startsWith('private-') === false && h.includes('-do-user-') && h.includes('pool')
  );
}

export function resolvePrismaConnectionLimit(url: URL): number {
  const fromEnv = process.env.PRISMA_CONNECTION_LIMIT?.trim();
  if (fromEnv && /^\d+$/.test(fromEnv)) return Math.max(1, Number(fromEnv));
  const pgbouncer =
    truthy(process.env.PGBOUNCER) ||
    url.searchParams.get('pgbouncer') === 'true' ||
    looksLikePooler(url.hostname);
  return pgbouncer ? PRISMA_PGBOUNCER_CONNECTION_LIMIT : PRISMA_DEFAULT_CONNECTION_LIMIT;
}

/**
 * Build the runtime datasource URL.
 * Prefers DATABASE_URL (set this to the PgBouncer pooled URL in production).
 */
export function buildDatasourceUrl(raw = process.env.DATABASE_URL?.trim()): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const pgbouncer =
      truthy(process.env.PGBOUNCER) ||
      url.searchParams.get('pgbouncer') === 'true' ||
      looksLikePooler(url.hostname);

    if (pgbouncer && !url.searchParams.has('pgbouncer')) {
      url.searchParams.set('pgbouncer', 'true');
    }
    // Prisma + PgBouncer (transaction mode): disable prepared statements.
    if (pgbouncer && !url.searchParams.has('statement_cache_size')) {
      url.searchParams.set('statement_cache_size', '0');
    }

    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(resolvePrismaConnectionLimit(url)));
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set(
        'pool_timeout',
        process.env.PRISMA_POOL_TIMEOUT?.trim() || String(PRISMA_DEFAULT_POOL_TIMEOUT_SEC),
      );
    }
    if (!url.searchParams.has('connect_timeout')) {
      url.searchParams.set('connect_timeout', '10');
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/** Budget snapshot for ops / load tests (no secrets). */
export function prismaPoolBudget(): {
  perProcessLimit: number;
  steadyProcesses: number;
  rollingProcesses: number;
  steadyTotal: number;
  rollingTotal: number;
  assumedPgMax: number;
  headroomRolling: number;
  pgbouncer: boolean;
} {
  const sample = buildDatasourceUrl(process.env.DATABASE_URL?.trim() || 'postgresql://u:p@localhost:5432/db');
  const url = new URL(sample!);
  const perProcessLimit = Number(url.searchParams.get('connection_limit') || PRISMA_DEFAULT_CONNECTION_LIMIT);
  const pgbouncer = url.searchParams.get('pgbouncer') === 'true' || truthy(process.env.PGBOUNCER);
  const steadyProcesses = 2; // api + worker in one App Platform container
  const rollingProcesses = 4; // old + new during deploy
  const assumedPgMax = Number(process.env.POSTGRES_MAX_CONNECTIONS?.trim() || 22);
  const reserved = 3;
  const usable = assumedPgMax - reserved;
  const steadyTotal = perProcessLimit * steadyProcesses;
  const rollingTotal = perProcessLimit * rollingProcesses;
  return {
    perProcessLimit,
    steadyProcesses,
    rollingProcesses,
    steadyTotal,
    rollingTotal,
    assumedPgMax,
    headroomRolling: usable - rollingTotal,
    pgbouncer,
  };
}

export function isDbConnectionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /too many clients already|Timed out fetching a new connection from the connection pool|Can't reach database server|Connection reset|ECONNRESET|ECONNREFUSED|remaining connection slots|server closed the connection|57P03|53300/i.test(
    msg,
  );
}

/**
 * Retry transient Postgres/Prisma pool errors with jittered backoff.
 * Never wraps long network/RPC work — only the DB call itself.
 */
export async function withPrismaRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isDbConnectionError(error) || i === attempts) throw error;
      const delay = Math.min(2_000, 80 * 2 ** (i - 1) + Math.floor(Math.random() * 80));
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          component: 'prisma-pool',
          msg: 'Transient DB connection error — retrying',
          attempt: i,
          delayMs: delay,
          label: opts.label ?? null,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        }),
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

function create(): PrismaClient {
  const url = buildDatasourceUrl();
  const budget = prismaPoolBudget();
  if (budget.headroomRolling < 0 && !budget.pgbouncer) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        component: 'prisma-pool',
        msg: 'Connection budget may exceed Postgres max during rolling deploy — set PgBouncer DATABASE_URL or lower PRISMA_CONNECTION_LIMIT',
        budget,
      }),
    );
  }

  const base = new PrismaClient({
    datasources: url ? { db: { url } } : undefined,
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

  // Retry only the Prisma query itself — never hold a connection across RPC.
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        return withPrismaRetry(() => query(args), { label: 'prisma-op' });
      },
    },
  }) as unknown as PrismaClient;
}

/**
 * Shared client. Reused across hot reloads and production so a process never
 * opens more than one Prisma pool against managed Postgres.
 */
export const prisma: PrismaClient = globalThis.__copyraPrisma ?? create();
globalThis.__copyraPrisma = prisma;

async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
}
process.once('beforeExit', () => {
  void disconnectPrisma();
});
process.once('SIGINT', () => {
  void disconnectPrisma();
});
process.once('SIGTERM', () => {
  void disconnectPrisma();
});

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

/** Bound parallel async work so concurrent queries stay under the process pool. */
export async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}
