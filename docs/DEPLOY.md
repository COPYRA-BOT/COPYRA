# COPYRA deployment

Live site: **https://copyra.fun** (DigitalOcean App Platform custom domain)  
Platform URL (same deploy): **https://copyra-nl7kz.ondigitalocean.app**

Every push to GitHub `COPYRA-BOT/COPYRA` branch `main` auto-deploys on DigitalOcean App Platform (`deploy_on_push: true`).

## Domain (DigitalOcean only)

TLS and the custom domain are managed **only** by App Platform. Do not put an external CDN/proxy in front of `copyra.fun`.

1. In **DigitalOcean → copyra → Networking → Domains**, keep `copyra.fun` (and `www`) attached (declared in `.do/app.yaml`).
2. At your DNS host, use the **A / CNAME records DigitalOcean shows** for that domain (not a proxy to `*.ondigitalocean.app` through a third-party CDN).
3. Wait for App Platform to issue the certificate. Status should be **Healthy**; `https://copyra.fun/health` → `{"ok":true,"service":"copyra-api"}`.

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
| Initial Delay | **60s** (xxs boot) |
| Period | **5s** |
| Timeout | **5s** |
| Success / Failure | **1 / 12** |

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

### Balances

Trading / Savings buckets are **live RPC reads of the signed-in account’s custody wallet**. They are not sticky, cached, or invented in the browser. Deposit via the dashboard Deposit button so funds land on that custody address (not the shared bot signer).

### Smoke after deploy

- `GET https://copyra.fun/` → dashboard HTML
- `GET https://copyra.fun/health` → `{"ok":true,"service":"copyra-api"}`
- `GET https://copyra.fun/api/status` → live status JSON (should respond in a few seconds)
- `GET https://copyra-nl7kz.ondigitalocean.app/health` → same JSON

In [WalletConnect Cloud](https://cloud.walletconnect.com/) allowlist **`https://copyra.fun`** (and `www` / App Platform hosts if you use them).
