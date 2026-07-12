/**
 * probe() — the agent's eyes. Connects, loads the page (optionally with props),
 * and returns a structured map: interactive elements with stable selectors and
 * bounding boxes, the props on stage, and whether the app exposes a window.__demo
 * bridge. An AI author uses this to pick selectors/coordinates reliably instead
 * of guessing.
 */
import type { BrowserTarget, Prop, ProbeResult, Viewport } from '../types.js';
import { Logger } from '../log.js';
import { connect } from '../browser.js';
import { composeScene } from '../scene.js';

export interface ProbeOptions {
  target: BrowserTarget;
  viewport?: Viewport;
  props?: Prop[];
  limit?: number;
  logLevel?: 'silent' | 'warn' | 'info' | 'debug';
}

const COLLECT = `
(() => {
  const cssPath = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid="' + tid + '"]';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).map((c) => CSS.escape(c)).join('.')
      : '';
    const tag = el.tagName.toLowerCase();
    const sel = tag + cls;
    try {
      const matches = document.querySelectorAll(sel);
      if (matches.length === 1) return sel;
      const idx = Array.prototype.indexOf.call(matches, el);
      return sel + ':nth-of-type(' + (idx + 1) + ')';
    } catch (e) { return tag; }
  };
  const sels = 'a,button,input,textarea,select,[role="button"],[role="link"],[onclick],[data-testid]';
  const out = [];
  const seen = new Set();
  document.querySelectorAll(sels).forEach((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = r.width > 1 && r.height > 1 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    const selector = cssPath(el);
    if (seen.has(selector)) return;
    seen.add(selector);
    out.push({
      selector,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      visible,
      clickable: visible && (getComputedStyle(el).cursor === 'pointer' || ['a','button','input','select','textarea'].includes(el.tagName.toLowerCase())),
    });
  });
  return {
    title: document.title,
    hasBridge: !!window.__demo,
    props: Array.from(document.querySelectorAll('[id^="__gifsmith_"]')).map((e) => e.id.replace('__gifsmith_', '')),
    elements: out,
  };
})()
`;

export async function probe(opts: ProbeOptions): Promise<ProbeResult> {
  const log = new Logger(opts.logLevel ?? 'warn');
  const viewport: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1, ...(opts.viewport ?? {}) };
  const conn = await connect(opts.target, viewport, log);
  try {
    if (opts.target.url && !conn.owned) {
      await conn.page.goto(opts.target.url, { waitUntil: 'load', timeout: 30_000 });
    }
    if (opts.props?.length) {
      await composeScene(conn.page, {
        props: opts.props,
        compose: 'overlay',
        ctx: { viewport, camera: null, compose: 'overlay' },
        log,
      });
    }
    const raw = (await conn.page.evaluate(COLLECT)) as any;
    const elements = (raw.elements as ProbeResult['elements'])
      .filter((e) => e.visible)
      .slice(0, opts.limit ?? 60);
    return {
      url: conn.page.url(),
      title: raw.title,
      viewport,
      elements,
      props: raw.props,
      hasBridge: raw.hasBridge,
    };
  } finally {
    if (conn.owned) await conn.browser.close();
    else await conn.browser.disconnect();
  }
}
