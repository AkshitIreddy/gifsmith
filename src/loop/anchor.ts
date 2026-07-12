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

  const consider = (a: number, e: number): void => {
    if (a < 0 || e >= n || e - a < minCycle) return;
    const d = mse(thumbs[e], thumbs[a]);
    if (d < best) {
      best = d;
      bestStart = a;
      bestEnd = e;
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

  return { start: bestStart, end: bestEnd, seamMSE: best };
}
