/**
 * snapshot() and contactSheet() — let an AI author "see" a moment mid-build
 * cheaply, without a full render. snapshot plays the timeline up to a given
 * time and returns one frame (base64 PNG). contactSheet plays once and grabs
 * N frames across the timeline, tiled into a single grid for one-shot visual QA.
 *
 * Seeking uses the timeline's *planned* durations (deterministic), executing
 * each beat in real time so the frame reflects genuine mid-animation state.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { Page } from 'puppeteer-core';
import type { RenderConfig, Step } from '../types.js';
import { Logger } from '../log.js';
import { connect } from '../browser.js';
import { composeScene } from '../scene.js';
import { setupBridge } from '../bridge.js';
import { runStep, type PlayContext } from '../timeline/player.js';
import { estimateSeconds } from '../timeline/timeline.js';
import { run } from '../encode/ffmpeg.js';

type SceneConfig = Pick<
  RenderConfig,
  'target' | 'props' | 'timeline' | 'viewport' | 'camera' | 'compose' | 'stage' | 'bridge' | 'logLevel'
>;

async function screenshotBase64(page: Page, camera: RenderConfig['camera']): Promise<string> {
  const opts: any = { encoding: 'base64', type: 'png' };
  if (camera) opts.clip = { x: camera.x, y: camera.y, width: camera.width, height: camera.height };
  return (await page.screenshot(opts)) as unknown as string;
}

async function withScene<T>(cfg: SceneConfig, fn: (page: Page, ctx: PlayContext, log: Logger) => Promise<T>): Promise<T> {
  const log = new Logger(cfg.logLevel ?? 'warn');
  const viewport = { width: 1280, height: 800, deviceScaleFactor: 1, ...(cfg.viewport ?? {}) };
  const compose = cfg.compose ?? 'overlay';
  const connectTarget = compose === 'stage' ? { ...cfg.target, url: undefined } : cfg.target;
  const conn = await connect(connectTarget, viewport, log);
  try {
    if (cfg.target.url && !conn.owned && compose !== 'stage') {
      await conn.page.goto(cfg.target.url, { waitUntil: 'load', timeout: 30_000 });
    }
    await conn.page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 }).catch(() => {});
    const comp = await composeScene(conn.page, {
      props: cfg.props ?? [],
      compose,
      ctx: { viewport, camera: cfg.camera ?? null, compose },
      targetUrl: cfg.target.url,
      stage: cfg.stage,
      log,
    });
    await setupBridge(comp.appFrame ?? conn.page, cfg.bridge ?? {}, log);
    const ctx: PlayContext = { startMs: Date.now(), cueTimes: {}, anchorMs: null, log, appFrame: comp.appFrame };
    return await fn(conn.page, ctx, log);
  } finally {
    if (conn.owned) await conn.browser.close();
    else await conn.browser.disconnect();
  }
}

/** Play the top-level steps until `untilMs` of planned time, capturing at each ms in `stops`. */
async function playCapturing(
  page: Page,
  cfg: SceneConfig,
  ctx: PlayContext,
  stops: number[],
): Promise<Record<number, string>> {
  const shots: Record<number, string> = {};
  const pending = [...stops].sort((a, b) => a - b);
  let elapsed = 0;
  const capture = async (ms: number) => {
    shots[ms] = await screenshotBase64(page, cfg.camera ?? null);
  };
  for (const step of cfg.timeline.steps) {
    const dur = estimateSeconds([step]) * 1000;
    // Fire any stops that land within/at the start of this step.
    while (pending.length && pending[0] <= elapsed) {
      await capture(pending.shift()!);
    }
    if (step.kind === 'hold' && pending.length && pending[0] < elapsed + dur) {
      // Split the hold around the stops it contains.
      let cursor = elapsed;
      while (pending.length && pending[0] < elapsed + dur) {
        const target = pending[0];
        await runStep(page, { kind: 'hold', ms: Math.max(0, target - cursor) }, cfg.timeline, ctx);
        cursor = target;
        await capture(pending.shift()!);
      }
      await runStep(page, { kind: 'hold', ms: Math.max(0, elapsed + dur - cursor) }, cfg.timeline, ctx);
    } else {
      await runStep(page, step, cfg.timeline, ctx);
    }
    elapsed += dur;
  }
  // Any remaining stops beyond the timeline → capture the final state.
  for (const ms of pending) await capture(ms);
  return shots;
}

export async function snapshot(cfg: SceneConfig, atSeconds: number): Promise<{ atSeconds: number; base64: string }> {
  const base64 = await withScene(cfg, async (page, ctx) => {
    const shots = await playCapturing(page, cfg, ctx, [Math.max(0, atSeconds * 1000)]);
    return shots[Math.max(0, atSeconds * 1000)];
  });
  return { atSeconds, base64 };
}

export interface ContactSheet {
  times: number[];
  columns: number;
  /** A single tiled PNG (base64) of all N frames. */
  gridBase64: string;
  frames: { atSeconds: number; base64: string }[];
}

export async function contactSheet(cfg: SceneConfig, n = 6): Promise<ContactSheet> {
  const total = Math.max(0.001, estimateSeconds(cfg.timeline.steps));
  const times = Array.from({ length: n }, (_, i) => Number(((i + 0.5) * (total / n)).toFixed(2)));
  const stops = times.map((t) => t * 1000);

  const shots = await withScene(cfg, (page, ctx) => playCapturing(page, cfg, ctx, stops));
  const frames = times.map((t) => ({ atSeconds: t, base64: shots[t * 1000] ?? '' }));

  // Tile with ffmpeg into a contact sheet.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gifsmith-sheet-'));
  try {
    frames.forEach((f, i) => {
      if (f.base64) fs.writeFileSync(path.join(tmp, `s${String(i).padStart(2, '0')}.png`), Buffer.from(f.base64, 'base64'));
    });
    const columns = Math.min(n, 3);
    const rows = Math.ceil(n / columns);
    const gridPath = path.join(tmp, 'grid.png');
    await run([
      '-y', '-framerate', '1', '-start_number', '0', '-i', path.join(tmp, 's%02d.png'),
      '-vf', `scale=420:-1,tile=${columns}x${rows}:padding=6:color=0x1b1f24`,
      '-frames:v', '1', gridPath,
    ]);
    const gridBase64 = fs.readFileSync(gridPath).toString('base64');
    return { times, columns, gridBase64, frames };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
