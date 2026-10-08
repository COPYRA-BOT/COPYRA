# Account layer — DigitalOcean env vars

Set these as **encrypted App-Level** variables on the `copyra` app (RUN_AND_BUILD_TIME where noted). No values are committed in git.

| Variable | Required for | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Google Sign in / Create account | Google Cloud → APIs & Services → Credentials → OAuth 2.0 Web client. Authorized JavaScript origins: `https://copyra.fun`. Authorized redirect URIs can stay empty for GIS ID-token / One Tap. |
| `GOOGLE_CLIENT_SECRET` | optional | Not required for ID-token verification; safe to set anyway. |
| `RESEND_API_KEY` | Email verification codes | [Resend](https://resend.com) API key. Without this, register still creates the pending user but email delivery fails (no code in production responses). |
| `ACCOUNT_EMAIL_FROM` | Email From header | Must be a domain verified in Resend, e.g. `COPYRA <noreply@copyra.fun>`. `ALERT_EMAIL_FROM` is used as fallback. |
| `WEBAUTHN_RP_ID` | Passkeys | Use `copyra.fun` (no scheme). |
| `WEBAUTHN_RP_NAME` | Passkeys | `COPYRA` |
| `REFERRAL_MIN_CLAIM_USD` | Referral claim floor | Default `1`. Claims stay **0** until platform fees are collected (see `ACCOUNTS_FEES_STOP.md`). |
| `PUBLIC_WEB_URL` | Referral share links | Keep `https://copyra.fun` so invite links never use `*.ondigitalocean.app`. |
| `SESSION_SECRET` | All sessions | Already required (≥32 chars). |

Already required for the live app (unchanged): `DATABASE_URL`, `REDIS_URL`, RPC URLs, bot keys, `TELEGRAM_*`, Reown project id.

## Referral earnings

Platform fees are **not** collected on trades yet. Referral **links, attribution, friends list, and claim API** are real; **claimable stays 0** with reason `PLATFORM_FEES_NOT_COLLECTED` until a separate fee-ledger change lands.
