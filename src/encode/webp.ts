/**
 * Animated WebP encode. WebP is smaller and higher-quality than GIF for modern
 * READMEs (full colour, no palette dithering grain) — GitHub renders it inline.
 * We keep GIF too for maximum compatibility; most projects ship both.
 *
 * `lossless: true` is the answer to "the GIF looks mushy" that does not involve
 * fighting a 256-colour palette: WebP has no palette to fight. On UI footage —
 * flat fills, text, hard edges, a background that does not move — lossless WebP
 * is routinely SMALLER than the same clip as a 128-colour dithered GIF, because
 * the dither's per-pixel noise is precisely what a compressor cannot predict.
 * On photographic or gradient-heavy footage the same switch is enormous. Measure
 * it; the README has the numbers for a real UI demo.
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
  const lossless = opts.lossless === true;
  await run([
    '-y',
    ...src.inputs,
    '-c:v', 'libwebp_anim',
    '-lossless', lossless ? '1' : '0',
    // In lossless mode libwebp reads -q:v as effort rather than quality, and
    // 100 is the setting that actually shrinks the file; passing the lossy
    // quality through would ask for less work for no gain in fidelity.
    '-q:v', lossless ? '100' : String(opts.quality),
    '-compression_level', '6',
    '-loop', '0',
    '-an',
    '-f', 'webp',
    outPath,
  ]);
  return fs.statSync(outPath).size;
}
