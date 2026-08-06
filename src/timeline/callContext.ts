/**
 * The clock, handed to an author callback — and the watchdog that stands behind
 * it.
 *
 * `t.call()` is where every non-trivial scene does its real work: blur the
 * editor, press a key, wait for the animation, seed some data. Every one of
 * those waits, and until now the callback had no way to wait that the renderer
 * understood. It got the raw Page, so it waited the only way JavaScript knows —
 * `await new Promise(r => setTimeout(r, 1900))` — which measures the *machine*,
 * the one thing the deterministic backend exists to remove. Under a virtual
 * clock it is worse than inaccurate: those 1900ms buy zero rendered frames, so
 * the animation the author was waiting for is not merely mistimed, it is not in
 * the output at all.
 *
 * So the callback now receives the clock as a second argument, with the same two
 * verbs the player uses for every beat of its own: `advance` for time you mean
 * to spend, `settle` for a promise that can only resolve while the page paints.
 * Under the real clock they are `setTimeout` and `await`, byte for byte what the
 * screencast path always did.
 *
 * Four defences, because a renderer that hangs with no output is the worst
 * failure it can have and an author cannot be expected to remember a rule.
 * (Four, and this line said three while listing four of them — the count is
 * quoted in the README and in test/README.md too, so all of them say four now.)
 *
 *  - `settle` has a scene-time cap and THROWS when it runs out, naming the step.
 *  - a callback that stops asking the clock for anything is presumed stuck: the
 *    stall watchdog fails the render with the same name, and says what to do.
 *  - `advance` fails when the clock stops moving under it, rather than spinning
 *    on a dead clock forever — the one stall the watchdog above cannot see,
 *    because `advance` itself is what keeps petting it.
 *  - a callback that burned real time without asking the clock for it is
 *    reported after the fact — the raw-`setTimeout` mistake exactly, which is
 *    not fatal (the render finishes) but is invisible in the output, so it must
 *    not be silent.
 *
 * None of the four exists on the real clock. Adding a new way for the default
 * path to fail would be a poor trade for a diagnostic it does not need.
 */
import type { Page } from 'puppeteer-core';
import type { CallContext, PageCallback } from '../types.js';
import type { Clock } from './clock.js';
import { Logger } from '../log.js';

/** Scene-time cap for `ctx.settle()` when the caller does not name one. */
export const DEFAULT_SETTLE_CAP_MS = 10_000;

/**
 * Real ms a callback may go without touching the clock before it is presumed
 * stuck. Generous: a legitimate `ctx.advance(20_000)` is hundreds of rendered
 * frames and can easily outlast this in real time — which is why the clock verbs
 * beat as they work, rather than only at their edges.
 */
export const DEFAULT_STALL_MS = 30_000;

/** Scene ms per beat inside a long `advance`, so the watchdog sees progress. */
const BEAT_CHUNK_MS = 500;

/**
 * Real ms of unclocked waiting worth reporting. Below this it is a callback
 * doing its job (a couple of CDP round trips); above it, it is a sleep.
 */
const IDLE_REPORT_MS = 400;

/**
 * Consecutive chunks `advance` may ask for and not receive before it declares
 * the clock dead.
 *
 * More than one because a clock is allowed a no-op tick — the scheduler resolves
 * a waiter the instant its deadline is met, so a chunk of ~0 scene time is a
 * legitimate (if pointless) round trip. More than none because a clock that has
 * genuinely stopped never starts again: `stop()` is one-way, and a pump that
 * died on a detached CDP session dies again on the next advance. Three is
 * "twice was not a fluke", and it costs three promise ticks.
 */
const MAX_DEAD_CHUNKS = 3;

const EPS = 1e-6;

export interface RunCallOptions {
  clock: Clock;
  log: Logger;
  /** How this beat is named in every message it can produce. */
  label: string;
  /** Real-time stall watchdog (virtual clock only). */
  stallMs?: number;
}

/** The real clock's context: the two verbs, unwrapped. */
function realContext(clock: Clock): CallContext {
  return {
    clock: 'real',
    frameMs: 0,
    nowMs: () => clock.nowMs(),
    advance: (ms: number) => clock.advance(ms),
    settle: <T>(p: Promise<T>) => Promise.resolve(p),
  };
}

