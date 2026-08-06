/**
 * The frame scheduler — the arithmetic half of deterministic capture.
 *
 * Everything in here is bookkeeping: where the next frame boundary is, who is
 * waiting for which scene-time deadline, and which of those a step forward
 * satisfies. It knows nothing about Chromium, virtual time or screenshots. The
 * two things it does to the outside world go through callbacks — `spend(ms)`
 * ("make the page live through ms of scene time") and `capture(atMs)` ("record a
 * frame now") — which is what lets the three properties that actually matter be
 * checked in milliseconds by a test with no browser in it:
 *
 *   - exactly one frame per frame interval,
 *   - no drift: frame 5000 lands on 5000 × frameMs, not near it,
 *   - a parallel beat costs the LONGEST branch, not the sum.
 *
 * That last one is why advancing is scheduled rather than immediate, and it is
 * the reason this is a pump and not a loop.
 *
 * Two timeline branches running concurrently each call `advance`, and if each
 * one spent its own budget the scene would consume the SUM of their durations —
 * a two-branch parallel of 1s and 1s would render two seconds — besides racing
 * over the single outstanding-budget slot the CDP half maintains. So callers do
 * not advance the clock; they declare a scene-time deadline and wait. One pump
 * walks the clock forward to the nearest deadline, capturing every frame
 * boundary it crosses, and wakes whoever that satisfied. Concurrent branches
 * therefore share one timeline and the beat costs the longest of them, which is
 * exactly what `parallel` means on the real clock.
 */

const EPS = 1e-6;

export interface FrameSchedulerOptions {
  /** Scene ms between captured frames. */
  frameMs: number;
  /** Let the page live through `ms` of scene time. */
  spend(ms: number): Promise<void>;
  /** Record a frame; `atMs` is the scene time of the boundary it lands on. */
  capture(atMs: number): Promise<void>;
  /** Reported when the pump dies mid-scene; every waiter is released after it. */
  onError?(e: unknown): void;
}

export interface FrameScheduler {
  /** Move scene time forward by `ms`, capturing every boundary crossed. */
  advance(ms: number): Promise<void>;
  /** Scene ms spent so far. */
  nowMs(): number;
  /** Frame boundaries crossed so far — one `capture()` call each. */
  frames(): number;
  /** Re-zero the clock and the frame grid (the Director calls this at freeze). */
  reset(): void;
  /** Refuse further advances and release everyone still waiting. Idempotent. */
  stop(): void;
  /** Whether `stop()` has been called. */
  isStopped(): boolean;
  /** Resolves once the pump is idle — nothing in flight, nothing waiting. */
  drain(): Promise<void>;
}

interface Waiter {
  deadline: number;
  wake: () => void;
}

export function createFrameScheduler(opts: FrameSchedulerOptions): FrameScheduler {
  const frameMs = opts.frameMs > 0 ? opts.frameMs : 1;
  let virtualMs = 0;
  let nextFrameAtMs = 0;
  let framesOut = 0;
  let stopped = false;

  const waiters: Waiter[] = [];
  let pumping: Promise<void> | null = null;

  function wakeReady(all = false): void {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (all || stopped || waiters[i].deadline <= virtualMs + EPS) {
        waiters.splice(i, 1)[0].wake();
      }
    }
  }

  async function runPump(): Promise<void> {
    try {
      wakeReady();
      while (waiters.length && !stopped) {
        let target = Infinity;
        for (const w of waiters) target = Math.min(target, w.deadline);
        // Capture on frame boundaries and only there. Tracking ABSOLUTE
        // boundaries rather than a per-call remainder is what makes a run of
        // sub-frame advances (a drag's pointer ticks, say) still produce frames
        // at the right moments instead of producing none at all — and what keeps
        // frame 5000 exactly on 5000 × frameMs after five thousand additions.
        if (nextFrameAtMs <= target + EPS) {
          await opts.spend(nextFrameAtMs - virtualMs);
          virtualMs = nextFrameAtMs;
          nextFrameAtMs += frameMs;
          framesOut++;
          await opts.capture(virtualMs);
        } else {
          await opts.spend(target - virtualMs);
          virtualMs = target;
        }
        wakeReady();
      }
    } catch (e) {
      // A dead page or a refused screenshot must not leave the timeline waiting
      // on a deadline that will never arrive; release everyone and let the
      // remaining steps run out on a frozen scene rather than hang the render.
      opts.onError?.(e);
      wakeReady(true);
    } finally {
      pumping = null;
      if (stopped) wakeReady(true);
    }
  }

  function pump(): void {
    if (!pumping) pumping = runPump();
  }

  return {
    async advance(ms: number): Promise<void> {
      if (stopped) return;
      const deadline = virtualMs + Math.max(0, ms);
      const waited = new Promise<void>((wake) => {
        waiters.push({ deadline, wake });
      });
      pump();
      await waited;
    },
    nowMs: () => virtualMs,
    frames: () => framesOut,
    reset(): void {
      virtualMs = 0;
      nextFrameAtMs = 0;
    },
    stop(): void {
      stopped = true;
      wakeReady(true);
    },
    isStopped: () => stopped,
    async drain(): Promise<void> {
      while (pumping) await pumping;
    },
  };
}
