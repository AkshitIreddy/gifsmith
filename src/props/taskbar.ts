/**
 * A mock OS taskbar/dock strip along the bottom — set-dressing for desktop-app
 * demos. Front layer, non-interactive. Windows-style (centered app icons +
 * a real-looking system tray: chevron, wifi, volume, battery, clock) or
 * macOS-style (centered rounded dock with the same icon set).
 *
 * Icons are original inline-SVG glyphs *suggestive of* a populated desktop
 * (folder, globe browser, code editor, terminal, mail) — not any vendor's
 * artwork.
 */
import type { Prop } from '../types.js';

export interface TaskbarOptions {
  os?: 'windows' | 'mac';
  height?: number;
  clock?: string;
  /** Date line under the clock (windows only). */
  date?: string;
}

// ─── app icon glyphs ─────────────────────────────────────────────────────────

const I_START =
  `<svg viewBox="0 0 24 24" width="24" height="24"><g fill="#4cc2ff">` +
  `<rect x="3" y="3" width="8.6" height="8.6" rx="1.6"/><rect x="12.4" y="3" width="8.6" height="8.6" rx="1.6"/>` +
  `<rect x="3" y="12.4" width="8.6" height="8.6" rx="1.6"/><rect x="12.4" y="12.4" width="8.6" height="8.6" rx="1.6"/></g></svg>`;

const I_SEARCH =
  `<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="#e9ecf2" stroke-width="2.1" stroke-linecap="round">` +
  `<circle cx="10.5" cy="10.5" r="6.2"/><path d="M15.3 15.3 20 20"/></svg>`;

const I_FOLDER =
  `<svg viewBox="0 0 24 24" width="24" height="24">` +
  `<path d="M3 6.5c0-1.1.9-2 2-2h4.2l2 2.4H19c1.1 0 2 .9 2 2V17c0 1.3-.9 2.3-2 2.3H5c-1.1 0-2-1-2-2.3z" fill="#eab54e"/>` +
  `<path d="M3 9.2h18V17c0 1.3-.9 2.3-2 2.3H5c-1.1 0-2-1-2-2.3z" fill="#fcd97a"/></svg>`;

const I_BROWSER =
  `<svg viewBox="0 0 24 24" width="24" height="24">` +
  `<defs><linearGradient id="gsmb" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="#59c2ff"/><stop offset="1" stop-color="#1565c0"/></linearGradient></defs>` +
  `<circle cx="12" cy="12" r="9.5" fill="url(#gsmb)"/>` +
  `<ellipse cx="12" cy="12" rx="4.4" ry="9.5" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.2"/>` +
  `<path d="M2.8 12h18.4M4.4 7.2h15.2M4.4 16.8h15.2" stroke="rgba(255,255,255,.5)" stroke-width="1.2" fill="none"/></svg>`;

const I_CODE =
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#42a5f5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M8.5 6 3.5 12l5 6"/><path d="M15.5 6l5 6-5 6"/></svg>`;

const I_TERMINAL =
  `<svg viewBox="0 0 24 24" width="24" height="24">` +
  `<rect x="2.5" y="3.5" width="19" height="17" rx="2.6" fill="#1b1e26" stroke="rgba(255,255,255,.28)" stroke-width="1"/>` +
  `<path d="M6.5 8.5 10 12l-3.5 3.5" fill="none" stroke="#7ee787" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="M12 15.5h5" stroke="#e9ecf2" stroke-width="1.9" stroke-linecap="round"/></svg>`;

const I_MAIL =
  `<svg viewBox="0 0 24 24" width="24" height="24">` +
  `<rect x="2.5" y="5" width="19" height="14" rx="2.4" fill="#e9eef7"/>` +
  `<path d="M3.5 6.5 12 13l8.5-6.5" fill="none" stroke="#5b7bd5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ─── system-tray glyphs ──────────────────────────────────────────────────────

const T_CHEVRON =
  `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#e9ecf2" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14.5 12 9l6 5.5"/></svg>`;

