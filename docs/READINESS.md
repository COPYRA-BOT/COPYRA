# COPYRA production readiness

**As of:** 2026-10-05 11:49 UTC
**Verdict: NOT production-ready.** The dashboard, API, and worker now persist to the public DigitalOcean Postgres host. COPYRA still has no bot signing key and has never broadcast a transaction from this codebase.

This document marks an item **VERIFIED** only when a command was run in this environment and produced real evidence. Code existing, compiling, or looking complete is not enough.

Evidence files (gitignored, contain raw RPC URLs):

- `evidence/providers-2026-10-05T02-46-17-837Z.json` — 23/23 live provider checks
- `evidence/providers-2026-10-05T00-27-41-084Z.json` — earlier 23/23 run

Commands that produced the evidence below:

```
node scripts/audit-mocks.mjs          → pass
node scripts/audit-secrets.mjs        → pass
npx vitest run --exclude '**/*.live.spec.ts'  → 16 files, 116 tests passed
LIVE_RPC_TESTS=1 npx vitest run --testNamePattern=live  → 14/14 passed
npx tsx scripts/verify-providers.mts  → 23/23 passed
npm run typecheck -w @copyra/api && npm run typecheck -w @copyra/worker → pass
npm run build -w @copyra/web          → Vite production build succeeded
```

---

## How to read the marks

| Mark | Meaning |
|---|---|
| **VERIFIED** | Observed with a real RPC/API response, a passing test run, or a passing audit in this session. The evidence is cited. |
| **IMPLEMENTED, NOT VERIFIED** | Code exists. No live confirmation of the behaviour. |
| **NOT BUILT** | No implementation beyond a package.json stub. |

---

## 1. Audits (this session)

| Check | Result | Evidence |
|---|---|---|
| Mock / simulation audit (`scripts/audit-mocks.mjs`) | **VERIFIED pass** | Tracked `apps/` + `packages/` TypeScript. No `mock`, `fake`, `placeholder`, `TODO`, `FIXME`, or hardcoded balance/price in production source. |
| Secret audit (`scripts/audit-secrets.mjs`) | **VERIFIED pass** | No committed credential-shaped literals. `.env` is gitignored. Signing-key env names appear only in `signer.ts`, `env.ts`, and `.env.example`. |

These audits prove the tracked source does not contain simulated trading or committed secrets. They do **not** prove the app can trade.

---

## 2. Automated tests (this session)

| Suite | Result | What it actually proves |
|---|---|---|
| Unit tests | **VERIFIED 116/116 passed** | Qualify, size, exits, execution gate, Telegram migrate parse, decoder, RPC failover, redaction, signer non-leakage, retry. |
| Live RPC tests | **VERIFIED 14/14 passed** | Real Helius/Alchemy/Jupiter/KyberSwap/Dexscreener/Telegram. No-signer path refuses to broadcast. A non-existent signature is not marked CONFIRMED. |
| Full union | **130 tests** (116 unit + 14 live) | |

### New unit coverage this pass

- `executionGate`: no signer → `BLOCKED_NO_SIGNER` and the detail states nothing was broadcast
- `fractionOfRaw`: integer half-sell
- `parseTelegramMigrateTo`: Telegram HTTP 400 `migrate_to_chat_id` is read from the error body

### Tests the spec asked for that were **not** run

No funded wallet exists, so these could not be executed against real fills:

- Insufficient-balance against a real wallet
- Concurrent position races against Postgres
- Duplicate-signal races against Redis + unique indexes
- TP/SL / trailing on a live position
- Partial-fill readback from a COPYRA-broadcast transaction
- Restart idempotency of the worker
- Database ↔ chain reconciliation of a COPYRA position
- User-signed Jupiter broadcast in a browser

---

## 3. Real on-chain / live API verification

Source: `npx tsx scripts/verify-providers.mts` at 2026-10-05T02:46:17Z, **23/23 passed**.

### Solana — VERIFIED (read / quote / unsigned build)

| Item | Evidence |
|---|---|
| Helius `getSlot` | slot **453448430** from `https://mainnet.helius-rpc.com` in 100ms |
| Alchemy Solana fallback | 2 healthy endpoints |
| Decode a real mainnet swap | signature `554CxMV6cxkfTPM9rpyC8oBAVoPhgqWvzY2zT5MPNvPXV8woL7aZrEn3XU53aas8MwkKBGtYbckdDc3R3beA1qPQ` classified **SELL** via Pump.fun |
| Jupiter quote 0.1 SOL → USDC | `outAmount=12141062`, route Whirlpool, `https://api.jup.ag` |
| Jupiter SOL price | **$121.41** at `blockId` 453448414 |
| Jupiter unsigned swap build | VersionedTransaction, 8 instructions, blockhash `CJY8gWkiEntanNDJ8EFxypUUwQ975CPTRSthLRe9sbHM`. **Not signed. Not broadcast.** |
| No-signer guard | `executeSolanaSwap` returns `FAILED` / `NO_SIGNER` / `txHash=null` |

### EVM RPC — VERIFIED (read)

Ethereum 1 / Base 8453 / Arbitrum 42161 / BNB 56 / Polygon 137 / Optimism 10 matched `eth_chainId`. Arc, Robinhood, Hyperliquid, Tron are monitor-only.

### EVM routing — VERIFIED (quote/build only)

KyberSwap Base / Arbitrum / BNB returned live routes and unsigned calldata. **Not broadcast.**

### Telegram — VERIFIED (reachability)

