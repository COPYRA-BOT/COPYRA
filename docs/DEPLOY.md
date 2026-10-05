# COPYRA deployment

Live site: **https://copyra.fun**

Every push to GitHub `COPYRA-BOT/COPYRA` branch `main` auto-deploys on DigitalOcean App Platform (`deploy_on_push: true`).

**Before you push:** run `npm run deploy:verify` (lint, types, tests, production build). GitHub Actions runs the same check on `main`.

**After deploy:** open the URLs in `docs/live-urls.json` — production **https://copyra.fun** and your `*.ondigitalocean.app` platform URL (same build).

## Processes (one Docker build)

| Process | How it runs on App Platform |
|---|---|
| API + dashboard | `scripts/start-production.sh` → Fastify on `:8080`, serves `apps/web/dist` |
| Worker | Same container, background (`RUN_WORKER=true`) |

Docker caches the `npm ci` layer when lockfiles are unchanged (~2× faster redeploys). Only **one** component builds the image (no separate worker build).

Build order inside Docker: cached `npm ci` → `db:generate` → `build`.

## DigitalOcean App Platform (exact settings)

The production Dockerfile expects the **repository root** as the build context.

| Field | Value |
|---|---|
| Source | GitHub `COPYRA-BOT/COPYRA` |
| Branch | **`main`** |
| Autodeploy | **On** |
| Source Directory | **leave blank** (repo root) |
| Dockerfile path | `Dockerfile` |
| Primary domain | **`copyra.fun`** |

### Components

| Component | Type | HTTP port | Run command |
|---|---|---|---|
| `api` | Web service | **`8080`** | `/app/scripts/start-production.sh` |

The API serves the dashboard at `/` and JSON/WS under `/api` and `/health`, so **https://copyra.fun** is one same-origin app (session cookies + Reown SIWE/SIWS work). Set `PUBLIC_PLATFORM_URL` and `CORS_ORIGINS` to include your `*.ondigitalocean.app` host so the DO default URL behaves the same.

### API health checks

| Setting | Value |
|---|---|
| HTTP Port | **`8080`** |
| Health Check path | **`/health`** |
| Initial Delay | **`35` seconds** |

### Public (non-secret) env vars — set on the app / api component

```
PUBLIC_WEB_URL=https://copyra.fun
PUBLIC_API_URL=https://copyra.fun
CORS_ORIGINS=https://copyra.fun
PORT=8080
API_HOST=0.0.0.0
TRADING_ENABLED=true
SOL_TRADING_ENABLED=true
EVM_TRADING_ENABLED=true
```

Use lowercase `true` / `false` (or `1` / `0`). Values like `True` / `TRUE` are now accepted by the API, but prefer lowercase.

### Required for live balances / deposit / withdraw (encrypted, App-Level, ALL components)

Bot keys alone are not enough. The **api** and **worker** must both see RPC URLs:

```
DATABASE_URL=
REDIS_URL=
SESSION_SECRET=
SOLANA_BOT_PRIVATE_KEY=
EVM_BOT_PRIVATE_KEY=
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
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
VITE_REOWN_PROJECT_ID=
NEXT_PUBLIC_REOWN_PROJECT_ID=
```

`VITE_REOWN_PROJECT_ID` is the public Reown / WalletConnect project id (safe to expose). Set it **App-Level → RUN_AND_BUILD_TIME** (or at least RUN_TIME). The API serves it via `/config.js` and `/api/public-config` so Connect Wallet can open the full multi-wallet Reown modal even when the Docker build did not bake the id.

Scope every encrypted var to **App-Level → All components** (or both `api` and `worker`). If RPCs are only on the worker, `/api/funds` and `/api/balances` fail with `SOLANA_RPC_URL is not configured`.

After editing env: **Force Rebuild and Deploy**. Then confirm:

- `GET /api/status` → `trading.envGuard: true`, `signers.*.available: true`, chain heads present
- `GET /api/funds?mode=sol` → `configured: true` with `onChainQuote`
- Dashboard: enable the trading switch (settings DB row)

### Cloudflare HTTPS `526`

`http://copyra.fun` may work while `https://copyra.fun` returns **526**. In Cloudflare SSL/TLS set mode to **Full** (or Full strict once DO has a valid cert), and ensure the origin is the App Platform ingress — not a dead IP.

### Cloudflare + DNS

`copyra.fun` often resolves through Cloudflare. In Cloudflare DNS, the `@` record must point at the DigitalOcean App Platform target from **Networking → Domains** (CNAME or A as DO shows). If Cloudflare returns an empty `404` while the app is Healthy in DO, the origin/DNS target is wrong — fix DNS, then purge cache.

After DNS is correct you should see:

- `GET https://copyra.fun/` → dashboard HTML
- `GET https://copyra.fun/health` → `{"ok":true,"service":"copyra-api"}`
- `GET https://copyra.fun/api/status` → live status JSON

### Prove the image locally

```bash
git clone https://github.com/COPYRA-BOT/COPYRA.git /tmp/copyra-docker-proof
cd /tmp/copyra-docker-proof
git checkout main
test ! -f .env
docker build -t copyra:proof .
```

## Auto-deploy loop

1. Change code in this repo on `main`.
2. `git push` to GitHub `COPYRA-BOT/COPYRA` (`main`).
3. App Platform builds from the Dockerfile and rolls the live app.
4. Test on **https://copyra.fun**.

## Environment

Copy `.env.example` for local work only. Never put bot keys in `VITE_*` / `NEXT_PUBLIC_*`. Leave those keys empty for observe-only.

Rotate every credential that was pasted into chat before treating the deploy as long-term production.

## Day 3–6 live checklist (operator)

3. Solana: watch one real trader, tiny Jupiter copy, confirm on Solscan.
4. Base: same with KyberSwap, confirm on Basescan. Then Arb/BNB.
5. Wait for a real TP or SL and confirm the sell.
6. Run 24/7 on small size; compare every trade, fee, and balance to explorers.
