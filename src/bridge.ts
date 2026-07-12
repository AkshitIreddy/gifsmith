/**
 * Two cooperation surfaces:
 *
 * 1. `window.__gifsmith` — gifsmith's own in-page runtime, injected into the
 *    target page. It owns the synthetic cursor, prop state, and the rAF tweens
 *    that the timeline's cursor/scroll/actor steps call. Keeping motion in-page
 *    (real requestAnimationFrame) means the screencast records genuine frames,
 *    not stepped teleports.
 *
 * 2. `window.__demo` — the *app's* opt-in cooperation bridge (generalizing
 *    Project A's window.__pet and Project C's window.__DEMO_PACE__). An app can
 *    expose `{ pace(mult), setState(k,v), trigger(action,...args) }`, gated
 *    behind a flag so it is dormant in production. gifsmith drives the real
 *    product engine through it — setting values sliders would clamp, firing
 *    actions, and slowing streaming for a clean capture. gifsmith never
 *    requires it; without it, we drive the DOM directly.
 */
import type { Page } from 'puppeteer-core';
import { Logger } from './log.js';

/** Injected once into the page. Pure browser JS (no template literals inside). */
export const RUNTIME_JS = String.raw`
(() => {
  if (window.__gifsmith) return;
  const easings = {
    linear: function (t) { return t; },
    easeIn: function (t) { return t * t; },
    easeOut: function (t) { return 1 - (1 - t) * (1 - t); },
    easeInOut: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
  };
  function tween(durMs, easingName, apply) {
    return new Promise(function (res) {
      if (durMs <= 0) { apply(1); return res(); }
      const ease = easings[easingName] || easings.easeInOut;
      const t0 = performance.now();
      function step(now) {
        const p = Math.min(1, (now - t0) / durMs);
        apply(ease(p));
        if (p < 1) requestAnimationFrame(step); else res();
      }
      requestAnimationFrame(step);
    });
  }
  const G = {
    version: '0.1.0',
    props: {},
    cursor: null,
    centerOf: function (sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    installCursor: function (opts) {
      opts = opts || {};
      if (G.cursor) return;
      const el = document.createElement('div');
      el.id = '__gifsmith_cursor';
      el.style.cssText =
        'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483646;' +
        'pointer-events:none;transform:translate(-2px,-2px);will-change:left,top;' +
        'filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))';
      el.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 22 22" fill="none">' +
        '<path d="M2 2 L2 17 L6.5 12.8 L9.4 19 L12 17.8 L9.1 11.8 L15 11.5 Z" ' +
        'fill="#ffffff" stroke="#1a1a1a" stroke-width="1.3" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(el);
      const start = opts.start || { x: window.innerWidth * 0.5, y: window.innerHeight * 0.62 };
      G.cursor = { el: el, x: start.x, y: start.y };
      el.style.left = start.x + 'px';
      el.style.top = start.y + 'px';
    },
    cursorTo: function (x, y, durMs, easing) {
      if (!G.cursor) return Promise.resolve();
      const c = G.cursor, sx = c.x, sy = c.y;
      return tween(durMs, easing, function (p) {
        c.x = sx + (x - sx) * p;
        c.y = sy + (y - sy) * p;
        c.el.style.left = c.x + 'px';
        c.el.style.top = c.y + 'px';
      });
    },
    cursorToSelector: function (sel, durMs, easing) {
      const p = G.centerOf(sel);
      if (!p) return Promise.resolve();
      return G.cursorTo(p.x, p.y, durMs, easing);
    },
    ripple: function (x, y) {
      if (x == null && G.cursor) { x = G.cursor.x; y = G.cursor.y; }
      if (x == null) return;
      const r = document.createElement('div');
      r.style.cssText =
        'position:fixed;left:' + x + 'px;top:' + y + 'px;width:8px;height:8px;' +
        'margin:-4px 0 0 -4px;border-radius:50%;z-index:2147483645;pointer-events:none;' +
        'background:rgba(80,140,255,.45);border:1.5px solid rgba(80,140,255,.9)';
      document.documentElement.appendChild(r);
      tween(420, 'easeOut', function (p) {
        r.style.transform = 'scale(' + (1 + p * 4) + ')';
        r.style.opacity = String(1 - p);
      }).then(function () { r.remove(); });
    },
    scrollBy: function (sel, dy, durMs, easing) {
      const el = document.querySelector(sel);
      if (!el) return Promise.resolve();
      const start = el.scrollTop;
      return tween(durMs, easing, function (p) { el.scrollTop = start + dy * p; });
    },
    registerActor: function (id, el) { G['actor_' + id] = el; },
    moveActor: function (id, x, y, durMs, easing) {
      const el = G['actor_' + id] || document.getElementById('__gifsmith_actor_' + id);
      if (!el) return Promise.resolve();
      const sx = parseFloat(el.style.left || '0');
      const sy = parseFloat(el.style.top || '0');
      return tween(durMs, easing, function (p) {
        el.style.left = (sx + (x - sx) * p) + 'px';
        el.style.top = (sy + (y - sy) * p) + 'px';
      });
    },
    setProp: function (id, patch) {
      const pr = G.props[id];
      if (pr && typeof pr.set === 'function') pr.set(patch);
    },
    pace: function (mult) {
      window.__DEMO_PACE__ = mult;
      try { if (window.__demo && typeof window.__demo.pace === 'function') window.__demo.pace(mult); } catch (e) {}
    },
  };
  window.__gifsmith = G;
})();
`;

export async function installRuntime(page: Page): Promise<void> {
  await page.evaluate(RUNTIME_JS);
}

export interface BridgeSetup {
  present: boolean;
}

/**
 * Detect and configure the app's opt-in `window.__demo` bridge. Sets the pace
 * multiplier both on the bridge (if present) and on `window.__DEMO_PACE__` for
 * apps that only read the flag. Optionally waits for the bridge to appear.
 */
export async function setupBridge(
  page: Page,
  opts: { pace?: number; require?: boolean; requireTimeoutMs?: number },
  log: Logger,
): Promise<BridgeSetup> {
  if (opts.require) {
    log.step('bridge', 'waiting for window.__demo');
    await page.waitForFunction('!!window.__demo', { timeout: opts.requireTimeoutMs ?? 15_000 });
  }
  const present = (await page.evaluate('!!window.__demo')) as boolean;
  if (opts.pace != null) {
    await page.evaluate((mult: number) => {
      (window as any).__DEMO_PACE__ = mult;
      const d = (window as any).__demo;
      if (d && typeof d.pace === 'function') { try { d.pace(mult); } catch (e) {} }
    }, opts.pace);
    log.step('bridge', `pace ${opts.pace}${present ? '' : ' (no __demo; set __DEMO_PACE__ only)'}`);
  }
  return { present };
}
