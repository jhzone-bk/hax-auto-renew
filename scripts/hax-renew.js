import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { daysUntil, findExpiryDate } from './expiry-parser.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const config = {
  cookie: process.env.HAX_COOKIE,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  thresholdDays: Number.parseInt(process.env.REMIND_THRESHOLD_DAYS || process.env.RENEW_THRESHOLD_DAYS || '3', 10),
  loginWaitMinutes: Number.parseInt(process.env.HAX_LOGIN_WAIT_MINUTES || '10', 10),
  loginPollSeconds: Number.parseInt(process.env.HAX_LOGIN_POLL_SECONDS || '15', 10),
  timezone: process.env.TIMEZONE || 'Asia/Shanghai',
  infoUrl: process.env.HAX_INFO_URL || 'https://hax.co.id/vps-info',
  profileDir: process.env.HAX_PROFILE_DIR || '',
  headless: process.env.HAX_HEADLESS !== 'false'
};

async function main() {
  validateConfig(config);

  let context;

  try {
    const session = await createSession();
    context = session.context;
    const page = session.page;

    let infoText = await loadInfoPage(page);
    let expiryDate = findExpiryDate(infoText);

    if (!expiryDate) {
      const diagnostics = await pageDiagnostics(page, infoText);
      if (isCloudflareChallenge(diagnostics)) {
        throw new Error(`Cloudflare challenge did not clear on the runner. Open the runner browser once to pass Cloudflare, then run again. ${JSON.stringify(diagnostics)}`);
      }

      if (isLoginPage(diagnostics)) {
        ({ infoText, expiryDate } = await waitForManualTelegramLogin(page, diagnostics));
      }
    }

    if (!expiryDate) {
      const diagnostics = await pageDiagnostics(page, infoText);
      const reason = isCloudflareChallenge(diagnostics)
        ? 'Cloudflare challenge did not clear on the runner.'
        : isLoginPage(diagnostics)
          ? 'Hax still redirects to login. Telegram confirmation was not completed or the session was not accepted.'
        : 'Could not find an expiry date. Cookie may be expired or the Hax page format changed.';
      throw new Error(`${reason} ${JSON.stringify(diagnostics)}`);
    }

    const remainingDays = daysUntil(expiryDate);
    const message = remainingDays <= config.thresholdDays
      ? `Hax VPS is close to expiry: ${formatDate(expiryDate)} (${remainingDays} days left).`
      : `Hax VPS expiry check OK: ${formatDate(expiryDate)} (${remainingDays} days left).`;

    await notify('Hax VPS expiry reminder', message);
  } catch (error) {
    await notify('Hax VPS expiry check failed', error.message);
    throw error;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

async function createSession() {
  const contextOptions = {
    headless: config.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-features=MediaRouter,OptimizationHints,Translate',
      '--disable-gpu',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--no-sandbox',
      '--renderer-process-limit=1',
      '--js-flags=--max-old-space-size=128'
    ],
    timezoneId: config.timezone,
    locale: 'en-US',
    userAgent: USER_AGENT,
    viewport: { width: 1000, height: 700 },
    screen: { width: 1000, height: 700 },
    extraHTTPHeaders: {
      'accept-language': 'en-US,en;q=0.9,id;q=0.8,zh-CN;q=0.7'
    }
  };

  const profileDir = config.profileDir || '';
  const hadProfile = hasExistingProfile(profileDir);
  const context = await withStepError('Chromium launch failed', () => (
    profileDir
      ? chromium.launchPersistentContext(profileDir, contextOptions)
      : chromium.launchPersistentContext('', contextOptions)
  ));

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  if (config.cookie && !hadProfile) {
    await withStepError('Adding Hax cookies failed', () => context.addCookies(parseCookieHeader(config.cookie, config.infoUrl)));
  }

  const page = await withStepError('Opening a new Chromium page failed', () => context.newPage());
  for (const oldPage of context.pages()) {
    if (oldPage !== page) {
      await oldPage.close().catch(() => {});
    }
  }

  return {
    context,
    page
  };
}

async function withStepError(label, action) {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

async function loadInfoPage(page) {
  try {
    await gotoWithRetry(page, config.infoUrl);
  } catch (error) {
    const diagnostics = await pageDiagnostics(page, '');
    throw new Error(`Hax navigation failed before the page loaded: ${error.message} ${JSON.stringify(diagnostics)}`);
  }
  await waitForCloudflare(page);
  return getBodyText(page);
}

async function gotoWithRetry(page, url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    } catch (error) {
      if (attempt === 1 || !/ERR_ABORTED|frame was detached|Target page/.test(error.message)) {
        throw error;
      }
      await page.waitForTimeout(2_000).catch(() => {});
    }
  }
}

