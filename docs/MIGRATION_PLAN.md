# COPYRA production migration plan

**Date:** 2026-10-05  
**Rule:** do not mark a step complete because the code compiles. A trade is executed only after the chain reports the required confirmation state.

This plan is the audit-then-change sequence for taking the current repository from observe-only to real on-chain copy trading without inventing fills, hashes, or balances.

## 1. Audit findings (this pass)

| Area | Current state | Gap |
|---|---|---|
| Frontend | Uploaded `copyra.` UI on Vite `:43127`, hydrated from `/api/snapshot` | Reown AppKit was removed with the earlier React dashboard. Connect still uses Phantom / MetaMask + SIWE/SIWS. Search input uses the HTML `placeholder` attribute (display only). |
| Backend API | Fastify on `:41717`, live RPC heads, settings, traders, positions, SIWE/SIWS | No user-signed Jupiter quote/build/broadcast/confirm route. NestJS was not introduced — Fastify is already the running API and a rebuild would break the live UI. |
| Solana worker | Helius `onLogs` → decode → qualify → persist | A `QUALIFIED` signal never called `executeSolanaSwap`. |
| EVM worker | Not started | Base / Arb / BNB wallets were not monitored. |
| Exits | Pure `evaluateExit` + unit tests | No worker loop marked prices or sold on TP/SL/trail. |
| Reconciliation | Schema (`DriftFlag`, UNKNOWN trades) | No sweeper resolved UNKNOWN / expired signatures against RPC. |
| Telegram | `getMe` / `getChat` verified | `migrate_to_chat_id` was handled only by editing `.env`, not in code. |
| Signing | Isolated in `signer.ts`, env-only | No `SOLANA_BOT_PRIVATE_KEY` / `EVM_BOT_PRIVATE_KEY` on this host. Observe-only is correct. |
| Database | Local Postgres 16 + Prisma invariants | DigitalOcean `private-` host is unreachable from this machine. |
| Deploy | Not on Railway / `copyra.fun` | Preview is the local Vite server. |

Banned-word scan of `apps/` + `packages/` TypeScript is enforced by `scripts/audit-mocks.mjs`. HTML is not part of that scan.

## 2. Workstreams (order)

### Backend / engine

1. Shared copy-execution pipeline: lock → re-check first-buy and open position → size from live RPC balance → quote → build → sign → broadcast → confirm → persist.
2. Solana worker: call that pipeline on `QUALIFIED`. If no signer, persist `BLOCKED_NO_SIGNER` and do not invent a trade.
3. EVM monitor (Base first, then Arbitrum / BNB when enabled): Alchemy transfers → receipt decode → same pipeline via KyberSwap.
4. Position monitor: Dexscreener / Jupiter marks, `evaluateExit`, real sell only after confirmation.
5. Reconciliation sweeper: UNKNOWN / BROADCAST trades re-read via `getSignatureStatuses` / receipts.
6. Telegram: retry `sendMessage` when Telegram returns `migrate_to_chat_id`.
7. User-signed Solana swaps: session-gated quote / unsigned build / signed-broadcast / confirm. Never store a user key.

### Frontend

1. Keep the uploaded `copyra.` UI and live `/api/snapshot` hydration.
2. Add Reown AppKit (Wagmi + Solana adapters) as a Vite module behind the existing Connect button.
3. SIWE / SIWS against the existing Fastify auth routes.
4. Optional Jupiter swap from the connected Solana wallet (user signs; server confirms).

### Security

1. Bot keys remain env-only, never `VITE_` / `NEXT_PUBLIC_`.
2. Frontend never receives bot key material.
3. Redaction on logs, Sentry, and Telegram stays in place.
4. Duplicate execution: Redis lock + `trades.idempotencyKey` + `positions_one_open_per_token`.

### Tests

1. Unit: execution gate, raw-amount fraction, Telegram migrate parse, existing qualify / size / exit suites.
2. Live RPC (`LIVE_RPC_TESTS=1`): quote, unsigned build, no-signer refuse, fake signature ≠ `CONFIRMED`.
3. Do not claim a COPYRA fill until an explorer-visible hash exists.

### Deploy

1. Document three Railway services (api, worker, web) in `docs/DEPLOY.md`.
2. Do not flip `copyra.fun` until a funded dedicated bot key exists and a tiny mainnet fill is confirmed.

## 3. What this pass will not fake

- A confirmed COPYRA buy or sell
- A wallet balance when no bot address exists
- Day 3–6 live copy / Base fill / TP-SL fill / Railway 24/7
- “1–2 second execution” as a guarantee

Those remain operator steps: rotate leaked credentials, fund a dedicated bot wallet, add traders, enable `TRADING_ENABLED`, and watch explorers.
