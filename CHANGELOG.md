# Changelog

What changed in each release, and why — the written account beside the commit
list GitHub generates. Newest first.

The version headings are the npm versions; each links its GitHub Release, where
the download and the generated commit list live.

---

## [0.2.3](https://github.com/AkshitIreddy/gifsmith/releases/tag/v0.2.3)

### Fixed

**An anchor trim that keeps the walkthrough.** `findAnchorLoop` took the pair
with the lowest seam MSE and nothing else, which is the wrong rule for exactly
the case the strategy exists for. A scripted product demo holds still on its
neutral pose for a beat after `loopAnchor()` — that hold is what makes an
artifact-free seam possible in the first place — but it also means every pair of
frames *inside* the hold matches almost perfectly, so the shortest qualifying
loop always scores best. Measured on a real 50-second walkthrough that returned
home exactly as intended: anchor frame 45, end frame 105, seam MSE 0.0, and a
4.29-second clip of a bookshelf doing nothing.

The rule is now lowest MSE, **then longest span**. Two seams a hair apart are
equally invisible — the metric stops discriminating long before the eye does —
so a seam within a small tolerance of the best is treated as just as good, and
among those the longest wins. `seamMSE` reports the seam that will actually be
shown rather than the best one seen while searching, so the high-seam warning
stays about the real wrap.

**`minCycleSeconds` is reachable.** It was threaded from `PlanLoopArgs` all the
way into the search, and nothing could set it, because `RenderConfig.loop` was a
bare string union. `loop` now also accepts an options object; a bare
`loop: 'anchor'` keeps meaning exactly what it did.

```ts
loop: { strategy: 'anchor', minCycleSeconds: 30 }
```

---

## [0.2.2](https://github.com/AkshitIreddy/gifsmith/releases/tag/v0.2.2)

### Changed

- Releases publish to npm from a tag with **trusted publishing (OIDC)** — no
  stored `NPM_TOKEN`, no manual OTP, and provenance attested automatically.
- The workflow creates the GitHub Release from the tag, and can be run manually
  for an npm-only publish when the Release already exists.

### Fixed

- `package-lock.json` version synced with `package.json`, so `npm ci` resolves.

---

## [0.2.1](https://github.com/AkshitIreddy/gifsmith/releases/tag/v0.2.1)

### Fixed

- Cursor-click and drag steps scroll their target into view first. A glide to an
  element below the fold used to land on nothing.

---

## [0.2.0](https://github.com/AkshitIreddy/gifsmith/releases/tag/v0.2.0)

### Added

- **`drag` step** — press, glide, release with real pointer events, so resize
  handles and sliders can be driven.
- **Distance-aware cursor glides** for click steps (~900px/s, clamped), so long
  travels stay watchable instead of teleporting. Pin an exact time with
  `click(sel, { glideSeconds })`.
- **Realistic taskbar props** — original SVG app-icon glyphs, a Windows system
  tray, and `stage.bottomInset` so a window never sits flush on the taskbar.

---

## [0.1.0](https://github.com/AkshitIreddy/gifsmith/releases/tag/v0.1.0)

First public release: the movie-set direction model — stage, props, camera and a
synthetic cursor — a declarative timeline, the `window.__demo` app-cooperation
bridge, seamless forward looping (anchor trim and half-period crossfade),
natural pacing from real per-frame timestamps, and the agent-authoring helpers
(`probe`, `dryRun`, `snapshot`, `contactSheet`) plus an MCP server.

- `GIFSMITH_NO_SANDBOX` honoured for containers and CI.
- Example gallery, an Electron attach-and-record example, and documentation for
  stage mode, the sandbox and camera clipping.
