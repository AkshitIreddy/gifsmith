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
import type { CDPSession, Page } from 'puppeteer-core';
import type { CameraClip } from '../types.js';
import { Logger } from '../log.js';

export interface CaptureHandle {
  client: CDPSession;
  frames: string[];        // absolute file paths, in capture order
  timestamps: number[];    // seconds, from CDP metadata
  stop(): Promise<void>;
}

const HEARTBEAT = `
(() => {
  if (window.__gifsmithHeartbeat) return;
  const d = document.createElement('div');
  d.id = '__gifsmith_heartbeat';
  d.style.cssText =
    'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.012;' +
    'pointer-events:none;z-index:2147483647;background:#808080';
  document.documentElement.appendChild(d);
  let t = 0;
  const tick = () => {
    t = (t + 1) % 1000;
    // A sub-pixel transform forces a fresh composite/paint every frame.
    d.style.transform = 'translateZ(0) translateX(' + (t % 2 ? 0.01 : 0) + 'px)';
    window.__gifsmithHeartbeat = requestAnimationFrame(tick);
  };
  window.__gifsmithHeartbeat = requestAnimationFrame(tick);
})();
`;

export interface ScreencastOptions {
  quality?: number;
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
  const frames: string[] = [];
  const timestamps: number[] = [];
  let index = 0;
  let stopped = false;

  client.on('Page.screencastFrame', async (evt: any) => {
    const { data, sessionId, metadata } = evt;
    if (stopped) {
      try { await client.send('Page.screencastFrameAck', { sessionId }); } catch { /* ignore */ }
      return;
    }
    const ts = metadata?.timestamp ?? Date.now() / 1000;
    const file = path.join(framesDir, String(index++).padStart(5, '0') + '.jpg');
    try {
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push(file);
      timestamps.push(ts);
    } catch (e) {
      log.debug('frame write failed', e);
    }
    try { await client.send('Page.screencastFrameAck', { sessionId }); } catch { /* dropped */ }
  });

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: opts.quality ?? 92,
    everyNthFrame: 1,
  });
  log.step('capture', 'screencast started');

  const stop = async (): Promise<void> => {
    stopped = true;
    try { await client.send('Page.stopScreencast'); } catch { /* ignore */ }
    // Give in-flight frame events a moment to flush.
    await new Promise((r) => setTimeout(r, 150));
    try { await page.evaluate('window.__gifsmithHeartbeat && cancelAnimationFrame(window.__gifsmithHeartbeat)'); } catch { /* ignore */ }
    log.step('capture', `${frames.length} frames`);
  };

  return { client, frames, timestamps, stop };
}
