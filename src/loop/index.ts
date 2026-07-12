/**
 * Loop planning. Given the paced frames and the chosen strategy, decide how the
 * seamless loop is built and hand the encoder a concrete plan.
 *
 *   auto      → anchor if the timeline declared a loopAnchor, else crossfade
 *   anchor    → trim to the best hold-to-hold seam (artifact-free)
 *   crossfade → half-period self-crossfade (works on any ambient clip)
 *   none      → straight clip, no looping
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LoopStrategy } from '../types.js';
import { Logger } from '../log.js';
import { thumbnails, mse } from './mse.js';
import { findAnchorLoop } from './anchor.js';
import { prepareCrossfade } from './crossfade.js';

export type LoopPlan =
  | {
      kind: 'frames';
      dir: string;
      fps: number;
      frameCount: number;
      strategy: LoopStrategy;
      seamMSE: number | null;
      anchorFrame?: number;
      endFrame?: number;
    }
  | {
      kind: 'crossfade';
      pacedDir: string;
      rotDir: string;
      blendFilter: string;
      fps: number;
      frameCount: number;
      strategy: LoopStrategy;
      seamMSE: number | null;
    };

export interface PlanLoopArgs {
  strategy: LoopStrategy;
  pacedDir: string;
  pacedFrames: string[];
  fps: number;
  speed: number;
  hasLoopAnchor: boolean;
  /** Wall-clock seconds (unscaled) from capture start to the loopAnchor cue. */
  anchorSeconds: number | null;
  minCycleSeconds?: number;
  log: Logger;
}

export async function planLoop(args: PlanLoopArgs): Promise<LoopPlan> {
  const { pacedDir, pacedFrames, fps, log } = args;
  const n = pacedFrames.length;

  let strategy = args.strategy;
  if (strategy === 'auto') {
    strategy = args.hasLoopAnchor && args.anchorSeconds != null ? 'anchor' : 'crossfade';
    log.step('loop', `auto → ${strategy}`);
  }

  // Degenerate case: with fewer than 2 frames there is nothing to loop over.
  // Emit the single paced frame as a straight clip so the encoder never sees an
  // empty sequence (which would make ffmpeg fail).
  if (n < 2) {
    log.warn(`only ${n} paced frame(s); emitting a still clip (no loop).`);
    return { kind: 'frames', dir: pacedDir, fps, frameCount: n, strategy, seamMSE: 0 };
  }

  if (strategy === 'none') {
    const thumbs = await thumbnails(pacedDir);
    const seam = n > 1 ? mse(thumbs[0], thumbs[n - 1]) : 0;
    return { kind: 'frames', dir: pacedDir, fps, frameCount: n, strategy, seamMSE: seam };
  }

  if (strategy === 'crossfade') {
    const prep = prepareCrossfade(pacedDir, pacedFrames);
    log.step('loop', `crossfade over ${prep.frameCount} frames`);
    return {
      kind: 'crossfade',
      pacedDir,
      rotDir: prep.rotDir,
      blendFilter: prep.blendFilter,
      fps,
      frameCount: prep.frameCount,
      strategy,
      seamMSE: null,
    };
  }

  // anchor
  const thumbs = await thumbnails(pacedDir);
  const anchorFrame =
    args.anchorSeconds != null
      ? Math.max(0, Math.min(n - 1, Math.round((args.anchorSeconds / args.speed) * fps)))
      : Math.round(n * 0.1);
  const found = findAnchorLoop(thumbs, {
    anchorFrame,
    frameCount: n,
    fps,
    minCycleSeconds: args.minCycleSeconds,
  });
  log.step(
    'loop',
    `anchor start=${found.start} end=${found.end} span=${found.end - found.start} mse=${found.seamMSE.toFixed(1)}`,
  );

  // Materialize the trimmed range as a fresh, renumbered PNG sequence.
  const loopDir = path.join(path.dirname(pacedDir), 'loop');
  fs.rmSync(loopDir, { recursive: true, force: true });
  fs.mkdirSync(loopDir, { recursive: true });
  let j = 0;
  for (let i = found.start; i < found.end; i++) {
    fs.copyFileSync(pacedFrames[i], path.join(loopDir, String(j++).padStart(5, '0') + '.png'));
  }
  return {
    kind: 'frames',
    dir: loopDir,
    fps,
    frameCount: j,
    strategy,
    seamMSE: found.seamMSE,
    anchorFrame: found.start,
    endFrame: found.end,
  };
}
