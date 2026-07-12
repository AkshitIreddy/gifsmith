/**
 * GIF encode: a single-pass split palette with ordered (bayer) dithering.
 *
 * Bayer — not error-diffusion — is deliberate: an ordered dither keeps a static
 * pattern frame-to-frame, so successive frames stay similar and the GIF's
 * inter-frame compression stays effective. On a white/text UI this is the
 * difference between ~25 MB and ~2 MB. `stats_mode=diff` biases the palette
 * toward the pixels that actually change between frames.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EncodeOptions } from '../types.js';
import type { LoopPlan } from '../loop/index.js';
import { run } from './ffmpeg.js';
import { resolveSource } from './source.js';

export async function encodeGif(
  plan: LoopPlan,
  outPath: string,
  opts: EncodeOptions,
): Promise<number> {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const src = resolveSource(plan);
  const palette =
    `split[a][b];[a]palettegen=max_colors=${opts.colors}:stats_mode=diff[p];` +
    `[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;

  const args = ['-y', ...src.inputs];
  if (src.complex) {
    args.push('-filter_complex', `${src.leadFilter},${palette}`);
  } else {
    args.push('-vf', palette);
  }
  args.push('-loop', '0', '-f', 'gif', outPath);

  await run(args);
  return fs.statSync(outPath).size;
}
