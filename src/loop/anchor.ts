/**
 * Scripted-anchor loop (Project A). When the timeline declares a `loopAnchor`
 * — a neutral pose/state the scene returns to — we search a small window of
 * start frames near that anchor against every candidate end frame, and pick the
 * pair whose thumbnails match most closely. Trimming to that hold-to-hold seam
 * yields a loop with *zero* blending artifacts: the last frame and the first
 * frame are genuinely the same moment. Best for scripted product demos.
 */
import { mse } from './mse.js';

export interface AnchorLoop {
  start: number;
  end: number; // exclusive
  seamMSE: number;
}

export interface AnchorSearchOpts {
  /** Frame index the loopAnchor cue fired at (center of the search window). */
  anchorFrame: number;
  /** Total paced frames. */
  frameCount: number;
  /** Uniform fps (used to size the minimum cycle and search window). */
  fps: number;
  /** Minimum loop length in seconds (ignore matches shorter than a full cycle). */
  minCycleSeconds?: number;
}

export function findAnchorLoop(
  thumbs: Uint8Array[],
  opts: AnchorSearchOpts,
): AnchorLoop {
  const n = opts.frameCount;
  // Clamp the minimum cycle to at most n-1 so a search is always possible for
  // n >= 2 (a short clip must never fall through to a fabricated result).
  const minCycle = Math.min(
    Math.max(1, Math.round((opts.minCycleSeconds ?? 3) * opts.fps)),
    Math.max(1, n - 1),
  );
  // Search a ± ~0.6s window of frames around the anchor, so we are robust to
  // exactly which frame the hold settled on.
  const win = Math.max(2, Math.round(opts.fps * 0.6));

  // Seed with a valid, honestly-measured pair — we never invent a score. This
  // guarantees the reported seamMSE reflects a real wrap, so the Director's
  // high-seam warning can fire when the loop is poor.
  let bestStart = Math.max(0, Math.min(opts.anchorFrame, n - minCycle - 1));
  let bestEnd = n - 1;
  let best = mse(thumbs[bestEnd], thumbs[bestStart]);
  /** The MSE of the pair actually chosen, which may differ from the minimum. */
  let bestScore = best;

  /*
   * LOWEST MSE, THEN LONGEST SPAN — and the second half of that is the whole
   * point.
   *
   * Picking the globally-lowest MSE alone is wrong for the scripted demos this
   * strategy exists for. A product tour holds still on its neutral pose for a
   * beat after `loopAnchor()`, so every pair of frames inside that hold matches
   * almost perfectly; the search then returns the SHORTEST qualifying loop —
   * `minCycle` seconds of a motionless scene — and throws the tour away.
   * Observed on a 50-second walkthrough that returned home exactly as intended:
   * anchor 45, end 105, seam MSE 0.0, a four-second clip of a bookshelf doing
   * nothing.
   *
   * Two seams a hair apart in MSE are equally invisible — the metric stops
   * discriminating long before the eye does. So a seam within `TIE` of the best
   * one is treated as just as good, and among those the LONGEST wins. That
   * encodes the author's actual intent: if several wraps are invisible, use as
   * much of the scene as possible.
   */
  const TIE = 0.75;
  const consider = (a: number, e: number): void => {
    if (a < 0 || e >= n || e - a < minCycle) return;
    const d = mse(thumbs[e], thumbs[a]);
    const span = e - a;
    const bestSpan = bestEnd - bestStart;
    // Strictly better seam, or an equally-invisible one that keeps more scene.
    if (d < best - TIE || (d <= best + TIE && span > bestSpan)) {
      // Track the true minimum so the reported seamMSE stays honest even when
      // a marginally-worse-but-longer wrap is chosen.
      best = Math.min(best, d);
      bestStart = a;
      bestEnd = e;
      bestScore = d;
    }
  };

  // Case A — the anchor is the loop START: search starts near it, ends after.
  const aLo = Math.max(0, opts.anchorFrame - win);
  const aHi = Math.min(n - minCycle - 1, opts.anchorFrame + win);
  for (let a = aLo; a <= aHi; a++) {
    for (let e = a + minCycle; e < n; e++) consider(a, e);
  }
  // Case B — the anchor is the loop END (the return point): search ends near
  // it, starts from the head. Handles a loopAnchor() placed late in the timeline.
  const eLo = Math.max(minCycle, opts.anchorFrame - win);
  const eHi = Math.min(n - 1, opts.anchorFrame + win);
  for (let e = eLo; e <= eHi; e++) {
    for (let a = 0; a <= e - minCycle; a++) consider(a, e);
  }

  // The seam that will actually be shown, not the best one seen on the way —
  // the Director's "seam too high" warning has to be about the real wrap.
  return { start: bestStart, end: bestEnd, seamMSE: bestScore };
}
