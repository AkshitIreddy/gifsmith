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
import { assertConfig } from './config.js';
import { connect } from './browser.js';
import { composeScene } from './scene.js';
import { setupBridge } from './bridge.js';
import { startScreencast } from './capture/screencast.js';
import type { CaptureHandle } from './capture/handle.js';
import { captureOptions } from './capture/options.js';
import {
  startDeterministicCapture,
  DETERMINISTIC_BROWSER_ARGS,
  type DeterministicHandle,
} from './capture/deterministic.js';
import { playTimeline, type PlayContext } from './timeline/player.js';
import { realClock } from './timeline/clock.js';
import { writeConcat, resampleToPaced, scaleUniform } from './pacing/concat.js';
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
  // Before anything is spent. Every rule gifsmith enforces on a config lives in
  // config.ts and is applied here, as a ConfigError the CLI prints as one line —
  // rather than at each value's first reader, which is how `--capture
  // Deterministic` came to print a stack from inside the director while the flag
  // layer next door had been printing one clean line for a release. It runs
  // before `assertFfmpeg` on purpose: a mistyped mode is worth naming on a
  // machine that has no ffmpeg yet.
  assertConfig(cfg);

  const log = new Logger(cfg.logLevel ?? 'info');
  assertFfmpeg();

  const viewport: Viewport = { ...DEFAULT_VIEWPORT, ...(cfg.viewport ?? {}) };
  const encode: EncodeOptions = { ...DEFAULT_ENCODE, ...(cfg.encode ?? {}) };
  const compose = cfg.compose ?? 'overlay';
  const capture = captureOptions(cfg.capture);
  const deterministic = capture.mode === 'deterministic';

  if (deterministic && (cfg.target.browserURL || cfg.target.browserWSEndpoint)) {
    log.warn(
      "capture:'deterministic' in attach mode freezes the clock of an app you did not launch. " +
        'Its timers, animations and polling stop for the duration of the render (they are restored ' +
        'afterwards), and the app must already have been started with ' +
        `${DETERMINISTIC_BROWSER_ARGS.join(' ')} or screenshots will stall. Launch mode is the ` +
        'tested path, because gifsmith can pass those itself.',
    );
  }

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
    let det: DeterministicHandle | undefined;
    // In stage mode the app is loaded inside an iframe, so the top page starts
    // blank (don't navigate it to the target). Deterministic capture defers the
    // navigation too, for a different reason: virtual time has to be armed
    // BEFORE the app boots, or the first seconds of the scene run on the real
    // clock — which is exactly the non-determinism the backend exists to remove.
    const connectTarget =
      compose === 'stage' || deterministic
        ? {
            ...cfg.target,
            url: undefined,
            // Deterministic capture needs the compositor to run every stage
            // before drawing, or the first screenshot after anything dirties
            // the page waits on a frame the paused clock will never produce.
            ...(deterministic
              ? { args: [...(cfg.target.args ?? []), ...DETERMINISTIC_BROWSER_ARGS] }
              : {}),
          }
        : cfg.target;
    // Render in a sandboxed, throwaway browser profile under the work dir, so
    // the capture never touches the user's real browser data and is cleaned up
    // with everything else.
    const conn = await connect(connectTarget, viewport, log, {
      userDataDir: path.join(workRoot, 'profile'),
    });
    try {
      if (deterministic) {
        // Arm first, navigate second. From here until freeze() the page runs on
        // a virtual clock pumped to track real time, so the load, the scene
        // composition and the bridge handshake all behave normally — every one
        // of them waits on the page, and a page cannot answer a stopped clock.
        det = await startDeterministicCapture(conn.page, framesDir, log, {
          fps: encode.fps,
          speed: encode.speed,
          ...(capture.format != null ? { format: capture.format } : {}),
          ...(capture.quality != null ? { quality: capture.quality } : {}),
          ...(capture.frameTimeoutMs != null ? { frameTimeoutMs: capture.frameTimeoutMs } : {}),
          ...(capture.waitForNetwork != null ? { waitForNetwork: capture.waitForNetwork } : {}),
        });
        cap = det;
        if (cfg.target.url) {
          await conn.page.goto(cfg.target.url, { waitUntil: 'load', timeout: 60_000 });
        }
      } else if (cfg.target.url && !conn.owned && compose !== 'stage') {
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

      const comp = await composeScene(conn.page, {
        props: cfg.props ?? [],
        compose,
        ctx: { viewport, camera: cfg.camera ?? null, compose },
        targetUrl: cfg.target.url,
        stage: cfg.stage,
        log,
      });
      play.appFrame = comp.appFrame;
      await setupBridge(comp.appFrame ?? conn.page, cfg.bridge ?? {}, log);

      if (det) {
        // The scene stops moving on its own here: from now on the only thing
        // that advances time is the timeline asking the clock for it.
        await det.freeze();
        play.clock = det.clock;
      } else {
        cap = await startScreencast(conn.page, framesDir, log, {
          clip: cfg.camera ?? null,
          ...(capture.format != null ? { format: capture.format } : {}),
          ...(capture.quality != null ? { quality: capture.quality } : {}),
        });
        play.clock = realClock();
      }
      play.startMs = Date.now();
      play.clock.mark();
      if (!cap) throw new Error('gifsmith: no capture backend started');
      await playTimeline(conn.page, cfg.timeline, play);
      await cap.stop(); // flush in-flight frames before we read cap.frames

      // A pump that died mid-scene releases the timeline rather than hanging it,
      // so the remaining steps run out against a frozen scene and everything
      // downstream still succeeds — a render that reports success, writes a GIF,
      // and silently stops halfway through the walkthrough. It used to be one
      // log.warn. It is a failure: the frames after the death do not exist.
      const failure = det?.captureError();
      if (failure) {
        throw new Error(
          `gifsmith: deterministic capture stopped advancing after ${cap.frames.length} frames, so ` +
            `the rest of the walkthrough was never rendered: ` +
            `${(failure as Error)?.message ?? failure}. The page or its CDP session went away ` +
            `mid-scene (a crash, a navigation, a closed window). Re-run with keepFrames:true to ` +
            `keep what was captured.`,
        );
      }

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
    let pacedFrames: string[];
    let achievedFps: number;
    if (deterministic) {
      // Already uniform, and `speed` was already folded into the scene-time
      // frame interval at capture — so this is a crop-and-scale, not a resample.
      log.step('pacing', `${frames.length} uniform frames @ ${encode.width}px (no resample)`);
      pacedFrames = await scaleUniform(framesDir, frames, pacedDir, encode.fps, encode.width, cfg.camera ?? null);
      achievedFps = det ? det.realFps() : encode.fps;
    } else {
      log.step('pacing', `${frames.length} frames → uniform ${encode.fps}fps @ ${encode.width}px`);
      const paced = writeConcat(framesDir, frames, timestamps, encode.speed);
      pacedFrames = await resampleToPaced(paced.concatPath, pacedDir, encode.fps, encode.width, cfg.camera ?? null);
      achievedFps = paced.achievedFps;
    }
    if (pacedFrames.length === 0) throw new Error('gifsmith: pacing produced no frames');

    // ---- loop ---------------------------------------------------------------
    // `loop` accepts a bare strategy or an options object; normalise once.
    const loopCfg =
      typeof cfg.loop === 'string' || cfg.loop == null
        ? { strategy: cfg.loop ?? ('auto' as const) }
        : cfg.loop;
    const plan = await planLoop({
      strategy: loopCfg.strategy,
      ...(loopCfg.minCycleSeconds != null
        ? { minCycleSeconds: loopCfg.minCycleSeconds }
        : {}),
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

    // Only meaningful for the screencast: it is a measurement there, and a
    // tautology under deterministic capture (which renders exactly `fps` scene
    // frames per second by construction, so it can never be "below" it).
    if (!deterministic && achievedFps < encode.fps) {
      warnings.push(
        `Capture averaged ${achievedFps.toFixed(1)}fps, below the ${encode.fps}fps output; ` +
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
      achievedCaptureFps: Number(achievedFps.toFixed(2)),
      loop: {
        strategy: plan.strategy,
        seamMSE: plan.seamMSE,
        anchorFrame: plan.anchorFrame,
        endFrame: plan.endFrame,
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
      for (const d of ['frames', 'paced', 'rot', 'loop', 'blend', 'profile']) {
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
