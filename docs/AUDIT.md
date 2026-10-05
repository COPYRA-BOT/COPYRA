# COPYRA — Repository Audit & Production-Readiness Report

**Audit date:** 2026-10-04
**Auditor:** lead production blockchain engineer (automated agent)
**Scope:** entire repository, all provided credentials, all declared chains.

---

## 0. Finding #1 — the starting repository was empty

The task described an existing repository containing simulated/demo blockchain
functionality, with two attachments:

- `copyra-updated_code_file__SOL_EVM__V2_2b44.zip`
- `COPYRA_Production_OnChain_Master_Prompt_f34d.docx`

**Neither attachment was present on the build machine, and the git repository
had a single root commit containing zero files:**

```
$ git ls-tree -r HEAD --name-only
(empty)
$ git log --oneline
a74d33b Initialize project
```

```
$ ls /workspace/uploads
ls: cannot access '/workspace/uploads': No such file or directory
$ find / -iname 'copyra*'
(no results)
```

This is reported rather than worked around, because it changes the nature of the
job: there was no prior implementation to preserve, and no "existing frontend"
or prior business-rule source other than the written specification in the task
itself.

**Consequence:** every behavioural rule in this codebase is derived from the
written specification (market-cap tiers, 80% max deployment, first-buy-only,
reserve, TP/SL/trailing, Telegram message layout, chain list, notification
triggers). Nothing was inferred from a previous codebase. If the zip contained
rules that differ from the written spec, those differences are **not** reflected
here — re-upload the zip and they will be reconciled.

### Mock/stub search

The requested grep sweep (`mock`, `simulated`, `fake`, `placeholder`, `TODO`,
`FIXME`, `hardcoded balance`, `hardcoded price`, `fake signature`,
`test wallet`, `sample data`) was run against the repository at `HEAD`.
Result: **0 files scanned, 0 matches — the tree was empty.**

The same sweep is now wired into CI (`npm run audit:mocks`) and runs against
every commit, so the "no simulated functionality" rule is enforced mechanically
from this point forward rather than by inspection. See
[`scripts/audit-mocks.mjs`](../scripts/audit-mocks.mjs).

---

## 1. Credential and provider verification (live, not assumed)

Every provider credential supplied was exercised with a real request from the
build machine before any code was written. Raw responses:

| Provider | Endpoint | Result | Evidence |
|---|---|---|---|
| Helius Solana RPC | `getSlot` | **WORKS** | `{"result":453406567}` |
| Helius Solana WS | `wss://mainnet.helius-rpc.com` | **WORKS** | `logsSubscribe` ack + live notifications |
| Alchemy Solana RPC | `getSlot` | **WORKS** | `{"result":453406814}` |
| Jupiter Lite API | `/swap/v1/quote` | **WORKS** | real route, `priceImpactPct` returned |
| Jupiter Pro API + `x-api-key` | `/swap/v1/quote` | **WORKS** | key accepted, better `outAmount` than lite |
| Jupiter Price v3 | `/price/v3` | **WORKS** | SOL = $121.44, `blockId` 453406671 |
| Dexscreener | `/latest/dex/tokens/{mint}` | **WORKS** | real pairs, liquidity, FDV/MC |
| KyberSwap Aggregator | `/base/api/v1/routes` | **WORKS** | real route, `amountInUsd` $272.83 |
| Telegram Bot API | `getMe` | **WORKS** | bot `@copyrafun_bot`, id `8683842826` |
| Sentry DSN | ingest host | **ACCEPTED** | DSN parses, project `4512199189790720` |
| **DigitalOcean Postgres** | TCP `:25060` | **UNREACHABLE** | see §3 |

### EVM chain endpoints — all probed with `eth_chainId`

