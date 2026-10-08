# COPYRA deployment

Live site: **https://copyra.fun** (DigitalOcean App Platform custom domain)  
Platform URL (same deploy): **https://copyra-nl7kz.ondigitalocean.app**

Every push to GitHub `COPYRA-BOT/COPYRA` branch `main` auto-deploys on DigitalOcean App Platform (`deploy_on_push: true`).

## Architecture (keeps the site up while trading runs)

| Component | Role | Health |
|---|---|---|
| `api` | Dashboard + `/api` + `/health` | HTTP health checks |
| `worker` | SOL/EVM detect → buy/sell + exits + Telegram | No HTTP (cannot make the app Degraded) |

`RUN_WORKER=false` on the API. Trading runs only on the dedicated worker.

## Domain stuck on “Configuring” / site 504 / DO Degraded

### A) Domain status = Configuring (your screenshot)

You do **not** need DigitalOcean nameservers if Cloudflare stays your DNS. The DO banner is generic. Fix validation:

1. DO → **copyra** → **Networking** → **Domains** → click `copyra.fun`.
2. Copy the **exact** CNAME/TXT/A records DO shows (not guesswork).
3. Cloudflare → DNS:
   - `copyra.fun` → CNAME → `copyra-nl7kz.ondigitalocean.app` → **DNS only** (grey).
   - `www` → same → **DNS only**.
   - Delete any extra A/AAAA on `@` that conflicts.
   - Add any **TXT** DO shows for ownership (required when stuck).
4. Cloudflare → SSL/TLS → mode **Full** (not Flexible).
5. Back in DO → **Refresh status**. Wait until status is **Active** (can take 15–60 min for cert).
6. If still Configuring after 1 hour: **Remove** `copyra.fun` from DO Domains → re-add as Primary → repeat records → Refresh.

Until status is **Active**, use `https://copyra-nl7kz.ondigitalocean.app` (should be green).

### B) Worker deploy failed: “did not respond to health checks”

The trading component must run `/app/scripts/start-worker.sh` (serves `/health` + trading).

1. DO → Settings → component **`worker`**
2. **Resource type** should be **Worker** (preferred). If you created a **Web Service**, set:
   - HTTP port **`8080`**
   - Health check path **`/health`**
   - Run command **`/app/scripts/start-worker.sh`**
   - Branch **`main`**
3. **Destroy** any failed duplicate worker component, then **Force rebuild and deploy**.
4. Confirm Runtime Logs → worker shows: `worker health listening` and `COPYRA worker starting`.

### C) Banner: `TRADING_ENABLED is false`

1. DO → Settings → **App-level** environment variables  
2. Set (or fix) **`TRADING_ENABLED=true`**, **`SOL_TRADING_ENABLED=true`**, **`EVM_TRADING_ENABLED=true`**  
3. Delete any App-level or component value that is `false` / empty  
4. Redeploy **api** (and worker). Dashboard cannot override a host `false`.

### D) App status = Degraded / 503 on `*.ondigitalocean.app`

That is the **container**, not DNS. You should see two components: `api` (Healthy) and `worker` (Running).

1. DO → **Runtime Logs** → select component **`api`** vs **`worker`**.
2. If `api` is unhealthy: check `DATABASE_URL` / migrate errors in api logs.
3. If `worker` crashes: check RPC keys + `TELEGRAM_*` are **App-level** secrets (available to **all** components), not only the api component.
4. Force redeploy: Actions → **Force rebuild and deploy**.

### C) Cloudflare (already DNS-only — keep it)

Grey cloud on `copyra.fun` + `www`. Leave it DNS only.

---

The Dockerfile is split into **independent BuildKit stages** so a backend-only change does not rebundle the Reown/Vite wallet app. First cold build is still longer; later pushes should reuse the cached `deps` + `build-web` (or `build-backend`) layers.

**Before you push:** run `npm run deploy:verify` (lint, types, tests, production build). GitHub Actions runs the same check on `main`.

**After deploy:** open the URLs in `docs/live-urls.json`.

## Processes (one Docker build)

| Process | How it runs on App Platform |
|---|---|
| API + dashboard | `scripts/start-production.sh` → Fastify on `:8080`, serves `apps/web/dist` |
| Worker | Same container, background (`RUN_WORKER=true`) |

