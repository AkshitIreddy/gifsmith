/**
 * A CLI config module: `gifsmith render examples/hello-web/demo.config.mjs`.
 * It default-exports a RenderConfig; CLI flags (--width, --fps, --also-webp…)
 * override the encode/loop options. In a published project you'd import from
 * 'gifsmith'; in-repo we import from the built dist.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timeline, web } from '../../dist/index.js';
import { cursor, bezel } from '../../dist/props/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appUrl = pathToFileURL(path.join(here, 'app.html')).href;

export default {
  target: web(appUrl),
  out: path.join(here, 'out', 'demo.gif'),
  viewport: { width: 1180, height: 720 },
  props: [cursor({ start: { x: 590, y: 470 } }), bezel()],
  timeline: timeline((t) => {
    t.waitFor('.app');
    t.hold(1.4);
    t.loopAnchor();
    t.click('.generate');
    t.waitFor('.card');
    t.hold(1.7);
    t.click('.card');
    t.waitFor('.content');
    t.hold(1.1);
    t.scroll('.content', 460, 3.0);
    t.hold(0.7);
    t.scroll('.content', -460, 1.6);
    t.click('.back');
    t.hold(1.5);
  }),
  encode: { width: 900, fps: 16, speed: 1.35, colors: 128, quality: 86, targetMB: 4 },
};
