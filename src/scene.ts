/**
 * Scene composition — build the movie set around the live app.
 *
 * `overlay` (default): inject props as DOM layers into the target page itself,
 * so they composite with the real UI in the same paint. The app is driven
 * directly at top level. Robust for any app; the full movie set for
 * transparent/overlay apps and full-bleed-plus-chrome for opaque ones.
 *
 * `stage`: serve a mock desktop (wallpaper + a window with a titlebar) and embed
 * the target in an <iframe> as the app window. Front-layer props (cursor,
 * taskbar, extra windows) sit on the top page; the app is driven inside the
 * frame (Puppeteer handles it even cross-origin). Because the top page is a
 * gifsmith document, the target must be an http(s) URL (a dev server) — a
 * file:// app can't be framed by a non-file page. Returns the app Frame.
 */
import type { Frame, Page } from 'puppeteer-core';
import type { ComposeMode, Prop, PropContext, StageOptions } from './types.js';
import { installRuntime } from './bridge.js';
import { Logger } from './log.js';

export interface ComposeArgs {
  props: Prop[];
  compose: ComposeMode;
  ctx: PropContext;
  targetUrl?: string;
  stage?: StageOptions;
  log: Logger;
}

export interface Composition {
  /** In stage mode, the frame the app runs in; null in overlay mode. */
  appFrame: Frame | null;
}

export async function composeScene(page: Page, args: ComposeArgs): Promise<Composition> {
  if (args.compose === 'stage') return composeStage(page, args);
  await composeOverlay(page, args);
  return { appFrame: null };
}

async function injectProp(page: Page, prop: Prop, ctx: PropContext): Promise<void> {
  const css = prop.css(ctx);
  const html = prop.html(ctx);
  await page.evaluate(
    (id: string, cssText: string, htmlText: string) => {
      if (cssText) {
        const st = document.createElement('style');
        st.setAttribute('data-gifsmith', id);
        st.textContent = cssText;
        document.head.appendChild(st);
      }
      const el = document.createElement('div');
      el.id = '__gifsmith_' + id;
      el.innerHTML = htmlText || '';
      document.documentElement.appendChild(el);
    },
    prop.id,
    css,
    html,
  );
  if (prop.runtime) await page.evaluate(prop.runtime);
}

async function composeOverlay(page: Page, args: ComposeArgs): Promise<void> {
  await installRuntime(page);
  const ordered = [
    ...args.props.filter((p) => p.layer === 'back'),
    ...args.props.filter((p) => p.layer === 'front'),
  ];
  for (const prop of ordered) {
    await injectProp(page, prop, args.ctx);
    args.log.debug(`prop injected: ${prop.id} (${prop.layer})`);
  }
  if (args.props.length) args.log.step('scene', `${args.props.length} props`);
}

async function composeStage(page: Page, args: ComposeArgs): Promise<Composition> {
  const url = args.targetUrl;
  if (!url) throw new Error("gifsmith: stage mode needs target.url");
  if (url.startsWith('file:')) {
    throw new Error(
      "gifsmith: compose:'stage' can't frame a file:// app (a non-file page may " +
        'not embed it). Serve the app over http(s) — a dev server — or use ' +
        "compose:'overlay'.",
    );
  }
  const html = buildStageHtml(url, args.ctx.viewport, args.stage ?? {});
  await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
  await installRuntime(page);

  // Front-layer props only (the stage owns the wallpaper backdrop).
  for (const prop of args.props.filter((p) => p.layer === 'front' && p.id !== 'wallpaper')) {
    await injectProp(page, prop, args.ctx);
  }

  const handle = await page.$('#__gifsmith_appframe');
  const appFrame = handle ? await handle.contentFrame() : null;
  if (!appFrame) throw new Error('gifsmith: stage iframe did not attach');
  await appFrame.waitForSelector('body', { timeout: 15_000 }).catch(() => {});
  args.log.step('scene', `stage (app framed) + ${args.props.length} props`);
  return { appFrame };
}

function buildStageHtml(url: string, viewport: { width: number; height: number }, stage: StageOptions): string {
  const pad = stage.padding ?? 44;
  const os = stage.os ?? 'mac';
  const hue = ((stage.hue ?? 222) % 360 + 360) % 360;
  const h2 = (hue + 28) % 360;
  const titleH = 40;
  const winW = Math.max(320, viewport.width - 2 * pad);
  const winH = Math.max(240, viewport.height - 2 * pad);
  const frameH = winH - titleH;

  const controls =
    os === 'mac'
      ? `<span class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></span>`
      : `<span class="wc">&#9472; &#9723; &#10005;</span>`;
  const titleAlign = os === 'mac' ? 'center' : 'flex-start';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden}
    body{background:
      radial-gradient(60% 55% at 22% 18%, hsla(${(hue + 330) % 360},70%,62%,.55), transparent 60%),
      radial-gradient(55% 50% at 82% 28%, hsla(${(hue + 46) % 360},72%,58%,.45), transparent 62%),
      radial-gradient(75% 60% at 65% 92%, hsla(${h2},60%,40%,.55), transparent 60%),
      linear-gradient(160deg, hsl(${hue},55%,40%), hsl(${h2},60%,16%));
      font-family:'Segoe UI',system-ui,sans-serif}
    .win{position:absolute;left:${pad}px;top:${pad}px;width:${winW}px;height:${winH}px;
      border-radius:12px;overflow:hidden;background:#111;
      box-shadow:0 40px 100px rgba(0,0,0,.55),0 2px 0 rgba(255,255,255,.06) inset;
      border:1px solid rgba(255,255,255,.14)}
    .tb{display:flex;align-items:center;justify-content:${titleAlign};position:relative;
      height:${titleH}px;padding:0 14px;background:#2a2d33;color:#dfe3ea;font-size:13px}
    .tb .dots{position:absolute;left:14px;display:flex;gap:8px}
    .tb .dots i{width:12px;height:12px;border-radius:50%;display:block}
    .tb .wc{position:absolute;right:14px;opacity:.7;letter-spacing:6px}
    .tb .title{opacity:.85}
    iframe{width:${winW}px;height:${frameH}px;border:0;display:block;background:#fff}
  </style></head><body>
    <div class="win">
      <div class="tb">${controls}<span class="title">${escapeHtml(stage.title ?? '')}</span></div>
      <iframe id="__gifsmith_appframe" src="${escapeAttr(url)}" referrerpolicy="no-referrer"></iframe>
    </div>
  </body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}
