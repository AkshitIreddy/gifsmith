/**
 * Renders the gifsmith demo from the bundled example app (examples/hello-web/
 * app.html). Also the project's own smoke test. Run:  npm run example
 *
 * The walkthrough: idle on the hero → generate → cards stagger in → open a
 * topic → slow read-scroll → back to the hero (the loop anchor). Because the
 * scene returns exactly to the hero, the anchor loop finds a clean seam.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render, timeline, web } from '../../dist/index.js';
import { cursor, bezel } from '../../dist/props/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appUrl = pathToFileURL(path.join(here, 'app.html')).href;
const out = path.join(here, 'out', 'demo.gif');

const tl = timeline((t) => {
  t.waitFor('.app');
  t.hold(1.4);
  t.loopAnchor();                      // neutral hero state we return to
  t.click('.generate');                // reveal the briefing grid
  t.waitFor('.card');
  t.hold(1.7);                         // let the cards settle + read
  t.click('.card');                    // open the first topic
  t.waitFor('.content');
  t.hold(1.1);
  t.scroll('.content', 460, 3.0);      // slow read-scroll down
  t.hold(0.7);
  t.scroll('.content', -460, 1.6);     // ease back up
  t.click('.back');                    // return to the hero (== anchor)
  t.hold(1.5);
});

const result = await render({
  target: web(appUrl),
  out,
  alsoEmit: ['webp'],
  viewport: { width: 1180, height: 720, deviceScaleFactor: 1 },
  props: [cursor({ start: { x: 590, y: 470 } }), bezel()],
  timeline: tl,
  loop: 'auto',
  encode: { width: 900, fps: 16, speed: 1.35, colors: 128, quality: 86, targetMB: 4 },
});

console.log('\n' + JSON.stringify(result, null, 2));
