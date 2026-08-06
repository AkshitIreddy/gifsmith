/**
 * snapshot() and contactSheet() — let an AI author "see" a moment mid-build
 * cheaply, without a full render. snapshot plays the timeline up to a given
 * time and returns one frame (base64 PNG). contactSheet plays once and grabs
 * N frames across the timeline, tiled into a single grid for one-shot visual QA.
 *
 * Seeking uses the timeline's *planned* durations (deterministic), executing
 * each beat in real time so the frame reflects genuine mid-animation state.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { Page } from 'puppeteer-core';
import type { RenderConfig, Step } from '../types.js';
import { Logger } from '../log.js';
import { connect } from '../browser.js';
import { composeScene } from '../scene.js';
import { setupBridge } from '../bridge.js';
import { captureOptions } from '../capture/options.js';
import { assertScene } from '../config.js';
import { runStep, type PlayContext } from '../timeline/player.js';
import { estimateSeconds } from '../timeline/timeline.js';
import { run } from '../encode/ffmpeg.js';

/**
 * `capture` is accepted so a scene object can be passed here EXACTLY as it is
 * passed to `render()` — the field used to be absent from the Pick, so a
 * `capture: 'deterministic'` scene was silently a different scene here, and TS
 * excess-property checking rejected the config object outright for good measure.
 *
 * It is accepted, not honoured, and the difference is worth one line of output:
 * these helpers play the timeline in real time and take a screenshot at the end
 * of a beat. That is the right design — a snapshot is a look at the app, not a
 * render, and standing up virtual time to produce one PNG would make the cheap
 * tool expensive. But the times you seek to are *planned* times, and under
 * deterministic capture the real render's scene clock is the one that decides
 * what a moment looks like, so the two can differ wherever the machine is slow.
 * Say so once rather than let it be discovered.
 */
type SceneConfig = Pick<
  RenderConfig,
  'target' | 'props' | 'timeline' | 'viewport' | 'camera' | 'compose' | 'stage' | 'bridge' | 'capture' | 'logLevel'
>;

async function screenshotBase64(page: Page, camera: RenderConfig['camera']): Promise<string> {
  const opts: any = { encoding: 'base64', type: 'png' };
  if (camera) opts.clip = { x: camera.x, y: camera.y, width: camera.width, height: camera.height };
  return (await page.screenshot(opts)) as unknown as string;
}

