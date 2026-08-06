# Changelog

What changed in each release, and why — the written account beside the commit
list GitHub generates. Newest first.

The version headings are the npm versions; each links its GitHub Release, where
the download and the generated commit list live.

---

## [0.3.1](https://github.com/AkshitIreddy/gifsmith/releases/tag/v0.3.1)

### Changed

- **README** — move the bundled **Examples** gallery and **Built with gifsmith** showcase directly under the hero demo so npm and GitHub show the pictures before the long-form docs.

---

---

## [0.3.0](https://github.com/AkshitIreddy/gifsmith/releases/tag/v0.3.0)

The release where a demo GIF stops being a measurement of the machine that
recorded it.

### Added

**`capture: 'deterministic'` — render it, don't record it.** A second capture
backend that replaces the page's clock with Chromium's virtual time
(`Emulation.setVirtualTimePolicy`), spends it one frame at a time and takes an
explicit screenshot per frame. `performance.now()`, `Date.now()`, `setTimeout`
and `requestAnimationFrame` all follow it, so animation advances exactly one
frame per budget while a main-thread stall burns real seconds and ~zero virtual
ones and never reaches the output. Frame timestamps are exact multiples of the
frame interval by construction, and `speed` is folded into the scene-time frame
interval at capture, so nothing downstream resamples.

The screencast remains the default and is untouched: it is honest about the
app's own animation and it is fast. Deterministic is for when the demo judders
because the recording machine was busy.

```ts
capture: 'deterministic'                          // or { mode, format, frameTimeoutMs, waitForNetwork }
```

On the bundled example: screencast 13.75s of output for a walkthrough designed
to be 9.4s; deterministic 9.38s, with the same seam quality. On a 90-second
WebGL product tour under SwiftShader with no GPU: 1336 frames at exactly 14fps,
a 1209-frame anchor loop, seam MSE 0.054 — at 3.9 frames per real second. You
wait, and the machine's mood is nowhere in the result.

**`t.call()` receives the scene clock.** The callback is where every non-trivial
scene does its waiting, and until now the only way it could wait was a
`setTimeout` — which measures the machine, and under a virtual clock buys zero
rendered frames, so the animation being waited for is not mistimed but absent.
The second argument is `ctx`: `ctx.advance(ms)` spends scene time,
`ctx.settle(p)` awaits something that can only finish while the page paints,
`ctx.nowMs()` reads the clock cues are stamped on. On the screencast path they
are exactly `setTimeout` and `await`.

**The one-argument form is untouched** — `t.call(async (page) => …)` keeps
working on both backends.

Four guards, all virtual-clock only, because a renderer that hangs with no
output is the worst failure it has: `ctx.settle` throws on its scene-time cap
naming the step; a stall watchdog fails a callback that goes 30s of real time
without touching the clock; `ctx.advance` fails when the clock stops moving
under it; and any unclocked stretch of real time is reported afterwards with the
number to pass to `ctx.advance`.

**Lossless frames and encoder quality knobs.** `capture: { format: 'png' }`
removes the JPEG stage before the encoder, making the deterministic pipeline
lossless end to end. `encode.palette` (`'diff' | 'full' | 'perFrame'`),
`encode.dither` (six kernels including `'none'`), `encode.bayerScale` and
`encode.lossless` for WebP. Measured on a 1209-frame UI render:
`colors: 256, dither: 'none', palette: 'full'` costs 6% more bytes than the
defaults and is 3.2 dB better, because on flat-colour art the dither was only
adding the noise it exists to hide. PNG capture frames produce a GIF **27%
smaller** than JPEG ones — JPEG ringing is high-frequency noise in a picture
that had none, and noise is the one thing a palette cannot compress. The README
has the full tables.

**`t.call(fn, { seconds })`** declares how much scene time a callback spends, so
`dryRun`'s `totalPlannedSeconds` stops under-reporting a scene that does its
work in callbacks. Undeclared calls still count as zero, and `dryRun` now says
how many there are rather than quoting a confident wrong total.

**A test suite** — `npm test`, `node --test` over the built output, no framework
and no new dependency. It covers what fails invisibly: the clock seam's
real-clock behaviour, the frame scheduler's arithmetic (one frame per interval,
no drift after thousands of sub-frame advances, a `parallel` costing the longest
branch and not the sum), the call context and its guards, the capture-option
rules, the anchor search, that encode options reach the ffmpeg filter chain, the
CLI's flag layer, a real MCP handshake, and what the package ships and costs to
install.

It also drives the CLI as a process — exit code and output, for every flag — and
compiles **every TypeScript example in the README** against the shipped
`dist/*.d.ts` under `strict: true`. Documentation that does not compile is the
kind of defect a test suite is for: the example above cost nothing to write, said
the right thing, and did not work.

