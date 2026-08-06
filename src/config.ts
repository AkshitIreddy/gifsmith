/**
 * The config rules — every value gifsmith will refuse, in one place.
 *
 * WHY THIS FILE EXISTS, twice over.
 *
 * 1. Shape. Validation used to be wherever the value happened to be read:
 *    `capture` in `capture/options.ts`, the stage combination in `director.ts`,
 *    the stage URL rules inside `scene.ts` at compose time, and nothing at all
 *    for `loop`, `format`, `dither` or `palette`. Each threw a bare `Error`, so
 *    the CLI could not tell a user's typo from a crash and printed a stack for
 *    both. Every rule now produces a message from here and a `ConfigError` from
 *    `assertConfig`, which the CLI prints as one line and exits 2 on.
 *
 * 2. Silence. The rules that were MISSING are the more expensive half, and they
 *    are all the same bug as the `capture` one the 0.3.0 CHANGELOG describes: a
 *    value nothing checks, compared against one known good value, with every
 *    other value falling through to a plausible render of the wrong thing.
 *      - `loop: 'crossfde'` → not 'auto', not 'none', not 'crossfade', so the
 *        planner took the ANCHOR branch. A typo silently changed the strategy.
 *      - `palette: 'ful'` → `mode === 'full' ? … : 'diff'`, so it silently
 *        rendered the default and the author read a number they did not get.
 *      - `format: 'jpg'` → `fmt === 'gif' ? gif : webp`, so a WebP was written
 *        to a path called demo.jpg.
 *      - `encode.fps: 0` → a division by zero downstream, an Infinity in the
 *        reported duration, and an ffmpeg failure a dozen steps later.
 *    None of them printed a warning. All of them are refused here, before a
 *    browser is launched.
 *
 * ONLY values that are already broken are rejected. A value that works today
 * keeps working: `colors: 300` and `bayerScale: 9` are documented as clamped by
 * the encoder and stay clamped, and a `target` with no url still launches a
 * blank page (dryRun warns; render does not refuse). The rule for adding to this
 * file is "is the current behaviour wrong, or merely unusual?".
 *
 * `render()` throws on the first problem; `dryRun()` reports them all — which is
 * the entire point of a dry run, and why the rules are functions returning
 * strings rather than functions that throw.
 */
import { statSync } from 'node:fs';
import type {
  CameraClip,
  DitherMode,
  EncodeOptions,
  LoopStrategy,
  OutputFormat,
  PaletteMode,
  RenderConfig,
  Viewport,
} from './types.js';
import { ConfigError } from './errors.js';
import { CAPTURE_MODES, FRAME_FORMATS, captureOptions, captureProblem, stageConflict } from './capture/options.js';

export { CAPTURE_MODES, FRAME_FORMATS };

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['gif', 'webp'];
export const LOOP_STRATEGIES: readonly LoopStrategy[] = ['auto', 'anchor', 'crossfade', 'none'];
export const DITHER_MODES: readonly DitherMode[] = [
  'bayer',
  'floyd_steinberg',
  'sierra2',
  'sierra2_4a',
  'atkinson',
  'none',
];
export const PALETTE_MODES: readonly PaletteMode[] = ['diff', 'full', 'perFrame'];
export const COMPOSE_MODES = ['overlay', 'stage'] as const;
/**
 * And the quietest silent failure of the lot. `Logger.enabled` compares
 * `ORDER[this.level] >= ORDER[l]`, and `ORDER['lound']` is `undefined`, so
 * `undefined >= 1` is false and a mistyped level does not raise the volume or
 * lower it — it turns the whole logger OFF, warnings included. The render then
 * exceeds `targetMB`, or captures below its output fps, and says nothing at all.
 */
export const LOG_LEVELS = ['silent', 'warn', 'info', 'debug'] as const;

