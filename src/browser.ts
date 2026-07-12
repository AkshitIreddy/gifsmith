/**
 * Browser connection: launch a fresh headless Chromium (no bundled Chromium —
 * we auto-detect an installed Chrome/Edge/Brave), or attach to an already
 * running CDP endpoint (Tauri WebView2 / Electron / a manual --remote-debugging
 * session). Mirrors Project C's findChrome, generalized to attach.
 */
import fs from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { BrowserTarget, Viewport } from './types.js';
import { Logger } from './log.js';

export function findChrome(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const candidates: Record<string, string[]> = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser',
    ],
  };
  const list = candidates[process.platform] || [];
  const hit = list.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error(
      'gifsmith: no Chromium-based browser found. Install Chrome/Edge/Brave, ' +
        'or set PUPPETEER_EXECUTABLE_PATH to the binary.',
    );
  }
  return hit;
}

export interface Connection {
  browser: Browser;
  page: Page;
  /** True when we launched the browser (and should therefore close it). */
  owned: boolean;
}

export interface LaunchExtras {
  /**
   * An isolated, throwaway profile directory. gifsmith always renders in a
   * sandboxed profile so it never reads or writes your real browser's
   * cookies/session/history; the Director points this at a temp dir it deletes
   * afterwards. If omitted, puppeteer auto-creates and removes its own.
   */
  userDataDir?: string;
}

export async function connect(
  target: BrowserTarget,
  viewport: Viewport,
  log: Logger,
  extras: LaunchExtras = {},
): Promise<Connection> {
  const defaultViewport = {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
  };

  // Attach mode — an app already exposes a CDP endpoint.
  if (target.browserWSEndpoint || target.browserURL) {
    log.step('attach', target.browserWSEndpoint || target.browserURL);
    const browser = await puppeteer.connect({
      browserWSEndpoint: target.browserWSEndpoint,
      browserURL: target.browserURL,
      defaultViewport,
    });
    const page = await firstUsablePage(browser);
    return { browser, page, owned: false };
  }

  // Launch mode — spin up a detected browser in an isolated, throwaway profile
  // (a sandbox): headless + muted by default, never touching the user's real
  // browser data. See LaunchExtras.userDataDir.
  const executablePath = findChrome(target.executablePath);
  log.step('launch', executablePath, target.headful ? '(headful)' : '(headless)');
  const args = [
    `--window-size=${viewport.width},${viewport.height}`,
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--mute-audio',
  ];
  // Disable Chromium's OS sandbox when asked, or via GIFSMITH_NO_SANDBOX — the
  // convenient toggle for containers/CI (where Chrome runs as root and won't
  // start otherwise) without changing any demo code.
  if (target.chromiumSandbox === false || process.env.GIFSMITH_NO_SANDBOX) {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  if (target.headful && target.offscreen !== false) {
    args.push('--window-position=-32000,-32000');
  }
  args.push(...(target.args || []));
  const browser = await puppeteer.launch({
    executablePath,
    headless: !target.headful,
    defaultViewport,
    userDataDir: extras.userDataDir,
    args,
  });
  // If page creation or the initial navigation fails, tear down the browser we
  // just launched — otherwise the Chromium process is orphaned (connect() never
  // returns, so the caller's try/finally never runs).
  try {
    const page = await browser.newPage();
    if (target.url) {
      await page.goto(target.url, { waitUntil: 'load', timeout: 30_000 });
    }
    return { browser, page, owned: true };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

async function firstUsablePage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  const usable = pages.find((p) => !p.url().startsWith('devtools://'));
  return usable ?? (await browser.newPage());
}
