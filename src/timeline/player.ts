/**
 * Timeline executor. Walks the compiled steps, resolving each declarative beat
 * to a concrete Puppeteer / in-page action. `parallel` awaits all branches; cues
 * and the loop anchor report their offset so the loop planner can find the seam.
 *
 * Two composition modes share this executor. In `overlay` the app IS the top
 * page, so `appFrame` is null and everything targets the page. In `stage` the
 * app runs inside an <iframe> on a mock desktop: selector-driven steps target
 * the app Frame (Puppeteer drives it fine, even cross-origin), while the
 * synthetic cursor and props live on the top page — so cursor coordinates are
 * computed from the element's rect inside the frame plus the iframe's offset.
 *
 * Time is not read here and is never slept for directly. Every beat that takes
 * time asks `ctx.clock` to advance, and every beat that *waits* on the page
 * hands its promise to `ctx.clock.settle` — see timeline/clock.ts for why. With
 * the real clock that is `setTimeout` and a plain await, exactly as this file
 * worked before the seam existed; with the deterministic backend's virtual clock
 * the same beats become an exact number of rendered frames, and the machine's
 * mood stops being part of the output.
 */
import type { Frame, Page } from 'puppeteer-core';
import type { CompiledTimeline, Easing, Step } from '../types.js';
import { Logger } from '../log.js';
import { realClock, type Clock } from './clock.js';
import { runCall } from './callContext.js';

/**
 * Extra scene time granted past an in-page tween's declared duration before we
 * give up on it. A tween resolves on the rAF *after* its final step, and the
 * whole point of the deterministic path is that we cannot know how many real
 * milliseconds that costs — so the slack is generous and measured in scene time.
 */
const TWEEN_TAIL_MS = 2_000;

/**
 * Scene time allowed for a Node-side puppeteer action that needs the page to
 * make progress (scroll-into-view, resolving a clickable point).
 */
const ACTION_CAP_MS = 3_000;

export interface PlayContext {
  startMs: number;
  cueTimes: Record<string, number>;
  anchorMs: number | null;
  log: Logger;
  /** Set in stage mode: the app runs in this frame; cursor/props stay on page. */
  appFrame?: Frame | null;
  /**
   * The clock this timeline plays on. The Director sets it; contexts built
   * before this existed (snapshot/contactSheet) leave it out and get a real
   * clock anchored at `startMs`, which is precisely what they had before.
   */
  clock?: Clock;
}

/** A Page or Frame — both expose the selector/eval methods the player needs. */
type Driver = Page | Frame;

function clockOf(ctx: PlayContext): Clock {
  if (!ctx.clock) ctx.clock = realClock(ctx.startMs);
  return ctx.clock;
}

/**
 * Run something that only finishes while the page keeps painting — an in-page
 * rAF tween, or a puppeteer poller that lives in the page.
 *
 * The control flow is inverted relative to the obvious `await`, and that
 * inversion is the whole trick: under a virtual clock the promise cannot
 * resolve until we spend scene time, so awaiting it first is a deadlock with no
 * timeout attached — the render would hang rather than fail. Start it, then let
 * the clock walk forward underneath it.
 *
 * On the real clock this collapses back to `await start()`, byte for byte what
 * the player did before, including letting errors propagate.
 */
async function drive(
  ctx: PlayContext,
  start: () => Promise<unknown>,
  sceneMs: number,
  what: string,
): Promise<void> {
  const clock = clockOf(ctx);
  if (clock.kind === 'real') {
    await start();
    return;
  }
  let error: unknown;
  const p = start().then(
    () => undefined,
    (e: unknown) => {
      error = e;
    },
  );
  const cap = Math.max(0, sceneMs) + TWEEN_TAIL_MS;
  const settled = await clock.settle(p, cap);
  if (error) throw error;
  if (!settled) {
    ctx.log.warn(`${what}: did not finish within ${Math.round(cap)}ms of scene time; moving on`);
  }
}

/**
 * Await a puppeteer action that may need frames to complete, reporting the
 * outcome instead of throwing so each step keeps its own warning text. Mirrors
 * the try/catch the steps used to wrap these calls in.
 */
