/**
 * Synthetic cursor prop. The visible cursor is created by the in-page runtime
 * (bridge.ts → installCursor); this prop just wires it up and sets a start
 * position. Timeline `cursorTo`/`click(via:'cursor')` steps drive it.
 */
import type { Prop, Point } from '../types.js';

export interface CursorOptions {
  /** Where the cursor rests before the first move (page/viewport px). */
  start?: Point;
}

export function cursor(opts: CursorOptions = {}): Prop {
  return {
    id: 'cursor',
    layer: 'front',
    css: () => '',
    html: () => '',
    runtime: `window.__gifsmith.installCursor(${JSON.stringify(opts)});`,
  };
}
