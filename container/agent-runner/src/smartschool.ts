/**
 * SmartSchool portal integration
 * Uses playwright-extra + stealth plugin to pass reCAPTCHA v2.
 * Supports 2captcha.com for solving image challenges.
 * Saves session cookies so login only needs to happen once.
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright-core';
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
  twoCaptchaApiKey?: string;
}

// ---------------------------------------------------------------------------
// 2captcha solver
// ---------------------------------------------------------------------------

async function solveRecaptchaWith2Captcha(
  page: Page,
  apiKey: string,
): Promise<string> {
  const pageUrl = page.url();

  // Extract sitekey from the page DOM
  // Try data-sitekey attribute first, then fall back to iframe src param
  let key = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]') || document.querySelector('.g-recaptcha');
    return el?.getAttribute('data-sitekey') ?? null;
  });

  if (!key) {
    const iframeSrc = await page
      .locator('iframe[src*="recaptcha"]')
      .first()
      .getAttribute('src')
      .catch(() => null);
    const match = iframeSrc?.match(/[?&]k=([^&]+)/);
    if (!match) throw new Error('Could not find reCAPTCHA sitekey on page');
    key = match[1];
  }

  // Submit to 2captcha
  const submitRes = await fetch(
    `https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${encodeURIComponent(key)}&pageurl=${encodeURIComponent(pageUrl)}&json=1`,
  );
  const submitJson = (await submitRes.json()) as { status: number; request: string };
  if (submitJson.status !== 1) {
    throw new Error(`2captcha submit failed: ${submitJson.request}`);
  }
  const taskId = submitJson.request;

  // Poll for result (up to 2 minutes)
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(
      `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`,
    );
    const pollJson = (await pollRes.json()) as { status: number; request: string };
    if (pollJson.status === 1) return pollJson.request; // token
    if (pollJson.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2captcha error: ${pollJson.request}`);
    }
  }

  throw new Error('2captcha timed out after 2 minutes');
}

async function injectRecaptchaToken(page: Page, token: string): Promise<void> {
  await page.evaluate((t) => {
    // Set the textarea — ID may have a numeric suffix (e.g. g-recaptcha-response-1)
    const textarea = (
      document.getElementById('g-recaptcha-response') ||
      document.querySelector<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]') ||
      document.querySelector<HTMLTextAreaElement>('textarea.g-recaptcha-response')
    ) as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.style.display = 'block';
      textarea.value = t;
    }

    // Fire the data-callback if present on a [data-sitekey] element
    const widget = document.querySelector<HTMLElement>('[data-sitekey]');
    const callbackName = widget?.getAttribute('data-callback');
    const win = window as unknown as Record<string, unknown>;
    if (callbackName && typeof win[callbackName] === 'function') {
      (win[callbackName] as (token: string) => void)(t);
      return;
    }

    // SmartSchool pattern: ___grecaptcha_cfg.clients[id].L.L.callback
    try {
      type GrecaptchaCfg = {
        clients?: Record<string, Record<string, Record<string, Record<string, ((t: string) => void) | undefined>>>>;
      };
      const cfg = (window as unknown as { ___grecaptcha_cfg?: GrecaptchaCfg }).___grecaptcha_cfg;
      if (cfg?.clients) {
        for (const client of Object.values(cfg.clients)) {
          for (const level1 of Object.values(client)) {
            if (level1 && typeof level1 === 'object') {
              for (const level2 of Object.values(level1)) {
                if (level2 && typeof level2 === 'object' && typeof (level2 as Record<string, unknown>).callback === 'function') {
                  (level2 as Record<string, (t: string) => void>).callback(t);
                  return;
                }
              }
            }
          }
        }
      }
    } catch {
      // ignore — textarea value alone may suffice
    }
  }, token);
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
  twoCaptchaApiKey?: string,
): Promise<{ success: boolean; message: string }> {
  // Always start fresh for login — don't reuse a potentially stale session
  const { browser, context } = await createContext(false);

  try {
    const page = await context.newPage();

    // SmartSchool is an Angular SPA — wait for full render
    await page.goto(`${SMARTSCHOOL_BASE}/account/login`, {
      waitUntil: 'networkidle',
      timeout: 45000,
    });

    // Dismiss cookie consent if present
    const cookieBtn = page.locator('button:has-text("אשר cookies")');
    if (await cookieBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cookieBtn.click();
      await page.waitForTimeout(500);
    }

    // Try direct API login first — bypasses Angular form validation issues
    const captchaToken = twoCaptchaApiKey
      ? await (async () => {
          // Check for reCAPTCHA on the page
          await page.waitForSelector('body', { timeout: 15000 });
          await page.waitForTimeout(2000);
          const hasCaptcha = await page.evaluate(() =>
            !!document.querySelector('[data-sitekey]') ||
            !!document.querySelector('iframe[src*="recaptcha"]'),
          );
          if (hasCaptcha) {
            return solveRecaptchaWith2Captcha(page, twoCaptchaApiKey);
          }
          return null;
        })()
      : null;

    // Call the login API directly from the page context
    const loginResult = await page.evaluate(
      async (args: { user: string; pass: string; captcha: string | null }) => {
        try {
          const res = await fetch('/api/user/LoginByUserNameAndPassword', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              UserName: args.user,
              Password: args.pass,
              Data: '',
              captcha: args.captcha ?? '',
              RememberMe: true,
              BiometricLogin: false,
              UniqueId: '',
              deviceDataJson: JSON.stringify({
                userAgent: navigator.userAgent,
                language: navigator.language,
              }),
            }),
          });
          const text = await res.text();
          return { status: res.status, body: text, ok: res.ok };
        } catch (e) {
          return { status: 0, body: String(e), ok: false };
        }
      },
      { user: username, pass: password, captcha: captchaToken },
    );

    // Check if API login succeeded
    if (loginResult.ok || loginResult.status === 200) {
      // Navigate to main page to confirm session
      await page.goto(SMARTSCHOOL_BASE, { waitUntil: 'networkidle', timeout: 30000 });
      const finalUrl = page.url();

      if (!isLoginPage(finalUrl)) {
        await saveSession(context);
        return { success: true, message: `Login successful (API). Landed on: ${finalUrl}` };
      }
    }

    // Fallback: try form-based login with proper Angular event triggering
    await page.goto(`${SMARTSCHOOL_BASE}/account/login`, {
      waitUntil: 'networkidle',
      timeout: 45000,
    });

    // Dismiss cookie consent if present
    const cookieBtn2 = page.locator('button:has-text("אשר cookies")');
    if (await cookieBtn2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cookieBtn2.click();
      await page.waitForTimeout(500);
    }

    // Use click + type to trigger Angular reactive form updates (not fill)
    await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: 15000 });
    const usernameInput = page.locator('input[type="text"]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    await usernameInput.click();
    await usernameInput.pressSequentially(username, { delay: 30 });
    await page.waitForTimeout(200);
    await passwordInput.click();
    await passwordInput.pressSequentially(password, { delay: 30 });
    await page.waitForTimeout(500);

    // Check for reCAPTCHA
    const hasCaptcha = await page.evaluate(() =>
      !!document.querySelector('[data-sitekey]') ||
      !!document.querySelector('iframe[src*="recaptcha"]'),
    );

    if (hasCaptcha && twoCaptchaApiKey) {
      const token = await solveRecaptchaWith2Captcha(page, twoCaptchaApiKey);
      await injectRecaptchaToken(page, token);
      await page.waitForTimeout(1000);
    }

    // Submit
    await page.click('button[type="submit"]:has-text("כניסה")');
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    const finalUrl = page.url();

    if (isLoginPage(finalUrl)) {
      const errorText = await page
        .textContent('.error, .alert-danger, [class*="error"], [class*="alert"], .message, snack-bar-container')
        .catch(() => '');
      return {
        success: false,
        message: `Login failed (API: ${loginResult.status} ${loginResult.body.slice(0, 200)})${errorText ? ' Form: ' + errorText.trim() : ''}.`,
      };
    }

    await saveSession(context);
    return { success: true, message: `Login successful (form). Landed on: ${finalUrl}` };
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
    await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 45000 });

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
