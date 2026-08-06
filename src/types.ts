/**
 * The gifsmith type spine — the "movie set" primitives and the render config.
 *
 * Mental model (see README): a Stage holds the app plus Props (mock OS chrome,
 * window frames, a synthetic cursor), a Camera frames a sub-region, and a
 * declarative Timeline choreographs the whole scene. The Director connects,
 * injects the scene, plays the timeline while a screencast records, then builds
 * a seamless, naturally-paced, size-budgeted loop.
 */

import type { Page } from 'puppeteer-core';
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
  // An author-supplied page fn (resolved by label). `seconds` is the author's
  // declaration of how much scene time it spends — see TimelineBuilder.call.
  | { kind: 'call'; label: string; name?: string; seconds?: number }
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

/**
 * The scene clock, as an author callback sees it.
 *
 * `t.call()` used to hand over the raw Page and nothing else, which was fine
 * while there was only one clock. Under `capture: 'deterministic'` it is a trap:
 * scene time is paused *inside* the callback, so a `setTimeout` in there buys
 * zero rendered frames and an awaited page promise that needs a paint can never
 * resolve at all. The second argument is the way out — the same two verbs the
 * player itself uses for every beat that takes time or waits on the page.
 *
 * On the default screencast path these are exactly `setTimeout` and `await`,
 * because that is what they have always been.
 */
export interface CallContext {
  /**
   * Which clock this render is on. Branch on it only when the two genuinely
   * need different choreography — `advance`/`settle` already do the right thing
   * on both.
   */
  readonly clock: 'real' | 'virtual';
  /** Scene ms per captured frame, or 0 under the real clock (no quantum). */
  readonly frameMs: number;
  /**
   * Spend `ms` of *scene* time — the callback's version of `t.hold()`.
   *
   * Real clock: `setTimeout(ms)`. Virtual clock: exactly `ms / frameMs` rendered
   * frames, whatever the machine was doing at the time. This is the replacement
   * for `await new Promise(r => setTimeout(r, ms))`, which under a virtual clock
   * burns real time and renders nothing.
   */
  advance(ms: number): Promise<void>;
  /** Scene ms since capture started (the same clock cues are stamped on). */
  nowMs(): number;
  /**
   * Await something that can only finish while the page keeps painting: an
   * `await`ed async `page.evaluate`, `waitForSelector`, an in-page animation.
   *
   * Real clock: a plain `await`, cap ignored. Virtual clock: the promise is
   * started, then scene time is walked forward one frame at a time underneath it
   * until it settles — and if `capMs` of scene time runs out first this THROWS,
   * naming the step. A render that fails tells you where it stopped; one that
   * hangs tells you nothing.
   */
  settle<T>(p: Promise<T>, opts?: { capMs?: number; label?: string }): Promise<T>;
}

/**
 * A raw page callback: receives the Puppeteer Page and the scene clock, and may
 * await interactions. The one-argument form is still the whole API for a demo
 * that never waits — every callback written before `ctx` existed keeps working
 * unchanged, because an ignored second argument is just an ignored argument.
 *
 * `page` is the real `Page`, not `unknown`. It was `unknown` to keep this file
 * free of a puppeteer import, and every author paid for that: in a strict
 * project the README's own example — `t.call(async (page, ctx) => { await
 * ctx.settle(page.evaluate(…)); })` — did not compile, failing with `TS18046:
 * 'page' is of type 'unknown'`. That is a poor greeting from the flagship
 * feature of a release. The import costs nothing that was not already being
 * paid: puppeteer-core is a hard dependency, and the shipped `assert.d.ts` has
 * imported `Page` from it since 0.1.0.
 */
export type PageCallback = (page: Page, ctx: CallContext) => Promise<void> | void;

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

/**
 * The loop, with its knobs — `loop: 'anchor'` stays valid and means
 * `{ strategy: 'anchor' }`.
 *
 * `minCycleSeconds` existed and was threaded all the way to the search, but
 * nothing could set it: `RenderConfig.loop` was a bare string. It is the one
 * lever that matters for a long scripted demo, so it is reachable now.
 */
