/**
 * CDP screencast capture. We use `Page.startScreencast` (jpeg, everyNthFrame:1)
 * rather than a `page.screenshot()` loop: screencast streams real paints at far
 * higher rates (native screenshot loops top out ~2–9 fps), and each frame comes
 * with a real `metadata.timestamp` — the raw material for natural, breathing
 * pacing (see pacing/concat.ts).
 *
 * A subtlety screencast has that a screenshot loop doesn't: it only emits on a
 * paint. A perfectly static hold produces *no* frames, so wall-clock time would
 * be lost. gifsmith injects a 1px, near-invisible heartbeat that dirties a tiny
 * region every animation frame, guaranteeing a steady stream so holds are
 * timed accurately. The heartbeat is placed at (0,0) and is trivially small; if
 * a camera clip is set it can be excluded entirely.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import type { CameraClip } from '../types.js';
import { Logger } from '../log.js';
import type { CaptureHandle } from './handle.js';

// The handle moved to ./handle.ts once a second backend needed it; re-exported
// here so every existing importer keeps working.
export type { CaptureHandle };

// A steady stream of paints during otherwise-static holds, so the screencast
// keeps emitting frames and their real timestamps time the hold accurately.
// We use a CSS animation, NOT requestAnimationFrame: headless Chrome throttles
// rAF for backgrounded/offscreen pages (and optimizes away sub-pixel changes),
// so an rAF loop can fall silent on a static scene — a CSS animation that
// mutates a *paint* property runs on the browser's own timeline and forces a
// real commit every frame. The element is 2px, ~invisible (opacity 0.02),
// parked in the top-left corner (exclude it with a camera clip if needed).
const HEARTBEAT = `
(() => {
  if (document.getElementById('__gifsmith_heartbeat')) return;
  const style = document.createElement('style');
  style.id = '__gifsmith_heartbeat_style';
  style.textContent =
    '@keyframes __gifsmith_hb{0%{background:#000}50%{background:#0c0c0c}100%{background:#000}}' +
    '#__gifsmith_heartbeat{position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.02;' +
    'pointer-events:none;z-index:2147483647;animation:__gifsmith_hb 0.1s linear infinite}';
  document.head.appendChild(style);
  const d = document.createElement('div');
  d.id = '__gifsmith_heartbeat';
  document.documentElement.appendChild(d);
})();
`;

const HEARTBEAT_STOP = `
(() => {
  var d = document.getElementById('__gifsmith_heartbeat');
  var s = document.getElementById('__gifsmith_heartbeat_style');
  if (d) d.remove();
  if (s) s.remove();
})();
`;

export interface ScreencastOptions {
  quality?: number;
  /**
   * Frame image format, `'jpeg'` (default) or `'png'`.
   *
   * PNG frames are lossless, and on this backend that is a real trade rather
   * than a free win: they are several times larger and slower to encode, so the
   * screencast delivers fewer paints per second — and a capture rate below the
   * output fps is visible as steppy motion, which is worse than the JPEG loss
   * it removes. Check `achievedCaptureFps` in the result before keeping it. The
   * deterministic backend has no such trade (it never races the clock).
   */
  format?: 'jpeg' | 'png';
  /** Restrict emitted frames to the camera region for smaller jpegs (optional). */
  clip?: CameraClip | null;
  heartbeat?: boolean;
}

export async function startScreencast(
  page: Page,
  framesDir: string,
  log: Logger,
  opts: ScreencastOptions = {},
): Promise<CaptureHandle> {
  fs.mkdirSync(framesDir, { recursive: true });
  if (opts.heartbeat !== false) await page.evaluate(HEARTBEAT);

  const client = await page.target().createCDPSession();
  const format = opts.format ?? 'jpeg';
  const ext = format === 'png' ? '.png' : '.jpg';
  const frames: string[] = [];
  const timestamps: number[] = [];
  let index = 0;
  let stopped = false;
  let onFirstFrame: (() => void) | null = null;
  const firstFrame = new Promise<void>((res) => { onFirstFrame = res; });

  client.on('Page.screencastFrame', async (evt: any) => {
    const { data, sessionId, metadata } = evt;
    if (stopped) {
      try { await client.send('Page.screencastFrameAck', { sessionId }); } catch { /* ignore */ }
      return;
    }
    const ts = metadata?.timestamp ?? Date.now() / 1000;
    const file = path.join(framesDir, String(index++).padStart(5, '0') + ext);
    try {
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push(file);
      timestamps.push(ts);
      if (onFirstFrame) { onFirstFrame(); onFirstFrame = null; }
    } catch (e) {
      log.debug('frame write failed', e);
    }
    try { await client.send('Page.screencastFrameAck', { sessionId }); } catch { /* dropped */ }
  });

  await client.send('Page.startScreencast', {
    format,
    ...(format === 'jpeg' ? { quality: opts.quality ?? 92 } : {}),
    everyNthFrame: 1,
  });

  // A cold screencast can take up to ~1s to emit its first frame. Wait for the
  // pipeline to actually be live before the timeline runs, so short captures
  // aren't empty and pacing starts from real frames (not an empty warmup gap).
  await Promise.race([firstFrame, new Promise<void>((r) => setTimeout(r, 4000))]);
  log.step('capture', `screencast live (${frames.length ? 'primed' : 'no first frame yet'})`);

  let didStop = false;
  const stop = async (): Promise<void> => {
    if (didStop) return; // idempotent: the Director calls this on success and again in finally
    didStop = true;
    stopped = true;
    try { await client.send('Page.stopScreencast'); } catch { /* ignore */ }
    // Give in-flight frame events a moment to flush.
    await new Promise((r) => setTimeout(r, 150));
    try { await page.evaluate(HEARTBEAT_STOP); } catch { /* ignore */ }
    log.step('capture', `${frames.length} frames`);
  };

  return { client, frames, timestamps, stop };
}