**And CI that runs it** — `.github/workflows/ci.yml`, on every push and pull
request, on Node 18 (the `engines` floor) and 24, plus a job that packs the
tarball and measures what a clean `npm install` of it actually pulls in.
`release.yml` runs the suite before it may publish. The suite was this release's
headline addition and for most of its development nothing ran it: the release
workflow was install → build → verify tag → pack → publish, with no `npm test`
anywhere, so the pipeline could have shipped a red suite and reported success.

**CLI:** `--capture`, `--frame-format`, `--palette`, `--dither`, `--bayer-scale`,
`--lossless`.

### Changed

- `PageCallback` gained its second parameter. Every authoring shape still
  compiles — a one-argument callback inline or assigned to the type — and the
  only code affected is anything that *invokes* a `PageCallback` itself with one
  argument, which now wants two.
- **`PageCallback`'s `page` is a puppeteer `Page`, not `unknown`.** It was
  `unknown` to keep `types.ts` free of a puppeteer import, and every author paid
  for it: in a strict project this README example did not compile —
  `t.call(async (page, ctx) => { await ctx.settle(page.evaluate(…)); })`, with
  `TS18046: 'page' is of type 'unknown'` — which is a poor greeting from the
  feature this release is named after. The import costs nothing that was not
  already being paid, since puppeteer-core is a hard dependency and the shipped
  `assert.d.ts` has imported `Page` from it since 0.1.0. Callbacks are
  unaffected; the only code that can notice is something invoking a
  `PageCallback` with a value that is not a Page.
- **Failures have types**: `UsageError`, `ConfigError` and `EnvironmentError` are
  exported, along with `configProblems` / `sceneProblems` / `assertConfig`. All
  three extend `Error` and carry the same messages, so catching one is unchanged
  — they exist so a caller can tell "you gave me a value I cannot use" from
  "gifsmith broke" without matching on a string, which is what the CLI could not
  do and why it printed a stack trace for a typo.
- `snapshot`, `contactSheet` and `dryRun` accept the scene's `capture` field, so
  the object passed to `render()` can be passed to them verbatim. `dryRun`
  enforces the capture rules `render` does; `snapshot`/`contactSheet` still play
  on the real clock and say so once when the scene asks for `deterministic`.
- The README's claim that a virtual clock freezes CSS transitions is gone. It
  was measured on current Chrome while building this: CSS `transition` and
  `@keyframes` both advance with virtual time.

### Fixed

- **An unrecognised `capture` no longer means "screencast".** The mode was never
  validated and was decided by a bare `=== 'deterministic'`, so a typo, an
  object with no `mode`, or the CLI's valueless `--capture` all fell through to
  the recorded path — the user asked for a deterministic render, waited for a
  recorded one, and was told nothing. Validated once before a browser is
  launched, and `dryRun` reports the same problem instead of throwing.
- **Every config value is checked the same way, in one place.** `capture` was
  validated, and nothing else was — so the same silent failure sat under
  `loop: 'crossfde'` (not 'auto', not 'none', not 'crossfade', so the planner
  took the ANCHOR branch), `palette: 'ful'` (silently the default),
  `format: 'jpg'` (a WebP written to a path called demo.jpg) and `encode.fps: 0`
  (a division by zero, an Infinity in the reported duration, and an ffmpeg
  failure a dozen steps later). The rules live in `config.ts`, `render()` applies
  all of them before it looks for ffmpeg or launches anything, and `dryRun()`
  reports them instead of throwing. Only values that are already broken are
  refused: `colors: 300` and `bayerScale: 9` are documented as clamped by the
  encoder and stay clamped.
- **`compose: 'stage'` checks its target before launching a browser.** "Stage
  mode needs target.url" and "can't frame a `file://` app" were discovered inside
  `composeScene` — one browser launch, one throwaway profile and one page load
  after both were knowable from the config alone.
- **A capture that stops advancing fails the render.** When the frame pump dies
  mid-scene it releases the timeline rather than hanging it, which is right —
  but the remaining steps then ran out against a frozen scene and the render
  reported success with half a walkthrough in it. The failure is kept and raised.
- **`ctx.advance` cannot spin forever.** It walked toward its target in chunks
  with no termination other than the clock actually moving, so a stopped clock
  meant an infinite hot loop — and because it beat the stall watchdog on every
  iteration, the guard standing next to it was being told everything was fine.
- **The unclocked-wait report sees the common case.** It fired only when a
  callback spent *exactly* zero scene time across its whole run, so
  `advance(250)` followed by a 1900ms sleep — spend a little, then wait out an
  animation on the machine's clock — was never reported. It now measures the
  longest single stretch without a clock verb, which catches both shapes and
  stays quiet about a callback doing ordinary CDP work.
