/**
 * Deterministic capture — the offline-renderer path.
 *
 * The screencast backend records whatever actually happened: real paints, real
 * timestamps, and therefore real stalls. That is the right default (it is
 * honest about the app's own animation, CSS included), but it means the GIF is
 * a measurement of the recording machine. Render the same demo on a busy laptop
 * and the walkthrough judders where the app blocked its main thread.
 *
 * This backend removes the machine from the equation using Chromium's virtual
 * time (`Emulation.setVirtualTimePolicy`). With a budget granted, the page's
 * `performance.now()`, `Date.now()`, `setTimeout` and `requestAnimationFrame`
 * all follow a clock we hand out in fixed instalments; when the budget is spent
 * Chromium fires `virtualTimeBudgetExpired` and the page freezes mid-scene
 * until we grant more. A 900ms main-thread stall costs real seconds and ~zero
 * virtual ones, so it never reaches a frame. One budget = one frame = one
 * screenshot, and the timestamps are exact multiples of the frame interval by
 * construction rather than by resampling.
 *
 * Three decisions in here are worth the ink:
 *
 * 1. `speed` is applied HERE, not in a later resample. Each captured frame is
 *    `speed/fps` seconds of *scene* time, so the finished GIF plays `speed`x
 *    faster with every one of its frames rendered. The alternative — capture at
 *    the output fps and let ffmpeg's `fps=` filter compress the stream — throws
 *    away ~29% of the frames at the default speed of 1.4, which puts the judder
 *    back in from the other end.
 *
 * 2. The default virtual-time policy is `advance`, not
 *    `pauseIfNetworkFetchesPending`. The latter refuses to spend budget while
 *    any fetch is outstanding, and a dev server's HMR channel or a long-poll is
 *    an outstanding fetch *forever* — the render would hang with no diagnostic.
 *    An offline renderer should not stall on the network; responses still
 *    arrive in real time and land a few frames later. Authors whose demo waits
 *    on real data can opt back in with `waitForNetwork`.
 *
 * 3. No heartbeat. The screencast backend injects a 2px CSS-animated square so
 *    a static hold still emits paints. Here every frame is an explicit
 *    screenshot, so it is unnecessary — and worse than unnecessary: it animates
 *    on the virtual clock too, so it would paint a flickering square into every
 *    frame of a capture whose whole selling point is determinism.
 *
 * 4. `format: 'png'` is worth taking here in a way it is not on the screencast.
 *    This backend has no resample stage, so PNG frames make the pipeline
 *    lossless end to end: what Chromium composited is what the quantiser sees.
 *    The cost is a slower, larger frame dir, and a slow capture costs a
 *    deterministic render nothing but time — it does not put judder in the
 *    output, because the output's clock is not this machine's.
 *
 * The scene-clock arithmetic (frame boundaries, waiters, the pump that makes a
 * `parallel` cost the longest branch rather than the sum) lives in ./schedule.ts
 * — it is testable without a browser, and this file is the CDP half.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { Logger } from '../log.js';
import { sleep, type Clock } from '../timeline/clock.js';
import type { CaptureHandle } from './handle.js';
import { createFrameScheduler } from './schedule.js';

/**
 * Chromium will force virtual time forward if a task queue reschedules itself
 * this many times without yielding, rather than deadlocking. It is a guard
 * against a pathological `setTimeout(fn, 0)` loop, set high enough that a
 * normal app never reaches it (and so never has time forced under it).
 */
const STARVATION_GUARD = 100_000;

/**
 * Chromium launch flags this backend cannot work without, measured rather than
 * assumed.
 *
 * `--run-all-compositor-stages-before-draw` is the load-bearing one and the
 * whole reason this list exists. `Page.captureScreenshot` waits for a frame
 * that includes the current content; normally the compositor produces one on
 * its own schedule, but with virtual time paused between frames it never does —
 * so the very first screenshot taken after something dirtied the page (a click
 * that changed the DOM, say) hangs *forever*, with no error and no timeout.
 * Isolated: a static page + a click + a paused clock deadlocks the screenshot
 * without this flag and returns in ~10ms with it.
 *
 * The other four are what Chromium's own `--deterministic-mode` implies, minus
 * `--enable-begin-frame-control` (which would hand frame production to an
 * embedder that isn't there). Threaded animation and threaded scrolling run on
 * the compositor thread against *its* clock, not the main thread's virtual one,
 * so leaving them enabled is a second source of frames that ignore the budget.
 */