| Network slug | `eth_chainId` | Decimal | Status |
|---|---|---|---|
| `eth-mainnet` | `0x1` | 1 | reachable |
| `base-mainnet` | `0x2105` | 8453 | reachable |
| `arb-mainnet` | `0xa4b1` | 42161 | reachable |
| `bnb-mainnet` | `0x38` | 56 | reachable |
| `polygon-mainnet` | `0x89` | 137 | reachable |
| `arc-mainnet` | `0x13b2` | 5042 | reachable |
| `robinhood-mainnet` | `0x1237` | 4663 | reachable |
| `tron-mainnet` | `0x2b6653dc` | 728126428 | reachable (read-only shim) |
| `hyperliquid-mainnet` | `0x3e7` | 999 | reachable |
| `opt-mainnet` | `0xa` | 10 | reachable (added, free with same key) |

**All the RPCs are reachable. Reachability is not the same as executability.**

---

## 2. Finding #2 — reachable ≠ tradeable. Chain support is tiered.

A chain can only execute a real swap if a real swap route source exists for it.
This was tested per chain, not assumed:

### Tier 1 — monitor **and** execute (verified route source)

| Chain | Route source | Verified |
|---|---|---|
| Solana | Jupiter v1 (Pro key) | yes — live quote |
| Base | KyberSwap Aggregator | yes — live route |
| Ethereum | KyberSwap Aggregator | chain path live |
| Arbitrum | KyberSwap Aggregator | chain path live |
| BNB Chain | KyberSwap Aggregator | chain path live |
| Polygon | KyberSwap Aggregator | chain path live |
| Optimism | KyberSwap Aggregator | chain path live |

### Tier 2 — monitor only, execution **disabled in code**

| Chain | Why execution is disabled |
|---|---|
| Arc (5042) | KyberSwap has no verified liquidity routing for this chain. No other aggregator confirmed. |
| Robinhood Chain (4663) | No aggregator coverage found. |
| Hyperliquid EVM (999) | KyberSwap returned chain-not-found. HyperCore order routing is a different, non-EVM-swap API. |
| Tron (728126428) | **Not an EVM execution target.** Tron uses TVM, base58 addresses and its own transaction envelope; the Alchemy endpoint is a JSON-RPC read shim. Signing an EVM transaction against it would not produce a valid Tron transaction. |

Tier-2 chains are hard-gated: `canExecute: false` in the chain registry, and
`EvmExecutor` throws `ChainNotExecutableError` instead of returning a fake
success. The dashboard renders them with an explicit **"Monitor only"** badge.
This is the honest answer to "EVM should handle mostly all EVM" — monitoring
covers all of them, execution covers the ones where a real swap can actually be
built.

To promote a Tier-2 chain, supply a working aggregator (router address + quote
API) for it; the code path is already abstracted behind `SwapRouteProvider`.

---

## 3. Finding #3 — the supplied `DATABASE_URL` is not reachable from outside DigitalOcean

```
DATABASE_URL=postgresql://doadmin:***@private-db-pgsql-nyc1-98023-do-user-45647566-0.k.db.ondigitalocean.com:25060/defaultdb?sslmode=require
```

The hostname is prefixed `private-`, which is DigitalOcean's **VPC-internal**
endpoint. TCP connect from the build machine timed out, as expected.

- It will work from a droplet/app inside the same DO VPC.
- It will **not** work from Railway, from a local machine, or from this build
  machine.

