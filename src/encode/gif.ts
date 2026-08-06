/**
 * GIF encode: a two-stage palette, generated from the clip and applied to it.
 *
 * The defaults — 128 colours, one shared palette weighted toward what moves
 * (`stats_mode=diff`), an ordered Bayer dither — are tuned for SIZE, and they
 * are the right defaults. Bayer, not error-diffusion, is the load-bearing one:
 * an ordered dither keeps a static pattern frame-to-frame, so successive frames
 * stay similar and the GIF's inter-frame compression stays effective. On a
 * white/text UI that is the difference between ~25MB and ~2MB.
 *
 * But they are a budget, and a budget shows. 128 colours of a warm-cream UI with
 * fine ink lines is a coarse approximation, and because the palette is chosen
 * from the pixels that *change*, the parts of the frame that get approximated
 * worst move around as the demo moves — which is exactly what a reader means by
 * "it is not always the same spot that gets messy". Every stage of that is a
 * knob now (see PaletteMode / DitherMode), so a demo that can afford the bytes
 * can buy its way out of it: `colors: 256, palette: 'perFrame', dither: 'none'`
 * is the top of what GIF can do, and the README has the measured cost.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EncodeOptions } from '../types.js';
import type { LoopPlan } from '../loop/index.js';
import { run } from './ffmpeg.js';
import { resolveSource } from './source.js';

/** The palettegen/paletteuse filter chain for one set of encode options. */
export function gifFilter(opts: Pick<EncodeOptions, 'colors' | 'dither' | 'bayerScale' | 'palette'>): string {
  const colors = Math.max(2, Math.min(256, Math.round(opts.colors)));
  const mode = opts.palette ?? 'diff';
  const dither = opts.dither ?? 'bayer';
  const bayerScale = Math.max(0, Math.min(5, opts.bayerScale ?? 4));

  const stats = mode === 'perFrame' ? 'single' : mode === 'full' ? 'full' : 'diff';
  const use: string[] = [
    `dither=${dither}`,
    ...(dither === 'bayer' ? [`bayer_scale=${bayerScale}`] : []),
    // A per-frame palette repaints the whole frame from a table the previous
    // frame did not have, so restricting the update to the changed rectangle
    // would leave everything outside it holding colours that no longer exist.
    ...(mode === 'perFrame' ? ['new=1'] : ['diff_mode=rectangle']),
  ];
  return (
    `split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=${stats}[p];` +
    `[b][p]paletteuse=${use.join(':')}`
  );
}

export async function encodeGif(
  plan: LoopPlan,
  outPath: string,
  opts: EncodeOptions,
): Promise<number> {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const src = resolveSource(plan);
  await run(['-y', ...src.inputs, '-vf', gifFilter(opts), '-loop', '0', '-f', 'gif', outPath]);
  return fs.statSync(outPath).size;
}
