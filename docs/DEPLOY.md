# COPYRA deployment

`copyra.fun` is the intended public domain. This repository is not pointed at it yet. Deploy only after a dedicated funded bot wallet exists and a tiny mainnet fill has been confirmed on an explorer.

## Processes

Run three services from the same image / repo:

| Service | Command | Port | Role |
|---|---|---|---|
| api | `npm run start -w @copyra/api` | `41717` | Fastify HTTP + WS |
| worker | `npm run start -w @copyra/worker` | none | monitors + exits |
| web | `npm run preview -w @copyra/web` | `43127` | Vite-built `copyra.` UI |

Build order: `npm run db:generate && npm run db:migrate && npm run build`.

## Railway

Create three services from this repo. Set the start command per service. Use a public Postgres URL (not a `private-` DigitalOcean host unless the service is in that VPC). Redis is required.

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

Copy `.env.example`. Never put `SOLANA_BOT_PRIVATE_KEY` or `EVM_BOT_PRIVATE_KEY` in `VITE_*` / `NEXT_PUBLIC_*`. Leave those keys empty for observe-only.

Rotate every credential that was pasted into chat before a public deploy.

## Day 3–6 live checklist (operator)

These are not done by code deploy alone:

3. Solana: watch one real trader, tiny Jupiter copy, confirm on Solscan.
4. Base: same with KyberSwap, confirm on Basescan. Then Arb/BNB.
5. Wait for a real TP or SL and confirm the sell.
6. Railway 24/7 on small size; compare every trade, fee, and balance to explorers.
