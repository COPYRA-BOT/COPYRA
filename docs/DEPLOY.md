# COPYRA deployment

`copyra.fun` is the intended public domain. Deploy only after a dedicated funded bot wallet exists and a tiny mainnet fill has been confirmed on an explorer.

## Processes

Run three services from the same image / repo:

| Service | Command | Port | Role |
|---|---|---|---|
| api | `npm run start -w @copyra/api` | `8080` in Docker / App Platform (`PORT`), `41717` locally via `API_PORT` | Fastify HTTP + WS |
| worker | `npm run start -w @copyra/worker` | none | monitors + exits |
| web | `npm run preview -w @copyra/web -- --host 0.0.0.0 --port 43127` | `43127` | Vite-built `copyra.` UI |

Build order inside Docker: `npm ci && npm run db:generate && npm run build`.

## DigitalOcean App Platform (exact settings)

The production Dockerfile expects the **repository root** as the build context. That is what fixes `TS5083: Cannot read file '/app/tsconfig.base.json'`.

In the App Platform component settings:

| Field | Value |
|---|---|
| Source | GitHub `COPYRA-BOT/COPYRA` |
| Branch | `main` (or `dev` — same Dockerfile fix is on both) |
| Autodeploy | On |
| Source Directory | **leave blank** (repo root `/`) — do **not** set `apps/api`, `packages/db`, or any subdirectory |
| Dockerfile path | `Dockerfile` |
| Docker build context | Repository root (default when Source Directory is blank) |

Create **three** components from the same Dockerfile / branch:

| Component | Type | HTTP port | Run command |
|---|---|---|---|
| `api` | Web service | **`8080`** | `npm run start -w @copyra/api` |
| `web` | Web service | `43127` | `npm run preview -w @copyra/web -- --host 0.0.0.0 --port 43127` |
| `worker` | Worker | none | `npm run start -w @copyra/worker` |

### API health checks (exact App Platform values)

On the **api** component → Settings → HTTP Port / Health Checks:

| Setting | Value |
|---|---|
| HTTP Port | **`8080`** |
| Health Check path | **`/health`** |
| Initial Delay | **`60` seconds** |
| Period | `10` seconds |
| Timeout | `5` seconds |
| Success Threshold | `1` |
| Failure Threshold | `6` |

The API binds `0.0.0.0` and listens on `process.env.PORT` when set (App Platform sets `PORT` from the HTTP Port). `GET /health` returns `200` with `{ "ok": true, "service": "copyra-api" }` and no secrets.

If health checks still fail, open **Runtime Logs** on the `api` component: a missing encrypted env var crashes before listen; a wrong HTTP Port (e.g. `41717` or `3000` while the process is on `8080`) never receives the probe.

A checked-in example lives at `.do/app.yaml` (no secrets). Prefer setting encrypted env vars in the DO UI.

### App-level environment variables (secrets in DO UI only)

Missing `REDIS_URL` or `SESSION_SECRET` causes:

`Error: Invalid environment configuration: REDIS_URL / SESSION_SECRET Required`

Set these as **encrypted App-Level** env vars in the DigitalOcean UI (Settings → App-Level Environment Variables). Scope them to **all components** (`api`, `worker`, and `web` if it loads config). Never commit real values.

**Required for boot (this is what the runtime crash was complaining about):**

| Key | Notes |
|---|---|
| `DATABASE_URL` | Public Postgres URL (`sslmode=require`). Host **without** `private-`. |
| `REDIS_URL` | Managed Redis with **`rediss://`** (TLS) and the **PUBLIC** hostname (`copyra-cache-…`, **not** `private-copyra-cache-…`). App Platform cannot reach the private VPC hostname. |
| `SESSION_SECRET` | ≥32 random hex/bytes. |

**Trading kill switches (keep false until a funded bot key exists):**

```
TRADING_ENABLED=false
SOL_TRADING_ENABLED=false
EVM_TRADING_ENABLED=false
```

**Also set (encrypted) from your local `.env` / provider dashboards:**

```
PUBLIC_API_URL=
PUBLIC_WEB_URL=
CORS_ORIGINS=
SOLANA_RPC_URL=
SOLANA_WS_URL=
SOLANA_RPC_FALLBACK_URLS=
JUPITER_API_KEY=
EVM_ETHEREUM_RPC_URL=
EVM_ETHEREUM_WS_URL=
EVM_BASE_RPC_URL=
EVM_BASE_WS_URL=
EVM_ARBITRUM_RPC_URL=
EVM_ARBITRUM_WS_URL=
EVM_BSC_RPC_URL=
EVM_BSC_WS_URL=
EVM_POLYGON_RPC_URL=
EVM_POLYGON_WS_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SENTRY_DSN=
VITE_REOWN_PROJECT_ID=
NEXT_PUBLIC_REOWN_PROJECT_ID=
```

Bot signing keys only when you intend to trade (encrypted, never `VITE_*`):

```
SOLANA_BOT_PRIVATE_KEY=
EVM_BOT_PRIVATE_KEY=
```

After adding the variables, use **Force Rebuild and Deploy** (or Redeploy) so every component picks them up. Trusted Sources on Postgres/Redis must allow App Platform egress.

Use the **public** Postgres and Redis hostnames (without `private-`). Keep the App Platform egress / trusted sources list up to date.

### Prove the image locally

```bash
git clone https://github.com/COPYRA-BOT/COPYRA.git /tmp/copyra-docker-proof
cd /tmp/copyra-docker-proof
git checkout dev
# Confirm no secrets in the build context:
test ! -f .env
docker build -t copyra:proof .
```

The build must copy `tsconfig.base.json` into `/app`. Packages under `packages/*` and `apps/*` extend `../../tsconfig.base.json`.

## Railway

Create three services from this repo. Set the start command per service. Use a public Postgres URL (host **without** the `private-` prefix) unless the service is in that VPC. Redis is required.

Point `copyra.fun` at the web service. Set:

```
PUBLIC_WEB_URL=https://copyra.fun
PUBLIC_API_URL=https://api.copyra.fun
CORS_ORIGINS=https://copyra.fun
VITE_REOWN_PROJECT_ID=
NEXT_PUBLIC_REOWN_PROJECT_ID=
```

Either put the API on the same origin (`/api` reverse proxy) or set `VITE_API_URL` and cookie `Secure`/`SameSite` correctly.

## Environment

Copy `.env.example` for local work only. Never put `SOLANA_BOT_PRIVATE_KEY` or `EVM_BOT_PRIVATE_KEY` in `VITE_*` / `NEXT_PUBLIC_*`. Leave those keys empty for observe-only.

Rotate every credential that was pasted into chat before a public deploy.

## Day 3–6 live checklist (operator)

These are not done by code deploy alone:

3. Solana: watch one real trader, tiny Jupiter copy, confirm on Solscan.
4. Base: same with KyberSwap, confirm on Basescan. Then Arb/BNB.
5. Wait for a real TP or SL and confirm the sell.
6. Run 24/7 on small size; compare every trade, fee, and balance to explorers.
