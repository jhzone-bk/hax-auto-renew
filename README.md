# Hax VPS Expiry Reminder

Checks `https://hax.co.id/vps-info` with an existing Hax login cookie and sends the result to Telegram.

## Required Secrets

- `HAX_COOKIE`: copied from a logged-in Hax browser session, for example `name=value; name2=value2`.
- `TELEGRAM_BOT_TOKEN`: Telegram bot token.
- `TELEGRAM_CHAT_ID`: Telegram chat ID that receives reminders.

## Optional Variables

- `REMIND_THRESHOLD_DAYS`: defaults to `3`.
- `TIMEZONE`: defaults to `Asia/Shanghai`.
- `HAX_INFO_URL`: defaults to `https://hax.co.id/vps-info`.

## Cookie Renewal

If the cookie expires, Hax redirects to login, asks for Telegram confirmation, or Cloudflare blocks the request, the workflow sends a Telegram failure message with diagnostics. Replace `HAX_COOKIE` with a fresh logged-in cookie and run the workflow again.

## WeChat

Telegram cannot reliably forward messages to a personal WeChat account through an official API. If WeChat delivery is required later, add a separate supported channel such as a WeCom bot or ServerChan instead of relaying through Telegram.
