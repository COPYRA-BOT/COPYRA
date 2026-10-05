# COPYRA production checklist

An item is **complete** only after the evidence column is filled with a real RPC/API response, a confirmed explorer hash, or a passing command from this environment. Code existing is not evidence.

| # | Item | Complete? | Evidence |
|---|---|---|---|
| 1 | Source audit: no simulated success path in production TypeScript | yes | `audit-mocks.mjs` pass 2026-10-05 02:45 |
| 2 | Secret audit: no committed credentials | yes | `audit-secrets.mjs` pass 2026-10-05 02:45 |
| 3 | Unit engine tests | yes | 116/116 2026-10-05 02:45 |
| 4 | Live RPC tests | yes | 14/14 2026-10-05 02:46 |
| 5 | Provider probe | yes | 23/23 `providers-2026-10-05T02-46-17-837Z.json` |
| 6 | Helius slot + decode of a third-party swap | yes | slot 453448430; SELL `554CxMV6…A1qPQ` |
| 7 | Jupiter quote + unsigned build | yes | out 12141062; unsigned tx lastValidBlockHeight 431486870 |
| 8 | KyberSwap Base/Arb/BNB unsigned route | yes | router `0x6131B5fa…` unsigned calldata |
| 9 | Telegram bot + chat reachable | yes | `@copyrafun_bot` / Copyra bot writable |
| 10 | Frontend loads live snapshot | yes | prior session `/` + `/api/snapshot` 200 |
| 11 | Worker heartbeat independent of the browser | yes | worker process + heartbeat upsert |
| 12 | QUALIFIED path calls real executor | code only | `handleQualifiedCopy` + no-signer unit/live guard |
| 13 | EVM Base monitor ingesting a real receipt | | stored `detected_transactions.txHash` |
| 14 | Position monitor marking live prices | | `positions.lastPriceAt` from Dexscreener/Jupiter |
| 15 | COPYRA-signed Solana buy confirmed | **NO** | needs funded `SOLANA_BOT_PRIVATE_KEY` + Solscan hash |
| 16 | COPYRA-signed Base buy confirmed | **NO** | needs funded `EVM_BOT_PRIVATE_KEY` + Basescan hash |
| 17 | TP / SL / trailing sell confirmed | **NO** | needs an open position that actually exits |
| 18 | User-wallet Jupiter swap confirmed | **NO** | needs a browser wallet signature |
| 19 | Reown connect + SIWE/SIWS in a browser | **NO** | needs a wallet extension |
| 20 | Duplicate-signal race against Postgres | **NO** | not load-tested |
| 21 | DigitalOcean production database | **yes, public host** | SSL + migrate deploy 2026-10-05 11:48 from egress `35.163.190.53`. Rotate the chat-pasted password. |
| 22 | Railway / `copyra.fun` 24/7 | **NO** | not deployed |
| 23 | Credentials rotated after chat paste | **NO** | operator action |
| 24 | Security review of a funded live system | **NO** | do this before meaningful capital |

## Pre-capital security review (must stay NO until funded)

- [ ] Private keys only in the host secret store, never in git, chat, or `VITE_*`
- [ ] Frontend cannot request a seed phrase
- [ ] First-buy + one-open-position constraints survive restart
- [ ] Replay of the same signature cannot open a second trade
- [ ] Stale quotes and expired blockhashes are refused
- [ ] Partial fills are read from confirmed balance deltas
- [ ] Token decimals come from the mint/contract, never assumed
- [ ] Emergency stop blocks new entries and is visible in the UI
- [ ] Withdrawals are not shown as success without a confirmed hash
- [ ] Telegram never prints a key, DSN, or connection string
