# COPYRA

On-chain copy trading for Solana and EVM. The engine watches real trader wallets, decodes confirmed transactions, qualifies first buys, and — only when a server-side bot key is present — broadcasts real Jupiter or KyberSwap swaps.

This repository is a working local platform: API, worker, and dashboard. It is **not** production-ready until a dedicated funded bot key exists and a COPYRA-signed transaction has confirmed on-chain. See `docs/READINESS.md`.

## What you can do in the dashboard

The UI is the original COPYRA `copyra.` frontend (Trading / Monitor / Leaderboard / PnL, SOL ↔ EVM modes, Connect, settings drawer). The in-page paper engine is gone. Numbers come from the live API:

- Solana slot and EVM heads from Helius / Alchemy
- Add, pause, and remove watched trader wallets
- Strategy settings, Option A / Option B exits, emergency stop
- Phantom / MetaMask connect + SIWE / SIWS
- Bot-wallet balance from RPC when a server key exists
- Empty lists stay empty until a real on-chain event arrives

Trading does **not** happen in the browser. The dashboard never receives `SOLANA_BOT_PRIVATE_KEY` or `EVM_BOT_PRIVATE_KEY`. Those exist only on the server, if you set them.

## Requirements

- Node.js 20.11+
- Postgres 16
- Redis

## Run locally

```bash
cp .env.example .env
# fill DATABASE_URL, REDIS_URL, RPC URLs, SESSION_SECRET, Telegram, VITE_REOWN_PROJECT_ID
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

That starts:

| Process | Port |
|---|---|
| API (`apps/api`) | `41717` locally (`API_PORT`); `8080` in Docker / App Platform (`PORT`) |
| Dashboard (`apps/web`) | `43127` |
| Worker (`apps/worker`) | no HTTP port — Helius log subscriptions + heartbeat |

Open `http://127.0.0.1:43127`. Vite proxies `/api` and `/health` to the API so session cookies stay same-origin.

Useful commands:

```bash
npm test
npm run audit:all
npm run verify:providers
npm run dev:api
npm run dev:web
npm run dev:worker
```

## Observe-only vs live trading

Leave the bot private keys blank to run observe-only:

1. Worker subscribes to watched Solana wallets
2. Buys are decoded and qualified against the real market-cap window
3. The signal is stored as `BLOCKED_NO_SIGNER`
4. Nothing is signed or broadcast

Set `TRADING_ENABLED=true` **and** a dedicated bot key only when you intend to spend that wallet’s funds.

## Repo layout

```
apps/api       Fastify HTTP + WebSocket API (SIWE/SIWS, Jupiter user-sign, snapshot)
apps/worker    Solana logs, EVM transfer polls, TP/SL marks, reconciliation
apps/web       Uploaded copyra. UI + Reown AppKit (Vite)
packages/core  RPC, decode, qualify, size, execute, exits, Jupiter, KyberSwap, Telegram
packages/db    Prisma schema and client
docs/          Audit, migration plan, readiness, deploy
```

## Socials

- X: https://x.com/copyrafun
- Telegram: https://t.me/copyrafun
- Domain: https://copyra.fun