Docker caches:
1. `deps` — `npm ci` until lockfile / package.json change  
2. `build-backend` — until `packages/`, `apps/api`, `apps/worker`, or `scripts/` change  
3. `build-web` — until `apps/web/` or lockfile change  

Runtime image is pruned (`npm prune --omit=dev`) so registry push is smaller/faster.

## DigitalOcean App Platform (exact settings)

The production Dockerfile expects the **repository root** as the build context.

| Field | Value |
|---|---|
| Source | GitHub `COPYRA-BOT/COPYRA` |
| Branch | **`main`** |
| Autodeploy | **On** |
| Source Directory | **leave blank** (repo root) |
| Dockerfile path | `Dockerfile` |
| Custom domain | **`copyra.fun`** (+ `www`) on App Platform |
| Platform ingress | **`copyra-nl7kz.ondigitalocean.app`** |

### Components

| Component | Type | HTTP port | Run command |
|---|---|---|---|
| `api` | Web service | **`8080`** | `/app/scripts/start-production.sh` |

The API serves the dashboard at `/` and JSON/WS under `/api` and `/health`, so **https://copyra.fun** is one same-origin app (session cookies + Reown SIWE/SIWS work). Set `PUBLIC_PLATFORM_URL` and `CORS_ORIGINS` to include your `*.ondigitalocean.app` host so the DO default URL behaves the same.

### API health checks

| Setting | Value |
|---|---|
| HTTP Port | **`8080`** |
| Health Check Path | **`/health`** |
| Initial Delay | **60s** |
| Period | **10s** |
| Timeout | **15s** |
| Success / Failure | **1 / 36** |

Worker is a separate App Platform **Worker** component (`start-worker.sh`) so trading load cannot flip the app to Degraded.

### Environment

Set in the DO UI (App-Level, encrypted for secrets). Spec also ships non-secret defaults in `.do/app.yaml`.

```
PUBLIC_WEB_URL=https://copyra.fun
PUBLIC_API_URL=https://copyra.fun
CORS_ORIGINS=https://copyra.fun,https://www.copyra.fun,https://copyra-nl7kz.ondigitalocean.app
MULTI_USER_CUSTODY=true
TRADING_ENABLED=true
```

Required secrets: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, bot keys, RPC URLs, Telegram, Reown project id. See `.do/app.yaml` comments.

### Keep the trading engine online (ops checklist)

| Priority | Action |
|---|---|
| 1 | **Cloudflare DNS only (grey cloud)** for `copyra.fun` / `www` — see above. Orange proxy is the main 504 source. |
| 2 | **PgBouncer** on DO Postgres: set `DATABASE_URL` = pooled, `DIRECT_URL` = direct, `PGBOUNCER=true` (see `docs/DATABASE_CONNECTIONS.md`). |
| 3 | Keep `TRADING_ENABLED` / `SOL_TRADING_ENABLED` / `EVM_TRADING_ENABLED` = `true` (App-Level). |
| 4 | Optional: upgrade App Platform size from `basic-xs` → `basic-s` if CPU still pegs during catch-up. |
| 5 | Telegram BUY/SELL DMs require **Settings → Connect Telegram BOT** with your chat ID (ops chat only gets admin/ops alerts). |

The worker is supervised 24/7 (`scripts/start-production.sh` respawns on crash). Live WS subscriptions keep detecting while catch-up runs in the background.

### Balances

Trading / Savings buckets are **live RPC reads of the signed-in account’s custody wallet**. They are not sticky browser guesses. Deposit via the dashboard Deposit button so funds land on that custody address (not the shared bot signer).

### Smoke after deploy

- `GET https://copyra.fun/` → dashboard HTML
- `GET https://copyra.fun/health` → `{"ok":true,"service":"copyra-api"}`
- `GET https://copyra.fun/api/status` → live status JSON (should respond in a few seconds)
- `GET https://copyra-nl7kz.ondigitalocean.app/health` → same JSON

In [WalletConnect Cloud](https://cloud.walletconnect.com/) allowlist **`https://copyra.fun`** (and `www` / App Platform hosts if you use them).
