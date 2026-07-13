/**
 * Timeline executor. Walks the compiled steps in real time (so CSS animations
 * play and the screencast records true pacing), resolving each declarative beat
 * to a concrete Puppeteer / in-page action. `parallel` awaits all branches;
 * cues and the loop anchor report their wall-clock offset so the loop planner
 * can find the seam.
 *
 * Two composition modes share this executor. In `overlay` the app IS the top
 * page, so `appFrame` is null and everything targets the page. In `stage` the
 * app runs inside an <iframe> on a mock desktop: selector-driven steps target
 * the app Frame (Puppeteer drives it fine, even cross-origin), while the
 * synthetic cursor and props live on the top page — so cursor coordinates are
 * computed from the element's rect inside the frame plus the iframe's offset.
 */
import type { Frame, Page } from 'puppeteer-core';
import type { CompiledTimeline, Easing, Step } from '../types.js';
import { Logger } from '../log.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PlayContext {
  startMs: number;
  cueTimes: Record<string, number>;
  anchorMs: number | null;
  log: Logger;
  /** Set in stage mode: the app runs in this frame; cursor/props stay on page. */
  appFrame?: Frame | null;
}

/** A Page or Frame — both expose the selector/eval methods the player needs. */
type Driver = Page | Frame;

export async function playTimeline(
  page: Page,
  tl: CompiledTimeline,
  ctx: PlayContext,
): Promise<void> {
  await runSteps(page, tl.steps, tl, ctx);
}

async function runSteps(page: Page, steps: Step[], tl: CompiledTimeline, ctx: PlayContext): Promise<void> {
  for (const step of steps) await runStep(page, step, tl, ctx);
}

/** Move the synthetic cursor (on the top page) to a selector's centre, mapping
 * through the iframe offset in stage mode. */
async function cursorToSelector(page: Page, appFrame: Frame | null | undefined, selector: string, durMs: number, easing: Easing): Promise<void> {
  if (!appFrame) {
    await page.evaluate((s: string, d: number, e: string) => (window as any).__gifsmith?.cursorToSelector(s, d, e), selector, durMs, easing);
    return;
  }
  const inFrame = await appFrame
    .$eval(selector, (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })
    .catch(() => null);
  if (!inFrame) return;
  const off = await page.evaluate(() => {
    const f = document.getElementById('__gifsmith_appframe') as HTMLIFrameElement | null;
    if (!f) return { x: 0, y: 0, sx: 1, sy: 1 };
    const r = f.getBoundingClientRect();
    return { x: r.left, y: r.top, sx: r.width / (f.clientWidth || r.width), sy: r.height / (f.clientHeight || r.height) };
  });
  await page.evaluate(
    (X: number, Y: number, d: number, e: string) => (window as any).__gifsmith?.cursorTo(X, Y, d, e),
    off.x + inFrame.x * off.sx,
    off.y + inFrame.y * off.sy,
    durMs,
    easing,
  );
}

async function runStep(page: Page, step: Step, tl: CompiledTimeline, ctx: PlayContext): Promise<void> {
  const appFrame = ctx.appFrame ?? null;
  const driver: Driver = appFrame ?? page;

  switch (step.kind) {
    case 'hold':
      await sleep(step.ms);
      break;

    case 'waitFor':
      try {
        if (step.selector) await driver.waitForSelector(step.selector, { timeout: step.timeoutMs });
        else if (step.predicate) await driver.waitForFunction(step.predicate, { timeout: step.timeoutMs });
      } catch {
        ctx.log.warn(`waitFor timed out: ${step.selector ?? step.predicate}`);
      }
      break;

    case 'click':
      if (step.via === 'cursor') {
        await cursorToSelector(page, appFrame, step.selector, step.glideMs ?? 0, 'easeInOut');
        await page.evaluate(() => (window as any).__gifsmith?.ripple());
      }
      try {
        await driver.click(step.selector);
      } catch {
        ctx.log.warn(`click: selector not found: ${step.selector}`);
      }
      break;

    case 'type':
      try {
        await driver.type(step.selector, step.text, { delay: step.delayMs });
      } catch {
        ctx.log.warn(`type: selector not found: ${step.selector}`);
      }
      break;

    case 'scroll':
      // Eased scroll of a container, run in-page so the screencast captures it.
      await driver.evaluate(
        (sel: string, dy: number, dur: number, ez: string) =>
          new Promise<void>((res) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return res();
            const easings: Record<string, (t: number) => number> = {
              linear: (t) => t,
              easeIn: (t) => t * t,
              easeOut: (t) => 1 - (1 - t) * (1 - t),
              easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
            };
            const ease = easings[ez] || easings.easeInOut;
            const start = el.scrollTop;
            const t0 = performance.now();
            const stepFn = (now: number) => {
              const p = Math.min(1, (now - t0) / dur);
              el.scrollTop = start + dy * ease(p);
              if (p < 1) requestAnimationFrame(stepFn);
              else res();
            };
            requestAnimationFrame(stepFn);
          }),
        step.selector,
        step.dy,
        step.durationMs,
        step.easing,
      );
      break;

    case 'cursorTo':
      if (step.selector) {
        await cursorToSelector(page, appFrame, step.selector, step.durationMs, step.easing);
      } else if (step.point) {
        await page.evaluate(
          (x: number, y: number, dur: number, ez: string) => (window as any).__gifsmith?.cursorTo(x, y, dur, ez),
          step.point.x,
          step.point.y,
          step.durationMs,
          step.easing,
        );
      }
      break;

    case 'actorMove':
      await page.evaluate(
        (id: string, x: number, y: number, dur: number, ez: string) => (window as any).__gifsmith?.moveActor(id, x, y, dur, ez),
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
      await driver.evaluate(
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
      await driver.evaluate(
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
      await driver.evaluate((m: number) => {
        (window as any).__DEMO_PACE__ = m;
        const d = (window as any).__demo;
        if (d && typeof d.pace === 'function') { try { d.pace(m); } catch (e) {} }
      }, step.multiplier);
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

export { runStep };
