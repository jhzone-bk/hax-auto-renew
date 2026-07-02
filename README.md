# Hax VPS Expiry Reminder

Checks `https://hax.co.id/vps-info` with an existing Hax login cookie and sends the result to Telegram.

## Runner

This workflow is configured for a Linux self-hosted GitHub Actions runner:

```yaml
runs-on: [self-hosted, Linux, X64]
```

Use a self-hosted runner when Hax rejects GitHub-hosted runners or ties login sessions to your local browser/IP environment.

## Required Secrets

- `HAX_COOKIE`: copied from a logged-in Hax browser session. It can be either `name=value; name2=value2` or the full JSON exported by a cookie extension such as Cookie-Editor.
- `TELEGRAM_BOT_TOKEN`: Telegram bot token.
- `TELEGRAM_CHAT_ID`: Telegram chat ID that receives reminders.

## Optional Variables

- `REMIND_THRESHOLD_DAYS`: defaults to `3`.
- `TIMEZONE`: defaults to `Asia/Shanghai`.
- `HAX_INFO_URL`: defaults to `https://hax.co.id/vps-info`.

## Cookie Renewal

If Hax redirects to login, Cloudflare has passed but the Hax login session is expired. The script tries to click the Telegram login control and sends a Telegram message asking you to tap Confirm.

If Cloudflare blocks the runner, the workflow sends a separate failure message saying the Cloudflare challenge did not clear. In that case the Telegram login button does not exist yet, so there is nothing to confirm in Telegram until Cloudflare is passed once in the runner browser.

## WeChat

Telegram cannot reliably forward messages to a personal WeChat account through an official API. If WeChat delivery is required later, add a separate supported channel such as a WeCom bot or ServerChan instead of relaying through Telegram.