/**
 * What the guards need to know about, and the only channel between the context
 * and the bookkeeping in `runCall`.
 *
 * `enter`/`leave` bracket every clock verb, which is what makes the *unclocked*
 * stretches measurable: everything outside a bracket is real time the callback
 * spent without asking for any scene time, and a long one of those is the
 * raw-`setTimeout` mistake whether or not the callback also spent scene time
 * elsewhere. `beat` is progress *inside* a verb, and only resets the stall
 * watchdog — a twenty-second hold is not a hang.
 */
interface Guards {
  enter(): void;
  leave(): void;
  beat(): void;
}

/**
 * The virtual clock's context: the two verbs, each one wrapped in the guards
 * that keep the render from ending in silence rather than in a message.
 */
function virtualContext(clock: Clock, label: string, g: Guards): CallContext {
  const step = clock.frameMs > 0 ? clock.frameMs : 16;
  return {
    clock: 'virtual',
    frameMs: clock.frameMs,
    nowMs: () => clock.nowMs(),
    async advance(ms: number): Promise<void> {
      g.enter();
      try {
        // Walked in chunks against an ABSOLUTE target rather than subtracted
        // from a remainder: the chunking exists for the watchdog's benefit and
        // must not be able to accumulate a millisecond of drift over a long
        // hold.
        const target = clock.nowMs() + Math.max(0, ms);
        let dead = 0;
        for (;;) {
          const left = target - clock.nowMs();
          if (left <= EPS) return;
          const before = clock.nowMs();
          await clock.advance(Math.min(left, BEAT_CHUNK_MS));
          if (clock.nowMs() - before > EPS) {
            dead = 0;
            // Only real movement pets the watchdog. Beating on a dead clock is
            // how this loop used to be invisible: it spun forever at full tilt
            // while telling the watchdog everything was fine.
            g.beat();
            continue;
          }
          if (++dead >= MAX_DEAD_CHUNKS) throw new Error(deadClockMessage(label, left));
        }
      } finally {
        g.leave();
      }
    },
    async settle<T>(p: Promise<T>, opts?: { capMs?: number; label?: string }): Promise<T> {
      g.enter();
      try {
        const cap = opts?.capMs ?? DEFAULT_SETTLE_CAP_MS;
        let done = false;
        let value: T | undefined;
        let failure: unknown;
        let failed = false;
        void Promise.resolve(p).then(
          (v) => { value = v; done = true; },
          (e) => { failure = e; failed = true; done = true; },
        );
        // An already-settled promise gets its turn before we spend a frame on it.
        await new Promise((r) => setImmediate(r));
        let spent = 0;
        // `spent` counts what was ASKED for, so this loop terminates on the cap
        // even against a clock that has stopped moving — a settle on a dead
        // clock ends as a settle that timed out, which is true and is already
        // the message the author needs.
        while (!done && spent < cap) {
          await clock.advance(step);
          spent += step;
          g.beat();
        }
        if (!done) {
          throw new Error(
            `gifsmith: ${label}: ctx.settle() gave up after ${Math.round(cap)}ms of scene time. ` +
              `Whatever it was waiting for never happened while the scene ran` +
              (opts?.label ? ` (${opts.label})` : '') +
              `. Raise the cap with ctx.settle(p, { capMs }) if the wait is genuinely that long.`,
          );
        }
        if (failed) throw failure;
        return value as T;
      } finally {
        g.leave();
      }
    },
  };
}

/**
 * Run one `call` step's callback with the clock it needs and the guards it
 * cannot ask for.
 *
 * The real-clock path is deliberately bare: build the context, await the
 * callback, let anything it throws propagate. That is what this step did before
 * the clock seam existed, and the default path does not move.
 */
