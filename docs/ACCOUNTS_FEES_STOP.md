# Referrals / platform fees — STOP report

**Date:** 2026-10-07  
**Branch:** `feat/accounts`

## Finding (blocking referral earnings)

COPYRA does **not** currently collect a platform fee on copy trades.

What exists today:

- **Network fees** (Solana tx fee / EVM gas) are recorded on positions/trades as `feesQuote` / `networkFeeRaw`.
- **Fee buffers** reserve gas so custody can exit; they are not a platform take.
- **Savings** is a ledger reservation on the user’s custody wallet, not fee skim.

There is **no** on-chain or ledger skim of a protocol/platform fee percentage on confirmed buys or exits (`copy-execute`, `exit-execute`, `funds`).

## Consequence for Referrals

Per product rules: *if fees are not really collected on-chain or into the ledger, STOP rather than inventing payouts.*

Therefore on this branch:

- Referral **codes**, **ref cookie capture**, **attribution at signup**, and **claim plumbing** are implemented.
- Referral **earnings are not credited** from invented fee % of volume.
- Claimable stays **0** until a real platform-fee collection path lands confirmed, tx-hash-backed ledger entries.
- The referrals API returns `earningsEnabled: false` and `reason: PLATFORM_FEES_NOT_COLLECTED` so the UI can stay honest.

## Next step (separate, approved change)

1. Define fee bps and destination (custody / treasury).
2. Deduct or collect on confirmed fills only.
3. Write double-entry ledger rows keyed by trade `txHash`.
4. Then enable referral accrual (10% of *those* fees for 30 days).
