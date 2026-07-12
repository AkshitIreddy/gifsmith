/**
 * Resolve a LoopPlan into ffmpeg input args + a leading filter fragment shared
 * by every output format. A `frames` plan is a single PNG sequence; a
 * `crossfade` plan is two sequences (paced + half-period rotation) fused by the
 * blend filter. The format-specific tail (palette for GIF, libwebp for WebP)
 * is appended by the encoder.
 */
import path from 'node:path';
import type { LoopPlan } from '../loop/index.js';

export interface FfmpegSource {
  inputs: string[];
  /** Filter chain that yields the loop stream, WITHOUT a trailing pad label. */
  leadFilter: string;
  /** Whether this must run through -filter_complex (true) or -vf (false). */
  complex: boolean;
  fps: number;
}

export function resolveSource(plan: LoopPlan): FfmpegSource {
  if (plan.kind === 'crossfade') {
    return {
      inputs: [
        '-framerate', String(plan.fps), '-start_number', '0',
        '-i', path.join(plan.pacedDir, '%05d.png'),
        '-framerate', String(plan.fps), '-start_number', '0',
        '-i', path.join(plan.rotDir, '%05d.png'),
      ],
      leadFilter: plan.blendFilter,
      complex: true,
      fps: plan.fps,
    };
  }
  return {
    inputs: [
      '-framerate', String(plan.fps), '-start_number', '0',
      '-i', path.join(plan.dir, '%05d.png'),
    ],
    leadFilter: '',
    complex: false,
    fps: plan.fps,
  };
}
