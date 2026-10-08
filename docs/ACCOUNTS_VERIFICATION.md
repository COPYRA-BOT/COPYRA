# feat/accounts — verification checklist

Branch: `feat/accounts` → PR into `dev` (do **not** merge to `main` until approved).

## STOP: referral earnings

See `docs/ACCOUNTS_FEES_STOP.md`. Platform fees are **not** collected on trades today.  
Referral codes / attribution / claim API are real; **earnings stay 0** (`PLATFORM_FEES_NOT_COLLECTED`).

## Automated (this environment)

| Check | Result |
|---|---|
| `npm run typecheck -w @copyra/api` | pass |
| Account unit tests (`crypto`, isolation, fee stop, claim stop) | pass |
| Full vitest suite | pass (see CI / local run) |
| `npm run audit:mocks` | pass |
| `npm run audit:secrets` | pass |
| Prisma migration `20261007234500_accounts_auth_referrals` | applied (additive) |
| Zero-balance UI (`0` not `*`) | code change on branch |
| `SOL_TRADING_ENABLED` / `EVM_TRADING_ENABLED` in `.do/app.yaml` | **false** on this branch |
| Wallet SIWE/SIWS nonce TTL | 5 minutes |
| WebAuthn server routes | implemented (`/api/account/passkeys/*`) |
| Withdraw step-up (TOTP / password for email accounts) | implemented |

## Manual / live (mark after you run)

| Flow | Status | Notes / tx hash |
|---|---|---|
| Google sign-in (OIDC ID token) | **unverified** | Needs `GOOGLE_CLIENT_ID` (+ GIS) on DO |
| Email register + Resend 6-digit code | **unverified** | Needs `RESEND_API_KEY` + `ACCOUNT_EMAIL_FROM` |
| Email login + 2FA | **unverified** | |
| Password reset-by-code API | **unverified** | No UI change (API only) |
| Solana wallet Connect → SIWS session | **unverified** | Uses existing Reown + `/api/auth/*` |
| EVM wallet Connect → SIWE session | **unverified** | |
| Guest (Continue without account) | **unverified** | Public stats: `GET /api/account/public/stats` |
| Referral link `/?ref=CODE` cookie + attribution | **unverified** | |
| Referral claim | **blocked by design** until fees exist | |
| Account linked methods / 2FA QR / devices | **unverified** | |
| Sign out clears cookies | **unverified** | |
| Account A cannot read account B | unit helpers pass; full DB isolation **unverified** | |
| WebAuthn passkeys (server) | **unverified** | Needs HTTPS + `WEBAUTHN_RP_ID` |
| Withdraw step-up prompt | **unverified** | |
| Playwright E2E matrix | **unverified** | No Playwright project in repo yet |

## Env vars (names only — see `.env.example`)

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ACCOUNT_EMAIL_FROM`, `RESEND_API_KEY`, `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `REFERRAL_MIN_CLAIM_USD`, plus existing `SESSION_SECRET`, `PUBLIC_WEB_URL`, `DATABASE_URL`, `REDIS_URL`.
