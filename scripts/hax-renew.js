import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { daysUntil, findExpiryDate } from './expiry-parser.js';

const config = {
  username: process.env.HAX_USERNAME,
  password: process.env.HAX_PASSWORD,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  thresholdDays: Number.parseInt(process.env.RENEW_THRESHOLD_DAYS || '3', 10),
  timezone: process.env.TIMEZONE || 'Asia/Shanghai',
  infoUrl: process.env.HAX_INFO_URL || 'https://hax.co.id/vps-info',
  renewUrl: process.env.HAX_RENEW_URL || 'https://hax.co.id/vps-renew/'
};

const RENEW_RESULT_HINT = /(success|successful|renewed|berhasil|sukses|extended|diperpanjang)/i;

async function main() {
  validateConfig(config);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ timezoneId: config.timezone });
  const page = await context.newPage();

  try {
    await page.goto(config.infoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await loginIfNeeded(page);

    const infoText = await getBodyText(page);
    const expiryDate = findExpiryDate(infoText);
    if (!expiryDate) {
      throw new Error('Could not find an expiry date on the VPS info page.');
    }

    const remainingDays = daysUntil(expiryDate);
    if (remainingDays > config.thresholdDays) {
      await notify(`Hax VPS does not need renewal. Expiry: ${formatDate(expiryDate)} (${remainingDays} days left).`);
      return;
    }

    await page.goto(config.renewUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await loginIfNeeded(page);
    await clickRenewButton(page);

    const resultText = await getBodyText(page);
    if (!RENEW_RESULT_HINT.test(resultText)) {
      throw new Error('Renewal was submitted, but no success message was detected.');
    }

    await notify(`Hax VPS renewal succeeded. Previous expiry: ${formatDate(expiryDate)} (${remainingDays} days left).`);
  } catch (error) {
    await notify(`Hax VPS renewal failed: ${error.message}`);
    throw error;
  } finally {
    await browser.close();
  }
}

function validateConfig(values) {
  const missing = [
    ['HAX_USERNAME', values.username],
    ['HAX_PASSWORD', values.password],
    ['TELEGRAM_BOT_TOKEN', values.telegramBotToken],
    ['TELEGRAM_CHAT_ID', values.telegramChatId]
  ].filter(([, value]) => !value);

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.map(([name]) => name).join(', ')}`);
  }

  if (!Number.isInteger(values.thresholdDays) || values.thresholdDays < 0) {
    throw new Error('RENEW_THRESHOLD_DAYS must be a non-negative integer.');
  }
}

async function loginIfNeeded(page) {
  const passwordInput = page.locator('input[type="password"]:visible').first();
  if ((await passwordInput.count()) === 0) {
    return;
  }

  const usernameInput = page
    .locator('input[name*="user" i]:visible, input[name*="email" i]:visible, input[type="email"]:visible, input[type="text"]:visible')
    .first();

  if ((await usernameInput.count()) === 0) {
    throw new Error('Login page detected, but username input was not found.');
  }

  await usernameInput.fill(config.username);
  await passwordInput.fill(config.password);

  const submit = page.locator('button[type="submit"]:visible, input[type="submit"]:visible, button:visible').first();
  if ((await submit.count()) === 0) {
    throw new Error('Login page detected, but submit button was not found.');
  }

  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {}),
    submit.click()
  ]);

  if ((await page.locator('input[type="password"]:visible').count()) > 0) {
    throw new Error('Login appears to have failed; password input is still visible.');
  }
}

async function clickRenewButton(page) {
  const renewButton = page
    .getByRole('button', { name: /renew|perpanjang|extend|lanjut/i })
    .or(page.getByRole('link', { name: /renew|perpanjang|extend|lanjut/i }))
    .first();

  if ((await renewButton.count()) === 0) {
    throw new Error('Renew page loaded, but no renewal button or link was found.');
  }

  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {}),
    renewButton.click()
  ]);
}

async function getBodyText(page) {
  return page.locator('body').innerText({ timeout: 30_000 });
}

async function notify(message) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: message,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram notification failed with HTTP ${response.status}.`);
  }
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