- **A capped click is no longer abandoned mid-flight.** `driver.click()` is
  scroll-into-view + resolve-a-point + dispatch, and the whole call was given a
  scene-time cap; on expiry puppeteer kept running and the click could land out
  of band, several beats later. Under the virtual clock the call is taken apart:
  everything under the cap is a query (safe to walk away from) and the dispatch
  happens only once a point is in hand. The real clock still calls
  `driver.click()`.
- **No frame can arrive after capture stops.** `stop()` waits at most 250ms for
  a pump mid-frame and then detaches CDP, so a screenshot could still be in
  flight and land in the frame directory after the Director had read it.
- **Installing gifsmith no longer installs an HTTP server stack.**
  `@modelcontextprotocol/sdk` sat in `optionalDependencies`, which reads like
  "opt in" and is not what npm means by it — npm installs optional dependencies
  **by default**, and "optional" only promises to tolerate one that fails. So
  every consumer of a 300 KB GIF library got express, hono, `@hono/node-server`,
  cors and the rest: **170 packages and 49.5 MB** in a clean project. It is an
  **optional peer dependency** now, which npm does not auto-install: **85
  packages and 35 MB**, all of it puppeteer-core. `gifsmith-mcp` still works the
  moment you install the SDK, and prints the one-line command if you have not.
  Both halves are tested (`packaging.test.mjs`, `mcp.test.mjs`) and the install
  cost is measured in CI, because the manifest looked reasonable throughout.
- **A mistake in the command line is one line and exit 2, not a stack.** Every
  failure used to print `gifsmith: <stack>` and exit 1. A config module that
  exported nothing gave `gifsmith: Error: gifsmith: demo.mjs must default-export
  …` — the program name twice, because the thrower added it and the handler added
  it again, and the class name leaking in the middle — followed by frames through
  node's module loader. A mistyped filename gave four frames of `ERR_MODULE_NOT_FOUND`.
  Failures are sorted by TYPE now rather than by inspecting a message: a mistake
  in the command line, or a value in the config gifsmith cannot honour, prints one
  line and exits 2; a missing ffmpeg or browser prints one line and exits 1; and
  anything else keeps its full stack, because that one is ours to debug.
- **…and that now covers loading the config, which is where the same defect was
  still sitting.** Sorting by type fixed the failures gifsmith *raised*; the ones
  node raised on the way in were untouched. `cli.ts` guarded exactly one of them
  (the file is not there) and left the rest, so a **syntax error in a config**
  printed five frames of `node:internal/modules/esm/*` and — the part that made
  it worth a release — never named the file, because node's message for a parse
  failure is `Unexpected identifier 'out'` and nothing else. An import that does
  not resolve gave eight frames, `gifsmith render demo.ts` five, a directory ten,
  a `.json` four. All of them are one line and exit 2 now, all of them name the
  config, `demo.ts` is told what to do instead, and an unresolved import still
  says which file imported it. A config that **loads and then throws** keeps its
  full stack — that one has the author's own frames in it and is the only
  debuggable thing about it.

  The rule is structural rather than a list of error types: code that ran must
  appear in its own stack, so a failure with no frame outside `node:` internals
  happened before the module body did. And it lives in one module both bins call,
  because the same twelve lines had been written twice — `mcp/server.ts` had no
  guards at all, and its dispatcher prints `e.message` with no stack, so an agent
  handed a broken scene was told `error: Unexpected identifier 'out'` and nothing
  whatsoever about which file it came from.
- **The MCP tools enforce the `inputSchema` they advertise.** Each one declares
  its arguments and which are required, and a client was trusted to honour a
  schema it had merely been shown — so `gifsmith_render` called with `{}` reached
  `path.resolve(undefined)` and answered `error: The "paths[0]" argument must be
  of type string. Received undefined`: no tool name, no argument name, nothing
  saying gifsmith was speaking, to a caller that is usually a model and will try
  again. The check is derived from `TOOLS` rather than written beside each call,
  so a tool added later is covered the day it is added.
- **`out` is checked for being a file before anything is spent.** It was
  validated as a non-empty string, which `.` satisfies — so `--out .` launched
  Chrome, played the scene, paced the frames, planned the loop, and died at
  ffmpeg refusing to open a directory: 29 lines of stderr with its whole
  `configuration:` line in them, minutes after the mistake, not one of them
  containing the word `out`. A path that does not exist yet is still fine, and
  has to be — it is what every correct render passes. Asking which other fields
  are a PATH found the one sibling: a `workDir` naming an existing file died at
  `fs.mkdirSync` with `EEXIST: file already exists` and three frames, from inside
  `render()`, naming nothing either.
