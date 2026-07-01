# Hax VPS Expiry Reminder

Checks `https://hax.co.id/vps-info` and sends a WeChat reminder through PushPlus.

## Required Secrets

- `HAX_USERNAME`
- `HAX_PASSWORD`

## Optional Secrets

- `PUSHPLUS_TOKEN`: PushPlus token for WeChat notifications. If omitted, results are only printed in Actions logs.

## Optional Variables

- `REMIND_THRESHOLD_DAYS`: defaults to `3`
- `TIMEZONE`: defaults to `Asia/Shanghai`
- `HAX_INFO_URL`: defaults to `https://hax.co.id/vps-info`

## Important

GitHub-hosted runners may be blocked by Hax/Cloudflare. If logs show `title="Just a moment..."`, run this workflow on your own machine or a self-hosted runner.
