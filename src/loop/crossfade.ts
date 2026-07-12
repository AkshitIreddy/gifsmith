/**
 * Half-period self-crossfade loop (Project B) — the headline algorithm, and the
 * piece nobody else ships as a library. For continuously-evolving or ambient
 * motion that never returns to a pose, we blend each frame with its half-period
 * counterpart under a raised-cosine weight:
 *
 *     out[i] = w[i]·frame[i] + (1 − w[i])·frame[(i + N/2) mod N]
 *     w[i]   = 0.5·(1 − cos(2π·i/N))
 *
 * w is 0 at the seam (i = 0) and 1 at the midpoint, so near the wrap the frame
 * is dominated by the half-shifted stream — which is continuous across
 * i = N−1 → 0 — and the loop has no visible jump. The whole clip is a blend of
 * the sequence with a copy of itself offset by half a period, so it is
 * mathematically periodic in N frames, and motion stays continuously *forward*
 * (no ping-pong reversal). Slight ghosting on fast motion → keep choreography
 * gentle (calm reads better anyway).
 *
 * Unlike Project B (which used ImageMagick per-frame), we express the whole
 * blend as a single ffmpeg `blend=all_expr` over two inputs: the paced frames,
 * and a copy rotated by half a period.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface CrossfadePrep {
  rotDir: string;
  frameCount: number;
  /** The ffmpeg `blend` filter fragment: consumes [0:v][1:v], emits the loop. */
  blendFilter: string;
}

export function prepareCrossfade(pacedDir: string, pacedFrames: string[]): CrossfadePrep {
  const n = pacedFrames.length;
  const half = Math.floor(n / 2);
  const rotDir = path.join(path.dirname(pacedDir), 'rot');
  fs.rmSync(rotDir, { recursive: true, force: true });
  fs.mkdirSync(rotDir, { recursive: true });

  for (let i = 0; i < n; i++) {
    const src = pacedFrames[(i + half) % n];
    fs.copyFileSync(src, path.join(rotDir, String(i).padStart(5, '0') + '.png'));
  }

  const w = `(0.5-0.5*cos(2*PI*N/${n}))`;
  const blendFilter =
    `[0:v][1:v]blend=all_expr='A*${w}+B*(1-${w})'`;

  return { rotDir, frameCount: n, blendFilter };
}