/** How a bad value is quoted back: readable, and never a `[object Object]`. */
export const show = (v: unknown): string => {
  if (typeof v === 'string') return `'${v}'`;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

const list = (vs: readonly string[]): string => vs.map((v) => `'${v}'`).join(' | ');

/** One value against one closed set of allowed values. */
function enumProblem(field: string, v: unknown, allowed: readonly string[]): string | null {
  if (v == null) return null;
  if (typeof v === 'string' && allowed.includes(v)) return null;
  return `gifsmith: ${field} must be ${list(allowed)}; got ${show(v)}.`;
}

interface Range {
  /** The value must be strictly greater than this. */
  above?: number;
  min?: number;
  max?: number;
}

/**
 * One number, checked for the things that cannot work rather than for taste.
 *
 * `NaN` is the case worth spelling out: it is a number, it survives every
 * arithmetic operation, and it reaches ffmpeg as the literal string "NaN" —
 * which fails several stages later with a message about a filter graph.
 */
function numberProblem(field: string, v: unknown, r: Range): string | null {
  if (v == null) return null;
  const bound =
    r.above != null
      ? `a number greater than ${r.above}`
      : r.min != null && r.max != null
        ? `a number between ${r.min} and ${r.max}`
        : r.min != null
          ? `a number of at least ${r.min}`
          : 'a finite number';
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return `gifsmith: ${field} must be ${bound}; got ${show(v)}.`;
  }
  if (r.above != null && !(v > r.above)) return `gifsmith: ${field} must be ${bound}; got ${v}.`;
  if (r.min != null && v < r.min) return `gifsmith: ${field} must be ${bound}; got ${v}.`;
  if (r.max != null && v > r.max) return `gifsmith: ${field} must be ${bound}; got ${v}.`;
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What is already at a path, or null — for the two config fields that name one.
 *
 * Every failure is null on purpose, not just ENOENT. The question these rules
 * ask is "is what is THERE the wrong kind of thing", and a path that cannot be
 * stat'd at all (a permission the process does not have, a network share that
 * is down, a name the platform rejects) has not answered it. Refusing on a
 * failed stat would turn "I could not look" into "you are wrong", which is the
 * one thing a validator must never do — the render is still free to fail later
 * for the real reason, with the real message.
 */
function existingEntry(p: string): { isDirectory(): boolean } | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * The numeric encode options and what each one can be.
 *
 * `colors` and `bayerScale` are deliberately loose: the GIF encoder documents
 * and applies a clamp (2–256 and 0–5), so a config out of range renders exactly
 * as its docs say it will. Only values the clamp cannot rescue — a negative, a
 * NaN, a string — are refused.
 */
const ENCODE_RANGES: ReadonlyArray<readonly [keyof EncodeOptions, Range]> = [
  ['width', { above: 0 }],
  ['fps', { above: 0 }],
  ['speed', { above: 0 }],
  ['colors', { above: 0 }],
  ['quality', { min: 0, max: 100 }],
  ['targetMB', { above: 0 }],
  ['bayerScale', { min: 0 }],
];


/** The scene half of a config — everything `dryRun` also receives. */
export interface SceneShape {
  target?: RenderConfig['target'];
  timeline?: RenderConfig['timeline'];
  viewport?: Viewport;
  camera?: CameraClip | null;
  compose?: RenderConfig['compose'];
  stage?: RenderConfig['stage'];
  capture?: RenderConfig['capture'];
  props?: RenderConfig['props'];
  logLevel?: RenderConfig['logLevel'];
}

function viewportProblems(v: Viewport | undefined, into: string[]): void {
  if (v == null) return;
  if (!isObject(v)) {
    into.push(`gifsmith: viewport must be an object with width and height; got ${show(v)}.`);
    return;
  }
  for (const k of ['width', 'height'] as const) {
    const p = numberProblem(`viewport.${k}`, v[k], { above: 0 });
    if (p) into.push(p);
  }
  const dpr = numberProblem('viewport.deviceScaleFactor', v.deviceScaleFactor, { above: 0 });
  if (dpr) into.push(dpr);
}

function cameraProblems(c: CameraClip | null | undefined, into: string[]): void {
  if (c == null) return;
  if (!isObject(c)) {
    into.push(`gifsmith: camera must be a clip {x, y, width, height} or null; got ${show(c)}.`);
    return;
  }
  for (const k of ['x', 'y'] as const) {
    const p = numberProblem(`camera.${k}`, c[k], { min: 0 });
    if (p) into.push(p);
  }
  for (const k of ['width', 'height'] as const) {
    const p = numberProblem(`camera.${k}`, c[k], { above: 0 });
    if (p) into.push(p);
  }
}

/**
 * The rules a scene can be checked against — the subset `dryRun` shares with
 * `render`, so a dry run refuses exactly what a render would.
 */
