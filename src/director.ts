/**
 * The Director — orchestrates a full render:
 *   connect → compose the scene → wire the bridge → screencast while the
 *   timeline plays → build a naturally-paced uniform sequence → plan & build a
 *   seamless loop → encode GIF/WebP under a size budget → return a structured
 *   result (frame counts, achieved fps, loop-seam MSE, byte sizes, warnings).
 *
 * Everything after capture works off frames on disk, so the browser closes as
 * soon as the walkthrough ends.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  EncodeOptions,
  OutputFormat,
  RenderConfig,
  RenderResult,
  Viewport,
} from './types.js';
import { Logger } from './log.js';
import { connect } from './browser.js';
import { composeScene } from './scene.js';
import { setupBridge } from './bridge.js';
import { startScreencast, type CaptureHandle } from './capture/screencast.js';
import { playTimeline, type PlayContext } from './timeline/player.js';
import { writeConcat, resampleToPaced } from './pacing/concat.js';
import { planLoop } from './loop/index.js';
import { encodeGif } from './encode/gif.js';
import { encodeWebp } from './encode/webp.js';
import { assertFfmpeg } from './encode/ffmpeg.js';

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
const DEFAULT_ENCODE: EncodeOptions = {
  width: 900,
  fps: 16,
  speed: 1.4,
  colors: 128,
  quality: 88,
};

function formatFor(out: string, explicit?: OutputFormat): OutputFormat {
  if (explicit) return explicit;
  return out.toLowerCase().endsWith('.webp') ? 'webp' : 'gif';
}

export async function render(cfg: RenderConfig): Promise<RenderResult> {
  const log = new Logger(cfg.logLevel ?? 'info');
  assertFfmpeg();

  const viewport: Viewport = { ...DEFAULT_VIEWPORT, ...(cfg.viewport ?? {}) };
  const encode: EncodeOptions = { ...DEFAULT_ENCODE, ...(cfg.encode ?? {}) };
  const compose = cfg.compose ?? 'overlay';

  // gifsmith owns an auto-created temp dir and may delete it wholesale; a
  // caller-supplied workDir is theirs — we only clean the subdirs we made.
  const autoWork = cfg.workDir == null;
  const workRoot = cfg.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'gifsmith-'));
  const framesDir = path.join(workRoot, 'frames');
  const pacedDir = path.join(workRoot, 'paced');
  fs.mkdirSync(workRoot, { recursive: true });
  log.debug('workdir', workRoot);

  try {
    // ---- browser phase ------------------------------------------------------
    let frames: string[] = [];
    let timestamps: number[] = [];
    const play: PlayContext = { startMs: 0, cueTimes: {}, anchorMs: null, log };

    let cap: CaptureHandle | undefined;
    // Render in a sandboxed, throwaway browser profile under the work dir, so
    // the capture never touches the user's real browser data and is cleaned up
    // with everything else.
    const conn = await connect(cfg.target, viewport, log, {
      userDataDir: path.join(workRoot, 'profile'),
    });
    try {
      if (cfg.target.url && !conn.owned) {
        await conn.page.goto(cfg.target.url, { waitUntil: 'load', timeout: 30_000 });
      }
      try {
        await conn.page.setViewport({
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        });
      } catch {
        /* attached real windows may refuse a resize; harmless */
      }

      await composeScene(conn.page, {
        props: cfg.props ?? [],
        compose,
        ctx: { viewport, camera: cfg.camera ?? null, compose },
        log,
      });
      await setupBridge(conn.page, cfg.bridge ?? {}, log);

      cap = await startScreencast(conn.page, framesDir, log, { clip: cfg.camera ?? null });
      play.startMs = Date.now();
      await playTimeline(conn.page, cfg.timeline, play);
      await cap.stop(); // flush in-flight frames before we read cap.frames

      frames = cap.frames;
      timestamps = cap.timestamps;
    } finally {
      // If playTimeline threw, the stop above was skipped — tear down the
      // heartbeat rAF loop + screencast while the CDP page is still alive
      // (crucial in attach mode, where disconnect() leaves the app running).
      if (cap) { try { await cap.stop(); } catch { /* ignore */ } }
      if (conn.owned) await conn.browser.close();
      else await conn.browser.disconnect();
    }

    // ---- pacing -------------------------------------------------------------
    log.step('pacing', `${frames.length} frames → uniform ${encode.fps}fps @ ${encode.width}px`);
    const paced = writeConcat(framesDir, frames, timestamps, encode.speed);
    const pacedFrames = await resampleToPaced(paced.concatPath, pacedDir, encode.fps, encode.width);
    if (pacedFrames.length === 0) throw new Error('gifsmith: pacing produced no frames');

    // ---- loop ---------------------------------------------------------------
    const plan = await planLoop({
      strategy: cfg.loop ?? 'auto',
      pacedDir,
      pacedFrames,
      fps: encode.fps,
      speed: encode.speed,
      hasLoopAnchor: cfg.timeline.hasLoopAnchor,
      anchorSeconds: play.anchorMs != null ? play.anchorMs / 1000 : null,
      log,
    });

    // ---- encode -------------------------------------------------------------
    const formats = new Set<OutputFormat>([formatFor(cfg.out, cfg.format), ...(cfg.alsoEmit ?? [])]);
    const outputs: RenderResult['outputs'] = [];
    for (const fmt of formats) {
      const outPath = outputPathFor(cfg.out, fmt, cfg.format);
      log.step('encode', `${fmt} → ${outPath}`);
      const bytes = fmt === 'gif' ? await encodeGif(plan, outPath, encode) : await encodeWebp(plan, outPath, encode);
      outputs.push({ format: fmt, path: outPath, bytes });
      log.step('encode', `${fmt} ${(bytes / 1024).toFixed(0)} KB`);
    }

    // ---- result + warnings --------------------------------------------------
    const warnings: string[] = [];
    if (paced.achievedFps < encode.fps) {
      warnings.push(
        `Capture averaged ${paced.achievedFps.toFixed(1)}fps, below the ${encode.fps}fps output; ` +
          `motion may look slightly steppy. Try a lighter viewport or lower fps.`,
      );
    }
    if (plan.seamMSE != null && plan.seamMSE > 60) {
      warnings.push(
        `Loop seam MSE is ${plan.seamMSE.toFixed(0)} (high). The anchor hold may not have ` +
          `settled — add a longer hold before loopAnchor(), or use loop:'crossfade'.`,
      );
    }
    if (encode.targetMB != null) {
      for (const o of outputs) {
        const mb = o.bytes / (1024 * 1024);
        if (mb > encode.targetMB) {
          warnings.push(
            `${o.format} is ${mb.toFixed(2)}MB (> targetMB ${encode.targetMB}). ` +
              `Reduce width/fps/colors, raise speed, or avoid an animated background (quiet-bg).`,
          );
        }
      }
    }
    for (const w of warnings) log.warn(w);

    return {
      outputs,
      sourceFrames: frames.length,
      pacedFrames: pacedFrames.length,
      loopFrames: plan.frameCount,
      achievedCaptureFps: Number(paced.achievedFps.toFixed(2)),
      loop: {
        strategy: plan.strategy,
        seamMSE: plan.seamMSE,
        anchorFrame: plan.kind === 'frames' ? plan.anchorFrame : undefined,
        endFrame: plan.kind === 'frames' ? plan.endFrame : undefined,
      },
      durationSeconds: Number((plan.frameCount / encode.fps).toFixed(2)),
      warnings,
    };
  } finally {
    // Cleanup on BOTH success and error paths. Never delete a caller's workDir
    // wholesale — only the subdirs we created inside it.
    if (cfg.keepFrames) {
      log.info('kept frames at', workRoot);
    } else if (autoWork) {
      try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      for (const d of ['frames', 'paced', 'rot', 'loop', 'profile']) {
        try { fs.rmSync(path.join(workRoot, d), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }
}

/**
 * When multiple formats are requested, derive sibling paths by swapping the
 * extension (out.gif → out.webp). The explicitly-requested `out` keeps its name.
 */
function outputPathFor(out: string, fmt: OutputFormat, explicitFormat?: OutputFormat): string {
  const primary = formatFor(out, explicitFormat);
  if (fmt === primary) return out;
  const dir = path.dirname(out);
  const base = path.basename(out).replace(/\.(gif|webp)$/i, '');
  return path.join(dir, `${base}.${fmt}`);
}
