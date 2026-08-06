/**
 * dryRun() — validate a scene without a full render: do the selectors resolve,
 * do referenced actors exist, is there a loop anchor, how long will it run?
 * Returns warnings/errors as structured data so an AI author can fix the script
 * before spending a capture. Selectors that only appear after a dynamic load are
 * warnings (they may resolve at play time), not hard errors.
 */
import type { DryRunReport, RenderConfig, Step } from '../types.js';
import { Logger } from '../log.js';
import { connect } from '../browser.js';
import { composeScene } from '../scene.js';
import { sceneProblems } from '../config.js';
import { estimateSeconds } from '../timeline/timeline.js';

/**
 * `capture` belongs here for the same reason everything else does: dryRun's job
 * is to reject a scene before it costs a capture, and two of the ways a scene
 * can be rejected live in that field — a mode `render()` will throw on, and the
 * deterministic/stage combination it refuses. Without the field they were both
 * reported as `ok: true` and discovered a browser launch later.
 */
type SceneConfig = Pick<RenderConfig, 'target' | 'props' | 'timeline' | 'viewport' | 'camera' | 'compose' | 'stage' | 'capture' | 'logLevel'>;

function collectSelectors(steps: Step[], acc: { sel: string; kind: string }[]): void {
  for (const s of steps) {
    if ((s.kind === 'click' || s.kind === 'type' || s.kind === 'scroll') && s.selector) acc.push({ sel: s.selector, kind: s.kind });
    else if (s.kind === 'waitFor' && s.selector) acc.push({ sel: s.selector, kind: 'waitFor' });
    else if (s.kind === 'cursorTo' && s.selector) acc.push({ sel: s.selector, kind: 'cursorTo' });
    else if (s.kind === 'parallel') s.branches.forEach((b) => collectSelectors(b, acc));
    else if (s.kind === 'sequence') collectSelectors(s.steps, acc);
  }
}

/** `call` steps that declare no duration — see the warning that quotes it. */
function undeclaredCalls(steps: Step[]): number {
  let n = 0;
  for (const s of steps) {
    if (s.kind === 'call' && s.seconds == null) n++;
    else if (s.kind === 'parallel') for (const b of s.branches) n += undeclaredCalls(b);
    else if (s.kind === 'sequence') n += undeclaredCalls(s.steps);
  }
  return n;
}

export async function dryRun(cfg: SceneConfig): Promise<DryRunReport> {
  const log = new Logger(cfg.logLevel ?? 'warn');
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!cfg.timeline.steps.length) errors.push('Timeline has no steps.');
  const totalPlannedSeconds = Number(estimateSeconds(cfg.timeline.steps).toFixed(2));
  if (!cfg.timeline.hasLoopAnchor) {
    warnings.push("No loopAnchor() — loop:'auto' will use crossfade. Add loopAnchor() at a neutral hold for an artifact-free anchor loop.");
  }

  const viewport = { width: 1280, height: 800, deviceScaleFactor: 1, ...(cfg.viewport ?? {}) };
  const compose = cfg.compose ?? 'overlay';

  // Every config error that would otherwise surface as a thrown render, one
  // browser launch later. These are the same rules `render()` enforces —
  // `config.ts` owns them, `render` throws on the first and a dry run reports
  // them all, which is the entire reason the rules return strings.
  errors.push(...sceneProblems({ ...cfg, compose }));

  // Not an error: a launch target with no url renders a blank page, which is
  // occasionally deliberate (a timeline that navigates itself in a `call`).
  if (cfg.target && !cfg.target.url && !cfg.target.browserURL && !cfg.target.browserWSEndpoint) {
    warnings.push('target has no url and no CDP endpoint — the render will start on a blank page.');
  }

  // A `call` step is worth however much scene time its callback spends, and
  // nothing here can know that — so the planned total is a floor whenever one
  // is undeclared, and saying so beats reporting a confident wrong number.
  const undeclared = undeclaredCalls(cfg.timeline.steps);
  if (undeclared) {
    warnings.push(
      `${undeclared} call step(s) declare no duration, so totalPlannedSeconds (${totalPlannedSeconds}s) ` +
        `excludes whatever their callbacks spend — under capture:'deterministic' a callback's ` +
        `ctx.advance() is real scene time and can be most of a scene. Pass it: t.call(fn, { seconds: 2 }).`,
    );
  }
  const connectTarget = compose === 'stage' ? { ...cfg.target, url: undefined } : cfg.target;
  const conn = await connect(connectTarget, viewport, log);
  try {
    if (cfg.target.url && !conn.owned && compose !== 'stage') await conn.page.goto(cfg.target.url, { waitUntil: 'load', timeout: 30_000 });
    const comp = await composeScene(conn.page, {
      props: cfg.props ?? [],
      compose,
      ctx: { viewport, camera: cfg.camera ?? null, compose },
      targetUrl: cfg.target.url,
      stage: cfg.stage,
      log,
    });
    // In stage mode the app (and its selectors) live in the iframe.
    const selDriver = comp.appFrame ?? conn.page;
    const selectors: { sel: string; kind: string }[] = [];
    collectSelectors(cfg.timeline.steps, selectors);
    for (const { sel, kind } of selectors) {
      const exists = (await selDriver.evaluate((s: string) => {
        try { return !!document.querySelector(s); } catch { return null; }
      }, sel)) as boolean | null;
      if (exists === null) errors.push(`Invalid selector syntax in ${kind}: "${sel}"`);
      else if (!exists) warnings.push(`${kind} selector not present at load: "${sel}" (ok if it appears after a waitFor).`);
    }
  } catch (e) {
    errors.push(`Could not load target: ${(e as Error).message}`);
  } finally {
    if (conn.owned) await conn.browser.close();
    else await conn.browser.disconnect();
  }

  return {
    ok: errors.length === 0,
    totalPlannedSeconds,
    cues: cfg.timeline.cues,
    hasLoopAnchor: cfg.timeline.hasLoopAnchor,
    warnings,
    errors,
  };
}