export function sceneProblems(cfg: SceneShape): string[] {
  const problems: string[] = [];

  if (!isObject(cfg.target)) {
    problems.push(
      `gifsmith: target is required — use web(url) to launch a browser, or tauri()/electron() ` +
        `to attach to a running app; got ${show(cfg.target)}.`,
    );
  }
  if (!isObject(cfg.timeline) || !Array.isArray((cfg.timeline as { steps?: unknown }).steps)) {
    problems.push(
      `gifsmith: timeline must be a compiled timeline — timeline((t) => …) — with a \`steps\` ` +
        `array; got ${show(cfg.timeline)}.`,
    );
  }
  if (cfg.props != null && !Array.isArray(cfg.props)) {
    problems.push(`gifsmith: props must be an array of props from 'gifsmith/props'; got ${show(cfg.props)}.`);
  }

  viewportProblems(cfg.viewport, problems);
  cameraProblems(cfg.camera, problems);

  const composeBad = enumProblem('compose', cfg.compose, COMPOSE_MODES);
  if (composeBad) problems.push(composeBad);

  const logBad = enumProblem('logLevel', cfg.logLevel, LOG_LEVELS);
  if (logBad) problems.push(logBad);

  const captureBad = captureProblem(cfg.capture);
  if (captureBad) problems.push(captureBad);

  // Only ask about the combination once both halves are known to be valid —
  // otherwise a bad `compose` reports twice and neither message is the one to
  // act on first.
  if (!captureBad && !composeBad) {
    const conflict = stageConflict(captureOptions(cfg.capture), cfg.compose);
    if (conflict) problems.push(conflict);
  }

  // The two stage rules, hoisted out of `scene.ts` — they were discovered at
  // compose time, which is one browser launch and a page load after they could
  // have been known.
  if (composeBad == null && cfg.compose === 'stage') {
    const url = cfg.target?.url;
    if (!url) {
      problems.push(
        `gifsmith: compose:'stage' needs target.url — the app is framed in an iframe, so there ` +
          `has to be an address to frame.`,
      );
    } else if (url.startsWith('file:')) {
      problems.push(
        `gifsmith: compose:'stage' can't frame a file:// app (a non-file page may not embed it). ` +
          `Serve the app over http(s) — a dev server — or use compose:'overlay'.`,
      );
    }
  }

  return problems;
}