export async function runCall(
  fn: PageCallback,
  page: Page,
  o: RunCallOptions,
): Promise<void> {
  if (o.clock.kind === 'real') {
    await fn(page, realContext(o.clock));
    return;
  }

  const stallMs = o.stallMs ?? DEFAULT_STALL_MS;
  const startedReal = Date.now();
  let lastBeat = Date.now();
  let usedClock = false;
  // The longest single stretch of real time the callback spent without asking
  // the clock for anything, and where it started. Measuring the LONGEST GAP
  // rather than the total-with-no-scene-time is the whole of the fix: the shape
  // worth catching is `await ctx.advance(250); await sleep(1900);`, which spends
  // scene time and still renders none of the thing it waited for. The old rule
  // only fired when a callback spent literally zero scene time across its whole
  // run, so the common case was the one it could not see.
  let clockLeftAt = Date.now();
  let worstIdleMs = 0;
  const noteIdle = (): void => {
    worstIdleMs = Math.max(worstIdleMs, Date.now() - clockLeftAt);
  };
  const ctx = virtualContext(o.clock, o.label, {
    enter: () => { usedClock = true; noteIdle(); lastBeat = Date.now(); },
    leave: () => { clockLeftAt = Date.now(); lastBeat = Date.now(); },
    beat: () => { lastBeat = Date.now(); },
  });

  let settledOrThrew = false;
  const ran = Promise.resolve(fn(page, ctx)).finally(() => { settledOrThrew = true; });
  // If the watchdog wins the race below, this promise is still outstanding and
  // may reject later with nobody left listening. A second, discarding handler
  // keeps that from surfacing as an unhandled rejection on top of the real
  // error; the race still sees the rejection, because a promise may have many
  // handlers and this one changes nothing but the bookkeeping.
  void ran.catch(() => undefined);
  let timer: ReturnType<typeof setInterval> | undefined;
  const stall = new Promise<never>((_res, rej) => {
    timer = setInterval(() => {
      if (settledOrThrew) return;
      if (Date.now() - lastBeat > stallMs) rej(new Error(stallMessage(o.label, stallMs, usedClock)));
    }, Math.max(50, Math.min(500, stallMs / 4)));
    // Deliberately NOT unref'd. If the callback is stuck on a promise that will
    // never settle and nothing else is pending, an unref'd watchdog lets Node
    // exit quietly with code 0 — a renderer that produces no output and no
    // error, which is the exact failure this whole file exists to prevent. The
    // interval is cleared in the `finally` below, so it cannot outlive the step.
  });
  try {
    await Promise.race([ran, stall]);
  } finally {
    if (timer) clearInterval(timer);
  }

  // The quiet failure: it did finish, it just did not render the part it was
  // waiting through. Worth a line, never worth failing a render over — those
  // frames are missing from the output, not wrong in it.
  noteIdle(); // the stretch after the last clock verb (or the whole run)
  if (worstIdleMs >= IDLE_REPORT_MS) {
    const realMs = Date.now() - startedReal;
    o.log.warn(
      `${o.label} spent ${worstIdleMs}ms of real time in one stretch without asking the clock ` +
        `for anything${usedClock ? ` (of ${realMs}ms in the callback)` : ''}. Under ` +
        `capture:'deterministic' scene time is paused there, so that wait rendered zero frames ` +
        `and whatever it was waiting for — a raw setTimeout, an animation — is not in the ` +
        `output. Spend it on the clock instead: await ctx.advance(${worstIdleMs}) for time you ` +
        `mean to pass, or await ctx.settle(p) for a promise that needs the page to paint. ` +
        `(Harmless if that wait genuinely needed no scene time — a slow CDP round trip, say.)`,
    );
  }
}

function deadClockMessage(label: string, leftMs: number): string {
  return (
    `gifsmith: ${label}: ctx.advance() asked for scene time and the clock did not move, ` +
    `${Math.round(leftMs)}ms short of the span it was given. Under capture:'deterministic' that ` +
    `means capture stopped advancing — a dead frame pump, a detached CDP session, or a page ` +
    `that went away — so no further frame can ever be rendered and the rest of this scene ` +
    `would be spent spinning on a stopped clock.`
  );
}

function stallMessage(label: string, stallMs: number, usedClock: boolean): string {
  return (
    `gifsmith: ${label} has not asked the clock for anything in ${stallMs}ms of real time, under ` +
    `capture:'deterministic'. Scene time is paused inside a callback, so anything that needs the ` +
    `page to make progress — an awaited async page.evaluate, waitForSelector, an in-page ` +
    `animation — can never finish here.\n` +
    (usedClock
      ? '  This callback did use ctx earlier, so the wait that is stuck is a later one.\n'
      : '  This callback never used ctx at all.\n') +
    '  Give it the clock:\n' +
    '    t.call(async (page, ctx) => {\n' +
    '      await ctx.settle(page.evaluate(async () => { await app.ready; }));\n' +
    '      await ctx.advance(250);   // 250ms of scene time, actually rendered\n' +
    '    });\n' +
    "  (The default screencast path is unaffected: there ctx.advance IS setTimeout and " +
    'ctx.settle IS await.)'
  );
}
