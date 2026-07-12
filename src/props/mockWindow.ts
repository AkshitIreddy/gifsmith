/**
 * A decorative mock application window (browser / code editor / terminal) —
 * set-dressing for the movie set, à la Project A's injected VS Code + browser.
 * Positioned absolutely; front layer by default so it composites over the app
 * (use in stage mode, or over a transparent app, for the desktop look).
 */
import type { Prop } from '../types.js';

export interface MockWindowOptions {
  kind: 'browser' | 'code' | 'terminal';
  title?: string;
  /** Position + size in page px. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Body content (HTML). Sensible defaults per kind if omitted. */
  body?: string;
  layer?: 'back' | 'front';
}

const DOTS =
  `<span style="display:flex;gap:8px">` +
  `<span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span>` +
  `<span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span>` +
  `<span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span></span>`;

function defaultBody(kind: MockWindowOptions['kind']): string {
  if (kind === 'terminal') {
    return (
      `<div style="font-family:'Cascadia Code',Consolas,monospace;font-size:13px;color:#d6f5e3;padding:14px 16px;line-height:1.7">` +
      `<div><span style="color:#5eead4">~/app</span> $ npm run build</div>` +
      `<div style="color:#9aa">✓ compiled in 1.2s</div>` +
      `<div><span style="color:#5eead4">~/app</span> $ ▍</div></div>`
    );
  }
  if (kind === 'code') {
    return (
      `<div style="display:flex;height:calc(100% - 40px)">` +
      `<div style="width:150px;background:#252526;padding:12px 8px;font-size:12.5px;color:#bdbdbd">` +
      `<b style="display:block;color:#8a8a8a;font-size:11px;letter-spacing:.6px;margin:2px 6px 8px">EXPLORER</b>` +
      `<span style="display:block;padding:4px 8px;border-radius:5px;background:#37373d;color:#fff">index.ts</span>` +
      `<span style="display:block;padding:4px 8px">timeline.ts</span></div>` +
      `<div style="flex:1;padding:12px 16px;font-family:'Cascadia Code',Consolas,monospace;font-size:13px;line-height:1.6;color:#d4d4d4">` +
      `<div><span style="color:#6a9955">// gifsmith timeline</span></div>` +
      `<div><span style="color:#569cd6">await</span> tl.<span style="color:#dcdcaa">click</span>(<span style="color:#ce9178">'.play'</span>)</div>` +
      `<div>tl.<span style="color:#dcdcaa">loopAnchor</span>()</div></div></div>`
    );
  }
  return (
    `<div style="padding:22px 26px;font-family:Georgia,serif;color:#202122">` +
    `<h1 style="font-size:24px;border-bottom:1px solid #a2a9b1;padding-bottom:6px;margin:0 0 8px;font-weight:400">Overview</h1>` +
    `<p style="font-size:13.5px;line-height:1.6;max-width:80%">A framed, decorative page used as set-dressing behind the real app.</p></div>`
  );
}

export function mockWindow(opts: MockWindowOptions): Prop {
  const id = `window_${opts.kind}_${Math.round(opts.x)}_${Math.round(opts.y)}`;
  const dark = opts.kind !== 'browser';
  const titlebar =
    opts.kind === 'browser'
      ? `<div class="tb" style="background:#dfe3ea;color:#333">${DOTS}` +
        `<span style="flex:1;background:#fff;border-radius:16px;height:26px;display:flex;align-items:center;padding:0 12px;` +
        `font-size:12.5px;color:#555;border:1px solid #cfd4dc;margin-left:12px">🔒 ${opts.title ?? 'example.com'}</span></div>`
      : `<div class="tb" style="background:${opts.kind === 'terminal' ? '#1b1b22' : '#323233'};color:#e8e8e8">${DOTS}` +
        `<span style="opacity:.85;font-size:13px;margin-left:12px">${opts.title ?? (opts.kind === 'code' ? 'index.ts' : 'zsh')}</span></div>`;

  const css =
    `#__gifsmith_${id}{position:fixed;left:${opts.x}px;top:${opts.y}px;width:${opts.width}px;height:${opts.height}px;` +
    `border-radius:11px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.55),0 2px 0 rgba(255,255,255,.05) inset;` +
    `border:1px solid rgba(255,255,255,.12);background:${dark ? '#1e1e1e' : '#fff'};` +
    `font-family:system-ui,sans-serif}` +
    `#__gifsmith_${id} .tb{display:flex;align-items:center;height:40px;padding:0 14px}`;

  const html = `${titlebar}<div style="height:calc(100% - 40px);overflow:hidden">${opts.body ?? defaultBody(opts.kind)}</div>`;

  return { id, layer: opts.layer ?? 'front', css: () => css, html: () => html };
}