/** Every rule, for the full render config. */
export function configProblems(cfg: RenderConfig): string[] {
  if (!isObject(cfg)) {
    return [`gifsmith: render() needs a RenderConfig object; got ${show(cfg)}.`];
  }
  const problems = sceneProblems(cfg);

  if (typeof cfg.out !== 'string' || cfg.out.trim() === '') {
    problems.push(`gifsmith: out must be an output path like 'docs/demo.gif'; got ${show(cfg.out)}.`);
  } else {
    /*
     * `out` must be a FILE we could write, and the check has to happen here —
     * before a browser launches — because of when the alternative fails.
     *
     * A directory passed as `out` (`--out .`, or a path whose trailing slash
     * was lost) is a non-empty string, so the rule above waved it through. The
     * render then connected, captured, paced and looped, and only died at the
     * encoder: ffmpeg refusing to open a directory, 29 lines of stderr with its
     * whole `configuration:` line in them, several minutes after the mistake
     * was made. Nothing about that output names `out`.
     *
     * A file that does not exist yet is fine and normal — the point is only to
     * refuse a path that IS something and is not a file, and to refuse it in
     * the same breath as every other config mistake.
     */
    const outPath = cfg.out.trim();
    if (existingEntry(outPath)?.isDirectory()) {
      problems.push(
        `gifsmith: out is a directory, not a file — ${show(outPath)}. ` +
          `Give it a filename, e.g. ${show(`${outPath.replace(/[\\/]+$/, '')}/demo.gif`)}.`,
      );
    }
  }

  /*
   * `workDir`, which is the only other path in a RenderConfig, and fails the
   * same way round.
   *
   * Found by asking the question the `out` fix asks in reverse: which fields are
   * a PATH, and what happens if what is already there is the wrong kind of
   * thing? There are exactly two — `out` and this one — and a `workDir` that
   * names an existing file died at `fs.mkdirSync(workRoot)` with
   * `Error: EEXIST: file already exists, mkdir '…'` and three frames, from
   * inside `render()` after the config had been accepted. Nothing in that names
   * `workDir` either.
   *
   * A directory that does not exist yet is fine and normal — the Director
   * creates it (`recursive: true`), which is the documented behaviour and the
   * usual way this field is used.
   */
  if (cfg.workDir != null) {
    if (typeof cfg.workDir !== 'string' || cfg.workDir.trim() === '') {
      problems.push(
        `gifsmith: workDir must be a directory path to keep frames in; got ${show(cfg.workDir)}.`,
      );
    } else {
      const dir = cfg.workDir.trim();
      const entry = existingEntry(dir);
      if (entry !== null && !entry.isDirectory()) {
        problems.push(
          `gifsmith: workDir is a file, not a directory — ${show(dir)}. ` +
            `Point it at a directory (it is created if it does not exist).`,
        );
      }
    }
  }

  const formatBad = enumProblem('format', cfg.format, OUTPUT_FORMATS);
  if (formatBad) problems.push(formatBad);

  if (cfg.alsoEmit != null) {
    if (!Array.isArray(cfg.alsoEmit)) {
      problems.push(`gifsmith: alsoEmit must be an array like ['webp']; got ${show(cfg.alsoEmit)}.`);
    } else {
      for (const f of cfg.alsoEmit) {
        const bad = enumProblem('alsoEmit[]', f, OUTPUT_FORMATS);
        if (bad) problems.push(bad);
      }
    }
  }

  if (cfg.loop != null) {
    if (typeof cfg.loop === 'string') {
      const bad = enumProblem('loop', cfg.loop, LOOP_STRATEGIES);
      if (bad) problems.push(bad);
    } else if (!isObject(cfg.loop)) {
      problems.push(
        `gifsmith: loop must be ${list(LOOP_STRATEGIES)}, or an object with a \`strategy\` of one ` +
          `of those; got ${show(cfg.loop)}.`,
      );
    } else {
      const bad = enumProblem('loop.strategy', cfg.loop.strategy, LOOP_STRATEGIES);
      if (bad) problems.push(bad);
      else if (cfg.loop.strategy == null) {
        problems.push(`gifsmith: loop.strategy is required; use ${list(LOOP_STRATEGIES)}.`);
      }
      const cyc = numberProblem('loop.minCycleSeconds', cfg.loop.minCycleSeconds, { above: 0 });
      if (cyc) problems.push(cyc);
    }
  }

  if (cfg.encode != null) {
    if (!isObject(cfg.encode)) {
      problems.push(`gifsmith: encode must be an object of encode options; got ${show(cfg.encode)}.`);
    } else {
      const dither = enumProblem('encode.dither', cfg.encode.dither, DITHER_MODES);
      if (dither) problems.push(dither);
      const palette = enumProblem('encode.palette', cfg.encode.palette, PALETTE_MODES);
      if (palette) problems.push(palette);
      if (cfg.encode.lossless != null && typeof cfg.encode.lossless !== 'boolean') {
        problems.push(`gifsmith: encode.lossless must be true or false; got ${show(cfg.encode.lossless)}.`);
      }
      for (const [key, range] of ENCODE_RANGES) {
        const p = numberProblem(`encode.${key}`, cfg.encode[key], range);
        if (p) problems.push(p);
      }
    }
  }

  return problems;
}

/**
 * Refuse a config that cannot be rendered — before ffmpeg is looked for, before
 * a browser is launched, before a temp dir is made.
 *
 * One problem is reported, because the CLI prints one line; the count of the
 * rest is on the end so nobody fixes four things one render at a time without
 * knowing there are four.
 */
export function assertConfig(cfg: RenderConfig): void {
  throwFirst(configProblems(cfg));
}

/**
 * The same, for the helpers that take a scene rather than a whole render config
 * — `snapshot()` and `contactSheet()`. They already validated `capture` and
 * nothing else, which left the same hole one field over: a scene with a mistyped
 * `logLevel` or a zero-width viewport got a browser launch and a confusing
 * failure instead of a sentence.
 */
export function assertScene(cfg: SceneShape): void {
  throwFirst(sceneProblems(cfg));
}

function throwFirst(problems: string[]): void {
  if (problems.length === 0) return;
  const more =
    problems.length > 1
      ? ` (+${problems.length - 1} more problem${problems.length > 2 ? 's' : ''} — dryRun() lists them all.)`
      : '';
  throw new ConfigError(problems[0] + more);
}
