/**
 * SmartSchool portal integration
 * Uses playwright-extra + stealth plugin to pass reCAPTCHA v2 checkbox.
 * Saves session cookies so login only needs to happen once.
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext } from 'playwright-core';
import fs from 'fs';
import path from 'path';

// Apply stealth plugin once at module load
chromium.use(StealthPlugin());

const SMARTSCHOOL_BASE = 'https://webtop.smartschool.co.il';
const GROUP_DIR = '/workspace/group';
const SESSION_FILE = path.join(GROUP_DIR, 'smartschool_session.json');
const CONFIG_FILE = path.join(GROUP_DIR, 'smartschool_config.json');

const CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1280,720',
];

const CONTEXT_OPTIONS = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 720 },
  locale: 'he-IL',
  timezoneId: 'Asia/Jerusalem',
  extraHTTPHeaders: {
    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  },
};

export interface SmartSchoolConfig {
  username: string;
  password: string;
}

export function saveConfig(config: SmartSchoolConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function loadConfig(): SmartSchoolConfig | null {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as SmartSchoolConfig;
  } catch {
    return null;
  }
}

function isLoginPage(url: string): boolean {
  return url.includes('/login') || url.includes('/account/login') || url.includes('/signin');
}

async function createContext(loadSavedSession = true): Promise<{
  browser: Awaited<ReturnType<typeof chromium.launch>>;
  context: BrowserContext;
}> {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: LAUNCH_ARGS,
  });

  const context = await browser.newContext(CONTEXT_OPTIONS);

  if (loadSavedSession && fs.existsSync(SESSION_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as { cookies?: object[] };
      if (saved.cookies?.length) {
        await context.addCookies(
          saved.cookies as Parameters<BrowserContext['addCookies']>[0],
        );
      }
    } catch {
      // Corrupt session file — start fresh
    }
  }

  return { browser, context };
}

async function saveSession(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2),
  );
}

export async function smartschoolLogin(
  username: string,
  password: string,
): Promise<{ success: boolean; message: string }> {
  // Always start fresh for login — don't reuse a potentially stale session
  const { browser, context } = await createContext(false);

  try {
    const page = await context.newPage();

    await page.goto(`${SMARTSCHOOL_BASE}/account/login`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });

    // Fill username
    await page.waitForSelector(
      'input[name="username"], input[type="email"], #username, input[id*="user"]',
      { timeout: 10000 },
    );
    await page.fill(
      'input[name="username"], input[type="email"], #username, input[id*="user"]',
      username,
    );

    // Fill password
    await page.fill(
      'input[name="password"], input[type="password"], #password, input[id*="pass"]',
      password,
    );

    // Attempt reCAPTCHA v2 checkbox via stealth plugin
    // The stealth plugin makes the browser look real enough that the checkbox auto-passes
    let recaptchaAttempted = false;
    try {
      // reCAPTCHA loads in a cross-origin iframe
      const recaptchaFrame = page.frameLocator(
        'iframe[src*="recaptcha"][src*="anchor"], iframe[title*="reCAPTCHA"]',
      ).first();
      const checkbox = recaptchaFrame.locator('#recaptcha-anchor');
      await checkbox.waitFor({ state: 'visible', timeout: 8000 });
      await checkbox.click();
      recaptchaAttempted = true;
      // Wait for Google's risk evaluation
      await page.waitForTimeout(4000);
    } catch {
      // reCAPTCHA iframe not found — may not be required on this attempt
    }

    // Submit the login form
    await page.click(
      'button[type="submit"], input[type="submit"], button:has-text("כניסה"), button:has-text("Login"), button:has-text("Sign in")',
    );

    await page.waitForLoadState('networkidle', { timeout: 25000 });

    const finalUrl = page.url();

    if (isLoginPage(finalUrl)) {
      // Still on login page — check for error message
      const errorText = await page
        .textContent('.error, .alert-danger, [class*="error"], [class*="alert"], .message')
        .catch(() => '');

      if (recaptchaAttempted) {
        return {
          success: false,
          message:
            `Login failed${errorText ? ': ' + errorText.trim() : ''}. ` +
            `reCAPTCHA was clicked but may have triggered an image challenge. ` +
            `To solve this reliably, provide a 2captcha API key.`,
        };
      }
      return {
        success: false,
        message: `Login failed${errorText ? ': ' + errorText.trim() : ''}. reCAPTCHA checkbox was not found.`,
      };
    }

    await saveSession(context);
    return { success: true, message: `Login successful. Landed on: ${finalUrl}` };
  } finally {
    await browser.close();
  }
}

export async function smartschoolFetch(url: string): Promise<{
  content: string;
  url: string;
  title: string;
  sessionExpired: boolean;
}> {
  const { browser, context } = await createContext(true);

  try {
    const page = await context.newPage();

    const fullUrl = url.startsWith('http') ? url : `${SMARTSCHOOL_BASE}${url}`;
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    if (isLoginPage(page.url())) {
      return { content: '', url: page.url(), title: '', sessionExpired: true };
    }

    await saveSession(context);

    const title = await page.title();
    const content = await page.evaluate(() => document.body.innerText);

    return { content, url: page.url(), title, sessionExpired: false };
  } finally {
    await browser.close();
  }
}
