/**
 * Resolve a LoopPlan into ffmpeg input args. Every plan is now a single PNG
 * sequence (the crossfade blend is materialized upstream in loop/), so the
 * encoders share one simple input path — no dual-input filter graphs.
 */
import path from 'node:path';
import type { LoopPlan } from '../loop/index.js';

export interface FfmpegSource {
  inputs: string[];
  fps: number;
}

export function resolveSource(plan: LoopPlan): FfmpegSource {
  return {
    inputs: ['-framerate', String(plan.fps), '-start_number', '0', '-i', path.join(plan.dir, '%05d.png')],
    fps: plan.fps,
  };
}
