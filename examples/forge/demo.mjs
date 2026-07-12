/**
 * Forge demo — showcases a CAMERA CLIP framed on the CI pipeline while it runs,
 * with a crossfade loop over the running animation. Clicking "Run pipeline"
 * animates the stages Build → Test → Scan → Deploy and streams the log.
 *
 *   (cd examples && python -m http.server 8266)
 *   node examples/forge/demo.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, timeline, web } from '../../dist/index.js';
import { cursor } from '../../dist/props/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.URL || 'http://127.0.0.1:8266/forge/app.html';

const result = await render({
  target: web(URL),
  out: path.join(here, 'out', 'demo.gif'),
  alsoEmit: ['webp'],
  viewport: { width: 1200, height: 760 },
  // Frame the topbar (Run button) + the four pipeline stage cards.
  camera: { x: 250, y: 0, width: 950, height: 246 },
  props: [cursor({ start: { x: 640, y: 120 } })],
  timeline: timeline((t) => {
    t.waitFor('.app');
    t.hold(1.0);
    t.cursorTo('.run', 0.6);
    t.click('.run'); // stages animate queued -> running -> passed, log streams
    t.hold(5.0);
    t.hold(0.8);
  }),
  loop: 'crossfade',
  encode: { width: 900, fps: 16, speed: 1.15, colors: 128, quality: 86, targetMB: 5 },
  logLevel: 'info',
});
console.log('\n' + JSON.stringify(result.outputs.map((o) => ({ f: o.format, kb: Math.round(o.bytes / 1024) })), null, 2), result.loop);
