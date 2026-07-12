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
import { estimateSeconds } from '../timeline/timeline.js';

type SceneConfig = Pick<RenderConfig, 'target' | 'props' | 'timeline' | 'viewport' | 'camera' | 'compose' | 'logLevel'>;

function collectSelectors(steps: Step[], acc: { sel: string; kind: string }[]): void {
  for (const s of steps) {
    if ((s.kind === 'click' || s.kind === 'type' || s.kind === 'scroll') && s.selector) acc.push({ sel: s.selector, kind: s.kind });
    else if (s.kind === 'waitFor' && s.selector) acc.push({ sel: s.selector, kind: 'waitFor' });
    else if (s.kind === 'cursorTo' && s.selector) acc.push({ sel: s.selector, kind: 'cursorTo' });
    else if (s.kind === 'parallel') s.branches.forEach((b) => collectSelectors(b, acc));
    else if (s.kind === 'sequence') collectSelectors(s.steps, acc);
  }
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
  const conn = await connect(cfg.target, viewport, log);
  try {
    if (cfg.target.url && !conn.owned) await conn.page.goto(cfg.target.url, { waitUntil: 'load', timeout: 30_000 });
    if (cfg.props?.length) {
      await composeScene(conn.page, {
        props: cfg.props,
        compose: cfg.compose ?? 'overlay',
        ctx: { viewport, camera: cfg.camera ?? null, compose: cfg.compose ?? 'overlay' },
        log,
      });
    }
    const selectors: { sel: string; kind: string }[] = [];
    collectSelectors(cfg.timeline.steps, selectors);
    for (const { sel, kind } of selectors) {
      const exists = (await conn.page.evaluate((s: string) => {
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
