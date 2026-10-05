# COPYRA trading engine

The engine is backend-only. Closing the browser does not stop the worker.

## Pipeline

1. **Detect** — Solana: Helius `onLogs` on each enabled trader. EVM: Alchemy `alchemy_getAssetTransfers` on Base, then Arbitrum/BNB if those chains are enabled.
2. **Decode** — balance deltas (Solana parsed tx / EVM Transfer logs). Classification is BUY, SELL, or non-trade (airdrop, LP, bridge, …).
3. **Qualify** — MC window $1M–$20M, real quote-asset spend, liquidity, blacklist, first-buy-only, one open position per token, max positions. Any failure skips.
4. **Gate** — emergency stop, `TRADING_ENABLED`, server signer. Observe-only records `BLOCKED_NO_SIGNER` and does not broadcast.
5. **Size** — 80% max deploy, reserve, MC tier caps (20/30/40/50%), 1% pool share, `MAX_TRADE_USD`. From live RPC balance, never a running tally.
6. **Quote / build / sign / broadcast** — Jupiter (Solana) or KyberSwap (EVM). Stale quotes and excessive price impact abort.
7. **Confirm** — `getSignatureStatuses` or receipt `success`. Only then is the position `OPEN`.
8. **Mark / exit** — worker loop reads Dexscreener/Jupiter prices and runs `evaluateExit`.
9. **Reconcile** — UNKNOWN / BROADCAST trades are re-read from chain. Never promoted without RPC proof.

## First-buy and correlated signals

`token_first_buys` is unique on `(chain, tokenAddress)` and survives restart. Later buys increment `correlatedBuys` (confidence only) and never open a second position. Postgres also enforces one live position per token.

## Exits (spec §13)

- **Option A (MANUAL):** SL = entry × 0.90, TP = entry × 1.20, sell 100% at TP.
- **Option B (TRAILING):** same SL; at +20% sell 50% and trail the rest at highest × 0.85 after the trailing stage arms.

Stop-loss is checked first. Exits use the same executor and confirmation rules as entries.

## Telemetry

Each trade stores: source detected, decoded, qualified, quoted, built, signed, broadcast, landed, confirmed, plus signature/hash, requested vs actual amount, slippage, fees, and status. Latency is measured. There is no guaranteed 1–2 second claim.

## Emergency stop

`POST /api/settings/emergency-stop` blocks new entries. Open positions stay marked for TP/SL. Telegram is notified.

## What “success” means

A UI refresh, a Jupiter quote, or a `sendRawTransaction` hash is not a fill. `CONFIRMED` plus a non-null `txHash` that explorers accept is the only success state.
