# COPYRA production readiness

**As of:** 2026-10-05 01:55 UTC
**Verdict: NOT production-ready.** The dashboard, API, and Solana worker are running locally and the frontend is on GitHub. COPYRA still has no bot signing key and has never broadcast a transaction from this codebase.

This document marks an item **VERIFIED** only when a command was run in this environment and produced real evidence. Code existing, compiling, or looking complete is not enough.

Evidence files (gitignored, contain raw RPC URLs):

- `evidence/providers-2026-10-05T00-27-41-084Z.json` — 23/23 live provider checks
- `evidence/providers-2026-10-05T00-14-08-807Z.json` — earlier 23/23 run

Commands that produced the evidence below:

```
node scripts/audit-mocks.mjs          → pass
node scripts/audit-secrets.mjs        → pass
LIVE_RPC_TESTS=1 npx vitest run       → 15 files, 120 tests passed
npx tsx scripts/verify-providers.mts  → 23/23 passed
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
| Mock / simulation audit (`scripts/audit-mocks.mjs`) | **VERIFIED pass** | Scanned tracked `apps/` + `packages/` TypeScript. No `mock`, `fake`, `placeholder`, `TODO`, `FIXME`, or hardcoded balance/price in production source. |
| Secret audit (`scripts/audit-secrets.mjs`) | **VERIFIED pass** | No committed credential-shaped literals. `.env` is gitignored. `SOLANA_BOT_PRIVATE_KEY` / `EVM_BOT_PRIVATE_KEY` referenced only from `packages/core/src/security/signer.ts` and `packages/core/src/config/env.ts`. |

These audits prove the tracked source does not contain simulated trading or committed secrets. They do **not** prove the app can trade.

---

## 2. Automated tests (this session)

| Suite | Result | What it actually proves |
|---|---|---|
| Unit tests (`npx vitest run --exclude '**/*.live.spec.ts'`) | **VERIFIED 106/106 passed** | Pure engine rules behave as specified: qualification skips, sizing/reserve/tiers, Option A/B exits, decoder classification on constructed transactions, RPC failover, redaction, Telegram message layout, signer non-leakage, retry/timeout. |
| Live RPC tests (`LIVE_RPC_TESTS=1`) | **VERIFIED 14/14 passed** | Real Helius/Alchemy/Jupiter/KyberSwap/Dexscreener/Telegram calls. No-signer path refuses to broadcast. A non-existent signature is not marked CONFIRMED. |
| Full suite | **VERIFIED 120/120 passed** (15 files) | Union of the two rows above. |

### Unit tests that passed — engine rules only

These are **not** on-chain proof. They prove the functions do what the spec says when given known inputs.

- Qualification: first-buy-only, one-position-per-token, max positions, MC window, liquidity, blacklist, airdrop/transfer/stake/LP/claim/bridge/sell, token-to-token skip, monitor-only chain skip
- Sizing: reserve never consumed, 80% deployment cap, tier % ceilings, 1% pool-share cap, absolute max, insufficient balance
- Exits: SL −10%, TP +20% sell 100% (Option A), +20% sell 50% then trail 15% off high (Option B), stop-loss precedence, trader-sold
- Telemetry: `claimsVerified === false` with no confirmed samples
- Telegram templates: `BUY · SOL`, `SELL · STOP LOSS / TAKE PROFIT / TRAILING STOP / TRADER SOLD`, explorer links

### Tests the spec asked for that were **not** run

No worker or funded wallet exists, so these could not be executed against real fills:

- Insufficient-balance against a real wallet
- Concurrent position races against Postgres
- Duplicate-signal races against Redis + unique indexes
- TP/SL / trailing on a live position
- Partial-fill readback from a COPYRA-broadcast transaction
- Restart idempotency of the worker
- Database ↔ chain reconciliation of a COPYRA position

---

## 3. Real on-chain / live API verification

Source: `npx tsx scripts/verify-providers.mts` at 2026-10-05T00:27:41Z, **23/23 passed**, plus the 14 live vitest cases.

### Solana — VERIFIED

| Item | Evidence |
|---|---|
| Helius `getSlot` | slot **453417344** from `https://mainnet.helius-rpc.com` in 100ms |
| Alchemy Solana fallback in pool | pool reports 2 healthy endpoints (Helius + Alchemy) |
| Decode a real mainnet swap | signature [`7eXaHft83yQ21HKRp31hLHMCFXmDmfSdUqaUjFRHKecj9r7Ev2uCsJ1nyQQLcnwkLTxsZnXpZu7wjEh6y6RFMq9`](https://solscan.io/tx/7eXaHft83yQ21HKRp31hLHMCFXmDmfSdUqaUjFRHKecj9r7Ev2uCsJ1nyQQLcnwkLTxsZnXpZu7wjEh6y6RFMq9) classified **SELL** via Pump.fun AMM; wallet `FN1VGMu6fJru2nZzMLwjMqhavcPMxfYnsLWg6CdTF3f2` sold `BbJJUTuGV2B7tJ99YeryiCBFLG39Hoc4RTzEwchtpump` for 4.100 SOL. Earlier run decoded BUY [`5QQ4cZKf…LzCyLn`](https://solscan.io/tx/5QQ4cZKfWxXaZ959UULnHbsLhRZikm7Ar8WpqSVRmoXdr1CQTT5dYHH3f9JEy8D84k1eSZNHWzdMkXMqxyLzCyLn). |
| Confirm a historical signature | live test: `getSignatureStatuses` on `5QQ4cZKf…` returned `confirmed`/`finalized`, `err: null` |
| Jupiter quote 0.1 SOL → USDC | `outAmount=12100788` (≈12.10 USDC), `minOut=11979781`, route GoonFi V2, endpoint `https://api.jup.ag` |
| Jupiter SOL price | **$120.99** at `blockId` 453417328 |
| Jupiter unsigned swap build | VersionedTransaction, 8 instructions, blockhash `FpVXhMHK4seY25zoHpoFVS4mVgaPwhV7ZF8tjsqhoAyL`, `lastValidBlockHeight=431455796`. **Not signed. Not broadcast.** |
| No-signer guard | `executeSolanaSwap` returned `FAILED` / `NO_SIGNER` / `txHash=null` because `SOLANA_BOT_PRIVATE_KEY` is empty |
| Fake-signature confirmation | `confirmSolanaTransaction('1'×88)` returned UNKNOWN or EXPIRED — **not CONFIRMED** |

### EVM RPC — VERIFIED (read)

| Chain | chainId | block | Execution |
|---|---|---|---|
| Ethereum | 1 | 26122576 | ENABLED (route source exists) |
| Base | 8453 | 52185355 | ENABLED |
| Arbitrum | 42161 | 511765878 | ENABLED |
| BNB | 56 | 125772184 | ENABLED |
| Polygon | 137 | 94969938 | ENABLED |
| Optimism | 10 | 157780640 | ENABLED |
| Arc | 5042 | 24305105 | **DISABLED — monitor only** |
| Robinhood | 4663 | 80362383 | **DISABLED — monitor only** |
| Hyperliquid | 999 | 47685176 | **DISABLED — monitor only** |
| Tron | 728126428 | 86829124 | **DISABLED — monitor only** |

Chain ids were read from each Alchemy endpoint with `eth_chainId` and matched the registry.

### EVM tokens / routing — VERIFIED (quote/build only)

| Item | Evidence |
|---|---|
| Base USDC decimals | contract `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` reported **decimals=6**, symbol USDC, totalSupply `4375472204358526` |
| KyberSwap Base | in $27.25 → out $27.24, router `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`, 8842-byte calldata. **Unsigned. Not broadcast.** |
| KyberSwap Arbitrum | in $27.25 → out $27.25, same router, 8266-byte calldata. **Unsigned. Not broadcast.** |
| KyberSwap BNB | in $7.95 → out $7.94, same router, 10314-byte calldata. **Unsigned. Not broadcast.** |

### Market data — VERIFIED

| Item | Evidence |
|---|---|
| Dexscreener BONK | price $0.00000394, MC $346,738,055, liq $1,668,876, pair `5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9` |
| Jupiter cross-check | unified snapshot source `dexscreener:marketCap+jupiter:price`, price $0.000003939 |

Note: BONK's live MC is ~$347M, **above** the $20M copy-trade window. The qualifier would skip it. That skip path is unit-tested; it has not been observed on a live worker because no worker is running.

### Telegram — VERIFIED (reachability, not a trade alert)

| Item | Evidence |
|---|---|
| Bot token | `getMe` → `@copyrafun_bot` |
| Group | `getChat` → title **"Copyra bot"**, `canPostToChat=true` |

No BUY/SELL/SKIP message was sent in this session. Delivery of the formatted templates to the group is **NOT VERIFIED**.

---

## 4. Spec checklist — honest status

### Must be real. Current status.

| Requirement | Status | Why |
|---|---|---|
| Actual on-chain COPYRA buy/sell | **NOT VERIFIED** | No signing key. No broadcast. No COPYRA signature on any explorer. |
| Balances from chain | **IMPLEMENTED, NOT VERIFIED** | `readOnChainBalance` exists. No bot address to read. |
| Trader-wallet monitoring (Helius WS) | **IMPLEMENTED, NOT VERIFIED live fill** | Worker is running and subscribes to enabled Solana traders via `onLogs`. Zero traders were configured at boot, so no live signature has been ingested yet. |
| First-buy-only persisted | **IMPLEMENTED, NOT VERIFIED** | Prisma model + unique index exist. No runtime insert was exercised. |
| Correlated signals = one position | **VERIFIED (unit only)** | `qualifySignal` + sizing tests. No live multi-trader event. |
| Position sizing / reserve | **VERIFIED (unit only)** | 10 sizing tests passed. |
| Real swap execution | **NOT VERIFIED** | Quote and unsigned build verified. Sign/broadcast/confirm of a COPYRA tx has never happened. |
| Confirmation = chain state | **VERIFIED (negative + historical)** | Fake sig ≠ CONFIRMED. Historical sig is confirmed via `getSignatureStatuses`. A COPYRA-broadcast tx has never been confirmed. |
| TP/SL / trailing | **VERIFIED (unit only)** | 16 exit tests passed. No live position has ever hit TP or SL. |
| Backend trades with browser closed | **IMPLEMENTED, observe-only** | Worker process is independent of the dashboard. It cannot trade without a signing key. |
| Wallet connect + SIWE/SIWS | **IMPLEMENTED, NOT VERIFIED in browser** | Original Connect button + Phantom/MetaMask + `/api/auth/nonce|verify`. A real wallet signature has not been completed in this session. |
| Frontend ↔ backend | **VERIFIED (HTTP)** | The uploaded `copyra.` UI is served on `:43127` and loads `/api/snapshot` (200) with live SOL USD, chain heads, Telegram, empty traders/positions. Vite proxies `/api` to Fastify `:41717`. |
| Duplicate-trade prevention | **IMPLEMENTED, NOT VERIFIED** | Unique indexes + Redis lock code. No concurrent-signal test against Postgres. |
| Withdrawals / emergency stop | **IMPLEMENTED, NOT VERIFIED** | Settings fields and skip path exist. No UI, no live engage. |
| RPC outage / reconnect | **VERIFIED (unit failover)** | Pool fails over and cools down a dead endpoint. Live WS reconnect is untested (no WS subscriber). |
| Mainnet tiny-size copy | **NOT VERIFIED** | Blocked on a funded dedicated wallet key that must never be pasted into chat. |
| Security audit of a running system | **NOT VERIFIED** | Source audits passed. No running API/frontend to attack. |
| `copyra.fun` live | **NOT VERIFIED** | DNS / Railway not configured by this work. |
| Production DigitalOcean Postgres | **NOT VERIFIED** | `private-` host is unreachable from this machine. Local Postgres 16 accepted migrations. |

### Final audit questions (spec §28)

| Question | Answer |
|---|---|
| Is any production functionality still simulated? | No simulated success path exists. Several required surfaces are **not built**, which is not the same as simulated. |
| Is any balance hardcoded? | **VERIFIED no** in production source (mock audit + no hardcoded-balance matches). |
| Is any price hardcoded? | **VERIFIED no** in production source. Live prices came from Jupiter/Dexscreener. |
| Are any transactions fake? | COPYRA has produced **zero** transactions. Jupiter/KyberSwap builds were real and unsigned. |
| Are transaction signatures real? | The decoded mainnet signatures above are real. None of them were sent by COPYRA. |
| Are wallet balances real? | **No bot wallet.** Cannot answer. |
| Are trader signals coming from real blockchain data? | Decoder works on real txs. The worker is running and will subscribe to any enabled Solana trader. No watched wallet was configured at verification time, so no new live signal has been recorded. |
| Are buys actually broadcast? | **No.** |
| Are sells actually broadcast? | **No.** |
| Are TP/SL rules actually active? | Functions exist. Nothing is monitoring a position. **No.** |
| Does the backend still trade when the browser is closed? | The worker stays up without the browser. It still cannot trade: no signing key. |
| Are duplicate trades prevented? | Schema designed for it. **Not verified under load.** |
| Are first-buy rules persistent? | Schema designed for it. **Not verified across restart.** |
| Are deployment secrets protected? | **VERIFIED** for the git tree. Host `.env` still holds the chat-transmitted keys and **must be rotated**. |
| Are failed transactions handled? | Executor code handles them. **No failed COPYRA tx has been observed.** |
| Can the app recover after restart? | **No worker to restart.** |
| Can DB state be reconciled against chain? | Schema for drift flags exists. Reconciler **not built**. |
| Are monitoring and Telegram notifications operational? | Telegram chat is reachable. No trade notification has been sent. Sentry DSN is configured, not proven by a captured event. |

---

## 5. What is actually running

| Process | Status |
|---|---|
| Local Postgres 16 / Redis | Up. Settings row seeded at API boot. |
| API (`apps/api`) | **Running** on `0.0.0.0:41717`. `/health` 200. `/api/status` returned live heads (Solana slot **453436938**, Ethereum 26123013, Base 52187976) and Telegram `@copyrafun_bot` / chat **Copyra bot** `canPostToChat=true`. |
| Worker (`apps/worker`) | **Running**. Heartbeat written. 0 Solana subscriptions (no traders yet). Observe-only. |
| Web (`apps/web`) | **Running** on `0.0.0.0:43127`. Serves the uploaded COPYRA `copyra.` UI (`web/index.html`). Paper engine removed. `/api/snapshot` 200 with live SOL USD and chain heads. |
| GitHub | Frontend/API/worker sources pushed to `https://github.com/COPYRA-BOT/COPYRA.git` on `main`. |
| `copyra.fun` | **Not deployed.** This preview is the local Vite server, not the public domain. |

Dashboard verdict from HTTP: the live link can load the app and read real engine state. A full click-through of Reown connect still needs a wallet in the browser.

---

## 6. Required from you (unchanged)

1. **Rotate every credential that was pasted into chat** (DB password first, then Telegram, Helius, Alchemy, Jupiter, Resend).
2. Public DigitalOcean `DATABASE_URL` (host without `private-`) plus this host's egress IP on Trusted Sources.
3. A **fresh dedicated** trading wallet, funded with a tiny amount (~0.05 SOL), with its key placed only in the host secret store as `SOLANA_BOT_PRIVATE_KEY`. Never paste it into chat.
4. Confirm `@copyrafun_bot` should post into group `-5389164510` (reachability is verified; no message has been sent yet).
5. Point `copyra.fun` at a deployment once one exists.

Until (3) exists, COPYRA will continue to decode, qualify and quote for real, then record `BLOCKED_NO_SIGNER`. That is the correct behaviour.

---

## 7. Production-ready?

**No.**

Verified: live RPC/market/quote/decode/Telegram reachability, engine unit tests, source audits.

Not verified: a single COPYRA-signed transaction, a live copy of a trader, a TP/SL fill, a completed Reown sign-in, or a `copyra.fun` deploy.
