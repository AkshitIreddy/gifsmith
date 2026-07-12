/**
 * A non-invasive edge frame: a soft inner shadow (and optional 1px inset
 * hairline) drawn over the whole capture. Gives any app a subtle "framed"
 * README look without reparenting or covering content. For a true rounded
 * browser-mockup with a wallpaper behind, use stage mode instead.
 */
import type { Prop } from '../types.js';

export interface BezelOptions {
  /** Inner shadow strength 0–1 (default 0.18). */
  vignette?: number;
  hairline?: boolean;
}

export function bezel(opts: BezelOptions = {}): Prop {
  const v = opts.vignette ?? 0.18;
  const hair = opts.hairline ?? true;
  const css =
    `#__gifsmith_bezel{position:fixed;inset:0;z-index:2147483639;pointer-events:none;` +
    `box-shadow:inset 0 0 60px rgba(0,0,0,${v})` +
    (hair ? `,inset 0 0 0 1px rgba(255,255,255,.06)` : '') +
    `}`;
  return { id: 'bezel', layer: 'front', css: () => css, html: () => '' };
}
