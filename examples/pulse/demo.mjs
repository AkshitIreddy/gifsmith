/**
 * Pulse demo — showcases OVERLAY mode with a synthetic-cursor journey and an
 * anchor loop. Clicking "Refresh" re-runs the dashboard's entrance animations
 * (chart draw-in + KPI count-up), then everything settles back to the same
 * state — so the loop seam is clean.
 *
 *   (cd examples && python -m http.server 8266)
 *   node examples/pulse/demo.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, timeline, web } from '../../dist/index.js';
import { cursor, bezel } from '../../dist/props/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.URL || 'http://127.0.0.1:8266/pulse/app.html';

const result = await render({
  target: web(URL),
  out: path.join(here, 'out', 'demo.gif'),
  alsoEmit: ['webp'],
  viewport: { width: 1200, height: 760 },
  props: [cursor({ start: { x: 640, y: 430 } }), bezel({ vignette: 0.14 })],
  timeline: timeline((t) => {
    t.waitFor('.app');
    t.hold(1.2);
    t.cursorTo('.refresh', 0.7);
    t.hold(0.35);
    t.loopAnchor(); // settled overview, cursor resting on Refresh
    t.click('.refresh'); // re-run chart draw-in + KPI count-up
    t.hold(3.0);
    t.hold(0.6); // settled again == anchor
  }),
  loop: 'auto',
  encode: { width: 940, fps: 16, speed: 1.3, colors: 128, quality: 86, targetMB: 5 },
  logLevel: 'info',
});
console.log('\n' + JSON.stringify(result.outputs.map((o) => ({ f: o.format, kb: Math.round(o.bytes / 1024) })), null, 2), result.loop);