async function act(
  ctx: PlayContext,
  p: Promise<unknown>,
  capMs: number,
): Promise<{ settled: boolean; error?: unknown }> {
  const clock = clockOf(ctx);
  if (clock.kind === 'real') {
    try {
      await p;
      return { settled: true };
    } catch (error) {
      return { settled: true, error };
    }
  }
  let error: unknown;
  const guarded = p.then(
    () => undefined,
    (e: unknown) => {
      error = e;
    },
  );
  const settled = await clock.settle(guarded, capMs);
  return { settled, error };
}

/**
 * The click, taken apart — virtual clock only.
 *
 * `driver.click()` is three things in a trench coat: scroll into view, resolve a
 * clickable point, dispatch press-and-release. Only the first two can need the
 * page to make progress (the visibility check is an IntersectionObserver, and a
 * fresh element has no layout quads until it has been laid out), and under a
 * virtual clock "needs the page to make progress" means "cannot finish unless we
 * spend scene time". So the whole call was handed to a scene-time cap — and on
 * expiry, ABANDONED. Abandoned is the problem: puppeteer's click was still
 * running, and a click that resolves its point two beats later still dispatches.
 * The render moves on, and somewhere in a later shot the app opens a panel
 * nobody asked for. A capped wait has to be a capped wait on something that is
 * safe to walk away from.
 *
 * Taken apart, everything under the cap is a *query* — abandoning one changes
 * nothing about the page — and the dispatch happens only once we hold a point,
 * in one go, or not at all. The three outcomes stay exactly what they were:
 * missing selector, never-clickable, clicked.
 */
async function clickWithoutAbandoning(
  page: Page,
  driver: Driver,
  selector: string,
  ctx: PlayContext,
  capMs: number,
): Promise<{ clicked: boolean; found: boolean }> {
  const clock = clockOf(ctx);
  const handle = await driver.$(selector).catch(() => null);
  if (!handle) return { clicked: false, found: false };

  // `driver.$()` allocates a remote object in the page and a JSHandle in Node
  // holding it open, and it is released only by disposing the handle. Every
  // click goes through here, and the longest renders are the ones with the most
  // clicks — so the leak grew exactly where it could least be afforded, one
  // pinned DOM node per click for the whole render. Every return below is inside
  // this try, deliberately: `finally` is the only shape that cannot be walked
  // past by a later edit adding a fourth way out.
  try {
    // What puppeteer's scrollIntoViewIfNeeded does, minus its
    // IntersectionObserver — the observer's callback is delivered on a task the
    // paused clock may never run, which is the wait that made the click
    // uncancellable in the first place. Same threshold (fully in view or scroll
    // to centre), so nothing moves that would not have moved before.
    await handle
      .evaluate((el: Element) => {
        const r = el.getBoundingClientRect();
        const inside =
          r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
        if (!inside) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      })
      .catch(() => undefined);

    // `clickablePoint` is a rect read plus the frame-offset walk — no waiting in
    // it at all. What it does do is FAIL while the element has no layout yet, so
    // the wait is ours: retry it a frame at a time and let the scene move under
    // it. Coordinates come back in the top frame's space, iframes accounted for,
    // which is exactly what page.mouse wants.
    const step = clock.frameMs > 0 ? clock.frameMs : 16;
    let spent = 0;
    for (;;) {
      const point = await handle.clickablePoint().catch(() => null);
      if (point) {
        await page.mouse.click(point.x, point.y);
        return { clicked: true, found: true };
      }
      if (spent >= capMs) return { clicked: false, found: true };
      await clock.advance(Math.min(step, capMs - spent));
      spent += step;
    }
  } finally {
    // Never allowed to fail the click: the page may already be gone, and a
    // disposal that throws would turn a successful click into a render error.
    await handle.dispose().catch(() => undefined);
  }
}

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

