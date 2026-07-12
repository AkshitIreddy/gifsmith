/**
 * gifsmith — a movie-set framework for browser/app demo GIFs.
 *
 * Script a walkthrough of any web (or webview-desktop) UI as a declarative
 * timeline, and get a tiny, smooth, seamless *forward*-looping README GIF/WebP.
 * Like vhs, but for GUI apps.
 *
 *   import { render, timeline, web } from 'gifsmith';
 *   import { cursor } from 'gifsmith/props';
 *
 *   const tl = timeline((t) => {
 *     t.waitFor('.app');
 *     t.hold(1.5);
 *     t.loopAnchor();
 *     t.click('.play');
 *     t.hold(2);
 *   });
 *
 *   await render({ target: web('http://localhost:5173'), out: 'demo.gif',
 *                  props: [cursor()], timeline: tl, alsoEmit: ['webp'] });
 */

// Core
export { render } from './director.js';
export { timeline, TimelineBuilder, estimateSeconds } from './timeline/timeline.js';

// Adapters
export { web, tauri, electron, TAURI_LAUNCH_HELP, ELECTRON_LAUNCH_HELP } from './adapters/index.js';
export type { AttachOptions } from './adapters/index.js';

// AI-author ergonomics
export { probe } from './ergonomics/probe.js';
export { snapshot, contactSheet } from './ergonomics/snapshot.js';
export type { ContactSheet } from './ergonomics/snapshot.js';
export { dryRun } from './ergonomics/dryRun.js';
export { expectVisible, expectStable, expectInFrame } from './ergonomics/assert.js';

// Bridge (for apps that opt into cooperation)
export { RUNTIME_JS } from './bridge.js';

// Types
export type {
  RenderConfig,
  RenderResult,
  BrowserTarget,
  Viewport,
  CameraClip,
  ComposeMode,
  Prop,
  PropContext,
  CompiledTimeline,
  Step,
  Easing,
  Point,
  Size,
  LoopStrategy,
  OutputFormat,
  EncodeOptions,
  ProbeResult,
  ProbeElement,
  DryRunReport,
} from './types.js';

/** Re-export the prop library namespace for convenience (`import * as props`). */
export * as props from './props/index.js';
