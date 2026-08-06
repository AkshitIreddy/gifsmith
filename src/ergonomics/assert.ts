/**
 * Build-time assertions, used inside a `call()` step against the live Page:
 *
 *   t.call(async (page) => { await expectVisible(page, '.chart'); });
 *
 * They throw a descriptive error (which fails the render loudly) so an AI author
 * catches a broken scene early instead of shipping a blank GIF.
 */
import type { Page } from 'puppeteer-core';
import type { CallContext, CameraClip } from '../types.js';

export async function expectVisible(page: Page, selector: string): Promise<void> {
  const ok = (await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }, selector)) as boolean;
  if (!ok) throw new Error(`gifsmith.expectVisible: "${selector}" is not visible`);
}

/**
 * Assert a region is visually stable over `ms` (nothing is still animating).
 * Compares two screenshots pixel-for-pixel; a stable region is a good place to
 * put a loopAnchor.
 *
 * PASS THE CALLBACK'S `ctx` UNDER `capture: 'deterministic'`, or this measures
 * nothing. The wait between the two screenshots is where the animation is meant
 * to happen, and a bare `setTimeout` does not move a virtual clock — the scene
 * is frozen across both shots, every region is trivially stable, and passing is
 * not evidence of anything. With `ctx` the wait becomes `ms` of *scene* time and
 * the assertion means what it says on both backends:
 *
 *   t.call(async (page, ctx) => { await expectStable(page, region, 300, ctx); });
 */
export async function expectStable(
  page: Page,
  region: CameraClip,
  ms = 300,
  ctx?: Pick<CallContext, 'advance'>,
): Promise<void> {
  const shot = () => page.screenshot({ clip: region, type: 'png' }) as Promise<Buffer>;
  const a = await shot();
  if (ctx) await ctx.advance(ms);
  else await new Promise((r) => setTimeout(r, ms));
  const b = await shot();
  if (!a.equals(b)) throw new Error(`gifsmith.expectStable: region is still changing after ${ms}ms`);
}

/** Assert an actor/element's box lies within the camera frame (nothing clipped). */
export async function expectInFrame(page: Page, selector: string, camera: CameraClip): Promise<void> {
  const rect = (await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, selector)) as CameraClip | null;
  if (!rect) throw new Error(`gifsmith.expectInFrame: "${selector}" not found`);
  const inside =
    rect.x >= camera.x &&
    rect.y >= camera.y &&
    rect.x + rect.width <= camera.x + camera.width &&
    rect.y + rect.height <= camera.y + camera.height;
  if (!inside) {
    throw new Error(
      `gifsmith.expectInFrame: "${selector}" (${Math.round(rect.x)},${Math.round(rect.y)} ` +
        `${Math.round(rect.width)}×${Math.round(rect.height)}) is outside the camera ` +
        `(${camera.x},${camera.y} ${camera.width}×${camera.height})`,
    );
  }
}
