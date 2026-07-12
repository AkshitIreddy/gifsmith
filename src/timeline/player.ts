/**
 * Timeline executor. Walks the compiled steps in real time (so CSS animations
 * play and the screencast records true pacing), resolving each declarative beat
 * to a concrete Puppeteer / in-page action. `parallel` awaits all branches;
 * cues and the loop anchor report their wall-clock offset so the loop planner
 * can find the seam.
 */
import type { Page } from 'puppeteer-core';
import type { CompiledTimeline, Step } from '../types.js';
import { Logger } from '../log.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PlayContext {
  startMs: number;
  cueTimes: Record<string, number>;
  anchorMs: number | null;
  log: Logger;
}

export async function playTimeline(
  page: Page,
  tl: CompiledTimeline,
  ctx: PlayContext,
): Promise<void> {
  await runSteps(page, tl.steps, tl, ctx);
}

async function runSteps(
  page: Page,
  steps: Step[],
  tl: CompiledTimeline,
  ctx: PlayContext,
): Promise<void> {
  for (const step of steps) {
    await runStep(page, step, tl, ctx);
  }
}

export async function runStep(
  page: Page,
  step: Step,
  tl: CompiledTimeline,
  ctx: PlayContext,
): Promise<void> {
  switch (step.kind) {
    case 'hold':
      await sleep(step.ms);
      break;

    case 'waitFor':
      try {
        if (step.selector) await page.waitForSelector(step.selector, { timeout: step.timeoutMs });
        else if (step.predicate) await page.waitForFunction(step.predicate, { timeout: step.timeoutMs });
      } catch {
        ctx.log.warn(`waitFor timed out: ${step.selector ?? step.predicate}`);
      }
      break;

    case 'click':
      if (step.via === 'cursor') {
        await page.evaluate(
          (sel: string) => (window as any).__gifsmith?.cursorToSelector(sel, 500, 'easeInOut'),
          step.selector,
        );
        await page.evaluate(() => (window as any).__gifsmith?.ripple());
      }
      try {
        await page.click(step.selector);
      } catch {
        ctx.log.warn(`click: selector not found: ${step.selector}`);
      }
      break;

    case 'type':
      try {
        await page.type(step.selector, step.text, { delay: step.delayMs });
      } catch {
        ctx.log.warn(`type: selector not found: ${step.selector}`);
      }
      break;

    case 'scroll':
      await page.evaluate(
        (sel: string, dy: number, dur: number, ez: string) =>
          (window as any).__gifsmith?.scrollBy(sel, dy, dur, ez),
        step.selector,
        step.dy,
        step.durationMs,
        step.easing,
      );
      break;

    case 'cursorTo':
      if (step.selector) {
        await page.evaluate(
          (sel: string, dur: number, ez: string) =>
            (window as any).__gifsmith?.cursorToSelector(sel, dur, ez),
          step.selector,
          step.durationMs,
          step.easing,
        );
      } else if (step.point) {
        await page.evaluate(
          (x: number, y: number, dur: number, ez: string) =>
            (window as any).__gifsmith?.cursorTo(x, y, dur, ez),
          step.point.x,
          step.point.y,
          step.durationMs,
          step.easing,
        );
      }
      break;

    case 'actorMove':
      await page.evaluate(
        (id: string, x: number, y: number, dur: number, ez: string) =>
          (window as any).__gifsmith?.moveActor(id, x, y, dur, ez),
        step.actorId,
        step.point.x,
        step.point.y,
        step.durationMs,
        step.easing,
      );
      break;

    case 'propSet':
      await page.evaluate(
        (id: string, patch: Record<string, unknown>) => (window as any).__gifsmith?.setProp(id, patch),
        step.propId,
        step.patch,
      );
      break;

    case 'bridgeSet':
      await page.evaluate(
        (key: string, value: unknown) => {
          const d = (window as any).__demo;
          if (!d) return;
          if (typeof d.setState === 'function') d.setState(key, value);
          else d[key] = value;
        },
        step.key,
        step.value,
      );
      break;

    case 'bridgeTrigger':
      await page.evaluate(
        (action: string, args: unknown[]) => {
          const d = (window as any).__demo;
          if (!d) return;
          if (typeof d.trigger === 'function') d.trigger(action, ...args);
          else if (typeof d[action] === 'function') d[action](...args);
        },
        step.action,
        step.args,
      );
      break;

    case 'pace':
      await page.evaluate((m: number) => (window as any).__gifsmith?.pace(m), step.multiplier);
      break;

    case 'call': {
      const fn = tl.calls[step.label];
      if (fn) await fn(page);
      break;
    }

    case 'cue':
      ctx.cueTimes[step.name] = Date.now() - ctx.startMs;
      ctx.log.debug(`cue '${step.name}' @ ${ctx.cueTimes[step.name]}ms`);
      break;

    case 'loopAnchor':
      ctx.anchorMs = Date.now() - ctx.startMs;
      ctx.log.debug(`loopAnchor @ ${ctx.anchorMs}ms`);
      break;

    case 'parallel':
      await Promise.all(step.branches.map((b) => runSteps(page, b, tl, ctx)));
      break;

    case 'sequence':
      await runSteps(page, step.steps, tl, ctx);
      break;
  }
}
