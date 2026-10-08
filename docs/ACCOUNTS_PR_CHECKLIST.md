# PR checklist (dev)

- [ ] Review `docs/ACCOUNTS_FEES_STOP.md` — do not invent referral payouts
- [ ] Confirm trading formulas in `packages/core` were not changed for this feature
- [ ] Set DO preview secrets: `GOOGLE_CLIENT_ID`, `RESEND_API_KEY`, `ACCOUNT_EMAIL_FROM`, `WEBAUTHN_RP_ID`
- [ ] Confirm `.do/app.yaml` keeps `SOL_TRADING_ENABLED=true` and `EVM_TRADING_ENABLED=true` (do not disable trading for account work)
- [ ] Hard-refresh preview; smoke: Create account → email code → Account → Referrals link format `/?ref=CODE`
- [ ] Wallet Connect still works (existing Reown path); Account menu shows linked wallet
- [ ] Zero balances show `0` not `*`
- [ ] Claim shows fees-not-collected message (earnings stay `$0.00`)
- [ ] Approve before any merge to `main`
