# Phase 4 — Worker reliability (root cause + ops checklist)

## Evidence from production (your screenshots)

| Signal | Meaning |
|---|---|
| Telegram `TRADING_ENABLED is false` + `https://copyra.fun` | **API** ops-watch saw the host guard off (empty/missing env or explicit false during a deploy). Not proof the worker formulas broke. |
| Telegram `Solana monitor silent ~300s` + `http://127.0.0.1:43127` | **Worker** watchdog respawned after sync loop stall; footer was the default URL because that process lacked `PUBLIC_WEB_URL` at the time. |
| SOL Recent Activity full of **Skip** (hours earlier) then silence | Detection + qualify **were** working; later silence = WS/sync stall or quiet wallets — not “settings ignore everything”. |
| EVM Recent Activity = deposits/moves only | No EVM buy/skip rows means no qualifying EVM copy detections in that window (or no enabled EVM traders trading memes). |
| Execution Metrics Submitted ~11s / Total ~13s | Prior live path was slow (quote/sign/confirm), separate from “no detections”. Target ≤2s remains a target, not a guarantee. |

## Root causes fixed in code

1. **Catch-up timeout bug** — outer race was **5s** while `getSignaturesForAddress` waited up to **8s**, so catch-up almost always failed (`catchUpErr` high). Now per-trader budget is **20s**.
2. **Trading flag empty-string → false** — DO blank values were coerced to `false`, firing trading-off alerts. Empty is now “unset”; production unset defaults to **true** (explicit `false` still wins).
3. **Ops alert localhost footer** — never show `127.0.0.1:43127`; fall back to `https://copyra.fun`.
4. **WS death stranding** — force resub every **180s**, sooner on WS close/error or 120s with no WS events while watching traders; catch-up recovery after resub.
5. **Watchdog semantics** — respawn only when **sync/poll loops** stall. Quiet markets get a separate notice; **no trades ≠ broken monitor**.
6. **Single engine** — supervisor flock + kill leftover PID + backoff; heartbeat marked `stopping` before exit.
7. **Health** — `/health` on worker includes sync/WS/processed ages from status file.

Trading formulas (`qualifySignal`, first-buy, TP/SL, sizing) were **not** changed.

## Live snapshot (at audit time)

- API `/api/status`: `trading.envGuard=true`, worker `live=true`, watching **14**, chains healthy, signers available.
- Gaps remaining are operational (RPC plan limits, trader activity matching filters), not a missing “buy button”.

## What you must verify manually on DigitalOcean

Do this once after deploy (App → Settings → App-level **and** component **worker**):

1. **App-level** (scope ALL / RUN_TIME):  
   `TRADING_ENABLED=true`  
   `SOL_TRADING_ENABLED=true`  
   `EVM_TRADING_ENABLED=true`  
   `PUBLIC_WEB_URL=https://copyra.fun`  
   `PUBLIC_API_URL=https://copyra.fun`  
   Delete any blank or `false` overrides on the **worker** component for those keys.
2. **Secrets (App-level encrypted, available to worker):**  
   `SOLANA_RPC_URL`, **`SOLANA_WS_URL`** (required for onLogs — HTTPS alone is not enough),  
   `SOLANA_RPC_FALLBACK_URLS` (optional),  
   `EVM_*_RPC_URL` (Alchemy preferred for `alchemy_getAssetTransfers`),  
   `SOLANA_BOT_PRIVATE_KEY`, `EVM_BOT_PRIVATE_KEY`,  
   `DATABASE_URL`, `REDIS_URL`,  
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,  
   `JUPITER_API_KEY` if you use Jupiter auth.
3. **Helius / Alchemy**  
   - Solana: paid plan with **WebSocket** + logs subscriptions for ~14 wallets.  
   - EVM: Alchemy app with **Transfers API** on ETH/Base/ARB/BSC.  
   Rate limits (429) look like “silence” — upgrade if catch-up errors stay high.
4. **Components**  
   - `api`: `RUN_WORKER=false`, Healthy.  
   - `worker`: run `/app/scripts/start-worker.sh`, instance_count **1**, Healthy/Running.  
   Never run two worker instances.
5. **Dashboard**  
   - Trading engine **ON** (not paused/emergency).  
   - Traders enabled; filters (min trade, mcap, liquidity) match the wallets you expect to copy.  
   - Skips with reasons = healthy detection; zero rows for hours while wallets are active = check WS URL + worker Runtime Logs.

## How to tell stall vs quiet market

| Condition | Meaning | Action |
|---|---|---|
| Sync age &gt; 5m, watching &gt; 0 | Stall — watchdog respawns | Check worker Runtime Logs + RPC |
| Sync age &lt; 1m, no processed for 45m+ | Quiet / filters | Check Recent Activity skips; relax filters only if intentional |
| `catchUpErr` high every pass | RPC timeout/rate limit | Fix catch-up (shipped) + upgrade RPC |
| Alert footer `127.0.0.1` | Missing `PUBLIC_WEB_URL` on that component | Set App-level URL (fixed in code too) |

## Live buy / sell

Do **not** force a live buy from CI. When you are ready: leave engine ON with a small allocation, watch one known active trader, confirm detection → qualify → signature on Solscan/Basescan, then TP/SL on the open position. Approve any intentional test size yourself.

## After this deploy

1. Hard refresh `https://copyra.fun` → System health → worker live, watching 14.  
2. Telegram should show `WORKER ONLINE` (cold start) without localhost footer.  
3. Within ~15–60s, SOL catch-up should show lower `catchUpErr` in heartbeat detail.  
4. When a tracked wallet buys within your filters, you should see Detect / Skip / Buy again in Recent Activity + Telegram.
