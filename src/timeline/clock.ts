/**
 * The clock seam.
 *
 * The player used to sleep. `hold(2)` was `setTimeout(2000)`, a cursor glide was
 * an in-page rAF tween we simply awaited, a drag was a burst of pointer moves
 * spaced by more `setTimeout`. Every one of those measured the *machine*, so the
 * output inherited whatever the machine did while it recorded: on the app this
 * was built for, a 904ms main-thread stall opening a panel and a 1147ms artwork
 * re-bake landed in the GIF as ~2 seconds of frozen frames, recorded faithfully.
 *
 * An offline renderer does not work that way. Blender does not care that your
 * machine took four seconds on frame 12 — render time is not playback time. So
 * the player no longer measures time at all. It asks a clock to *advance*, and
 * the clock decides what advancing means:
 *
 *   realClock          `advance(ms)` sleeps ms, `settle()` is a plain await.
 *                      This is exactly what the player did before the seam
 *                      existed, and it is what the default screencast path
 *                      still uses — so nothing about that path moved.
 *
 *   the deterministic  `advance(ms)` grants the page exactly ms of Chromium
 *   backend's clock    *virtual* time and screenshots each frame boundary it
 *                      crosses. A main-thread stall burns real seconds and
 *                      ~zero virtual ones, so it cannot reach the output.
 *
 * Two members are less obvious than `advance` and carry real weight:
 *
 * `nowMs()` — cues and the loop anchor record *when* they happened, and the loop
 * planner turns the anchor into a frame index. Read off the wall clock under a
 * virtual clock that number is far too large (that is the entire point of
 * virtual time), the anchor clamps to the last frame, the seam is searched in
 * the wrong place, and you get a bad loop out of a render that reported success.
 * So elapsed time is a question for the clock, never for `Date.now()`.
 *
 * `settle()` — the player awaits four kinds of promise that can only resolve if
 * the page keeps painting: in-page rAF tweens (cursor glide, scroll, actorMove),
 * and puppeteer's in-page pollers (`waitForSelector`). Awaiting one of those
 * against a stopped clock is a deadlock with no timeout attached, so the render
 * would hang rather than fail. `settle` inverts it: the caller starts the work
 * *without* awaiting, hands the promise here, and the clock moves scene time
 * forward in frame-sized steps until the promise resolves or the cap is spent.
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface Clock {
  /**
   * `real` — scene time is wall-clock time and passes on its own.
   * `virtual` — scene time only exists because we spend it, one frame at a time.
   *
   * Steps branch on this where the two genuinely need different choreography
   * (typing, dragging, waiting): under a virtual clock a Node-side `setTimeout`
   * between keystrokes separates them by zero scene time, so the typing
   * animation would vanish from the output entirely.
   */
  readonly kind: 'real' | 'virtual';
  /**
   * Scene ms per captured frame, or 0 when there is no quantum (real time).
   * Steps that emit a burst of input use it to put exactly one event between
   * two frames — Chromium coalesces pointer moves that arrive within one frame,
   * so an un-spaced burst arrives as a single jump.
   */
  readonly frameMs: number;
  /** Move scene time forward by `ms`. */
  advance(ms: number): Promise<void>;
  /** Scene ms elapsed since `mark()` (or since the clock was created). */
  nowMs(): number;
  /** Re-zero the scene-time origin — the director calls this as capture starts. */
  mark(): void;
  /**
   * Await something that can only settle while the scene keeps moving.
   * Resolves `true` if it settled, `false` if `capMs` of scene time ran out
   * first. The real clock ignores the cap and simply awaits, because that is
   * what the player did before and a new timeout on the default path would be a
   * new way for a working render to fail.
   */
  settle(p: Promise<unknown>, capMs: number): Promise<boolean>;
}

/**
 * Scene time is wall-clock time. `originMs` exists so a context built before
 * this seam existed (snapshot/contactSheet, which set `startMs` themselves)
 * reports exactly the elapsed times it always did.
 */
export function realClock(originMs: number = Date.now()): Clock {
  let origin = originMs;
  return {
    kind: 'real',
    frameMs: 0,
    async advance(ms: number): Promise<void> {
      await sleep(ms);
    },
    nowMs(): number {
      return Date.now() - origin;
    },
    mark(): void {
      origin = Date.now();
    },
    async settle(p: Promise<unknown>): Promise<boolean> {
      await p;
      return true;
    },
  };
}
