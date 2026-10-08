# Database connection budget (DigitalOcean Postgres)

## Verified audit (this repo)

| Service / process | How Prisma is created | Shared singleton? | Default `connection_limit` |
|---|---|---|---|
| `apps/api` | imports `prisma` from `@copyra/db` | yes (`globalThis.__copyraPrisma`) | **3** (or **10** if PgBouncer) |
| `apps/worker` (Solana + EVM + exit-monitor in-process) | same singleton | yes | same |
| `packages/core` engine / notify / reconcile | same singleton via `@copyra/db` | yes | same |
| Scripts / migrate (`npm run db:migrate` / `db:push`) | Prisma CLI uses `DIRECT_URL` | short-lived CLI process | 1 (CLI default) |
| Loops / HTTP handlers | **no** `new PrismaClient()` | N/A | N/A |

**There is only one `new PrismaClient()` in the monorepo:** `packages/db/src/index.ts`.

App Platform runs **api + worker as two Node processes in one container** (`scripts/start-production.sh`).

## Budget table (no PgBouncer — current default)

Assumed DO basic Postgres: **`max_connections ≈ 22`**, ~3 reserved → **~19 usable**.

| Scenario | Processes | Pool each | Total client slots |
|---|---:|---:|---:|
| Steady (1 container) | api + worker = 2 | 3 | **6** |
| Rolling deploy overlap | 2 containers × 2 = 4 | 3 | **12** |
| + migrate during boot | +1 short | 1 | **≤13** |

Headroom vs 19 usable: **≥6** during rolling deploy.

### What broke production

Earlier default `connection_limit=8` → rolling deploy ≈ **32** client slots →  
`FATAL: sorry, too many clients already` on `prisma.signal.findMany()`.

## With DigitalOcean PgBouncer (recommended)

1. In DO: Databases → Connection pools → create pool (mode **transaction**, size e.g. 10–15).
2. App Platform env (api component / app-level):

| Variable | Value |
|---|---|
| `DATABASE_URL` | **Pooled** connection string (PgBouncer host/port) |
| `DIRECT_URL` | **Direct** connection string (primary host, port 25060) |
| `PGBOUNCER` | `true` (optional if URL already has `pgbouncer=true`) |
| `PRISMA_CONNECTION_LIMIT` | optional; defaults to **10** when pooler detected |

Runtime Prisma adds `pgbouncer=true` + `statement_cache_size=0` when pooler mode is on.  
Migrations always use `DIRECT_URL` (`schema.prisma` `directUrl`).

## Concurrency caps (under pool)

| Loop | Cap |
|---|---:|
| Exit monitor position ticks | 2 |
| EVM trader polls per tick | 2 |
| Solana catch-up batch | 2 |

Transient pool / “too many clients” errors retry with jittered backoff (`withPrismaRetry`).

## Load test

```bash
npm run test:db-pool
```

Simulates steady + rolling-deploy connection demand and fails if the budget exceeds usable Postgres slots.

## Trading flags

Per operator request for this change set: `SOL_TRADING_ENABLED=false`, `EVM_TRADING_ENABLED=false` in `.do/app.yaml`. Re-enable only when you approve a push.