- **The flags are read before the positional, so a swallowed config path is
  named.** `gifsmith render --lossless demo.mjs` parses as
  `{ lossless: 'demo.mjs' }` with no positional left — and the CLI tested
  `if (!file)` first, printing the bare `gifsmith render <config.mjs>` usage,
  which sends the reader hunting for an argument they did type. Every flag is now
  validated before a positional is looked at, before a config module is imported
  and before a browser is launched, so the message describes what happened.
- **The values of `--capture`, `--loop`, `--format`, `--dither`, `--palette` and
  `--frame-format` are checked.** They were read as strings and handed on, which
  is the same silent class the `capture` fix above is about, one layer down:
  `--loop crossfde` matched none of the planner's three tests and rendered with
  the ANCHOR strategy; `--palette ful` silently rendered the default; `--format
  jpg` wrote a WebP to a path ending `.jpg`. A near-miss is named as one:
  `--capture Deterministic` answers `did you mean --capture deterministic?`. The
  hint quotes the value it means and says nothing about its shape — an earlier
  version ended "the values are lowercase", which contradicted itself on
  `--palette PerFrame`, the one value most likely to be mistyped.
- **CLI flags that take a value say so instead of being spread in as `true`** —
  and that fix now covers the numeric flags, which it did not. They went through
  a bare `Number(v)`, and `Number(true) === 1`, so `--bayer-scale` with its value
  left off did not fail, warn, or fall back to the default: it rendered at
  bayerScale 1, the setting this project's own measurements call a disaster at
  30.2 dB. `--fps` alone was one frame per second. A value that is not a number
  is refused too, rather than reaching ffmpeg as `NaN`. `--fps 0`, `--width -1`
  and `--quality 120` are refused as well; `--colors 300` and `--bayer-scale 9`
  are not, because the encoder documents a clamp for those two.
- **`--also-webp false` turns also-webp off.** One of the six booleans behaved
  differently from the other five: its config field is an ARRAY (`alsoEmit`), the
  false branch handed the config's array straight back, and against
  `alsoEmit: ['webp']` bare, `true` and `false` all emitted the WebP. Asking the
  question the other way round — which flags write a config field whose shape
  they cannot express? — found two more of the same kind. `--capture screencast`
  replaced `{ mode, format, frameTimeoutMs, waitForNetwork }` with the bare
  string, silently dropping every other knob; `--loop anchor` replaced
  `{ strategy, minCycleSeconds }` and put the anchor floor back to the 3-second
  default, which is exactly the "hands back a motionless clip" failure 0.2.3
  fixed. All three merge onto the config now instead of replacing it.
- **`--lossless false` turns lossless off.** It parsed as the string `'false'`,
  which is truthy. The same `flag || cfg.flag` shape was under `--headful` and
  `--keep-frames`, where it meant a config that said `true` could not be
  overridden from the command line at all.
- **`--debug false` and `--quiet false` deliberately do not, and now say so.**
  Four of the six booleans own a field with two states, so "off" is a thing that
  can be said. These two are shortcuts onto `logLevel`, which has four — and "not
  debug" does not name one of `silent | warn | info | debug`. Any answer gifsmith
  picked would be a level the reader never asked for, overriding one they did
  write in the config, so a false answer means "not asking" and the config's own
  level stands. The asymmetry looked exactly like the `--also-webp` bug above
  while nothing documented it; the CLI's `--help` and the README both state it,
  and both say that `--quiet` wins when the two are given together.
- **A leaked JSHandle per click.** `clickWithoutAbandoning` acquired
  `driver.$(selector)` and never disposed it, pinning one DOM node in the page
  for the life of the render — worst on the longest renders, which are the ones
  with the most clicks. The `type` and `drag` steps had it too.
- **`snapshot()` lands inside a `call` step.** `playCapturing` split only `hold`
  steps around a requested stop, which was sufficient while a callback counted
  for zero planned seconds. Now that `t.call(fn, { seconds: 2 })` declares real
  duration, asking to see 1s into a 2s callback returned the frame *after* the
  whole callback — the one moment not asked for, silently substituted. A step
  that cannot be split is raced instead: started, shot through part-way, then
  awaited.
- **The published tarball stopped shipping dead source maps.** Every
  `dist/**/*.js.map` and `*.d.ts.map` listed `sources: ["../src/*.ts"]` with no
  `sourcesContent`, and `src/` is deliberately not published — 152 KB, 34% of the
  unpacked tarball, resolving to nothing. Emitting `sourcesContent` instead would
  put the whole TypeScript source inside the maps, which is bigger than shipping
  `src/`. They are still built locally, where the sources exist. 156 packed
  entries → 88.
- The anti-hang guards are counted the same everywhere. There are **four**, and
  the README said four in one place and three in another, while
  `callContext.ts`'s own header said three above a list of four.
- `.npmignore`'s first line claimed "publish only dist + docs". `docs/` is not in
  `files` and correctly never shipped — `docs/demo.gif` alone is 3.4 MB.

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