const T_WIFI =
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#e9ecf2" stroke-width="1.9" stroke-linecap="round">` +
  `<path d="M3.5 9.5a13 13 0 0 1 17 0"/><path d="M6.7 12.9a8.4 8.4 0 0 1 10.6 0"/>` +
  `<path d="M9.9 16.2a3.9 3.9 0 0 1 4.2 0"/><circle cx="12" cy="19" r="1.3" fill="#e9ecf2" stroke="none"/></svg>`;

const T_SPEAKER =
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="#e9ecf2">` +
  `<path d="M4 9.5h3.5L13 5v14l-5.5-4.5H4z"/>` +
  `<path d="M15.5 9a4.5 4.5 0 0 1 0 6" fill="none" stroke="#e9ecf2" stroke-width="1.8" stroke-linecap="round"/></svg>`;

const T_BATTERY =
  `<svg viewBox="0 0 24 24" width="17" height="17">` +
  `<rect x="2.5" y="8" width="16.5" height="8.5" rx="2" fill="none" stroke="#e9ecf2" stroke-width="1.6"/>` +
  `<rect x="4.3" y="9.8" width="10.5" height="4.9" rx="1" fill="#e9ecf2"/>` +
  `<rect x="20" y="10.4" width="2" height="3.6" rx=".8" fill="#e9ecf2"/></svg>`;

const APP_ICONS = [I_FOLDER, I_BROWSER, I_CODE, I_TERMINAL, I_MAIL];

export function taskbar(opts: TaskbarOptions = {}): Prop {
  const os = opts.os ?? 'windows';
  const h = opts.height ?? (os === 'mac' ? 64 : 56);
  const clock = opts.clock ?? '10:24';
  const date = opts.date ?? '7/13/2026';

  const css =
    `#__gifsmith_taskbar{position:fixed;left:0;right:0;bottom:0;height:${h}px;` +
    `z-index:2147483641;pointer-events:none;display:flex;align-items:center;` +
    `font-family:'Segoe UI',system-ui,sans-serif;color:#eaeaea;` +
    (os === 'mac'
      ? `justify-content:center;background:transparent}` +
        `#__gifsmith_taskbar .dock{display:flex;gap:14px;align-items:center;padding:9px 18px;border-radius:20px;` +
        `background:rgba(40,40,48,.55);backdrop-filter:blur(24px) saturate(1.3);` +
        `border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.4)}` +
        `#__gifsmith_taskbar .dock svg{display:block;transform:scale(1.18)}`
      : `background:rgba(24,24,30,.72);backdrop-filter:blur(24px) saturate(1.3);` +
        `border-top:1px solid rgba(255,255,255,.07)}` +
        `#__gifsmith_taskbar .mid{position:absolute;left:50%;transform:translateX(-50%);` +
        `display:flex;gap:6px;align-items:center}` +
        `#__gifsmith_taskbar .mid .slot{width:38px;height:38px;display:flex;align-items:center;` +
        `justify-content:center;border-radius:7px}` +
        `#__gifsmith_taskbar .tray{position:absolute;right:12px;display:flex;align-items:center;gap:12px}` +
        `#__gifsmith_taskbar .tray .glyphs{display:flex;align-items:center;gap:9px;opacity:.92}` +
        `#__gifsmith_taskbar .tray .glyphs svg{display:block}` +
        `#__gifsmith_taskbar .tray .clock{font-size:12.5px;text-align:right;line-height:1.25}`);

  const winIcons = [I_START, I_SEARCH, ...APP_ICONS]
    .map((svg) => `<span class="slot">${svg}</span>`)
    .join('');

  const html =
    os === 'mac'
      ? `<div class="dock">${APP_ICONS.join('')}</div>`
      : `<div class="mid">${winIcons}</div>` +
        `<div class="tray"><span class="glyphs">${T_CHEVRON}${T_WIFI}${T_SPEAKER}${T_BATTERY}</span>` +
        `<span class="clock"><div>${clock}</div><div>${date}</div></span></div>`;

  return { id: 'taskbar', layer: 'front', css: () => css, html: () => html };
}
