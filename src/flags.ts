/**
 * The CLI's flag layer — argv in, a RenderConfig override out.
 *
 * It lives in its own module rather than inside `cli.ts` for one reason: `cli.ts`
 * is a bin. It calls `main()` at the top level, so importing it to check a flag
 * launches a render, and the only way to test the parser was to spawn a process
 * and read a message. Every rule below is an assertion in `test/flags.test.mjs`
 * — which matters here more than usual, because every bug this file has ever had
 * was SILENT: a flag that was misread and rendered anyway.
 *
 * That unit test is necessary and it is not sufficient, which this file learned
 * the expensive way. `--lossless demo.mjs` got its named error here, the test
 * called `applyOverrides()` directly and went green, and the actual command
 * still printed the bare usage line — because `cli.ts` checked for a missing
 * positional BEFORE anything in this file was consulted, so the naming never
 * ran. A parser that is right in isolation is worth nothing if the program
 * reaches its error first. Hence `checkFlags` below (validate before reading
 * positionals) and `test/cli.test.mjs`, which spawns the real binary and reads
 * its exit code and its output.
 */
import type { CaptureMode, LoopStrategy, RenderConfig } from './types.js';
import {
  CAPTURE_MODES,
  DITHER_MODES,
  FRAME_FORMATS,
  LOOP_STRATEGIES,
  OUTPUT_FORMATS,
  PALETTE_MODES,
} from './config.js';

/**
 * A mistake in the command line, as opposed to a failure during a render.
 *
 * The distinction earns its keep at the top of `cli.ts`: a UsageError prints as
 * one line and exits 2, everything else keeps its stack and exits 1. Before it
 * existed, `gifsmith render cfg.mjs --fps` printed
 * `gifsmith: Error: gifsmith: --fps needs a value …` — the prefix twice, because
 * the thrower added it and the handler added it again — followed by four frames
 * through node_modules, for a typo.
 *
 * So the messages below carry NO program prefix. The handler owns it.
 *
 * It is DECLARED in `errors.ts` beside `ConfigError` and `EnvironmentError`, and
 * re-exported here because that is where every importer already looks for it.
 * The reason for the move is the whole of the second gate's finding: this class
 * covered the flag layer, the same defect then turned up in the director, and a
 * class that lives inside one layer cannot be the answer for the others.
 */
export { UsageError } from './errors.js';
import { UsageError } from './errors.js';

export interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

