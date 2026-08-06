/**
 * Normalising — and *checking* — the `capture` field.
 *
 * `capture` accepts a bare mode or an options object, the same shape `loop`
 * takes, and until now normalising it was the whole of the job: whatever came
 * out was handed straight to `capture.mode === 'deterministic'`. That comparison
 * has no wrong answer. A typo (`'deterministc'`), a mode the CLI never filled in
 * (`--capture` with no value parses as the boolean `true`), an object with no
 * `mode` at all — every one of them is false, and false is the screencast. The
 * user asks for a deterministic render, watches a recorded one go by, and is
 * told nothing at any point.
 *
 * So the shape is validated once, here, before a browser is launched, and both
 * callers get the same rules: `render()` throws, `dryRun()` reports — because
 * catching exactly this before a capture is what dryRun is for.
 */
import type { CaptureMode, CaptureOptions, RenderConfig } from '../types.js';
import { ConfigError } from '../errors.js';

/**
 * Exported because the CLI validates `--capture` and `--frame-format` against
 * the same lists before it reads a positional (see `flags.ts`). One list, two
 * vocabularies: the flag layer names the flag, the library names the field.
 */
export const CAPTURE_MODES: readonly CaptureMode[] = ['screencast', 'deterministic'];
export const FRAME_FORMATS = ['jpeg', 'png'] as const;

const MODES = CAPTURE_MODES;
const FORMATS = FRAME_FORMATS;

const show = (v: unknown): string =>
  typeof v === 'string' ? `'${v}'` : v === undefined ? 'undefined' : JSON.stringify(v) ?? String(v);

/**
 * The rules, as a message or nothing. `null` means the value is usable.
 *
 * Only the fields whose wrong value is SILENT are checked. `quality` out of
 * range or a nonsense `frameTimeoutMs` produce a visibly bad render or a loud
 * CDP error; a wrong `mode` or `format` produces a plausible render of the
 * wrong thing, which is the failure worth spending an error message on.
 */
export function captureProblem(cfg: RenderConfig['capture']): string | null {
  if (cfg == null) return null;
  const modes = MODES.map((m) => `'${m}'`).join(' or ');

  if (typeof cfg !== 'string' && (typeof cfg !== 'object' || Array.isArray(cfg))) {
    return (
      `gifsmith: capture must be ${modes}, or an object with a \`mode\` of one of those; ` +
      `got ${show(cfg)}.` +
      ((cfg as unknown) === true
        ? ' (From the CLI, --capture needs a value: --capture deterministic.)'
        : '')
    );
  }
  const opts = typeof cfg === 'string' ? ({ mode: cfg } as CaptureOptions) : cfg;

  if (!MODES.includes(opts.mode)) {
    return (
      `gifsmith: capture.mode must be ${modes}; got ${show(opts.mode)}. ` +
      `An unrecognised mode used to fall through to the screencast, so a deterministic render ` +
      `silently became a recorded one.`
    );
  }
  if (opts.format != null && !(FORMATS as readonly string[]).includes(opts.format)) {
    return (
      `gifsmith: capture.format must be 'jpeg' or 'png'; got ${show(opts.format)}. ` +
      `Chromium is given this verbatim, so anything else stalls every screenshot.`
    );
  }
  return null;
}

/**
 * `capture: 'deterministic'` is shorthand for `{ mode: 'deterministic' }`.
 *
 * The throw is a `ConfigError` and not a bare `Error` for a reason that took two
 * gates to learn: this is input validation, it is reachable from the command
 * line (`--capture Deterministic`), and a bare Error is indistinguishable from a
 * crash — so the CLI printed a four-line stack for a capital D. See errors.ts.
 */
export function captureOptions(cfg: RenderConfig['capture']): CaptureOptions {
  const problem = captureProblem(cfg);
  if (problem) throw new ConfigError(problem);
  if (cfg == null) return { mode: 'screencast' };
  return typeof cfg === 'string' ? { mode: cfg } : cfg;
}

/**
 * The one combination that is well-formed and still cannot work. Virtual time
 * is granted per target, and a staged app lives in a cross-origin iframe with a
 * renderer — and a clock — of its own, so the app would simply freeze while the
 * mock desktop around it animated. Shared so `dryRun` refuses the same scene
 * `render` would, instead of reporting it ok.
 */
export function stageConflict(capture: CaptureOptions, compose: string | undefined): string | null {
  if (capture.mode !== 'deterministic' || compose !== 'stage') return null;
  return (
    "gifsmith: capture:'deterministic' does not support compose:'stage' — the app runs in a " +
    "separate renderer with its own clock. Use compose:'overlay', or keep the screencast capture."
  );
}
