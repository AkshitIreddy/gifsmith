/**
 * Natural pacing. We keep each captured frame's real timestamp and build an
 * ffmpeg concat list with *per-frame durations* — so holds breathe and motion
 * flows, exactly as it happened, instead of a robotic constant-fps sampling.
 * This is CSS-animation-safe (unlike a virtual clock, which only overrides JS
 * timers and freezes CSS transitions).
 *
 * We then resample that variably-timed stream to a *uniform* fps PNG sequence.
 * That sounds like it throws pacing away, but it doesn't: a 2s hold becomes ~2s
 * of repeated frames (which the palette encoder compresses to almost nothing),
 * and every downstream stage (loop search, crossfade) gets a clean uniform
 * clock. Speed>1 scales every duration down, tightening the whole loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CameraClip } from '../types.js';
import { run } from '../encode/ffmpeg.js';

const MIN_DT = 1 / 60; // clamp floor: never below ~60fps spacing
const MAX_DT = 0.5;    // clamp ceiling: guard against pathological gaps

export interface Paced {
  concatPath: string;
  durations: number[];
  totalSeconds: number;
  achievedFps: number;
}

export function writeConcat(
  framesDir: string,
  frames: string[],
  timestamps: number[],
  speed: number,
): Paced {
  const n = frames.length;
  if (n === 0) throw new Error('gifsmith: no frames captured (did the timeline run?)');

  const lines: string[] = [];
  const durations: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const raw = i < n - 1 ? timestamps[i + 1] - timestamps[i] : 0.4;
    const d = Math.max(MIN_DT, Math.min(MAX_DT, raw)) / speed;
    durations.push(d);
    total += d;
    lines.push(`file '${path.basename(frames[i])}'`);
    lines.push(`duration ${d.toFixed(4)}`);
  }
  // Repeat the last frame so the concat demuxer doesn't drop it.
  lines.push(`file '${path.basename(frames[n - 1])}'`);

  const concatPath = path.join(framesDir, 'concat.txt');
  fs.writeFileSync(concatPath, lines.join('\n'));

  const span = timestamps[n - 1] - timestamps[0];
  const achievedFps = span > 0 ? (n - 1) / span : n;
  return { concatPath, durations, totalSeconds: total, achievedFps };
}

/**
 * Resample the variably-timed concat stream to a uniform-fps, target-width PNG
 * sequence in `pacedDir`. Returns the list of produced frame paths.
 */
export async function resampleToPaced(
  concatPath: string,
  pacedDir: string,
  fps: number,
  width: number,
  camera?: CameraClip | null,
): Promise<string[]> {
  fs.mkdirSync(pacedDir, { recursive: true });
  const pattern = path.join(pacedDir, '%05d.png');
  // Camera clip crops the captured frame to a sub-region first (coords are CSS
  // px; assumes deviceScaleFactor 1, the default). Then resample to a uniform
  // clock and scale to the target width.
  const filters: string[] = [];
  if (camera) {
    const cw = Math.max(2, Math.round(camera.width));
    const ch = Math.max(2, Math.round(camera.height));
    filters.push(`crop=${cw}:${ch}:${Math.round(camera.x)}:${Math.round(camera.y)}`);
  }
  filters.push(`fps=${fps}`);
  filters.push(`scale=${width}:-2:flags=lanczos`);
  await run([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-vf', filters.join(','),
    pattern,
  ]);
  return fs
    .readdirSync(pacedDir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => path.join(pacedDir, f));
}
