# Running COPYRA

## Environment

Copy `.env.example` to `.env` at the repo root. Every app loads that file.

Required for the API and worker to boot:

- `DATABASE_URL` — Postgres
- `REDIS_URL` — Redis (idempotency locks)
- `SESSION_SECRET` — at least 32 characters
- At least one Solana RPC URL (`SOLANA_RPC_URL`) for monitoring and decode

Required for the dashboard wallet modal:

- `VITE_REOWN_PROJECT_ID` — public Reown/WalletConnect project id (safe to ship to the browser)

Never prefix bot keys with `VITE_`.

## Ports

The dashboard is bound to `0.0.0.0:43127` and the API to `0.0.0.0:41717` so a preview or another machine on the network can reach them. Change `API_PORT` / Vite `server.port` together if you move them.

## First trader

1. Open `/traders`
2. Paste a real Solana mainnet address
3. Confirm the worker heartbeat on Overview is `running`
4. The next confirmed transaction from that wallet is decoded. Non-buys and out-of-window tokens are stored as skips with the actual reason.

## Wallet connect

Connect Wallet is identity only. After the wallet signs the SIWE/SIWS message, the API sets an HTTP-only session cookie. It cannot authorize a copy-trade; copy-trades use the server signer.