async function withScene<T>(cfg: SceneConfig, fn: (page: Page, ctx: PlayContext, log: Logger) => Promise<T>): Promise<T> {
  // The whole scene, by the same rules `render()` and `dryRun()` apply: a scene
  // these helpers would refuse should not quietly produce a contact sheet of
  // itself. `capture` was checked here and nothing else was, which left the same
  // hole one field over — a mistyped `logLevel` silences the logger completely,
  // and a zero-width viewport reaches puppeteer.
  assertScene(cfg);

  const log = new Logger(cfg.logLevel ?? 'warn');
  const viewport = { width: 1280, height: 800, deviceScaleFactor: 1, ...(cfg.viewport ?? {}) };
  const compose = cfg.compose ?? 'overlay';
  const capture = captureOptions(cfg.capture);
  if (capture.mode === 'deterministic') {
    log.warn(
      'snapshot/contactSheet play the timeline on the REAL clock. The scene asks for ' +
        "capture:'deterministic', whose virtual clock is what decides timing in the finished " +
        'render, so a frame here is the app at the planned moment rather than at the rendered ' +
        'one. Fine for "does this look right"; not a measurement of the render.',
    );
  }
  const connectTarget = compose === 'stage' ? { ...cfg.target, url: undefined } : cfg.target;
  const conn = await connect(connectTarget, viewport, log);
  try {
    if (cfg.target.url && !conn.owned && compose !== 'stage') {
      await conn.page.goto(cfg.target.url, { waitUntil: 'load', timeout: 30_000 });
    }
    await conn.page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 }).catch(() => {});
    const comp = await composeScene(conn.page, {
      props: cfg.props ?? [],
      compose,
      ctx: { viewport, camera: cfg.camera ?? null, compose },
      targetUrl: cfg.target.url,
      stage: cfg.stage,
      log,
    });
    await setupBridge(comp.appFrame ?? conn.page, cfg.bridge ?? {}, log);
    const ctx: PlayContext = { startMs: Date.now(), cueTimes: {}, anchorMs: null, log, appFrame: comp.appFrame };
    return await fn(conn.page, ctx, log);
  } finally {
    if (conn.owned) await conn.browser.close();
    else await conn.browser.disconnect();
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Play the top-level steps, capturing a frame at each ms in `stops`.
 *
 * A stop that lands *inside* a step is the whole difficulty. There are two ways
 * to serve one and this uses both, because they are not interchangeable:
 *
 *  - A `hold` is split. It is pure waiting, so the same total time passes and
 *    the frame is taken at exactly the moment asked for, with nothing racing.
 *    This is the precise path and stays the preferred one.
 *  - Anything else with a duration is raced. `scroll`, `cursorTo`, `drag`,
 *    `type` and — since `call` learned to declare `seconds` — an author callback
 *    are single indivisible awaits: there is no seam to split them at. So the
 *    step is started, the shot is taken part-way through in real time, and the
 *    step is then awaited to completion.
 *
 * Only the hold case existed, and everything else fell through to "run the whole
 * step, then capture". That was survivable while a `call` counted as zero
 * planned seconds — a stop could not land inside a step that had no duration.
 * Now that `t.call(fn, { seconds: 2 })` is how a deterministic scene declares its
 * real length, asking to see 1s into a 2s callback handed back the frame *after*
 * the callback: the one moment the author explicitly did not ask for, and no
 * indication that it had been substituted.
 *
 * Racing is safe here specifically because these helpers play on the real clock
 * — `withScene` builds a PlayContext with no clock, so `runStep` gets a real one
 * and a step's planned duration is real elapsed time. A screenshot is a CDP call
 * on its own channel, so taking one mid-step observes the page rather than
 * disturbing it.
 *
 * Exported for `test/snapshot.test.mjs`, and deliberately not from `index.ts`:
 * everything above `withScene` needs a browser, but the seeking arithmetic — the
 * part that was silently returning the wrong moment — needs only something with
 * a `screenshot()` on it. The bug shipped verified by one manual measurement,
 * which is exactly the kind of check that is not repeated; a fake page and a
 * `call` step that changes what a screenshot says is the same measurement, run
 * every time.
 */
export async function playCapturing(
  page: Page,
  cfg: SceneConfig,
  ctx: PlayContext,
  stops: number[],
): Promise<Record<number, string>> {
  const shots: Record<number, string> = {};
  const pending = [...stops].sort((a, b) => a - b);
  let elapsed = 0;
  const capture = async (ms: number) => {
    shots[ms] = await screenshotBase64(page, cfg.camera ?? null);
  };
  const contains = (start: number, dur: number) =>
    pending.length && pending[0] < start + dur;

  for (const step of cfg.timeline.steps) {
    const dur = estimateSeconds([step]) * 1000;
    // Fire any stops that land within/at the start of this step.
    while (pending.length && pending[0] <= elapsed) {
      await capture(pending.shift()!);
    }
    if (step.kind === 'hold' && contains(elapsed, dur)) {
      // Split the hold around the stops it contains.
      let cursor = elapsed;
      while (contains(elapsed, dur)) {
        const target = pending[0];
        await runStep(page, { kind: 'hold', ms: Math.max(0, target - cursor) }, cfg.timeline, ctx);
        cursor = target;
        await capture(pending.shift()!);
      }
      await runStep(page, { kind: 'hold', ms: Math.max(0, elapsed + dur - cursor) }, cfg.timeline, ctx);
    } else if (dur > 0 && contains(elapsed, dur)) {
      // Indivisible, so run it and shoot through it. A rejection is held rather
      // than left dangling: the step is awaited at the end either way, so the
      // error surfaces from the same place it always did.
      let failure: unknown;
      let failed = false;
      const running = runStep(page, step, cfg.timeline, ctx).catch((e: unknown) => {
        failure = e;
        failed = true;
      });
      let cursor = elapsed;
      while (contains(elapsed, dur)) {
        const target = pending[0];
        await sleep(target - cursor);
        cursor = target;
        // If the step has already finished, this is the final state rather than
        // a mid-step frame — the same answer the old code gave, just no longer
        // the answer to every question.
        await capture(pending.shift()!);
      }
      await running;
      if (failed) throw failure;
    } else {
      await runStep(page, step, cfg.timeline, ctx);
    }
    elapsed += dur;
  }
  // Any remaining stops beyond the timeline → capture the final state.
  for (const ms of pending) await capture(ms);
  return shots;
}

export async function snapshot(cfg: SceneConfig, atSeconds: number): Promise<{ atSeconds: number; base64: string }> {
  const base64 = await withScene(cfg, async (page, ctx) => {
    const shots = await playCapturing(page, cfg, ctx, [Math.max(0, atSeconds * 1000)]);
    return shots[Math.max(0, atSeconds * 1000)];
  });
  return { atSeconds, base64 };
}

export interface ContactSheet {
  times: number[];
  columns: number;
  /** A single tiled PNG (base64) of all N frames. */
  gridBase64: string;
  frames: { atSeconds: number; base64: string }[];
}

export async function contactSheet(cfg: SceneConfig, n = 6): Promise<ContactSheet> {
  const total = Math.max(0.001, estimateSeconds(cfg.timeline.steps));
  const times = Array.from({ length: n }, (_, i) => Number(((i + 0.5) * (total / n)).toFixed(2)));
  const stops = times.map((t) => t * 1000);

  const shots = await withScene(cfg, (page, ctx) => playCapturing(page, cfg, ctx, stops));
  const frames = times.map((t) => ({ atSeconds: t, base64: shots[t * 1000] ?? '' }));

  // Tile with ffmpeg into a contact sheet.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gifsmith-sheet-'));
  try {
    frames.forEach((f, i) => {
      if (f.base64) fs.writeFileSync(path.join(tmp, `s${String(i).padStart(2, '0')}.png`), Buffer.from(f.base64, 'base64'));
    });
    const columns = Math.min(n, 3);
    const rows = Math.ceil(n / columns);
    const gridPath = path.join(tmp, 'grid.png');
    await run([
      '-y', '-framerate', '1', '-start_number', '0', '-i', path.join(tmp, 's%02d.png'),
      '-vf', `scale=420:-1,tile=${columns}x${rows}:padding=6:color=0x1b1f24`,
      '-frames:v', '1', gridPath,
    ]);
    const gridBase64 = fs.readFileSync(gridPath).toString('base64');
    return { times, columns, gridBase64, frames };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
