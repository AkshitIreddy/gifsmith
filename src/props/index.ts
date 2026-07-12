/**
 * The gifsmith prop library — composable set-pieces for the movie set. Import
 * from `gifsmith/props`. Props are applied back-to-front; `desktop()` bundles a
 * wallpaper + taskbar for the classic mock-desktop look.
 */
import type { Prop } from '../types.js';
import { wallpaper, type WallpaperOptions } from './wallpaper.js';
import { taskbar, type TaskbarOptions } from './taskbar.js';

export { cursor, type CursorOptions } from './cursor.js';
export { wallpaper, type WallpaperOptions } from './wallpaper.js';
export { taskbar, type TaskbarOptions } from './taskbar.js';
export { mockWindow, type MockWindowOptions } from './mockWindow.js';
export { bezel, type BezelOptions } from './bezel.js';

export interface DesktopOptions {
  os?: 'windows' | 'mac';
  wallpaper?: WallpaperOptions;
  taskbar?: TaskbarOptions;
}

/** Convenience: a wallpaper + a taskbar/dock, the classic mock-desktop base. */
export function desktop(opts: DesktopOptions = {}): Prop[] {
  return [
    wallpaper(opts.wallpaper ?? {}),
    taskbar({ os: opts.os ?? 'windows', ...(opts.taskbar ?? {}) }),
  ];
}
