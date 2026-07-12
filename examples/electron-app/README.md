# Electron attach example

A minimal, real Electron app recorded **end-to-end** with gifsmith's
`electron()` adapter — no changes to the app, just two launch switches. The
renderer is the premium **Cadence** music player (`renderer.html`, a copy of
[`../cadence/app.html`](../cadence/app.html)); its ambient equalizer makes the
crossfade loop seamless.

```bash
npm install          # pulls Electron (~200 MB)
npm run record       # launches the app, attaches over CDP, writes out/demo.gif (+ .webp)
```

## How it works

1. [`main.js`](main.js) starts a borderless `BrowserWindow` and appends
   `--remote-debugging-port=9222` + `--remote-allow-origins=*` (the CDP
   WebSocket 403s without the latter). The window renders hidden
   (`show:false`, `paintWhenInitiallyHidden:true`) so the capture is invisible.
2. [`record.mjs`](record.mjs) spawns Electron, waits for the CDP endpoint, then
   calls `render({ target: electron({ port: 9222 }), … })`.

**Tauri** works identically — launch with a WebView2 remote-debugging port and
swap `electron()` for `tauri()`.
