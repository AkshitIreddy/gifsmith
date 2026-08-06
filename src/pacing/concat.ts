/**
 * Natural pacing. We keep each captured frame's real timestamp and build an
 * ffmpeg concat list with *per-frame durations* — so holds breathe and motion
 * flows, exactly as it happened, instead of a robotic constant-fps sampling.
 *
 * (This comment used to add "unlike a virtual clock, which only overrides JS
 * timers and freezes CSS transitions". Measured on current Chrome while adding
 * the deterministic backend, that is not true — CSS transitions and @keyframes
 * both advance with virtual time. The real difference is honesty versus
 * repeatability: this path records what happened, stalls included; the
 * deterministic path renders what was designed. See capture/deterministic.ts.)
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

/** Crop to the camera region, then scale to the output width. Shared by both
 * pacing paths so a camera clip means the same thing in each. */
function frameFilters(width: number, camera?: CameraClip | null): string[] {
  const filters: string[] = [];
  // Camera clip crops the captured frame to a sub-region first (coords are CSS
  // px; assumes deviceScaleFactor 1, the default).
  if (camera) {
    const cw = Math.max(2, Math.round(camera.width));
    const ch = Math.max(2, Math.round(camera.height));
    filters.push(`crop=${cw}:${ch}:${Math.round(camera.x)}:${Math.round(camera.y)}`);
  }
  filters.push(`scale=${width}:-2:flags=lanczos`);
  return filters;
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
  const filters = frameFilters(width, camera);
  filters.splice(filters.length - 1, 0, `fps=${fps}`); // resample before scaling
  await run([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-vf', filters.join(','),
    pattern,
  ]);
  return listPng(pacedDir);
}

/**
 * The deterministic path's pacing: there isn't any, and that is the point.
 *
 * Frames arrive from the deterministic backend already one-per-output-frame,
 * with `speed` folded into the scene-time frame interval at capture. Sending
 * them through `writeConcat` + `fps=` anyway would be a *second* resample of an
 * already-uniform stream, and a resample can only do two things to it: at the
 * default speed of 1.4 the `fps=` filter would drop ~29% of the frames (the
 * judder, reintroduced from the other end), and the concat list's hardcoded
 * 0.4s tail plus its repeated last frame would append a freeze to a loop that
 * is supposed to be exact. `toFixed(4)` on the per-frame duration is not even
 * representable at 24 or 30fps, so it drifts a frame every thousand.
 *
 * So this does the only two things that remain: crop and scale, 1:1.
 */
export async function scaleUniform(
  framesDir: string,
  frames: string[],
  pacedDir: string,
  fps: number,
  width: number,
  camera?: CameraClip | null,
): Promise<string[]> {
  if (frames.length === 0) throw new Error('gifsmith: no frames captured (did the timeline run?)');
  fs.mkdirSync(pacedDir, { recursive: true });
  // The backend numbers frames %05d from 0 in this directory, so the image2
  // demuxer reads them in capture order with no concat list involved.
  const ext = path.extname(frames[0]) || '.jpg';
  await run([
    '-y',
    '-framerate', String(fps),
    '-start_number', '0',
    '-i', path.join(framesDir, `%05d${ext}`),
    '-vf', frameFilters(width, camera).join(','),
    // Output numbering deliberately left at ffmpeg's default (00001…), the same
    // as resampleToPaced produces, so every downstream stage sees one convention.
    path.join(pacedDir, '%05d.png'),
  ]);
  return listPng(pacedDir);
}

function listPng(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => path.join(dir, f));
}
