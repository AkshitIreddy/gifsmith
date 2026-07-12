/**
 * End-to-end recording of a real Electron app with gifsmith's electron()
 * adapter. Launches the Electron app (which exposes a CDP port, see main.js),
 * waits for the endpoint, attaches, and records the live window — no changes to
 * the app itself. The identical attach flow works for Tauri (WebView2); swap
 * electron() for tauri().
 *
 *   npm install        # in this folder (pulls Electron)
 *   npm run record     # -> out/demo.gif (+ .webp)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import { render, timeline, electron } from '../../dist/index.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const electronBin = require('electron'); // the electron package exports its binary path

function waitForCDP(url, timeoutMs = 25_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(url, (res) => { res.resume(); res.statusCode === 200 ? resolve() : retry(); })
        .on('error', retry);
    };
    const retry = () => (Date.now() - start > timeoutMs ? reject(new Error('CDP endpoint never came up')) : setTimeout(tick, 300));
    tick();
  });
}

const proc = spawn(electronBin, [here], { cwd: here, stdio: ['ignore', 'inherit', 'inherit'] });
try {
  await waitForCDP('http://127.0.0.1:9222/json/version');
  await new Promise((r) => setTimeout(r, 800)); // let the renderer settle

  const result = await render({
    target: electron({ port: 9222 }),
    out: path.join(here, 'out', 'demo.gif'),
    alsoEmit: ['webp'],
    viewport: { width: 1200, height: 760 }, // matches the BrowserWindow
    // The renderer (Cadence) has a continuously-animating equalizer, so the
    // crossfade loop is seamless with no reset needed.
    timeline: timeline((t) => {
      t.waitFor('.player', { timeoutMs: 15_000 });
      t.hold(1.6);
      t.click('.track');   // load a track from the library
      t.hold(1.3);
      t.click('.play');    // play — equalizer comes alive
      t.hold(2.6);
      t.click('.next');    // skip to the next track
      t.hold(2.4);
    }),
    loop: 'crossfade',
    encode: { width: 900, fps: 16, speed: 1.15, colors: 128, quality: 86 },
    logLevel: 'info',
  });
  console.log('\n' + JSON.stringify(result.outputs.map((o) => ({ format: o.format, kb: Math.round(o.bytes / 1024) })), null, 2));
} finally {
  proc.kill();
}