export function parse(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

/**
 * A flag that takes a value, read as one.
 *
 * `parse` gives `true` to any `--flag` not followed by a value, which is right
 * for `--debug` and quietly wrong for everything else: `--capture` alone used to
 * become `capture: true`, which is not a mode, is not an object either, and
 * ended up spread into one — a config asking for a deterministic render that
 * silently recorded a screencast. Every value-taking flag goes through here, so
 * the mistake is a sentence instead of a surprise.
 */
export function str(f: Flags, key: string): string | undefined {
  const v = f[key];
  if (v == null) return undefined;
  if (typeof v !== 'string') {
    throw new UsageError(`--${key} needs a value (e.g. --${key} <value>)`);
  }
  return v;
}

/**
 * The same rule, for the flags whose value is a number — and this half was
 * missing for a release.
 *
 * `str` was added so a value-taking flag could not be silently misread, then
 * applied only to the string flags. The numeric ones kept going through a bare
 * `Number(v)`, and `Number(true) === 1`. So `--bayer-scale` with its value left
 * off did not fail, did not warn, and did not fall back to the default — it
 * rendered at bayerScale 1, which this project's own measurements call a
 * disaster at 30.2 dB, and it did it while printing a result that looked fine.
 * `--fps` alone silently became one frame per second; `--colors` alone became a
 * one-colour palette.
 *
 * A number that is not a number is refused for the same reason: `--fps sixteen`
 * used to reach the ffmpeg filter chain as `NaN`.
 */
export function num(f: Flags, key: string): number | undefined {
  const v = str(f, key);
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  if (v.trim() === '' || !Number.isFinite(n)) {
    throw new UsageError(`--${key} needs a number, got "${v}"`);
  }
  return n;
}

/**
 * And the flags that take NO value — where the same class of bug runs the other
 * way. `--lossless false` parsed as the string `'false'`, which is truthy, so
 * asking for lossless *off* turned it on. A bare `--lossless` is still the
 * normal spelling; `true`/`false` are accepted because people write them;
 * anything else is a mistake worth naming, and it is usually the same one —
 * `gifsmith render --lossless demo.mjs`, where the config path was swallowed as
 * the flag's value and the run died complaining the config was missing.
 */
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

export function bool(f: Flags, key: string): boolean {
  const v = f[key];
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  throw new UsageError(
    `--${key} takes no value (write just --${key}, or --${key} true|false); got "${v}"`,
  );
}

/**
 * A flag whose value is one of a closed set — the third silent class, and the
 * one the second gate found live.
 *
 * `str()` proved a flag HAS a value and stopped there, so `--capture
 * Deterministic` was a perfectly good string all the way into the director,
 * where a validator threw a bare Error and the CLI printed four lines of stack
 * with `gifsmith:` in two of them. `--loop crossfde` was worse: nothing checked
 * it at all, and the planner's `strategy === 'crossfade'` test simply came out
 * false, so the render silently used the anchor strategy instead.
 *
 * The allowed values are imported from `config.ts` rather than repeated here.
 * Two layers check them, on purpose — this one names the FLAG, because that is
 * what the user typed; the library names the FIELD, because that is what a
 * config module and a programmatic caller have. Neither is redundant, and there
 * is still only one list.
 */
export function enumStr(f: Flags, key: string, allowed: readonly string[]): string | undefined {
  const v = str(f, key);
  if (v === undefined) return undefined;
  if (!allowed.includes(v)) {
    const near = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
    /*
     * The near-miss hint QUOTES the value and says nothing about its shape.
     *
     * It used to end "the values are lowercase", which is true of most of them
     * and false of the one a reader is most likely to mistype: `--palette
     * PerFrame` answered "did you mean --palette perFrame? the values are
     * lowercase", contradicting in the same sentence the camelCase value it had
     * just suggested. A hint that argues with its own suggestion is worse than
     * no hint, because the reader now has to work out which half to believe.
     */
    throw new UsageError(
      `--${key} must be ${allowed.map((a) => `'${a}'`).join(' | ')}; got "${v}"` +
        (near ? ` (did you mean --${key} ${near}?)` : ''),
    );
  }
  return v;
}

/** A numeric flag whose range the render cannot work outside of. */
export interface FlagRange {
  /** Strictly greater than. */
  above?: number;
  min?: number;
  max?: number;
}

/**
 * The ranges, and deliberately only the ones a render cannot survive.
 *
 * `--colors 300` and `--bayer-scale 9` are NOT here: the GIF encoder documents
 * and applies a clamp to both, so they render exactly as the README says they
 * will, and refusing them would break a command line that works today. `--fps 0`
 * is a different thing — a division by zero, an Infinity in the reported
 * duration, and an ffmpeg failure several stages downstream.
 */
export function rangedNum(f: Flags, key: string, r: FlagRange): number | undefined {
  const n = num(f, key);
  if (n === undefined) return undefined;
  const bound =
    r.above != null
      ? `greater than ${r.above}`
      : r.min != null && r.max != null
        ? `between ${r.min} and ${r.max}`
        : `at least ${r.min}`;
  const ok =
    (r.above == null || n > r.above) && (r.min == null || n >= r.min) && (r.max == null || n <= r.max);
  if (!ok) throw new UsageError(`--${key} must be a number ${bound}; got ${n}`);
  return n;
}

/** The numeric encode flags, and the encode option each one sets. */
type NumericEncodeKey = 'width' | 'fps' | 'speed' | 'colors' | 'quality' | 'targetMB' | 'bayerScale';

const NUMERIC_ENCODE: ReadonlyArray<readonly [string, NumericEncodeKey]> = [
  ['width', 'width'],
  ['fps', 'fps'],
  ['speed', 'speed'],
  ['colors', 'colors'],
  ['quality', 'quality'],
  ['target-mb', 'targetMB'],
  ['bayer-scale', 'bayerScale'],
];

/**
 * Which flags a command understands, and what kind of thing each one is.
 *
 * `applyOverrides` reads exactly these, but it cannot be the thing that CHECKS
 * them: it needs a loaded config, and loading a config needs the positional that
 * a mis-typed flag may have just eaten. So the kinds are declared once, here,
 * and `checkFlags` runs over them first — before `cli.ts` looks at a positional,
 * before a config module is imported, before a browser is launched.
 */
export interface FlagSpec {
  /** Flags that take a value, read as a string. */
  strings?: readonly string[];
  /** Flags that take a value, read as a number. */
  numbers?: readonly string[];
  /** Flags that take no value. */
  booleans?: readonly string[];
  /** Of the string flags, the ones whose value is one of a closed set. */
  enums?: Readonly<Record<string, readonly string[]>>;
  /** Of the numeric flags, the ones with a range a render cannot work outside. */
  ranges?: Readonly<Record<string, FlagRange>>;
}

const STRING_FLAGS = ['out', 'format', 'loop', 'capture', 'dither', 'palette', 'frame-format'] as const;
const NUMBER_FLAGS = NUMERIC_ENCODE.map(([flag]) => flag);
const BOOLEAN_FLAGS = ['lossless', 'headful', 'keep-frames', 'debug', 'quiet', 'also-webp', 'help'] as const;

/**
 * Every render flag whose value is one of a closed set, and the set.
 *
 * `--out` is the only string flag that is genuinely free-form. All six of the
 * others name a mode, and every one of them used to be handed through unchecked.
 */
const ENUM_FLAGS: Readonly<Record<string, readonly string[]>> = {
  format: OUTPUT_FORMATS,
  loop: LOOP_STRATEGIES,
  capture: CAPTURE_MODES,
  dither: DITHER_MODES,
  palette: PALETTE_MODES,
  'frame-format': FRAME_FORMATS,
};

const RANGE_FLAGS: Readonly<Record<string, FlagRange>> = {
  width: { above: 0 },
  fps: { above: 0 },
  speed: { above: 0 },
  colors: { above: 0 },
  quality: { min: 0, max: 100 },
  'target-mb': { above: 0 },
  'bayer-scale': { min: 0 },
};

export const RENDER_FLAGS: FlagSpec = {
  strings: STRING_FLAGS,
  numbers: NUMBER_FLAGS,
  booleans: BOOLEAN_FLAGS,
  enums: ENUM_FLAGS,
  ranges: RANGE_FLAGS,
};

export const PROBE_FLAGS: FlagSpec = { booleans: ['json', 'debug', 'help'] };


/**
 * Read every flag that is present, purely for its errors, and warn about the
 * ones nothing will read.
 *
 * The ORDER of this call is the whole point, and it is the bug this function
 * exists for. `gifsmith render --lossless demo.mjs` parses as
 * `{ lossless: 'demo.mjs', _: ['render'] }` — the config path is the flag's
 * value and there is no positional left. `bool()` has named that exact mistake
 * since the flag layer was written; nobody ever saw it, because `cli.ts` tested
 * `if (!file)` first and printed the bare `gifsmith render <config.mjs>` usage,
 * which sends the reader to look for a missing argument they did in fact type.
 * Validating first means the message describes what actually happened.
 *
 * An unknown flag is a WARNING, not an error: it is the same silent class (a
 * mis-typed `--fsp 16` renders happily at the config's fps and says nothing),
 * but refusing one would turn a harmless extra argument into a failed render,
 * and that is not a trade to make on the way out of the door.
 */
export function checkFlags(f: Flags, spec: FlagSpec): void {
  // Kind first (is there a value at all, is it a number), then the closed sets
  // and the ranges. The order matters for the message: `--capture` with nothing
  // after it should say it needs a value, not list the two modes it isn't.
  for (const key of spec.strings ?? []) if (key in f) str(f, key);
  for (const key of spec.numbers ?? []) if (key in f) num(f, key);
  for (const key of spec.booleans ?? []) if (key in f) bool(f, key);
  for (const [key, allowed] of Object.entries(spec.enums ?? {})) if (key in f) enumStr(f, key, allowed);
  for (const [key, range] of Object.entries(spec.ranges ?? {})) if (key in f) rangedNum(f, key, range);

  const known = new Set<string>([...(spec.strings ?? []), ...(spec.numbers ?? []), ...(spec.booleans ?? [])]);
  for (const key of Object.keys(f)) {
    if (key === '_' || known.has(key)) continue;
    console.error(`gifsmith: warning: unknown flag --${key} (ignored)`);
  }
}

/**
 * The value-taking flag that appears to have eaten the config path, if one has.
 *
 * `checkFlags` catches the boolean half of this mistake outright — `--lossless`
 * takes no value, so swallowing `demo.mjs` is provably wrong. The value-taking
 * half is not provable: `gifsmith render --out demo.mjs` is a perfectly
 * well-formed command line that happens to be missing its config, and all the
 * CLI can honestly say is "no config module". It can, however, point at the
 * argument that looks like one, which is the whole of the user's confusion.
 */
export function swallowedConfig(f: Flags): { key: string; value: string } | null {
  for (const key of [...STRING_FLAGS, ...NUMBER_FLAGS]) {
    const v = f[key];
    if (typeof v === 'string' && /\.(mjs|cjs|js|ts)$/i.test(v)) return { key, value: v };
  }
  return null;
}

/**
 * `capture` accepts a bare mode or an options object, and `--frame-format` is a
 * knob on the object — so both flags are merged ONTO the config's own capture
 * rather than replacing it.
 *
 * The merge is the fix for the second half of the `--also-webp` class: a flag
 * whose shape (a bare mode) is not the config's shape (an options object)
 * silently dropping everything the config said. `--capture screencast` against
 * `capture: { mode: 'deterministic', format: 'png', waitForNetwork: true }` used
 * to produce the string `'screencast'` — the format and the network policy gone,
 * with no warning, from a flag that claimed only to pick a backend.
 */
export function applyCapture(cfg: RenderConfig, f: Flags): RenderConfig['capture'] {
  const mode = enumStr(f, 'capture', CAPTURE_MODES);
  const frameFormat = enumStr(f, 'frame-format', FRAME_FORMATS);
  if (mode === undefined && frameFormat === undefined) return cfg.capture;

  const base = typeof cfg.capture === 'string' ? { mode: cfg.capture } : { ...(cfg.capture ?? {}) };
  return {
    ...base,
    // A config with no capture at all defaults to the screencast, which is what
    // `captureOptions` would have done — spelled out here because `--frame-format`
    // alone has to produce a valid object.
    mode: (mode as CaptureMode | undefined) ?? base.mode ?? 'screencast',
    ...(frameFormat ? { format: frameFormat as 'jpeg' | 'png' } : {}),
  };
}

/**
 * `--also-webp`, whose config shape is an ARRAY and whose flag shape is a
 * boolean — the one of the six booleans that did not honour `false`.
 *
 * `bool()` answered correctly and nothing read the answer: the old expression
 * was `bool(f, 'also-webp') ? [...cfg.alsoEmit, 'webp'] : cfg.alsoEmit`, so the
 * false branch handed back the config's own `alsoEmit: ['webp']` and the WebP
 * was emitted anyway. `--lossless false`, `--headful false` and the rest were
 * fixed by asking `'flag' in f` before reading the config's value; this one
 * needs the same question AND a way to say "off", which for an array means
 * removing the entry rather than leaving the value alone.
 */
export function applyAlsoEmit(cfg: RenderConfig, f: Flags): RenderConfig['alsoEmit'] {
  if (!('also-webp' in f)) return cfg.alsoEmit;
  const current = cfg.alsoEmit ?? [];
  if (!bool(f, 'also-webp')) return current.filter((fmt) => fmt !== 'webp');
  return current.includes('webp') ? current : [...current, 'webp' as const];
}

/**
 * `--loop`, the third option whose flag shape is narrower than its config shape.
 *
 * `loop` accepts a bare strategy or `{ strategy, minCycleSeconds }`, and the
 * flag can only say the strategy — so replacing the field wholesale threw away
 * the one knob 0.2.3 added to reach it. `--loop anchor` against
 * `loop: { strategy: 'crossfade', minCycleSeconds: 30 }` used to produce the
 * string `'anchor'` and a 3-second default floor, which is precisely the
 * "search hands back a motionless clip" failure that release fixed.
 */
export function applyLoop(cfg: RenderConfig, f: Flags): RenderConfig['loop'] {
  const strategy = enumStr(f, 'loop', LOOP_STRATEGIES) as LoopStrategy | undefined;
  if (strategy === undefined) return cfg.loop;
  if (cfg.loop == null || typeof cfg.loop === 'string') return strategy;
  return { ...cfg.loop, strategy };
}

export function applyOverrides(cfg: RenderConfig, f: Flags): RenderConfig {
  const encode = { ...(cfg.encode ?? {}) };
  for (const [flag, key] of NUMERIC_ENCODE) {
    const v = rangedNum(f, flag, RANGE_FLAGS[flag] ?? {});
    if (v !== undefined) encode[key] = v;
  }
  const dither = enumStr(f, 'dither', DITHER_MODES);
  if (dither) encode.dither = dither as never;
  const palette = enumStr(f, 'palette', PALETTE_MODES);
  if (palette) encode.palette = palette as never;
  // Present-and-false is a real answer, so `--lossless false` turns it OFF
  // rather than leaving the config's own value standing. Same for the other
  // three OVERRIDE booleans — `x || cfg.x` cannot express "off", which is how
  // `--lossless false` came to mean lossless on. `--debug` and `--quiet` are
  // deliberately not among them; see logLevel below.
  if ('lossless' in f) encode.lossless = bool(f, 'lossless');
  return {
    ...cfg,
    out: str(f, 'out') ?? cfg.out,
    format: (enumStr(f, 'format', OUTPUT_FORMATS) as RenderConfig['format']) ?? cfg.format,
    alsoEmit: applyAlsoEmit(cfg, f),
    loop: applyLoop(cfg, f),
    capture: applyCapture(cfg, f),
    encode,
    keepFrames: 'keep-frames' in f ? bool(f, 'keep-frames') : cfg.keepFrames,
    /*
     * The two booleans that are a REQUEST rather than an override, and the one
     * place `--flag false` deliberately does not beat the config.
     *
     * The other four each own a field of their own with two states, so "off" is
     * a thing that can be said. These two are shortcuts onto `logLevel`, which
     * has FOUR — and "not debug" does not name one of them. `--debug false`
     * could mean silent, warn or info with equal justification, and any choice
     * would be gifsmith inventing a level the reader did not ask for and then
     * overriding the one they did write in the config. So a false answer here
     * means "I am not asking", and the config's own level stands. Turning the
     * volume down explicitly is `logLevel: 'warn'` in the config, or `--quiet`.
     *
     * `--quiet` is tested first when both are given: the flag that asks for LESS
     * output wins, because a reader who typed both is more likely to have added
     * `--quiet` to a command line that already said `--debug` than the reverse,
     * and being too quiet is recoverable in a way that a wall of debug is not.
     */
    logLevel: bool(f, 'quiet') ? 'warn' : bool(f, 'debug') ? 'debug' : cfg.logLevel,
    // Only rebuilt when the flag is actually present. A blanket
    // `{ ...cfg.target, headful }` turns a config with no `target` at all into
    // `{}`, which reads as a valid object and renders a blank page — leaving it
    // untouched lets `assertConfig` say what is actually wrong.
    target:
      'headful' in f && cfg.target && typeof cfg.target === 'object'
        ? { ...cfg.target, headful: bool(f, 'headful') }
        : cfg.target,
  };
}
