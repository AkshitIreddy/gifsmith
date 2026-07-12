/**
 * Animated WebP encode. WebP is smaller and higher-quality than GIF for modern
 * READMEs (full colour, no palette dithering grain) — GitHub renders it inline.
 * We keep GIF too for maximum compatibility; most projects ship both.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EncodeOptions } from '../types.js';
import type { LoopPlan } from '../loop/index.js';
import { run } from './ffmpeg.js';
import { resolveSource } from './source.js';

export async function encodeWebp(
  plan: LoopPlan,
  outPath: string,
  opts: EncodeOptions,
): Promise<number> {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const src = resolveSource(plan);
  await run([
    '-y',
    ...src.inputs,
    '-c:v', 'libwebp_anim',
    '-lossless', '0',
    '-q:v', String(opts.quality),
    '-compression_level', '6',
    '-loop', '0',
    '-an',
    '-f', 'webp',
    outPath,
  ]);
  return fs.statSync(outPath).size;
}