export const DETERMINISTIC_BROWSER_ARGS = [
  '--run-all-compositor-stages-before-draw',
  '--disable-new-content-rendering-timeout',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--disable-checker-imaging',
];

/** Boot pump cadence: how closely virtual time tracks real time before capture. */
const BOOT_TICK_MS = 16;
const BOOT_MAX_CHUNK_MS = 250;

const EPS = 1e-6;

export interface DeterministicOptions {
  /** Output frame rate — one captured frame per output frame. */
  fps: number;
  /** Playback speed multiplier; folded into the scene-time frame interval. */
  speed: number;
  /** JPEG quality for captured frames (default 92, matching the screencast). */
  quality?: number;
  /**
   * Frame image format. `'png'` is lossless and, since this backend never
   * resamples, makes the whole pipeline lossless up to the quantiser. `quality`
   * is meaningless with it and is not sent.
   */
  format?: 'jpeg' | 'png';
  /**
   * Real-time watchdog for a single frame's budget. Virtual time is supposed to
   * expire almost instantly, so this only fires when the page is starving its
   * task queue or (with `waitForNetwork`) holding a fetch. On expiry we log,
   * pause the clock and take the frame anyway — a degraded render beats a hang.
   */
  frameTimeoutMs?: number;
  /**
   * Hold the budget while network fetches are pending, so a demo that waits on
   * real data sees it arrive. Off by default; see the header for why.
   */
  waitForNetwork?: boolean;
}

export interface DeterministicHandle extends CaptureHandle {
  /** The scene clock the timeline plays on. */
  clock: Clock;
  /**
   * Stop the free-running boot clock and hand control to `clock.advance`.
   * Called once the page has loaded, the scene is composed and the bridge
   * handshake is done — all of which are Node-side awaits that would deadlock
   * against a stopped clock, which is why the clock runs freely until here.
   */
  freeze(): Promise<void>;
  /**
   * Frames produced per REAL second — render throughput, not a pacing measure.
   * Under deterministic capture the *scene* rate is exactly `fps` by
   * construction, so the only fps worth reporting is how fast the render ran.
   */
  realFps(): number;
  /**
   * Why capture stopped advancing mid-scene, or null if it never did.
   *
   * The pump releases every waiter when it dies, deliberately: the alternative
   * is a timeline blocked on a deadline that can never arrive, which hangs the
   * render with no output and no message. But "the rest of the scene ran
   * instantly against a frozen page" is not success, and the Director cannot
   * tell that from a short walkthrough by looking at the frames. So the first
   * failure is kept and the Director asks.
   */
  captureError(): unknown;
}

