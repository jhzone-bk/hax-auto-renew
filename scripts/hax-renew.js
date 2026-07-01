import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { daysUntil, findExpiryDate } from './expiry-parser.js';

const config = {
  username: process.env.HAX_USERNAME,
  password: process.env.HAX_PASSWORD,
  pushplusToken: process.env.PUSHPLUS_TOKEN,
  thresholdDays: Number.parseInt(process.env.REMIND_THRESHOLD_DAYS || process.env.RENEW_THRESHOLD_DAYS || '3', 10),
  timezone: process.env.TIMEZONE || 'Asia/Shanghai',
  infoUrl: process.env.HAX_INFO_URL || 'https://hax.co.id/vps-info'
};

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
      throw new Error(`Could not find an expiry date on the VPS info page. ${await pageDiagnostics(page, infoText)}`);
    }

    const remainingDays = daysUntil(expiryDate);
    const message = remainingDays <= config.thresholdDays
      ? `Hax VPS is close to expiry: ${formatDate(expiryDate)} (${remainingDays} days left).`
      : `Hax VPS expiry check OK: ${formatDate(expiryDate)} (${remainingDays} days left).`;

    await notify('Hax VPS 到期提醒', message);
  } catch (error) {
    await notify('Hax VPS 查询失败', `Hax VPS expiry check failed: ${error.message}`);
    throw error;
  } finally {
    await browser.close();
  }
}

function validateConfig(values) {
  const missing = [
    ['HAX_USERNAME', values.username],
    ['HAX_PASSWORD', values.password]
  ].filter(([, value]) => !value);

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.map(([name]) => name).join(', ')}`);
  }

  if (!Number.isInteger(values.thresholdDays) || values.thresholdDays < 0) {
    throw new Error('REMIND_THRESHOLD_DAYS must be a non-negative integer.');
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

async function getBodyText(page) {
  return page.locator('body').innerText({ timeout: 30_000 });
}

async function pageDiagnostics(page, pageText) {
  const title = await page.title().catch(() => 'unknown');
  const url = page.url();
  const hasPasswordInput = await page.locator('input[type="password"]:visible').count().then((count) => count > 0).catch(() => false);
  const hasLoginText = /login|sign in|masuk/i.test(pageText);
  const dateMatches = [...pageText.matchAll(/\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}\s+(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December|Januari|Februari|Maret|Mei|Juni|Juli|Agustus|Agu|Oktober|Desember)\s+\d{4})\b/gi)]
    .map((match) => match[0])
    .slice(0, 5);

  return JSON.stringify({
    url,
    title,
    textLength: pageText.length,
    hasPasswordInput,
    hasLoginText,
    dateMatches
  });
}

async function notify(title, message) {
  console.log(`${title}: ${message}`);

  if (!config.pushplusToken) {
    return;
  }

  const response = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: config.pushplusToken,
      title,
      content: message,
      template: 'txt'
    })
  });

  if (!response.ok) {
    throw new Error(`PushPlus notification failed with HTTP ${response.status}.`);
  }

  const result = await response.json().catch(() => null);
  if (result && result.code !== 200) {
    throw new Error(`PushPlus notification failed: ${result.msg || JSON.stringify(result)}`);
  }
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
