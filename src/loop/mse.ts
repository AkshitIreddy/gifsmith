/**
 * Frame similarity via tiny grayscale thumbnails. We ask ffmpeg to dump every
 * paced frame as a 32×18 gray raw image in one shot, then compare frames in JS
 * with mean-squared-error. This is how the scripted-anchor loop finds a
 * hold-to-hold seam (Project A), and how we report loop-seam quality back to
 * the caller. No image-decoding dependency — ffmpeg is already required.
 */
import path from 'node:path';
import { runCapture } from '../encode/ffmpeg.js';

export const THUMB_W = 32;
export const THUMB_H = 18;
const THUMB_BYTES = THUMB_W * THUMB_H;

/** Decode all paced frames into per-frame gray thumbnails (Uint8Array[576]). */
export async function thumbnails(pacedDir: string): Promise<Uint8Array[]> {
  const pattern = path.join(pacedDir, '%05d.png');
  const buf = await runCapture([
    '-start_number', '0',
    '-i', pattern,
    '-vf', `scale=${THUMB_W}:${THUMB_H},format=gray`,
    '-f', 'rawvideo',
    'pipe:1',
  ]);
  const count = Math.floor(buf.length / THUMB_BYTES);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Uint8Array(buf.subarray(i * THUMB_BYTES, (i + 1) * THUMB_BYTES)));
  }
  return out;
}

export function mse(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum / a.length;
}