**Action required from you:** in the DigitalOcean console open the database →
Settings → copy the **public** connection string (same host without the
`private-` prefix) and add it, with the Railway/host egress IP added to the
database's Trusted Sources. Until then the app uses a local Postgres.
Documented in [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## 4. Finding #4 — every secret in this task is now compromised and must be rotated

The Helius key, Alchemy key, Jupiter key, Telegram bot token, Resend key, Sentry
DSN, Reown project id and the **database password** were all transmitted in
plaintext in a chat message. Treat all of them as public.

They are wired into a **gitignored** `.env` so the system runs, and `.env.example`
carries names only. `scripts/audit-secrets.mjs` runs in CI and fails the build if
any of these literal values appear in a tracked file.

**Rotate, in this order of severity:**

1. **Database password** — `doadmin` is a superuser. Rotate now.
2. **Telegram bot token** — anyone holding it can post as the bot and read the group.
3. Helius / Alchemy / Jupiter keys — billable quota theft.
4. Resend key — can send mail as your domain.
5. Sentry DSN — low severity (write-only), but rotate on principle.

Also: **never send a trading wallet private key through chat.** The signing
design in §6 is built so you never have to.

---

## 5. Finding #5 — the spec's TP/SL numbers are internally inconsistent

The spec states both:

- "Exit plan: TP +20% · SL -10%" with "At +20%: SELL 100%"  (Option A)
- "At +20%: SELL 50% … trailing stop = highest × 0.85"       (Option B)

and separately shows a ladder rendering `TP1 +20% · TP2 +50%`.

These are three different exit shapes. **Nothing was silently changed.** Both
Option A and Option B are implemented exactly as written and are user-selectable
(`ExitStrategy.MANUAL` / `ExitStrategy.TRAILING`), per spec §13. The ladder
string is treated as a *rendering* case of the Telegram "Exit plan" line, not as
a third strategy, because no ladder rules were specified. If you want a real TP1/TP2
ladder, give me the ladder's sell fractions and I will add it as a third strategy.

One more observed inconsistency, in the example notification:

```
Spent: 1.25 SOL ($294) · 50%
```

`$294 / 1.25 = $235.20` per SOL, while the same message prices BONK off a
$4.2M market cap. Dollar values in this implementation are taken from the real
Jupiter price at trade time (spec: "Dollar values: use the price at the time of
the trade"), so these will be internally consistent in real messages rather than
matching the example's arithmetic.

---

## 6. Signing & key-custody architecture (the most important security decision)

Two completely separate signing domains, which never mix:

| | **User-initiated swaps** | **Bot copy-trading** |
|---|---|---|
| Key location | user's own wallet (Phantom / MetaMask / etc.) | server process env var only |
| Who signs | the user's wallet extension | `SignerService` inside the worker |
| Backend role | builds unsigned tx, returns base64 | builds, signs, broadcasts |
| Key ever leaves process? | never exists server-side | never — not logged, not in DB, not in API responses |
| Frontend ever sees key? | no | no |

Enforced mechanically:

- `packages/core/src/security/signer.ts` is the **only** module permitted to read
  `SOLANA_BOT_PRIVATE_KEY` / `EVM_BOT_PRIVATE_KEY`. It exposes `signTransaction`
  and `publicKey`, and has no getter for the secret.
- `scripts/audit-secrets.mjs` fails CI if those env names are referenced anywhere
  else, or anywhere under `apps/web/`.
- The logger runs a redaction pass over every log record
  (`packages/core/src/obs/redact.ts`) and is unit-tested against key-shaped
  strings.
- No API route accepts a private key or seed phrase. There is no such DTO.
- The web app has no code path that can receive one; Vite only exposes
  `VITE_`-prefixed variables, and the bot key is not `VITE_`-prefixed.

**If `SOLANA_BOT_PRIVATE_KEY` is unset, the bot does not trade.** It starts,
monitors, decodes, qualifies, sizes, quotes, emits full telemetry and Telegram
signals, and then records the signal as `BLOCKED_NO_SIGNER`. It does not pretend
to trade. This is deliberate: the system is fully exercisable end-to-end without
a key present.

---

## 7. Risks explicitly designed against

| Risk | Mitigation | Test |
|---|---|---|
| Duplicate trade on the same signal | Postgres unique index on `(chain, sourceTxHash, traderId)` + Redis `SETNX` lease | `duplicate-signal.spec.ts` |
| Two positions in one token (first-buy rule) | unique partial index on `(chain, tokenAddress)` where status is open | `first-buy.spec.ts` |
| Correlated signals multiplying exposure | token-level position identity; extra traders raise `signalStrength`, never allocate again | `correlated-signals.spec.ts` |
| Race past `maxOpenPositions` | `SELECT … FOR UPDATE` on a settings row inside the sizing transaction | `concurrent-positions.spec.ts` |
| Eating the reserve | sizing subtracts reserve before any tier cap | `sizing.spec.ts` |
| Stale blockhash | blockhash fetched at build time, `lastValidBlockHeight` tracked, rebuild on expiry | `confirmation.spec.ts` |
| Stale quote | quote TTL; re-quote if older than `QUOTE_MAX_AGE_MS` | `quote-staleness.spec.ts` |
| "API said ok" treated as success | `TxStatus` only reaches `CONFIRMED` via `getSignatureStatuses` / `getTransactionReceipt` with `status === success` | `confirmation.spec.ts` |
| Partial fill | actual received amount read from post-tx on-chain balance delta, not from the quote | `partial-fill.spec.ts` |
| Wrong decimals | decimals read from mint/ERC-20 contract and cached; never defaulted to 18 or 9 | `decimals.spec.ts` |
| Missing SPL token account | ATA existence checked, created in the same tx when needed | `token-account.spec.ts` |
| RPC outage | ordered failover pool, health scoring, exponential backoff, WS auto-reconnect with replay | `rpc-failover.spec.ts` |
| DB vs chain drift | reconciliation worker; chain wins, drift is flagged not overwritten | `reconciliation.spec.ts` |
| Replayed signal after restart | processed-signature set persisted in Postgres, not only Redis | `restart-idempotency.spec.ts` |

---

## 8. What is NOT production-ready, stated plainly

These are **not** faked, mocked or hidden. They are blocked on things only you
can provide:

1. **No real mainnet swap has been executed.** No signing key exists in this
   environment, and it would be wrong for an agent to create one and move your
   money. Quote → build → sign-shape → serialize is verified against real
   Jupiter/KyberSwap responses; the broadcast step is verified only against
   simulation (`simulateTransaction`), which is a real RPC call, not a mock.
2. **No TP/SL has fired on a real position**, for the same reason.
3. **Telegram group delivery is unverified.** `getMe` succeeds. Sending to
   `-5389164510` requires the bot to be a member of that group. See §9.
4. **Production database is unreachable** (§3).
5. **Tier-2 chains cannot execute** (§2).
6. **`copyra.fun` DNS is not pointed anywhere by this work.**

Per the brief: nothing above is marked complete, and none of it is simulated to
look complete.

---

## 9. Required from you

| # | What | Where |
|---|---|---|
| 1 | **Rotate every credential in §4** | each provider's console |
| 2 | Public `DATABASE_URL` + trusted-source IP | DigitalOcean → Database → Settings |
| 3 | Add `@copyrafun_bot` to group `-5389164510` and promote it so it can post | Telegram group → Add members |
| 4 | Fund a **fresh, dedicated** trading wallet with a tiny amount (≈0.05 SOL) | your wallet |
| 5 | Put that wallet's key in the host's secret store as `SOLANA_BOT_PRIVATE_KEY` — **never in chat, never in git** | Railway → Variables |
| 6 | Confirm the `arc` / `robinhood` / `hyperliquid` aggregator, or accept monitor-only | — |
| 7 | Point `copyra.fun` at the deployment | your DNS |

---

## 10. Migration plan (executed in this order)

1. Monorepo scaffold, strict TypeScript, CI, mock/secret audit scripts. ✅
2. Prisma schema — every entity carries real chain identifiers and full telemetry. ✅
3. Chain layer — Solana (Helius + Jupiter) and EVM (viem + KyberSwap) with failover. ✅
4. Decoder — balance-delta based, classifies BUY/SELL/TRANSFER/AIRDROP/LP/STAKE/CLAIM/BRIDGE/MIGRATION. ✅
5. Market data — Dexscreener + Jupiter price for MC/liquidity/impact. ✅
6. Strategy engine — pure functions, exhaustively unit-tested. ✅
7. Execution engine — build/sign/broadcast/confirm/reconcile with retries. ✅
8. Exit engine — Option A and Option B, backend-driven. ✅
9. Telegram + Sentry. ✅
10. API — SIWE/SIWS auth, REST, WS. ✅
11. Frontend — real backend state only, zero client-side trading math. ✅
12. Tests + live provider verification. ✅
13. Docs + deployment config. ✅
14. **Mainnet smoke test with a funded key — blocked on item 4/5 above.** ⛔
