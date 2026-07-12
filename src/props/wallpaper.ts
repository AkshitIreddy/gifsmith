/**
 * Procedural desktop wallpaper (a diagonal gradient with soft glowing blobs) —
 * a CSS port of Project A's wallpaper.py, so there's no raster asset to ship.
 * It sits at z-index:-1 as a true backdrop, so it shows for transparent/overlay
 * apps and in stage mode (behind the app's window). Behind an opaque app body
 * it is, correctly, not visible.
 */
import type { Prop } from '../types.js';

export interface WallpaperOptions {
  /** Base hue 0–360 (default 222, a calm blue). */
  hue?: number;
}

export function wallpaper(opts: WallpaperOptions = {}): Prop {
  const h = ((opts.hue ?? 222) % 360 + 360) % 360;
  const h2 = (h + 28) % 360;
  const css =
    `#__gifsmith_wallpaper{position:fixed;inset:0;z-index:-1;` +
    `background:` +
    `radial-gradient(60% 55% at 22% 18%, hsla(${(h + 330) % 360},70%,62%,.55), transparent 60%),` +
    `radial-gradient(55% 50% at 82% 28%, hsla(${(h + 46) % 360},72%,58%,.45), transparent 62%),` +
    `radial-gradient(75% 60% at 65% 92%, hsla(${h2},60%,40%,.55), transparent 60%),` +
    `linear-gradient(160deg, hsl(${h},55%,40%), hsl(${h2},60%,16%));}`;
  return { id: 'wallpaper', layer: 'back', css: () => css, html: () => '' };
}
