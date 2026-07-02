const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.');
}

const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    chat_id: chatId,
    text: `Hax VPS workflow started\n\nRun: ${process.env.GITHUB_RUN_ID || 'local'}`,
    disable_web_page_preview: true
  })
});

const body = await response.text();
if (!response.ok) {
  throw new Error(`Telegram smoke test failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
}

console.log(`Telegram smoke test response: ${body.slice(0, 500)}`);
