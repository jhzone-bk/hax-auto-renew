import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { daysUntil, findExpiryDate } from './expiry-parser.js';

const config = {
  cookie: process.env.HAX_COOKIE,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  thresholdDays: Number.parseInt(process.env.REMIND_THRESHOLD_DAYS || process.env.RENEW_THRESHOLD_DAYS || '3', 10),
  timezone: process.env.TIMEZONE || 'Asia/Shanghai',
  infoUrl: process.env.HAX_INFO_URL || 'https://hax.co.id/vps-info'
};

async function main() {
  validateConfig(config);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ timezoneId: config.timezone });
  await context.addCookies(parseCookieHeader(config.cookie, config.infoUrl));
  const page = await context.newPage();

  try {
    let infoText = await loadInfoPage(page);
    let expiryDate = findExpiryDate(infoText);

    if (!expiryDate) {
      const diagnostics = await pageDiagnostics(page, infoText);
      if (isCloudflareChallenge(diagnostics)) {
        await refreshCloudflareCookies(context, page);
        infoText = await loadInfoPage(page);
        expiryDate = findExpiryDate(infoText);
      }
    }

    if (!expiryDate) {
      throw new Error(`Could not find an expiry date. Cookie may be expired or Hax blocked the request. ${JSON.stringify(await pageDiagnostics(page, infoText))}`);
    }

    const remainingDays = daysUntil(expiryDate);
    const message = remainingDays <= config.thresholdDays
      ? `Hax VPS is close to expiry: ${formatDate(expiryDate)} (${remainingDays} days left).`
      : `Hax VPS expiry check OK: ${formatDate(expiryDate)} (${remainingDays} days left).`;

    await notify('Hax VPS expiry reminder', message);
  } catch (error) {
    await notify('Hax VPS cookie check failed', `Hax VPS expiry check failed: ${error.message}`);
    throw error;
  } finally {
    await browser.close();
  }
}

async function loadInfoPage(page) {
  await page.goto(config.infoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  return getBodyText(page);
}

function validateConfig(values) {
  const missing = [
    ['HAX_COOKIE', values.cookie],
    ['TELEGRAM_BOT_TOKEN', values.telegramBotToken],
    ['TELEGRAM_CHAT_ID', values.telegramChatId]
  ].filter(([, value]) => !value);

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.map(([name]) => name).join(', ')}`);
  }

  if (!Number.isInteger(values.thresholdDays) || values.thresholdDays < 0) {
    throw new Error('REMIND_THRESHOLD_DAYS must be a non-negative integer.');
  }
}

function parseCookieHeader(cookieHeader, url) {
  const { hostname } = new URL(url);
  const cookies = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return null;

      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
        domain: hostname,
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax'
      };
    })
    .filter(Boolean);

  if (!cookies.length) {
    throw new Error('HAX_COOKIE does not contain any name=value cookie pairs.');
  }

  return cookies;
}

async function getBodyText(page) {
  return page.locator('body').innerText({ timeout: 30_000 });
}

async function pageDiagnostics(page, pageText) {
  const title = await page.title().catch(() => 'unknown');
  const url = page.url();
  const hasPasswordInput = await page.locator('input[type="password"]:visible').count().then((count) => count > 0).catch(() => false);
  const hasLoginText = /login|sign in|masuk|telegram|phone|otp|verify/i.test(pageText);
  const dateMatches = [...pageText.matchAll(/\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}\s+(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December|Januari|Februari|Maret|Mei|Juni|Juli|Agustus|Agu|Oktober|Desember)\s+\d{4})\b/gi)]
    .map((match) => match[0])
    .slice(0, 5);

  return {
    url,
    title,
    textLength: pageText.length,
    hasPasswordInput,
    hasLoginText,
    dateMatches
  };
}

function isCloudflareChallenge(diagnostics) {
  return /just a moment/i.test(diagnostics.title) || /__cf_chl_|cf_chl/i.test(diagnostics.url);
}

async function refreshCloudflareCookies(context, page) {
  const refreshUrl = new URL('/create-vps/', config.infoUrl).href;
  console.log(`Refreshing Cloudflare cookies from ${refreshUrl}`);
  await page.goto(refreshUrl, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(8_000);
  const cookies = await context.cookies();
  console.log(`Cloudflare cookie refresh completed. Cookie names: ${cookies.map((cookie) => cookie.name).join(', ')}`);
}

async function notify(title, message) {
  console.log(`${title}: ${message}`);

  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: `${title}\n\n${message}`,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    console.warn(`Telegram notification failed with HTTP ${response.status}.`);
    return;
  }

  const result = await response.json().catch(() => null);
  if (result && result.ok !== true) {
    console.warn(`Telegram notification failed: ${result.description || JSON.stringify(result)}`);
  }
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
