# COPYRA API integration

Base URL locally: `http://127.0.0.1:41717`  
The Vite dashboard on `:43127` proxies `/api` and `/health` to that origin so cookies stay same-site.

Nothing in these routes invents a fill. A trade is `executed: true` only after Solana `getSignatureStatuses` or an EVM receipt with `status === 'success'`.

## Public / dashboard

| Method | Path | Source of data |
|---|---|---|
| GET | `/health` | process liveness |
| GET | `/api/status` | live RPC heads, Telegram `getMe`/`getChat`, signer presence, worker heartbeat |
| GET | `/api/snapshot` | status + settings + traders + positions + signals + trades + pnl + balances + live SOL USD |
| GET | `/api/settings` | `strategy_settings` row + effective config |
| PATCH | `/api/settings` | operator risk limits (never silently changed by the engine) |
| POST | `/api/settings/emergency-stop` | kill switch; Telegram alert |
| POST | `/api/settings/emergency-clear` | clear kill switch |
| GET/POST/PATCH/DELETE | `/api/traders` | watched wallets |
| GET | `/api/positions` | positions; OPEN only after a confirmed entry |
| GET | `/api/signals` | qualification decisions |
| GET | `/api/trades` | one row per broadcast attempt, with explorer URL |
| GET | `/api/pnl` | confirmed realized + last mark unrealized |
| GET | `/api/balances` | bot wallet from RPC, or `configured: false` |
| GET | `/api/wallet/onchain?address=&chain=` | any address, live RPC |
| GET | `/api/market/:chain/:address` | Dexscreener |
| GET | `/api/notifications` | Telegram delivery log |
| GET | `/api/ws` | status ticks |

## Auth (SIWE / SIWS)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/nonce` | `{ address, chain }` → server nonce + message |
| POST | `/api/auth/verify` | `{ address, chain, message, signature }` → httpOnly session cookie |
| GET | `/api/auth/me` | current session |
| POST | `/api/auth/logout` | revoke cookie |

The frontend never sends a private key. Bot keys stay in `SOLANA_BOT_PRIVATE_KEY` / `EVM_BOT_PRIVATE_KEY` on the server only.

## User-signed Jupiter (Solana session required)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/swap/quote` | live Jupiter quote |
| POST | `/api/swap/build` | unsigned VersionedTransaction for the signed-in pubkey |
| POST | `/api/swap/broadcast` | user-signed bytes → `sendRawTransaction` → confirm |
| GET | `/api/swap/tx/:signature` | re-read confirmation from RPC |

`broadcast` returns `executed: false` unless confirmation status is `CONFIRMED`.

## Providers

- Solana RPC/WS: Helius, Alchemy fallback
- EVM RPC/WS: Alchemy per chain
- Solana routes: Jupiter (`x-api-key` when set, lite fallback)
- EVM routes: KyberSwap Aggregator
- Market: Dexscreener + Jupiter price cross-check on Solana
- Alerts: Telegram Bot API, Sentry
