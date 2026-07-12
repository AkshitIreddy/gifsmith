/**
 * Adapters produce a BrowserTarget for the Director. `web` launches a detected
 * Chrome/Edge/Brave and points it at a URL — the fully-supported v1 path.
 * `tauri` and `electron` attach to a webview that already exposes a CDP
 * endpoint; you launch the app yourself with the debugging flags below (this is
 * the one non-obvious gotcha — modern Chromium/WebView2 rejects the CDP
 * WebSocket without `--remote-allow-origins=*`).
 */
import type { BrowserTarget } from '../types.js';

export function web(url: string, opts: Omit<BrowserTarget, 'url'> = {}): BrowserTarget {
  return { url, ...opts };
}

export interface AttachOptions {
  port?: number;
  host?: string;
  /** Optionally navigate the attached page to this URL first. */
  url?: string;
}

/**
 * Attach to a Tauri (WebView2/WKWebView) app. Launch it first with a remote
 * debugging port. On Windows (WebView2):
 *
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
 *     "--remote-debugging-port=9222 --remote-allow-origins=*"
 *   Start-Process .\your-app.exe
 *
 * Run the app off-screen and muted for an invisible capture; if it is a
 * single-instance app, stop the running instance first and relaunch after.
 */
export function tauri(opts: AttachOptions = {}): BrowserTarget {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 9222;
  return { browserURL: `http://${host}:${port}`, url: opts.url };
}

export const TAURI_LAUNCH_HELP =
  'Windows (WebView2): set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=' +
  '"--remote-debugging-port=9222 --remote-allow-origins=*" then start the app.\n' +
  'The --remote-allow-origins=* flag is required or the CDP WebSocket 403s.';

/**
 * Attach to an Electron app launched with `--remote-debugging-port=9222`
 * (add it to your app's argv, or the ELECTRON_EXTRA_LAUNCH_ARGS env).
 */
export function electron(opts: AttachOptions = {}): BrowserTarget {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 9222;
  return { browserURL: `http://${host}:${port}`, url: opts.url };
}

export const ELECTRON_LAUNCH_HELP =
  'Launch your Electron app with --remote-debugging-port=9222 ' +
  '(e.g. app.commandLine.appendSwitch("remote-debugging-port","9222") before app.ready).';
