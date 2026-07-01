import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { daysUntil, findExpiryDate } from './expiry-parser.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const config = {
  cookie: process.env.HAX_COOKIE,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  thresholdDays: Number.parseInt(process.env.REMIND_THRESHOLD_DAYS || process.env.RENEW_THRESHOLD_DAYS || '3', 10),
  timezone: process.env.TIMEZONE || 'Asia/Shanghai',
  infoUrl: process.env.HAX_INFO_URL || 'https://hax.co.id/vps-info',
  headless: process.env.HAX_HEADLESS !== 'false'
};

async function main() {
  validateConfig(config);

  const browser = await chromium.launch({
    headless: config.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });
  const session = await createSession(browser);
  let context = session.context;
  let page = session.page;

  try {
    let infoText = await loadInfoPage(page);
    let expiryDate = findExpiryDate(infoText);

    if (!expiryDate) {
      const diagnostics = await pageDiagnostics(page, infoText);
      if (isCloudflareChallenge(diagnostics)) {
        await context.close();
        ({ context, page } = await refreshCloudflareCookies(browser));
        infoText = await loadInfoPage(page);
        expiryDate = findExpiryDate(infoText);
      }
    }

    if (!expiryDate) {
      const diagnostics = await pageDiagnostics(page, infoText);
      const reason = isCloudflareChallenge(diagnostics)
        ? 'Cloudflare challenge did not clear on GitHub Actions. The cookie may be valid in your browser but blocked on GitHub runner.'
        : isLoginPage(diagnostics)
          ? 'Cloudflare passed, but Hax redirected to login. HAX_COOKIE is expired or does not include the full logged-in session cookie.'
        : 'Could not find an expiry date. Cookie may be expired or the Hax page format changed.';
      throw new Error(`${reason} ${JSON.stringify(diagnostics)}`);
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

async function createSession(browser) {
  const context = await browser.newContext({
    timezoneId: config.timezone,
    locale: 'en-US',
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    extraHTTPHeaders: {
      'accept-language': 'en-US,en;q=0.9,id;q=0.8,zh-CN;q=0.7'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await context.addCookies(parseCookieHeader(config.cookie, config.infoUrl));

  return {
    context,
    page: await context.newPage()
  };
}

async function loadInfoPage(page) {
  await page.goto(config.infoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForCloudflare(page);
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
  const jsonCookies = parseCookieJson(cookieHeader, url);
  if (jsonCookies) return jsonCookies;

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

function parseCookieJson(cookieHeader, url) {
  const trimmed = cookieHeader.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;

  const { hostname } = new URL(url);
  const parsed = JSON.parse(trimmed);
  const source = Array.isArray(parsed) ? parsed : parsed.cookies;
  if (!Array.isArray(source)) {
    throw new Error('HAX_COOKIE JSON must be an array, or an object with a cookies array.');
  }

  const cookies = source
    .filter((cookie) => cookie && cookie.name && cookie.value !== undefined)
    .map((cookie) => ({
      name: String(cookie.name),
      value: String(cookie.value),
      domain: cookie.domain || hostname,
      path: cookie.path || '/',
      httpOnly: Boolean(cookie.httpOnly),
      secure: cookie.secure !== false,
      sameSite: normalizeSameSite(cookie.sameSite)
    }));

  if (!cookies.length) {
    throw new Error('HAX_COOKIE JSON does not contain any cookies with name and value.');
  }

  return cookies;
}

function normalizeSameSite(value) {
  if (/^strict$/i.test(value || '')) return 'Strict';
  if (/^none$/i.test(value || '')) return 'None';
  return 'Lax';
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

function isLoginPage(diagnostics) {
  return /\/login\b/i.test(diagnostics.url) || diagnostics.hasLoginText;
}

async function refreshCloudflareCookies(browser) {
  const refreshUrl = new URL('/create-vps/', config.infoUrl).href;
  const { context, page } = await createSession(browser);
  console.log(`Refreshing Cloudflare cookies from ${refreshUrl}`);
  await page.goto(refreshUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForCloudflare(page);
  const cookies = await context.cookies();
  const cookieNames = cookies.map((cookie) => cookie.name).join(', ');
  console.log(`Cloudflare cookie refresh completed. Cookie names: ${cookieNames || 'none'}`);
  return { context, page };
}

async function waitForCloudflare(page) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const title = await page.title().catch(() => '');
    if (!/just a moment/i.test(title) && !/__cf_chl_|cf_chl/i.test(page.url())) return;
    await page.waitForTimeout(5_000);
  }
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
