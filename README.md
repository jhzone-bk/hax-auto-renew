# Hax VPS Auto Renew

GitHub Actions script for checking `https://hax.co.id/vps-info` and renewing at `https://hax.co.id/vps-renew/` when the VPS is close to expiry.

## GitHub Secrets

Set these repository secrets:

- `HAX_USERNAME`
- `HAX_PASSWORD`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Optional GitHub Variables

- `RENEW_THRESHOLD_DAYS`: defaults to `3`
- `TIMEZONE`: defaults to `Asia/Shanghai`
- `HAX_INFO_URL`: defaults to `https://hax.co.id/vps-info`
- `HAX_RENEW_URL`: defaults to `https://hax.co.id/vps-renew/`

## Run

The workflow runs daily at `01:00 UTC`, which is `09:00` in Beijing time. You can also start it manually from GitHub Actions with `workflow_dispatch`.

For local checks:

```bash
npm install
npm test
npm run renew
```

If Hax requires a CAPTCHA, email verification, or Cloudflare challenge, account-password login may fail in GitHub Actions. In that case, switch to a cookie-based approach or use this workflow only as a reminder.
