/**
 * Build-time assertions, used inside a `call()` step against the live Page:
 *
 *   t.call(async (page) => { await expectVisible(page, '.chart'); });
 *
 * They throw a descriptive error (which fails the render loudly) so an AI author
 * catches a broken scene early instead of shipping a blank GIF.
 */
import type { Page } from 'puppeteer-core';
import type { CameraClip } from '../types.js';

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
 */
export async function expectStable(page: Page, region: CameraClip, ms = 300): Promise<void> {
  const shot = () => page.screenshot({ clip: region, type: 'png' }) as Promise<Buffer>;
  const a = await shot();
  await new Promise((r) => setTimeout(r, ms));
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
