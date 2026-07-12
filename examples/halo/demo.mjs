/**
 * Halo demo — showcases STAGE mode: the landing page renders as an app window
 * on a mock desktop. The billing toggle flips prices and flips back, so the
 * anchor loop lands exactly where it started.
 *
 * Stage mode needs an http(s) target. Serve the examples dir first:
 *   (cd examples && python -m http.server 8266)   # or any static server
 *   node examples/halo/demo.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, timeline, web } from '../../dist/index.js';
import { cursor } from '../../dist/props/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.URL || 'http://127.0.0.1:8266/halo/app.html';

const result = await render({
  target: web(URL),
  out: path.join(here, 'out', 'demo.gif'),
  alsoEmit: ['webp'],
  compose: 'stage',
  stage: { title: 'Halo — ship with confidence', os: 'mac', hue: 252, padding: 46 },
  viewport: { width: 1200, height: 760 },
  props: [cursor({ start: { x: 620, y: 430 } })],
  timeline: timeline((t) => {
    t.waitFor('.app');
    t.hold(1.6);
    t.scroll('html', 860, 2.6); // one-time intro: glide down to the pricing section
    t.hold(0.7);
    t.cursorTo('.billing-toggle', 0.6);
    t.hold(0.3);
    t.loopAnchor(); // pricing, monthly, cursor on the toggle (loop starts here)
    t.click('.billing-toggle');
    t.hold(1.7); // annual prices animate in
    t.click('.billing-toggle');
    t.hold(1.5); // back to monthly == anchor (a tiny, tightly-compressing loop)
  }),
  loop: 'auto',
  encode: { width: 900, fps: 15, speed: 1.25, colors: 128, quality: 86, targetMB: 5 },
  logLevel: 'info',
});
console.log('\n' + JSON.stringify(result.outputs.map((o) => ({ f: o.format, kb: Math.round(o.bytes / 1024) })), null, 2), result.loop);
