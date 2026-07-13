/**
 * The gifsmith type spine — the "movie set" primitives and the render config.
 *
 * Mental model (see README): a Stage holds the app plus Props (mock OS chrome,
 * window frames, a synthetic cursor), a Camera frames a sub-region, and a
 * declarative Timeline choreographs the whole scene. The Director connects,
 * injects the scene, plays the timeline while a screencast records, then builds
 * a seamless, naturally-paced, size-budgeted loop.
 */

import type { LogLevel } from './log.js';

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A clip/zoom region in page (CSS) pixels. Origin is the top-left of the page. */
export interface CameraClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene / stage
// ─────────────────────────────────────────────────────────────────────────────

export type ComposeMode =
  /** Load the target at top level; inject props as overlays (robust, any app). */
  | 'overlay'
  /** Embed the target in an <iframe> inside a gifsmith stage (same-origin only). */
  | 'stage';

export interface Viewport {
  width: number;
  height: number;
  /** Device scale factor (DPR). 2 renders retina-crisp then downscales. */
  deviceScaleFactor?: number;
}

/**
 * A Prop is a reusable set-piece injected into the page: mock desktop, a window
 * frame, a taskbar, a synthetic cursor, decorative windows. It renders as DOM
 * so it composes with the real, live app in the same paint.
 */
export interface Prop {
  /** Stable id, also used as the DOM element id (`__gifsmith_<id>`). */
  id: string;
  /** z-index band: `back` sits behind the app, `front` on top of it. */
  layer: 'back' | 'front';
  /** Returns the CSS injected once for this prop. */
  css(ctx: PropContext): string;
  /** Returns the HTML for this prop's root element's innerHTML. */
  html(ctx: PropContext): string;
  /**
   * Optional in-page runtime installed on `window.__gifsmith.props[id]`,
   * serialized and eval'd in the page. Use for props that animate (cursor).
   */
  runtime?: string;
}

export interface PropContext {
  viewport: Viewport;
  camera: CameraClip | null;
  compose: ComposeMode;
}