export async function startDeterministicCapture(
  page: Page,
  framesDir: string,
  log: Logger,
  opts: DeterministicOptions,
): Promise<DeterministicHandle> {
  fs.mkdirSync(framesDir, { recursive: true });
  const client = await page.target().createCDPSession();

  const fps = Math.max(1, opts.fps);
  const speed = opts.speed > 0 ? opts.speed : 1;
  const frameMs = (1000 * speed) / fps;
  const quality = opts.quality ?? 92;
  const format = opts.format ?? 'jpeg';
  const ext = format === 'png' ? '.png' : '.jpg';
  const frameTimeoutMs = opts.frameTimeoutMs ?? 10_000;
  const policy: 'advance' | 'pauseIfNetworkFetchesPending' = opts.waitForNetwork
    ? 'pauseIfNetworkFetchesPending'
    : 'advance';

  const frames: string[] = [];
  const timestamps: number[] = [];

  let originMs = 0;        // what nowMs() counts from (scene time is the scheduler's)
  let mode: 'boot' | 'scene' | 'stopped' = 'boot';
  /** Read through a function: `mode` changes across awaits, and a direct
   * comparison would be narrowed by the compiler on the strength of an earlier
   * one — which is exactly the check that has to be repeated. */
  const stopped = (): boolean => mode === 'stopped';
  let stalls = 0;
  let shotStalls = 0;
  const wallStart = Date.now();
  let wallEnd = 0;

  // Exactly one budget is ever outstanding, so a single slot is enough. A late
  // expiry (one the watchdog already gave up on) finds the slot empty and is
  // correctly ignored rather than resolving the *next* frame's wait early.
  let pendingExpiry: (() => void) | null = null;
  client.on('Emulation.virtualTimeBudgetExpired', () => {
    const resolve = pendingExpiry;
    pendingExpiry = null;
    if (resolve) resolve();
  });

  async function setPolicy(p: string, budget?: number): Promise<void> {
    const params: Record<string, unknown> = { policy: p };
    if (budget != null) {
      params.budget = budget;
      params.maxVirtualTimeTaskStarvationCount = STARVATION_GUARD;
    }
    await client.send('Emulation.setVirtualTimePolicy' as never, params as never);
  }

  /** Grant `ms` of virtual time and return once the page has actually spent it. */
  async function spend(ms: number): Promise<void> {
    if (ms <= EPS || stopped()) return;
    const expired = new Promise<void>((res) => {
      pendingExpiry = res;
    });
    await setPolicy(policy, ms);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => res('timeout'), frameTimeoutMs);
    });
    const outcome = await Promise.race([expired.then(() => 'expired' as const), watchdog]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      pendingExpiry = null;
      stalls++;
      if (stalls <= 3) {
        log.warn(
          `virtual time did not expire within ${frameTimeoutMs}ms of real time — the page is ` +
            `starving its task queue${opts.waitForNetwork ? ' or holding a network fetch' : ''}. ` +
            `Pausing and continuing; the frame may be early.`,
        );
      }
      await setPolicy('pause').catch(() => {
        /* page may be gone */
      });
    }
  }

  /**
   * Before capture starts the clock must keep moving on its own: `page.goto`,
   * the stage's `waitForSelector('body')` and the bridge's
   * `waitForFunction('!!window.__demo')` all wait on the page, and the page
   * cannot make progress against a stopped clock. We pump budgets that track
   * real time instead of letting virtual time run free — an idle page
   * fast-forwards to its next timer, so an ungoverned boot would burn minutes of
   * virtual time in seconds and the app would open on a scene that had already
   * been running for an hour.
   */
  let pump: Promise<void> = Promise.resolve();
  function startBootPump(): void {
    const t0 = Date.now();
    let granted = 0;
    pump = (async () => {
      while (mode === 'boot') {
        const behind = Date.now() - t0 - granted;
        if (behind >= BOOT_TICK_MS) {
          const chunk = Math.min(behind, BOOT_MAX_CHUNK_MS);
          try {
            await spend(chunk);
          } catch (e) {
            log.debug('boot pump stopped', e);
            return;
          }
          granted += chunk;
        } else {
          await sleep(BOOT_TICK_MS);
        }
      }
    })();
  }

  /**
   * One explicit screenshot per frame — no screencast, no heartbeat, no waiting
   * for the page to decide to paint.
   *
   * The tempting assumption is that `Page.captureScreenshot` forces a commit and
   * therefore always returns. It does not: it waits for a frame that *includes*
   * the current content, and with virtual time paused the compositor may never
   * produce one, so the call hangs silently and forever. That is what
   * DETERMINISTIC_BROWSER_ARGS fixes and what the watchdog below covers when
   * gifsmith could not pass those flags (attach mode).
   */
  async function capture(): Promise<void> {
    // `stop()` waits at most 250ms for a pump that is mid-frame and then detaches
    // CDP, so a screenshot CAN still be in flight when the render moves on. What
    // must not happen is that frame landing afterwards: the Director has already
    // read `frames` (by reference) and pacing globs this directory by pattern, so
    // a late arrival is a frame the encode half-sees and the count disagrees
    // about. The window is closed at both ends — nothing starts once stopped, and
    // anything already started is discarded rather than written.
    if (stopped()) return;
    const index = frames.length;
    const file = path.join(framesDir, String(index).padStart(5, '0') + ext);
    const shot = (client.send('Page.captureScreenshot' as never, {
      format,
      // Only meaningful for jpeg; CDP ignores it for png, but sending a quality
      // with a lossless format is a confusing thing to read in a protocol log.
      ...(format === 'jpeg' ? { quality } : {}),
      captureBeyondViewport: false,
      fromSurface: true,
    } as never) as unknown as Promise<{ data: string }>).then(
      (s) => s,
      () => null,
    );
    // A screenshot that waits on a frame the paused compositor will never
    // produce hangs with no error at all (see DETERMINISTIC_BROWSER_ARGS), so it
    // gets the same real-time watchdog the budget does. If it fires we repeat
    // the previous frame: a held frame is a visible glitch, a hung render is not
    // even a bug report.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const got = await Promise.race([
      shot,
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), frameTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (stopped()) return; // the render ended while this was in flight
    if (!got) {
      shotStalls++;
      if (shotStalls === 1) {
        log.warn(
          `screenshot stalled at frame ${index}. The browser must be launched with ` +
            `${DETERMINISTIC_BROWSER_ARGS[0]} for deterministic capture — gifsmith adds it ` +
            `automatically in launch mode, but an attached app has to be started with it.`,
        );
      }
      if (index === 0) return; // nothing to repeat yet; drop the frame entirely
      fs.copyFileSync(frames[index - 1], file);
    } else {
      fs.writeFileSync(file, Buffer.from(got.data, 'base64'));
    }
    frames.push(file);
    // Output-clock seconds. Uniform by construction — nothing downstream has to
    // infer a cadence from jitter, because there is none to infer.
    timestamps.push(index / fps);
    // A deterministic render is three CDP round-trips per frame and is meant to
    // be slow; without a pulse it is indistinguishable from a hang.
    if (index > 0 && index % (fps * 2) === 0) {
      log.step('capture', `${index} frames · ${(index / fps).toFixed(1)}s of output`);
    }
  }

  // The scene clock's arithmetic — frame boundaries, waiters, and the single
  // pump that makes a `parallel` beat cost the longest branch instead of the
  // sum. See ./schedule.ts, which owns all of it and none of the CDP.
  // Kept, not just logged: the render must fail on it (see captureError). The
  // FIRST one is the one that explains the others — everything after a dead CDP
  // session is a consequence of it.
  let pumpError: unknown = null;
  const scheduler = createFrameScheduler({
    frameMs,
    spend,
    capture,
    onError: (e) => {
      // A pump unwinding after stop() is the render ending, not a failure.
      if (stopped()) return;
      if (pumpError == null) pumpError = e;
      log.warn('deterministic capture stopped advancing:', (e as Error)?.message ?? e);
    },
  });
  const advance = scheduler.advance;

  const clock: Clock = {
    kind: 'virtual',
    frameMs,
    advance,
    nowMs: () => scheduler.nowMs() - originMs,
    mark: () => {
      originMs = scheduler.nowMs();
    },
    async settle(p: Promise<unknown>, capMs: number): Promise<boolean> {
      let done = false;
      void Promise.resolve(p).then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      // Give an already-settled promise its turn before spending a frame on it.
      await new Promise((r) => setImmediate(r));
      let spent = 0;
      while (!done && spent < capMs && !scheduler.isStopped()) {
        await advance(frameMs);
        spent += frameMs;
      }
      return done;
    },
  };

  async function freeze(): Promise<void> {
    if (mode !== 'boot') return;
    mode = 'scene';
    await pump.catch(() => {
      /* already reported */
    });
    await setPolicy('pause').catch(() => {
      /* page may be gone */
    });
    scheduler.reset();
    originMs = 0;
    log.step(
      'capture',
      `deterministic — ${fps}fps × speed ${speed} = ${frameMs.toFixed(1)}ms of scene time per frame`,
    );
  }

  let didStop = false;
  async function stop(): Promise<void> {
    if (didStop) return; // idempotent: the Director calls this on success and again in finally
    didStop = true;
    mode = 'stopped';
    wallEnd = Date.now();
    scheduler.stop(); // nothing may still be waiting on a clock that has stopped
    await pump.catch(() => {
      /* ignore */
    });
    // Let a pump that is mid-frame finish writing it, but never wait on one that
    // is blocked on a budget the page will not spend — the frame watchdog is
    // measured in seconds and the render is over.
    await Promise.race([scheduler.drain(), sleep(250)]);
    // Hand the page its real clock back. This matters most in attach mode, where
    // the app outlives the render: leaving it frozen would look like a crash.
    try {
      await setPolicy('advance');
    } catch {
      /* ignore */
    }
    try {
      await client.detach();
    } catch {
      /* ignore */
    }
    if (stalls) log.warn(`${stalls} budget(s) hit the ${frameTimeoutMs}ms real-time watchdog`);
    if (shotStalls) log.warn(`${shotStalls} frame(s) repeated because the screenshot stalled`);
    log.step('capture', `${frames.length} frames (${(frames.length / fps).toFixed(2)}s of output)`);
  }

  function realFps(): number {
    const ms = (wallEnd || Date.now()) - wallStart;
    return ms > 0 ? (frames.length * 1000) / ms : 0;
  }

  // Armed *before* the Director navigates, so the app's boot happens on the
  // virtual clock rather than the real one — otherwise the first seconds of the
  // scene are exactly the non-deterministic thing this backend exists to remove.
  await setPolicy('pause');
  startBootPump();
  log.step('capture', 'virtual time armed (the page boots on the virtual clock)');

  return { client, frames, timestamps, stop, clock, freeze, realFps, captureError: () => pumpError };
}
