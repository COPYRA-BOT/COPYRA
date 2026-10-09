# Account layer — DigitalOcean env vars

Set these as **encrypted App-Level** variables on the `copyra` app (RUN_AND_BUILD_TIME where noted). No values are committed in git.

| Variable | Required for | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Google Sign in / Create account | OAuth 2.0 **Web** client id only — e.g. `123-abc.apps.googleusercontent.com` (**no** `https://` prefix). **Authorized JavaScript origins**: `https://copyra.fun`, `https://www.copyra.fun`, `https://copyra-nl7kz.ondigitalocean.app`. |
| `GOOGLE_CLIENT_SECRET` | Google popup code exchange | **Required** for the Sign in with Google button (popup auth code → server). App-Level encrypted. **Authorized redirect URIs** should include `https://copyra.fun` (and www / DO app URL). Popup mode uses Google’s special `postmessage` redirect; do **not** use `api.copyra.fun`. |
| `RESEND_API_KEY` | Email verification codes | [Resend](https://resend.com) API key. Without this, register still creates the pending user but email delivery fails (no code in production responses). |
| `ACCOUNT_EMAIL_FROM` | Email From header | Must be a domain verified in Resend, e.g. `COPYRA <noreply@copyra.fun>`. `ALERT_EMAIL_FROM` is used as fallback. |
| `WEBAUTHN_RP_ID` | Passkeys | Use `copyra.fun` (no scheme). |
| `WEBAUTHN_RP_NAME` | Passkeys | `COPYRA` |
| `REFERRAL_MIN_CLAIM_USD` | Referral claim floor | Default `1`. Claims stay **0** until platform fees are collected (see `ACCOUNTS_FEES_STOP.md`). |
| `PUBLIC_WEB_URL` | Referral share links | Keep `https://copyra.fun` so invite links never use `*.ondigitalocean.app`. |
| `SESSION_SECRET` | All sessions | Already required (≥32 chars). |

Already required for the live app (unchanged): `DATABASE_URL`, `REDIS_URL`, RPC URLs, bot keys, `TELEGRAM_*`, Reown project id.

## Telegram routing

| Target | Env / field | Receives |
|---|---|---|
| Admin ops chat | `TELEGRAM_CHAT_ID` (App-Level, e.g. `-5389164510`) | **All** worker/backend alerts: detection, skip, buy/sell submitted/confirmed/failed, ops/watchdog, worker-online |
| Linked end-user | `User.telegramChatId` (Connect Telegram in account) | **Buy confirmed** and **sell confirmed** only (+ link ack) |

`TELEGRAM_BOT_TOKEN` stays encrypted App-Level. Keep the admin chat id on App-Level so both `api` and `worker` can post.

## Referral earnings

Platform fees are **not** collected on trades yet. Referral **links, attribution, friends list, and claim API** are real; **claimable stays 0** with reason `PLATFORM_FEES_NOT_COLLECTED` until a separate fee-ledger change lands.