/** Options for `compose: 'stage'` — the app embedded as a window on a desktop. */
export interface StageOptions {
  /** Window titlebar text. */
  title?: string;
  /** Wallpaper base hue 0–360 (default 222). */
  hue?: number;
  /** Desktop margin around the window in px (how much wallpaper shows). */
  padding?: number;
  /** Extra space reserved below the window, so a taskbar()/dock prop never
   * overlaps it and some desktop stays visible in between. Defaults to 72
   * (windows) / 84 (mac) — set 0 to restore the old edge-to-edge layout. */
  bottomInset?: number;
  /** Window chrome style. */
  os?: 'windows' | 'mac';
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────────────────

export type Easing =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut';

/**
 * A single choreographed step, resolved to a concrete action at play time.
 * Steps are authored through the TimelineBuilder (see timeline/timeline.ts);
 * this is the compiled, serializable form the Director executes.
 */
export type Step =
  | { kind: 'hold'; ms: number }
  | { kind: 'waitFor'; selector?: string; predicate?: string; timeoutMs: number }
  | { kind: 'click'; selector: string; via: 'cursor' | 'direct'; glideMs?: number }
  | { kind: 'drag'; selector: string; dx: number; dy: number; durationMs: number }
  | { kind: 'type'; selector: string; text: string; delayMs: number }
  | { kind: 'scroll'; selector: string; dy: number; durationMs: number; easing: Easing }
  | { kind: 'cursorTo'; selector?: string; point?: Point; durationMs: number; easing: Easing }
  | { kind: 'actorMove'; actorId: string; point: Point; durationMs: number; easing: Easing }
  | { kind: 'propSet'; propId: string; patch: Record<string, unknown> }
  | { kind: 'bridgeSet'; key: string; value: unknown }
  | { kind: 'bridgeTrigger'; action: string; args: unknown[] }
  | { kind: 'pace'; multiplier: number }
  | { kind: 'call'; label: string }              // an author-supplied page fn (resolved by index)
  | { kind: 'cue'; name: string }
  | { kind: 'loopAnchor' }
  | { kind: 'parallel'; branches: Step[][] }
  | { kind: 'sequence'; steps: Step[] };

/** The compiled timeline plus the out-of-band page callbacks referenced by `call`. */
export interface CompiledTimeline {
  steps: Step[];
  /** `call` steps reference these by label. */
  calls: Record<string, PageCallback>;
  /** Names collected from `cue` steps, for introspection. */
  cues: string[];
  hasLoopAnchor: boolean;
}

/** A raw page callback: receives the Puppeteer Page, may await interactions. */
export type PageCallback = (page: unknown) => Promise<void> | void;

// ─────────────────────────────────────────────────────────────────────────────
// Loop / pacing / encode
// ─────────────────────────────────────────────────────────────────────────────

export type LoopStrategy =
  /** Trim to the best hold-to-hold seam near a declared loopAnchor (artifact-free). */
  | 'anchor'
  /** Half-period self-crossfade — a forward loop from any ambient clip. */
  | 'crossfade'
  /** No looping (straight clip). */
  | 'none'
  /** Pick `anchor` if the timeline declares a loopAnchor, else `crossfade`. */
  | 'auto';

export type OutputFormat = 'gif' | 'webp';

export interface EncodeOptions {
  /** Output width in px; height auto (keeps aspect). */
  width: number;
  /** Output frame rate after resampling to a uniform clock. */
  fps: number;
  /** Playback speed multiplier applied to the natural pacing (>1 = faster). */
  speed: number;
  /** GIF palette size (fewer colors = smaller file). */
  colors: number;
  /** WebP quality 0–100. */
  quality: number;
  /** Soft target size in MB; gifsmith warns (and can auto-tune) if exceeded. */
  targetMB?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser connection
// ─────────────────────────────────────────────────────────────────────────────

export interface BrowserTarget {
  /** Launch a fresh headless Chromium (auto-detected) at this URL. */
  url?: string;
  /** OR attach to an already-running CDP endpoint (Tauri/Electron/manual). */
  browserURL?: string;
  browserWSEndpoint?: string;
  /** Explicit Chrome/Edge/Brave binary; else auto-detected or PUPPETEER_EXECUTABLE_PATH. */
  executablePath?: string;
  /** Extra launch args. */
  args?: string[];
  /** Run with a visible window (default headless). */
  headful?: boolean;
  /**
   * Chromium's OS-level sandbox. Default true. Set false ONLY inside a
   * container / CI / when running as root, where the sandbox can't initialize
   * (adds --no-sandbox --disable-setuid-sandbox). The env var GIFSMITH_NO_SANDBOX=1
   * does the same without touching code. gifsmith always renders in a throwaway,
   * isolated browser profile regardless — this flag is unrelated to that
   * isolation; it only concerns Chromium's own process sandbox.
   */
  chromiumSandbox?: boolean;
  /**
   * In headful mode, park the window far off-screen so the capture never
   * flashes on your desktop. Default true. Ignored when headless.
   */
  offscreen?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level render config
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderConfig {
  /** What to record. */
  target: BrowserTarget;
  /** Output file path (extension picks the default format if `format` unset). */
  out: string;
  format?: OutputFormat;
  /** Also emit the sibling format alongside `out` (e.g. gif + webp). */
  alsoEmit?: OutputFormat[];

  viewport?: Viewport;
  camera?: CameraClip | null;
  compose?: ComposeMode;
  /** Options for `compose: 'stage'` (app-in-a-window on a mock desktop). */
  stage?: StageOptions;

  /** Props to inject (from `gifsmith/props`), applied back-to-front. */
  props?: Prop[];

  /** The choreography. */
  timeline: CompiledTimeline;

  loop?: LoopStrategy;
  encode?: Partial<EncodeOptions>;

  /** Cooperation with the app's own engine (window.__demo handshake). */
  bridge?: {
    /** Slow the app's own streaming/animation while recording (pace multiplier). */
    pace?: number;
    /** Wait until `window.__demo` is present before starting (opt-in apps). */
    require?: boolean;
    requireTimeoutMs?: number;
  };

  logLevel?: LogLevel;
  /** Keep the intermediate frame dir for debugging. */
  keepFrames?: boolean;
  /** Working dir for frames/palettes (default: OS temp). */
  workDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured results (the "AI-author" contract — every helper returns data)
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderResult {
  outputs: { format: OutputFormat; path: string; bytes: number }[];
  /** Source frames captured from the screencast. */
  sourceFrames: number;
  /** Frames after resampling to the uniform clock. */
  pacedFrames: number;
  /** Frames in the final loop. */
  loopFrames: number;
  achievedCaptureFps: number;
  loop: {
    strategy: LoopStrategy;
    /** Loop-seam quality: MSE between the wrap frames (lower = smoother). null if n/a. */
    seamMSE: number | null;
    anchorFrame?: number;
    endFrame?: number;
  };
  durationSeconds: number;
  warnings: string[];
}

export interface ProbeElement {
  selector: string;
  tag: string;
  text: string;
  rect: CameraClip;
  visible: boolean;
  clickable: boolean;
}

export interface ProbeResult {
  url: string;
  title: string;
  viewport: Viewport;
  /** Interactive elements (buttons, links, inputs) with bounding boxes. */
  elements: ProbeElement[];
  /** Props currently on stage. */
  props: string[];
  /** Whether the app exposes a window.__demo cooperation bridge. */
  hasBridge: boolean;
}

export interface DryRunReport {
  ok: boolean;
  totalPlannedSeconds: number;
  cues: string[];
  hasLoopAnchor: boolean;
  warnings: string[];
  errors: string[];
}