`getMe` → `@copyrafun_bot`. `getChat` → **"Copyra bot"**, writable. No BUY/SELL fill alert has been sent because no COPYRA fill exists.

---

## 4. Spec checklist — honest status

| Requirement | Status | Why |
|---|---|---|
| Actual on-chain COPYRA buy/sell | **NOT VERIFIED** | No signing key. No broadcast. No COPYRA signature on any explorer. |
| QUALIFIED path calls the real executor | **IMPLEMENTED, NOT VERIFIED live fill** | Worker now calls `handleQualifiedCopy` → `executeSolanaSwap` / `executeEvmSwap`. Without a key this records `BLOCKED_NO_SIGNER`. |
| EVM Base monitor | **IMPLEMENTED, NOT VERIFIED ingest** | Alchemy `alchemy_getAssetTransfers` poll. No Base trader configured at verification time. |
| Balances from chain | **IMPLEMENTED, NOT VERIFIED** | `readOnChainBalance` exists. No bot address to read. |
| First-buy-only persisted | **IMPLEMENTED, NOT VERIFIED** | Prisma unique + pipeline writes inside a Redis lock. |
| Position sizing / reserve | **VERIFIED (unit only)** | 10 sizing tests + execution-gate tests. |
| Real swap execution | **NOT VERIFIED** | Quote and unsigned build verified. |
| Confirmation = chain state | **VERIFIED (negative + historical)** | Fake sig ≠ CONFIRMED. Historical sigs confirm via RPC. |
| TP/SL / trailing | **IMPLEMENTED, NOT VERIFIED live** | Worker ticks `monitorOpenPositions`. No open position exists. |
| User-signed Jupiter | **IMPLEMENTED, NOT VERIFIED in browser** | `/api/swap/quote|build|broadcast` + Reown AppKit module. |
| Reown + SIWE/SIWS | **IMPLEMENTED, NOT VERIFIED in browser** | Connect Wallet button + AppKit. Needs a wallet extension. |
| Frontend ↔ backend | **VERIFIED (HTTP, prior session)** | `copyra.` UI + `/api/snapshot`. |
| Telegram migrate_to_chat_id | **VERIFIED (unit parse)** | Retry path exists. Live migrate not re-triggered. |
| `copyra.fun` / Railway | **NOT VERIFIED** | `docs/DEPLOY.md` + Dockerfile only. |
| Production DigitalOcean Postgres | **VERIFIED reachable** | Public host `db-pgsql-nyc1-98023-do-user-45647566-0.k.db.ondigitalocean.com:25060` accepted SSL from this machine (egress `35.163.190.53`). Prisma applied 3 migrations. API `/api/snapshot` returned `settingsId=1` and worker heartbeat `running` from that database. The literal password `show-password` was rejected; the previously supplied `doadmin` password worked on the public hostname. **Rotate it.** The `private-` hostname is still not used. |

### Final audit questions (spec §28)

| Question | Answer |
|---|---|
| Is any production functionality still simulated? | No simulated success path. Several required surfaces are **unverified** because there is no funded bot key. |
| Is any balance hardcoded? | **VERIFIED no** in production TypeScript. |
| Is any price hardcoded? | **VERIFIED no.** Live prices came from Jupiter/Dexscreener. |
| Are any transactions fake? | COPYRA has produced **zero** transactions. |
| Are buys actually broadcast? | **No.** |
| Are sells actually broadcast? | **No.** |
| Are TP/SL rules actually active? | The worker now ticks open positions. Nothing is open. **No live exit.** |
| Does the backend still trade when the browser is closed? | Worker is independent. It still cannot trade: no signing key. |
| Are deployment secrets protected? | **VERIFIED** for the git tree. Host `.env` still holds chat-transmitted keys and **must be rotated**. |

---

## 5. What is actually running

| Process | Status |
|---|---|
| DigitalOcean Postgres (public host) | **Connected.** Schema migrated. Settings row id=1. |
| Local Redis | Used by API/worker |
| API | Fastify `:41717` |
| Worker | Solana logs + EVM polls + exit marks + reconcile |
| Web | Vite `:43127`, uploaded `copyra.` UI + Reown module |
| GitHub | Pushed to `https://github.com/COPYRA-BOT/COPYRA.git` on `main` |
| `copyra.fun` | **Not deployed** |

---

## 6. Required from you

1. **Rotate every credential that was pasted into chat.**
2. Keep egress IP `35.163.190.53` on the database Trusted Sources list. Rotate the `doadmin` password that was pasted into chat and send only a new URL.
3. A **fresh dedicated** trading wallet, funded with a tiny amount (~0.05 SOL), with its key placed only in the host secret store. Never paste it into chat.
4. Add at least one real Solana trader in the dashboard, set `TRADING_ENABLED=true` only when you intend to spend that wallet.
5. Point `copyra.fun` at Railway after a confirmed tiny fill.

Until (3) exists, COPYRA will decode, qualify and quote for real, then record `BLOCKED_NO_SIGNER`. That is the correct behaviour.

---

## 7. Production-ready?

**No.**

Verified: live RPC/market/quote/decode/Telegram reachability, engine unit tests, source audits, QUALIFIED→executor wiring (observe-only), Vite + Reown build, public DigitalOcean Postgres (migrated, settings + heartbeat).

Not verified: a single COPYRA-signed transaction, a live copy of a trader, a TP/SL fill, a completed Reown sign-in, or a `copyra.fun` deploy.
