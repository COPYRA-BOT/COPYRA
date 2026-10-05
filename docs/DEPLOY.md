# COPYRA deployment

Live site: **https://copyra.fun**

Every push to GitHub `COPYRA-BOT/COPYRA` branch `main` auto-deploys on DigitalOcean App Platform (`deploy_on_push: true`). Fixes landed here are pushed to GitHub so the live domain updates.

## Processes

| Service | Command | Port | Role |
|---|---|---|---|
| api | `npm run start -w @copyra/api` | `8080` in Docker / App Platform (`PORT`), `41717` locally via `API_PORT` | Fastify HTTP + WS **and** the built dashboard (`apps/web/dist`) on the same origin |
| worker | `npm run start -w @copyra/worker` | none | monitors + exits |

Build order inside Docker: `npm ci && npm run db:generate && npm run build`.

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
| `api` | Web service | **`8080`** | `npm run start -w @copyra/api` |
| `worker` | Worker | none | `npm run start -w @copyra/worker` |

The API serves the dashboard at `/` and JSON/WS under `/api` and `/health`, so **https://copyra.fun** is one same-origin app (session cookies + Reown SIWE/SIWS work).

### API health checks

| Setting | Value |
|---|---|
| HTTP Port | **`8080`** |
| Health Check path | **`/health`** |
| Initial Delay | **`60` seconds** |

### Public (non-secret) env vars — set on the app / api component

```
PUBLIC_WEB_URL=https://copyra.fun
PUBLIC_API_URL=https://copyra.fun
CORS_ORIGINS=https://copyra.fun
PORT=8080
API_HOST=0.0.0.0
TRADING_ENABLED=false
SOL_TRADING_ENABLED=false
EVM_TRADING_ENABLED=false
```

A checked-in example lives at `.do/app.yaml` (no secrets).

### Encrypted secrets (DO UI only)

| Key | Notes |
|---|---|
| `DATABASE_URL` | Public Postgres URL with `sslmode=require`. Host **without** `private-`. Use the **real** database password from the DO control panel — do **not** paste the UI label `show-password`. |
| `REDIS_URL` | Managed Redis **`rediss://`** + **PUBLIC** hostname (not `private-`). |
| `SESSION_SECRET` | ≥32 random hex/bytes. |

Also set RPC / Telegram / Reown vars from `.env.example`. Bot signing keys only when you intend to trade.

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
