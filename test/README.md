# tests

`npm test` — the node:test runner over the built `dist/`, no framework and no
new dependency. It covers the parts of gifsmith that can be checked without a
browser or an ffmpeg round trip, which is a smaller set than it sounds:

- **the clock seam** (`clock.test.mjs`) — that `realClock` still is `setTimeout`
  and `await`, because the default screencast path is defined as "whatever the
  player did before the seam existed" and that is only true if it stays true.
- **the frame scheduler** (`schedule.test.mjs`) — one frame per frame interval,
  no drift after thousands of sub-frame advances, and a `parallel` beat costing
  the longest branch rather than the sum. This is the arithmetic a deterministic
  render's whole promise rests on, and it is invisible in the output: a scheduler
  that drifts produces a GIF that looks fine and is a frame short every second.
- **the call context** (`callContext.test.mjs`) — the legacy one-argument
  callback, the real clock's pass-through behaviour, and the four ways a
  virtual-clock callback is stopped from hanging silently (including the two
  that were wrong first time: an `advance` that spun forever on a stopped clock
  while petting the watchdog that was meant to catch it, and an unclocked-wait
  report that only fired when a callback spent literally no scene time at all).
- **the capture options** (`captureOptions.test.mjs`) — that a mode gifsmith
  cannot honour is refused rather than quietly meaning "screencast". Every case
  in there used to render happily, slowly, and on the other backend.
- **the anchor search** (`anchor.test.mjs`) — lowest seam MSE, then longest span,
  on synthetic thumbnails.
- **the encode filter** (`encode.test.mjs`) — the palette/dither options produce
  the ffmpeg filter chain they claim to, including dropping `diff_mode` for a
  per-frame palette.
- **the CLI flags** (`flags.test.mjs`) — that every value-taking flag is read as
  the kind of thing it is. `str()` was added so a flag with its value left off
  could not be misread, and applied to the string flags only; the numeric ones
  kept a bare `Number(v)` behind them, and `Number(true) === 1`, so
  `--bayer-scale` alone rendered at scale 1 — the setting this project's own
  measurements call a disaster at 30.2 dB — and printed a result that looked
  fine. `--lossless false` turned lossless on. Every failure in this layer is
  silent, which is what makes argv parsing worth a test file.
- **the MCP server** (`mcp.test.mjs`) — a real stdio JSON-RPC handshake against
  `dist/mcp/server.js`. Nothing else in gifsmith imports
  `@modelcontextprotocol/sdk`, so this is the only thing that would notice if the
  lazy load broke. It SKIPS when the SDK is absent, because `npm test` has to
  pass for someone who never opted into an optional peer; CI sets
  `GIFSMITH_REQUIRE_MCP=1`, which turns a skip into a failure.
- **the package** (`packaging.test.mjs`) — what `npm pack` actually contains, and
  what the manifest actually asks npm to install. The MCP SDK sat in
  `optionalDependencies` for a release — which npm installs BY DEFAULT — so a
  clean `npm i gifsmith` was 170 packages and 49.5 MB of HTTP server stack. The
  build was clean and every other test was green throughout.

Everything downstream of a browser (capture, pacing, loop materialisation,
encoding) is exercised by `npm run example`, which renders the bundled demo end
to end.

`.github/workflows/ci.yml` runs all of this on every push and pull request (Node
18, the `engines` floor, and 24) and separately measures what a clean install of
the packed tarball costs. `release.yml` runs the same suite before it is allowed
to publish.
