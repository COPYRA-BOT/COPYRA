# COPYRA deployment

`copyra.fun` is the intended public domain. Deploy only after a dedicated funded bot wallet exists and a tiny mainnet fill has been confirmed on an explorer.

## Processes

Run three services from the same image / repo:

| Service | Command | Port | Role |
|---|---|---|---|
| api | `npm run start -w @copyra/api` | `41717` | Fastify HTTP + WS |
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
| `api` | Web service | `41717` | `npm run start -w @copyra/api` |
| `web` | Web service | `43127` | `npm run preview -w @copyra/web -- --host 0.0.0.0 --port 43127` |
| `worker` | Worker | none | `npm run start -w @copyra/worker` |

Health check for `api`: `GET /health`.

A checked-in example lives at `.do/app.yaml` (no secrets). Prefer setting encrypted env vars in the DO UI.

### App-level environment variables (secrets in DO UI only)

Set these as **encrypted** App-Level or component env vars — never in git:

```
DATABASE_URL=
REDIS_URL=
SESSION_SECRET=
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
TRADING_ENABLED=false
```

Bot signing keys only when you intend to trade (encrypted, never `VITE_*`):

```
SOLANA_BOT_PRIVATE_KEY=
EVM_BOT_PRIVATE_KEY=
```

Use the **public** Postgres hostname (without `private-`). Keep the App Platform egress / trusted sources list up to date.

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