export interface LoopOptions {
  strategy: LoopStrategy;
  /**
   * The shortest loop the anchor search may return, in seconds. Default 3.
   *
   * Raise it when the scene holds still on its neutral pose: every pair of
   * frames inside that hold matches, so without a floor the search is free to
   * hand back a few motionless seconds and drop the rest of the walkthrough.
   */
  minCycleSeconds?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture backend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the frames are obtained — and, really, whose clock the demo runs on.
 *
 * `screencast` (default) records what actually happened: CDP `Page.startScreencast`
 * streams real paints while the timeline plays in real time, and every frame
 * keeps its real timestamp for natural pacing. It is honest about the app's own
 * animation, CSS included, and it is fast. It also inherits the machine: if the
 * app blocks its main thread for a second while opening a panel, that second is
 * in the GIF, and the same demo rendered on a busy laptop judders.
 *
 * `deterministic` renders instead of records. Chromium's virtual time
 * (`Emulation.setVirtualTimePolicy`) replaces the page's clock, the player
 * spends it one frame at a time, and each frame is an explicit screenshot. The
 * page's `performance.now()`, `Date.now()`, `setTimeout` and
 * `requestAnimationFrame` all follow it, so rAF-driven animation advances
 * exactly one frame per budget — while a main-thread stall costs real seconds
 * and ~zero virtual ones and therefore cannot reach the output. Render time
 * stops being playback time, the way it works in an offline renderer.
 *
 * The trade, stated plainly:
 *  - the render is slower (three CDP round trips per frame) — it is offline, so
 *    this is a fine price, but a 20s demo is a few minutes rather than 20s;
 *  - `compose: 'stage'` is not supported: virtual time is per-target, and a
 *    cross-origin app in an iframe is its own renderer with its own clock;
 *  - in attach mode you are freezing a real running app's clock, which has
 *    effects outside the capture (gifsmith warns);
 *  - anything the page does off its own JS clock is untested here. The
 *    screencast path is CSS-animation-safe by construction; this one relies on
 *    Chromium driving the document animation timeline from virtual time too.
 */
export type CaptureMode = 'screencast' | 'deterministic';

/**
 * The capture backend with its knobs — `capture: 'deterministic'` stays valid
 * and means `{ mode: 'deterministic' }`, matching how `loop` works.
 */
export interface CaptureOptions {
  mode: CaptureMode;
  /** JPEG quality of the captured frames, 0–100 (default 92). */
  quality?: number;
  /**
   * Frame image format — `'jpeg'` (default) or `'png'`.
   *
   * The frames are the first lossy stage in the pipeline, before the encoder
   * has quantised anything: JPEG at 92 is already ~44dB against what Chromium
   * composited. `'png'` removes that stage entirely, which under
   * `capture: 'deterministic'` makes the pipeline lossless end to end — that
   * backend has no resample step, so the quantiser sees exactly the pixels the
   * browser drew.
   *
   * The cost differs sharply by backend, which is why this is one option and
   * not a default:
   *  - deterministic: a slower render and a bigger frame dir. Nothing else. A
   *    slow capture cannot put judder in the output, because the output's clock
   *    is not this machine's.
   *  - screencast: PNG frames are several times larger and slower to encode, so
   *    the capture delivers fewer frames per second — and there a low capture
   *    rate IS steppy motion. Measure `achievedCaptureFps` before keeping it.
   */
  format?: 'jpeg' | 'png';
  /**
   * deterministic only. Real-time watchdog for one frame's virtual-time budget
   * (default 10000ms). Virtual time normally expires almost instantly; this
   * only fires when the page starves its task queue, or holds a fetch under
   * `waitForNetwork`. On expiry gifsmith logs, pauses the clock and takes the
   * frame anyway — a degraded render beats a silent hang.
   */
  frameTimeoutMs?: number;
  /**
   * deterministic only. Hold the frame's budget while network fetches are
   * pending, so a demo that waits on real data sees it arrive (CDP's
   * `pauseIfNetworkFetchesPending`). Off by default, because a dev server's HMR
   * channel or any long-poll is a pending fetch *forever* and the render would
   * never advance. With it off, responses still arrive in real time and simply
   * land a few frames later.
   */
  waitForNetwork?: boolean;
}

export type OutputFormat = 'gif' | 'webp';

/**
 * How the GIF's palette is derived. This is the single biggest lever on how
 * "mushy" a GIF of a pale, fine-lined UI looks, and the reason the noise a
 * reader notices moves around rather than sitting still.
 *
 * `diff`    (default) one palette for the whole clip, weighted toward the pixels
 *           that CHANGE between frames. Small files, and the right default:
 *           motion is where a wrong colour is most visible.
 * `full`    one palette for the whole clip, weighted by the whole picture. The
 *           quiet 90% of a UI demo — paper, rules, ink — gets its fair share of
 *           the 256 slots instead of being outvoted by the panel that slides.
 * `perFrame` a NEW palette every frame (`stats_mode=single` + `paletteuse=new=1`).
 *           Every frame gets its own best 256 colours, which is as good as GIF
 *           gets — and costs the most, because a fresh palette per frame is a
 *           fresh 256-entry table per frame plus a full-frame update. It also
 *           makes `diff_mode=rectangle` unsafe (pixels outside the changed
 *           rectangle would keep colours from a palette that no longer exists),
 *           so gifsmith drops that optimisation for you here.
 */
export type PaletteMode = 'diff' | 'full' | 'perFrame';

/**
 * GIF dither. `bayer` is the default and is deliberate: an ordered dither keeps
 * its pattern still frame-to-frame, so successive frames stay similar and the
 * GIF's inter-frame compression keeps working — the difference between ~25MB and
 * ~2MB on a text UI. The error-diffusion kernels look better on a single frame
 * and cost enormously more in an animation, because the diffused error re-rolls
 * on every frame and turns a static background into noise that never repeats.
 * `none` is the cleanest for flat-colour art with few gradients, and banding is
 * the price.
 */
export type DitherMode = 'bayer' | 'floyd_steinberg' | 'sierra2' | 'sierra2_4a' | 'atkinson' | 'none';

export interface EncodeOptions {
  /** Output width in px; height auto (keeps aspect). */
  width: number;
  /** Output frame rate after resampling to a uniform clock. */
  fps: number;
  /** Playback speed multiplier applied to the natural pacing (>1 = faster). */
  speed: number;
  /** GIF palette size, 2–256 (fewer colors = smaller file). */
  colors: number;
  /** WebP quality 0–100. Ignored when `lossless` is set. */
  quality: number;
  /** Soft target size in MB; gifsmith warns (and can auto-tune) if exceeded. */
  targetMB?: number;
  /** GIF dither kernel. Default `'bayer'`. */
  dither?: DitherMode;
  /** Bayer pattern coarseness 0–5; higher is finer/less visible. Default 4. */
  bayerScale?: number;
  /** How the GIF palette is derived. Default `'diff'`. */
  palette?: PaletteMode;
  /**
   * WebP only: encode losslessly. Every pixel survives, the file is several
   * times larger than a quality-88 WebP and usually still smaller than the GIF
   * of the same clip — GIF pays 256 colours for the same pixels. Reach for this
   * when the demo is a UI (flat fills and text compress extremely well) rather
   * than video-like content.
   */
  lossless?: boolean;
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

  loop?: LoopStrategy | LoopOptions;
  encode?: Partial<EncodeOptions>;
  /**
   * Which capture backend records the walkthrough. Defaults to `'screencast'`
   * — the existing real-time path — so this is purely opt-in. Reach for
   * `'deterministic'` when the app being demoed stutters under capture and you
   * want the GIF generated as designed rather than as measured. See CaptureMode.
   */
  capture?: CaptureMode | CaptureOptions;

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
  /**
   * Under `capture: 'screencast'` this is a *measurement*: the average rate the
   * screencast actually delivered paints, which is worth watching because a
   * capture slower than the output fps makes motion steppy (gifsmith warns).
   *
   * Under `capture: 'deterministic'` the scene rate is exactly `encode.fps` by
   * construction — there is nothing to measure and no warning to give — so the
   * field reports the *render throughput* instead: frames produced per real
   * second. A low number there means the render was slow, not that the GIF is.
   */
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