function validateConfig(values) {
  const missing = [
    ['TELEGRAM_BOT_TOKEN', values.telegramBotToken],
    ['TELEGRAM_CHAT_ID', values.telegramChatId]
  ].filter(([, value]) => !value);

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.map(([name]) => name).join(', ')}`);
  }

  if (!Number.isInteger(values.thresholdDays) || values.thresholdDays < 0) {
    throw new Error('REMIND_THRESHOLD_DAYS must be a non-negative integer.');
  }

  if (!Number.isInteger(values.loginWaitMinutes) || values.loginWaitMinutes < 1) {
    throw new Error('HAX_LOGIN_WAIT_MINUTES must be a positive integer.');
  }

  if (!Number.isInteger(values.loginPollSeconds) || values.loginPollSeconds < 5) {
    throw new Error('HAX_LOGIN_POLL_SECONDS must be an integer of at least 5.');
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

async function waitForManualTelegramLogin(page, diagnostics) {
  const clicked = await triggerTelegramLogin(page);
  await notify(
    'Hax VPS login confirmation needed',
    clicked
      ? `Hax is on the Telegram login page. I clicked the Telegram login control. Open Telegram and tap Confirm within ${config.loginWaitMinutes} minutes.\n\nCurrent page: ${diagnostics.title}\n${diagnostics.url}`
      : `Hax is on the login page, but I could not find a clickable Telegram login control. ${JSON.stringify(diagnostics)}`
  );

  if (!clicked) {
    throw new Error(`Could not find a clickable Telegram login control. ${JSON.stringify(diagnostics)}`);
  }

  const deadline = Date.now() + config.loginWaitMinutes * 60_000;
  let lastDiagnostics = diagnostics;

  while (Date.now() < deadline) {
    await page.waitForTimeout(config.loginPollSeconds * 1000);
    await triggerTelegramLogin(page);

    const infoText = await loadInfoPage(page).catch(async (error) => {
      lastDiagnostics = {
        ...lastDiagnostics,
        error: error.message
      };
      return null;
    });
    if (!infoText) continue;

    const expiryDate = findExpiryDate(infoText);
    if (expiryDate) {
      await notify('Hax VPS login confirmed', 'Telegram confirmation worked. The VPS info page is now accessible.');
      return { infoText, expiryDate };
    }

    lastDiagnostics = await pageDiagnostics(page, infoText);
    if (!isCloudflareChallenge(lastDiagnostics) && !isLoginPage(lastDiagnostics)) {
      return { infoText, expiryDate: null };
    }
  }

  throw new Error(`Manual Telegram login was not completed within ${config.loginWaitMinutes} minutes. ${JSON.stringify(lastDiagnostics)}`);
}

async function triggerTelegramLogin(page) {
  const selectors = [
    'a[href*="oauth.telegram.org"]',
    'a[href*="telegram"]',
    'button:has-text("Telegram")',
    '[role="button"]:has-text("Telegram")'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count === 1 && await locator.first().isVisible().catch(() => false)) {
      await locator.first().click({ timeout: 5_000 }).catch(() => {});
      return true;
    }
  }

  const telegramFrames = page.locator('iframe[src*="oauth.telegram.org"], iframe[src*="telegram"]');
  const frameCount = await telegramFrames.count().catch(() => 0);
  if (frameCount === 1) {
    await page.frameLocator('iframe[src*="oauth.telegram.org"], iframe[src*="telegram"]').locator('body').click({ timeout: 5_000 }).catch(() => {});
    return true;
  }

  const visibleFrames = page.locator('iframe:visible');
  const visibleFrameCount = await visibleFrames.count().catch(() => 0);
  if (visibleFrameCount === 1) {
    const box = await visibleFrames.first().boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      return true;
    }
  }

  return false;
}

function hasExistingProfile(profileDir) {
  if (!profileDir) return false;
  try {
    return fs.existsSync(profileDir) && fs.readdirSync(profileDir).length > 0;
  } catch {
    return false;
  }
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
