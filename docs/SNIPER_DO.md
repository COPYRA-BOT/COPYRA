# Phase 5 — Sniper worker on DigitalOcean

Sniper Mode is a **third independent strategy** next to SOL and EVM copy-trading. It uses the same Solana custody wallet and shared RPC / signer / balance reservations, but runs in its **own App Platform worker** so discovery never starves the copy-trade loop.

Live trading stays **off** until you flip host env + dashboard runtime to live.

## Architecture

| Component | Role |
|---|---|
| `api` | Dashboard + `/api` + Sniper Mode settings/signals (unchanged health path) |
| `worker` | Wallet copy-trade (SOL + EVM) + **COPY** exits only |
| `sniper` | Helius Pump.fun discovery → qualify → sniper buys → **SNIPER** exits |

Positions are tagged `strategy=SNIPER` vs `COPY`. Deployed capital is shared atomically across strategies; open-count and duplicate-mint checks are per strategy.

## 1) Add the Sniper worker component (manual once)

Spec is already in `.do/app.yaml` under `workers → sniper`. If DigitalOcean did **not** create the component from the yaml sync:

1. DO → **copyra** → **Components** → **Create Component** → **Worker**
2. Name: **`sniper`** (exact)
3. Source: same GitHub repo `COPYRA-BOT/COPYRA`, branch **`main`**, Dockerfile at repo root
4. **Run command:** `/app/scripts/start-sniper-worker.sh`
5. Instance size: **basic-xs** (or larger under heavy stream load)
6. HTTP port / health (if DO requires): **`8080`** — the script starts `worker-health.mjs`
7. Autodeploy: **On** (deploy on push)

Do **not** set `RUN_WORKER=true` on the sniper box. Do **not** point the sniper run command at `start-worker.sh`.

## 2) App-Level env vars (shared secrets)

These must stay **App-Level** (all components), encrypted where sensitive — same as copy trading:

| Key | Notes |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Pooled + direct Postgres |
| `REDIS_URL` | Shared locks / reservations |
| `SESSION_SECRET` | API sessions |
| `SOLANA_RPC_URL` / `SOLANA_WS_URL` | Helius HTTP + WS (sniper uses WS `logsSubscribe`) |
| `SOLANA_BACKUP_*` | Fallbacks |
| `SOLANA_BOT_PRIVATE_KEY` or multi-user custody material | Shared signer path |
| `JUPITER_API_KEY` | Swap quotes / routes |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Ops alerts |

No new secrets are required beyond what copy-trading already uses.

## 3) Sniper-specific env (safe defaults = monitor)

Set on the **`sniper` component** (or App-Level). Defaults in `.do/app.yaml` are fail-closed:

| Key | Safe start | Live |
|---|---|---|
| `SNIPER_ENABLED` | `false` | `true` only when ready |
| `SNIPER_MODE` | `monitor` | `onchain` then `live` |
| `SNIPER_MAX_MARKET_CAP_USD` | `20000000` | tighten as needed |
| `SNIPER_MIN_LIQUIDITY_USD` | `10000` | |
| `SNIPER_MAX_PRICE_IMPACT_BPS` | `800` | |
| `SNIPER_MAX_SLIPPAGE_BPS` | `300` | |
| `SNIPER_MAX_OPEN_POSITIONS` | `5` | |
| `SNIPER_MAX_POSITION_SOL` | `0.25` | |
| `SNIPER_MAX_DEPLOYED_SOL` | `2` | |
| `SNIPER_DAILY_LOSS_LIMIT_SOL` | `1` | |
| `SNIPER_ALLOWED_LAUNCHPADS` | `pump.fun` | comma list |
| `PUMP_FUN_PROGRAM_ID` | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | |

Dashboard Sniper settings can **tighten** host caps further; they cannot loosen host `SNIPER_ENABLED=false`.

## 4) Database migration

After deploy, ensure migration `20261011210000_sniper_mode` applied (API/start scripts run `db:migrate` when configured). Confirms:

- enum `TradingStrategy` (`COPY` / `SNIPER`)
- `positions.strategy`
- table `sniper_signals`
- `TradingMode.SNIPER` + sniper skip reasons

## 5) End-to-end checklist

1. Push `main` → DO builds `api`, `worker`, `sniper`
2. Runtime logs → **sniper** shows: `COPYRA sniper worker starting` and `Sniper Helius/WS logsSubscribe connected`
3. Heartbeat name: `copyra-sniper-worker` (Monitor tab / DB `worker_heartbeats`)
4. Dashboard → **Sniper Mode** (third segment) → connect **Solana** wallet (same custody as SOL Mode)
5. Open **Sniper settings**: runtime `monitor` / `onchain` / `live`, MC/liq/slippage, max position/deployed SOL, daily loss, launchpads, TP/SL
6. Toggle bot **ON** for Sniper Mode only (does not start SOL/EVM copy)
7. With `SNIPER_ENABLED=false` or runtime `monitor`: signals appear as rejected / blocked with exact reasons — **no buys**
8. For live: set App `SNIPER_ENABLED=true`, `SNIPER_MODE=live`, dashboard runtime **Live**, bot **ON**, funded custody + fee reserve
9. Kill Switch on Sniper Mode stops sniper engine and liquidates **sniper** positions only

## 6) Force rebuild if sniper looks stuck

Same as copy worker: if heartbeat `beatAt` is fresh but discovery count frozen for a long time after WS errors, DO → **sniper** → **Force rebuild**.

Do **not** Force-rebuild the copy `worker` unless that component is the one stuck — they are independent.

## 7) Local run

```bash
npm run dev:sniper   # or npm run dev (api + worker + sniper + web)
```

Requires `SOLANA_WS_URL` (Helius) and DB/Redis like the copy worker.

## Pipeline (fail-closed)

1. Live listener — Helius WS `logsSubscribe` on Pump.fun (+ PumpSwap)
2. Decode — mint, creator, launch tx, bonding-curve / migration
3. Enrich — market, mint/freeze, holders, Jupiter buy+sell quotes, Pump curve probe
4. Qualify — every gate must pass; missing/stale data rejects
5. Execute — Jupiter / PumpSwap-compatible routes via shared Solana executor + Redis locks
6. Confirm — position `strategy=SNIPER`, sniper-only TP/SL monitor, balance reconcile