/**
 * How long the in-page cursor tween will actually run for.
 *
 * A glide with `durMs <= 0` is auto-timed from the travel distance *inside the
 * page* (~900px/s, clamped), so Node does not know its duration — and under a
 * virtual clock a duration we do not know is a tween we cannot drive. We ask
 * the runtime, which computes it with the same function the tween itself uses,
 * so the two can never drift apart. Only the deterministic path pays for this
 * round trip; the real clock just awaits the tween and never needs the number.
 */
async function plannedGlideMs(
  page: Page,
  fn: 'glideMsToSelector' | 'autoDurMs',
  args: [string | number, number, number?],
  fallback: number,
): Promise<number> {
  try {
    const ms = (await page.evaluate(
      (name: string, a: unknown[]) => {
        const g = (window as any).__gifsmith;
        return g && typeof g[name] === 'function' ? g[name](...a) : 0;
      },
      fn,
      args.filter((a) => a !== undefined) as unknown[],
    )) as number;
    return Number.isFinite(ms) && ms > 0 ? ms : fallback;
  } catch {
    return fallback;
  }
}

/** Move the synthetic cursor (on the top page) to a selector's centre, mapping
 * through the iframe offset in stage mode. */
async function cursorToSelector(
  page: Page,
  appFrame: Frame | null | undefined,
  selector: string,
  durMs: number,
  easing: Easing,
  ctx: PlayContext,
): Promise<void> {
  const virtual = clockOf(ctx).kind === 'virtual';
  if (!appFrame) {
    const planned = virtual
      ? await plannedGlideMs(page, 'glideMsToSelector', [selector, durMs], durMs)
      : durMs;
    await drive(
      ctx,
      () =>
        page.evaluate(
          (s: string, d: number, e: string) => (window as any).__gifsmith?.cursorToSelector(s, d, e),
          selector,
          durMs,
          easing,
        ),
      planned,
      'cursor glide',
    );
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
  const X = off.x + inFrame.x * off.sx;
  const Y = off.y + inFrame.y * off.sy;
  const planned = virtual ? await plannedGlideMs(page, 'autoDurMs', [X, Y, durMs], durMs) : durMs;
  await drive(
    ctx,
    () =>
      page.evaluate(
        (x: number, y: number, d: number, e: string) => (window as any).__gifsmith?.cursorTo(x, y, d, e),
        X,
        Y,
        durMs,
        easing,
      ),
    planned,
    'cursor glide',
  );
}

/** Smooth-scroll a target into view before the cursor travels to it. A glide
 * toward an off-screen element followed by puppeteer's instant auto-scroll on
 * click reads as a camera jump; scrolling first keeps the shot continuous. */
async function ensureInView(driver: Driver, selector: string, ctx: PlayContext): Promise<void> {
  let scrolled = false;
  try {
    scrolled = (await driver.evaluate((s: string) => {
      const el = document.querySelector(s);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth) {
        return false;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      return true;
    }, selector)) as boolean;
  } catch {
    /* selector missing — the click/drag step reports it */
  }
  // The smooth scroll is browser-driven, so this is not merely a pause: it is
  // the scene time the scroll animation is given to happen in.
  if (scrolled) await clockOf(ctx).advance(560);
}

async function runStep(page: Page, step: Step, tl: CompiledTimeline, ctx: PlayContext): Promise<void> {
  const appFrame = ctx.appFrame ?? null;
  const driver: Driver = appFrame ?? page;
  const clock = clockOf(ctx);
  // Cheap, debug-only, and the thing you want when a render stops moving: which
  // beat it stopped on, and how far into the scene it got.
  ctx.log.debug(`step ${step.kind} @ ${Math.round(clock.nowMs())}ms`);

  switch (step.kind) {
    case 'hold':
      await clock.advance(step.ms);
      break;

    case 'waitFor': {
      if (clock.kind === 'real') {
        try {
          if (step.selector) await driver.waitForSelector(step.selector, { timeout: step.timeoutMs });
          else if (step.predicate) await driver.waitForFunction(step.predicate, { timeout: step.timeoutMs });
        } catch {
          ctx.log.warn(`waitFor timed out: ${step.selector ?? step.predicate}`);
        }
        break;
      }
      // Puppeteer's poller runs IN the page, so it can only fire while the page
      // is running — and its timeout is a real-time one, which under a virtual
      // clock measures the render machine rather than the scene. Disable the
      // real timeout, cap the wait in scene time instead, and let each polling
      // attempt land on a rendered frame.
      if (!step.selector && !step.predicate) break;
      const waiting = step.selector
        ? driver.waitForSelector(step.selector, { timeout: 0 })
        : driver.waitForFunction(step.predicate as string, { timeout: 0 });
      const r = await act(ctx, waiting as Promise<unknown>, step.timeoutMs);
      if (!r.settled || r.error) {
        ctx.log.warn(
          `waitFor timed out after ${step.timeoutMs}ms of scene time: ` +
            `${step.selector ?? step.predicate}`,
        );
      }
      break;
    }

    case 'click': {
      if (step.via === 'cursor') {
        await ensureInView(driver, step.selector, ctx);
        await cursorToSelector(page, appFrame, step.selector, step.glideMs ?? 0, 'easeInOut', ctx);
        // Fire-and-forget on purpose: ripple() starts a 420ms in-page tween and
        // returns, so it animates over the frames the following beats render.
        await page.evaluate(() => (window as any).__gifsmith?.ripple());
      }
      // Puppeteer scrolls the element into view and resolves a clickable point
      // before dispatching, and both of those can need the page to move. On the
      // real clock that is a plain await, as it always was; on the virtual one
      // the call is taken apart so nothing capped is ever left running.
      let found = true;
      let clicked = true;
      if (clock.kind === 'real') {
        try {
          await driver.click(step.selector);
        } catch {
          found = false;
        }
      } else {
        ({ clicked, found } = await clickWithoutAbandoning(
          page, driver, step.selector, ctx, ACTION_CAP_MS,
        ));
      }
      // Two different failures, and telling them apart is the difference between
      // "your selector is wrong" and "your app was still busy". They used to
      // share one message, which sent a real investigation down the wrong road:
      // every tile in a panel reported "selector not found" while the tiles were
      // plainly in the DOM — they were simply not clickable yet.
      if (!found) {
        ctx.log.warn(`click: selector not found: ${step.selector}`);
      } else if (!clicked) {
        ctx.log.warn(
          `click: '${step.selector}' did not become clickable within ${ACTION_CAP_MS}ms of scene ` +
            `time. The element exists; the page had not finished laying it out or painting it. ` +
            `Add a hold (or a waitFor on something the panel only renders when it is ready) first.`,
        );
      }
      break;
    }

    case 'type': {
      if (clock.kind === 'real') {
        try {
          await driver.type(step.selector, step.text, { delay: step.delayMs });
        } catch {
          ctx.log.warn(`type: selector not found: ${step.selector}`);
        }
        break;
      }
      // Puppeteer's key delay is a NODE-side setTimeout: under a virtual clock
      // it separates keystrokes by zero scene time, so the whole string appears
      // in one frame and the typing animation vanishes from the output. Press
      // the keys ourselves and buy the gap in scene time.
      let typeHandle: Awaited<ReturnType<Driver['$']>> = null;
      try {
        typeHandle = await driver.$(step.selector);
        if (!typeHandle) throw new Error('not found');
        await typeHandle.focus();
        for (const ch of step.text) {
          await page.keyboard.type(ch);
          await clock.advance(step.delayMs);
        }
      } catch {
        ctx.log.warn(`type: selector not found: ${step.selector}`);
      } finally {
        // Same handle leak as the click, on a rarer beat. See
        // clickWithoutAbandoning.
        await typeHandle?.dispose().catch(() => undefined);
      }
      break;
    }

    case 'drag': {
      await ensureInView(driver, step.selector, ctx);
      const handle = await driver.$(step.selector);
      const box = handle ? await handle.boundingBox() : null; // page coords, iframe-safe
      // The box is a plain object; the handle behind it is not needed past this
      // line and is not free — see clickWithoutAbandoning.
      await handle?.dispose().catch(() => undefined);
      if (!box) {
        ctx.log.warn(`drag: selector not found: ${step.selector}`);
        break;
      }
      const sx = box.x + box.width / 2;
      const sy = box.y + box.height / 2;
      const ex = sx + step.dx;
      const ey = sy + step.dy;
      await cursorToSelector(page, appFrame, step.selector, 0, 'easeInOut', ctx);
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      // One pointer move per rendered frame under a virtual clock. Chromium
      // coalesces moves that arrive inside one frame, so a burst issued with no
      // frames in between is delivered as a single jump and the drag reads as a
      // teleport — the ticks have to interleave strictly with the capture.
      const n =
        clock.frameMs > 0
          ? Math.max(2, Math.round(step.durationMs / clock.frameMs))
          : Math.max(12, Math.round(step.durationMs / 40));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOut
        const x = sx + (ex - sx) * e;
        const y = sy + (ey - sy) * e;
        await page.mouse.move(x, y);
        const nudge = () =>
          page.evaluate(
            (X: number, Y: number) => (window as any).__gifsmith?.cursorTo(X, Y, 1, 'linear'),
            x, y,
          );
        if (clock.kind === 'real') {
          await nudge();
          await clock.advance(step.durationMs / n);
        } else {
          // The 1ms tween still needs one rAF to resolve, which only happens
          // while the clock advances — so start it and let the tick pay for it.
          const moved = nudge().then(() => undefined, () => undefined);
          await clock.advance(step.durationMs / n);
          await clock.settle(moved, clock.frameMs * 2);
        }
      }
      await page.mouse.up();
      break;
    }

    case 'scroll':
      // Eased scroll of a container, run in-page so the capture sees every step.
      await drive(
        ctx,
        () =>
          driver.evaluate(
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
                // performance.now() inside the callback, not rAF's timestamp —
                // they are different clocks under virtual time. See bridge.ts.
                const stepFn = () => {
                  const p = Math.min(1, (performance.now() - t0) / dur);
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
          ),
        step.durationMs,
        'scroll',
      );
      break;

    case 'cursorTo':
      if (step.selector) {
        await cursorToSelector(page, appFrame, step.selector, step.durationMs, step.easing, ctx);
      } else if (step.point) {
        await drive(
          ctx,
          () =>
            page.evaluate(
              (x: number, y: number, dur: number, ez: string) => (window as any).__gifsmith?.cursorTo(x, y, dur, ez),
              step.point!.x,
              step.point!.y,
              step.durationMs,
              step.easing,
            ),
          step.durationMs,
          'cursor move',
        );
      }
      break;

    case 'actorMove':
      await drive(
        ctx,
        () =>
          page.evaluate(
            (id: string, x: number, y: number, dur: number, ez: string) => (window as any).__gifsmith?.moveActor(id, x, y, dur, ez),
            step.actorId,
            step.point.x,
            step.point.y,
            step.durationMs,
            step.easing,
          ),
        step.durationMs,
        `actorMove ${step.actorId}`,
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
      // An author callback used to be outside the clock by construction: it got
      // the raw Page and nothing else, so the only way it could wait was a
      // `setTimeout` that measures the machine — and under a virtual clock buys
      // no frames at all. It now gets the clock as a second argument, guarded by
      // a stall watchdog that fails with this step's name rather than hanging.
      // See timeline/callContext.ts; the one-argument form is untouched.
      const fn = tl.calls[step.label];
      if (fn) {
        await runCall(fn, page, {
          clock,
          log: ctx.log,
          label: step.name ? `call step "${step.name}" (${step.label})` : `call step ${step.label}`,
        });
      }
      break;
    }

    case 'cue':
      ctx.cueTimes[step.name] = clock.nowMs();
      ctx.log.debug(`cue '${step.name}' @ ${Math.round(ctx.cueTimes[step.name])}ms`);
      break;

    case 'loopAnchor':
      // Scene time, not wall time: the loop planner turns this into a frame
      // index, and a wall-clock reading under a virtual clock overshoots by
      // exactly the amount of stall the deterministic path exists to discard.
      ctx.anchorMs = clock.nowMs();
      ctx.log.debug(`loopAnchor @ ${Math.round(ctx.anchorMs)}ms`);
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
