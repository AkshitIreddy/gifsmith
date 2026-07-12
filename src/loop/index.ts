/**
 * Loop planning. Given the paced frames and the chosen strategy, produce a
 * concrete set of PNG loop frames the encoder turns into a GIF/WebP.
 *
 *   auto      → anchor if the timeline declared a loopAnchor, else crossfade
 *   anchor    → trim to the best hold-to-hold seam (artifact-free)
 *   crossfade → half-period self-crossfade, materialized to PNG frames
 *   none      → straight clip, no looping
 *
 * The crossfade blend is rendered to its own PNG sequence in one ffmpeg pass
 * (rather than blended live into the final encoder) — two image2 inputs feeding
 * libwebp_anim can deadlock, and materializing means every downstream encoder
 * gets one simple frame sequence.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LoopStrategy } from '../types.js';
import { Logger } from '../log.js';
import { run } from '../encode/ffmpeg.js';
import { thumbnails, mse } from './mse.js';
import { findAnchorLoop } from './anchor.js';
import { prepareCrossfade } from './crossfade.js';

export interface LoopPlan {
  /** Directory of the final loop frames as %05d.png. */
  dir: string;
  fps: number;
  frameCount: number;
  strategy: LoopStrategy;
  /** Loop-seam MSE for reporting (null when the seam is removed by crossfade). */
  seamMSE: number | null;
  anchorFrame?: number;
  endFrame?: number;
}

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
    return { dir: pacedDir, fps, frameCount: n, strategy, seamMSE: 0 };
  }

  if (strategy === 'none') {
    const thumbs = await thumbnails(pacedDir);
    const seam = mse(thumbs[0], thumbs[n - 1]);
    return { dir: pacedDir, fps, frameCount: n, strategy, seamMSE: seam };
  }

  if (strategy === 'crossfade') {
    const prep = prepareCrossfade(pacedDir, pacedFrames);
    const blendDir = path.join(path.dirname(pacedDir), 'blend');
    fs.rmSync(blendDir, { recursive: true, force: true });
    fs.mkdirSync(blendDir, { recursive: true });
    // One pass: paced frames + their half-period rotation → the blended loop.
    await run([
      '-y',
      '-thread_queue_size', '1024', '-framerate', String(fps), '-start_number', '0', '-i', path.join(pacedDir, '%05d.png'),
      '-thread_queue_size', '1024', '-framerate', String(fps), '-start_number', '0', '-i', path.join(prep.rotDir, '%05d.png'),
      '-filter_complex', prep.blendFilter,
      '-start_number', '0',
      path.join(blendDir, '%05d.png'),
    ]);
    const blended = fs.readdirSync(blendDir).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(blendDir, f));
    log.step('loop', `crossfade over ${blended.length} frames`);
    return { dir: blendDir, fps, frameCount: blended.length, strategy, seamMSE: null };
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
    dir: loopDir,
    fps,
    frameCount: j,
    strategy,
    seamMSE: found.seamMSE,
    anchorFrame: found.start,
    endFrame: found.end,
  };
}
