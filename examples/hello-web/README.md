# hello-web example

A self-contained demo: `app.html` is a tiny animated "Aurora" briefing app (no
server, no build), and the scripts render a seamless looping GIF/WebP of a
scripted walkthrough of it. This doubles as gifsmith's smoke test.

```bash
npm run build          # from the repo root
node examples/hello-web/demo.mjs
# → examples/hello-web/out/demo.gif  (+ demo.webp)
```

- **`demo.mjs`** — the walkthrough authored with the library API (`render(...)`).
- **`demo.config.mjs`** — the same scene as a CLI config module:

  ```bash
  node dist/cli.js render examples/hello-web/demo.config.mjs --width 900 --also-webp
  ```

The timeline idles on the hero, generates the briefing, opens a topic,
slow-scrolls the detail, and returns to the hero — which is marked
`loopAnchor()`, so the loop seam is where the scene started.
