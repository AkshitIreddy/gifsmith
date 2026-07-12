/**
 * Scene composition — inject the movie set around the live app. In `overlay`
 * mode (the default, robust for any app) props are injected as DOM layers into
 * the target page itself, so they composite with the real UI in the same paint:
 * back-layer props (wallpaper) sit behind, front-layer props (cursor, taskbar,
 * bezel, decorative windows) on top. The app is driven directly at top level.
 *
 * `stage` mode (embedding the app in an <iframe> on a full mock desktop) is a
 * roadmap item; see README › Composition. Overlay already delivers the full
 * movie set for transparent/overlay apps (the desktop-pet case) and the
 * full-bleed-plus-chrome look for opaque web apps.
 */
import type { Page } from 'puppeteer-core';
import type { ComposeMode, Prop, PropContext } from './types.js';
import { installRuntime } from './bridge.js';
import { Logger } from './log.js';

export interface ComposeArgs {
  props: Prop[];
  compose: ComposeMode;
  ctx: PropContext;
  log: Logger;
}

export async function composeScene(page: Page, args: ComposeArgs): Promise<void> {
  if (args.compose === 'stage') {
    throw new Error(
      "gifsmith: compose:'stage' (app-in-an-iframe on a mock desktop) is a roadmap " +
        "item. Use 'overlay' (the default): inject a wallpaper/taskbar/mock-window " +
        'prop set for the desktop look, plus a cursor and bezel. See README › Composition.',
    );
  }

  await installRuntime(page);

  // Apply back-layer props first so front props paint over them.
  const ordered = [
    ...args.props.filter((p) => p.layer === 'back'),
    ...args.props.filter((p) => p.layer === 'front'),
  ];

  for (const prop of ordered) {
    const css = prop.css(args.ctx);
    const html = prop.html(args.ctx);
    await page.evaluate(
      (id: string, cssText: string, htmlText: string) => {
        if (cssText) {
          const st = document.createElement('style');
          st.setAttribute('data-gifsmith', id);
          st.textContent = cssText;
          document.head.appendChild(st);
        }
        // Always create the container so CSS selectors on `#__gifsmith_<id>` match,
        // even for props whose body is empty (wallpaper, bezel).
        const el = document.createElement('div');
        el.id = '__gifsmith_' + id;
        el.innerHTML = htmlText || '';
        document.documentElement.appendChild(el);
      },
      prop.id,
      css,
      html,
    );
    if (prop.runtime) await page.evaluate(prop.runtime);
    args.log.debug(`prop injected: ${prop.id} (${prop.layer})`);
  }
  if (args.props.length) args.log.step('scene', `${args.props.length} props`);
}
