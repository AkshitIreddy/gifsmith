/**
 * A mock OS taskbar/dock strip along the bottom — set-dressing for desktop-app
 * demos. Front layer, non-interactive. Windows-style (centered icons + tray
 * clock) or macOS-style (centered rounded dock).
 */
import type { Prop } from '../types.js';

export interface TaskbarOptions {
  os?: 'windows' | 'mac';
  height?: number;
  clock?: string;
}

const ICON = (bg: string) =>
  `<div style="width:34px;height:34px;border-radius:9px;background:${bg};` +
  `box-shadow:0 2px 6px rgba(0,0,0,.3)"></div>`;

export function taskbar(opts: TaskbarOptions = {}): Prop {
  const os = opts.os ?? 'windows';
  const h = opts.height ?? (os === 'mac' ? 64 : 56);
  const clock = opts.clock ?? '10:24';

  const css =
    `#__gifsmith_taskbar{position:fixed;left:0;right:0;bottom:0;height:${h}px;` +
    `z-index:2147483641;pointer-events:none;display:flex;align-items:center;` +
    `font-family:'Segoe UI',system-ui,sans-serif;color:#eaeaea;` +
    (os === 'mac'
      ? `justify-content:center;background:transparent}` +
        `#__gifsmith_taskbar .dock{display:flex;gap:12px;padding:8px 16px;border-radius:20px;` +
        `background:rgba(40,40,48,.55);backdrop-filter:blur(24px) saturate(1.3);` +
        `border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.4)}`
      : `background:rgba(24,24,30,.72);backdrop-filter:blur(24px) saturate(1.3);` +
        `border-top:1px solid rgba(255,255,255,.07)}` +
        `#__gifsmith_taskbar .mid{position:absolute;left:50%;transform:translateX(-50%);` +
        `display:flex;gap:12px}` +
        `#__gifsmith_taskbar .tray{position:absolute;right:16px;font-size:12.5px;text-align:right;line-height:1.2}`);

  const icons = [ICON('#38bdf8'), ICON('#f6c453'), ICON('#1f6fb2'), ICON('#5eead4'), ICON('#7c5cff')].join('');
  const html =
    os === 'mac'
      ? `<div class="dock">${icons}</div>`
      : `<div class="mid">${icons}</div><div class="tray"><div>${clock}</div><div>7/13/2026</div></div>`;

  return { id: 'taskbar', layer: 'front', css: () => css, html: () => html };
}
