#!/usr/bin/env node
/**
 * gifsmith CLI.
 *
 *   gifsmith render <config.mjs> [--out demo.gif --width 900 --fps 16 ...]
 *   gifsmith probe  <url>        [--json]
 *   gifsmith doctor
 *
 * A config module default-exports (or exports `config`) a RenderConfig — the
 * timeline is authored in code (the DSL), vhs-.tape in spirit but fully
 * programmable. CLI flags override the config's encode/loop options.
 */
import { render } from './director.js';
import { probe } from './ergonomics/probe.js';
import { web } from './adapters/index.js';
import { ffmpegAvailable, FFMPEG } from './encode/ffmpeg.js';
import { findChrome } from './browser.js';

// The flag layer lives next door so it can be tested without launching a
// render — see flags.ts. `test/cli.test.mjs` then spawns THIS file, because a
// parser that is right in isolation is not the same claim as a command that
// behaves: the flag layer named `--lossless demo.mjs` for a whole release while
// the command still printed the bare usage line, since the check below for a
// missing positional ran first.
import {
  parse, applyOverrides, bool, checkFlags, swallowedConfig,
  RENDER_FLAGS, PROBE_FLAGS,
} from './flags.js';
import { UsageError, isEnvironmentError, isUserFacing } from './errors.js';
// Loading the config module is `loadConfig.ts`'s job, not this file's, for the
// reason `errors.ts` gives about validation: the same code was written twice
// (here and in mcp/server.ts), only this copy guarded a missing file, and every
// OTHER way a module fails to load — a syntax error, an unresolved import, a
// `.ts` path, a directory — printed node's ESM stack and exited 1. A fix at
// this call site would have covered exactly one of the two callers again.
import { loadConfigModule } from './loadConfig.js';

const loadConfig = (file: string) => loadConfigModule(file, (m) => new UsageError(m));

const USAGE = `gifsmith — browser/app demo GIF/WebP maker

Usage:
  gifsmith render <config.(mjs|js)>   Render a demo from a config module
  gifsmith probe  <url> [--json]      Print interactive elements + bridge status
  gifsmith doctor                     Check ffmpeg + browser detection


Render flags (override the config):
  --out <path>        --format <gif|webp>   --also-webp
  --width <px>        --fps <n>             --speed <x>
  --colors <n>        --quality <0-100>     --target-mb <n>
  --loop <auto|anchor|crossfade|none>
  --capture <screencast|deterministic>
      screencast (default) records real paints in real time.
      deterministic renders on Chromium's virtual clock — slower, but the
      output is identical whatever the machine was doing at the time.
  --headful           --keep-frames         --debug   --quiet
      Every flag above takes true|false as well as being written bare, and an
      explicit false overrides a config that said true — except --debug and
      --quiet, which are shortcuts onto logLevel: "false" there means "not
      asking", and the config's own logLevel stands. --quiet wins over --debug.

Quality flags (the defaults are tuned for size; these buy fidelity back):
  --frame-format <jpeg|png>   captured frames; png is lossless (see --capture)
  --palette <diff|full|perFrame>   GIF palette: shared, shared-weighted-by-all,
                                   or a fresh one every frame (best, biggest)
  --dither <bayer|floyd_steinberg|sierra2|sierra2_4a|atkinson|none>
  --bayer-scale <0-5>         finer pattern at higher values (default 4)
  --lossless                  WebP only: keep every pixel
`;

async function main(): Promise<void> {
  const f = parse(process.argv.slice(2));
  const cmd = (f._ as string[])[0] ?? 'help';

  // `'help' in f` rather than `bool(f, 'help')`: `--help` is the one flag whose
  // job is to explain the command line, so it must not be able to fail on the
  // shape of the command line. `gifsmith render --help demo.mjs` prints usage.
  if (cmd === 'help' || 'help' in f) { console.log(USAGE); return; }

  if (cmd === 'doctor') {
    const ff = ffmpegAvailable();
    console.log(`ffmpeg (${FFMPEG}): ${ff ? 'OK' : 'MISSING'}`);
    try { console.log(`browser: ${findChrome()}`); } catch (e) { console.log(`browser: MISSING (${(e as Error).message})`); }
    process.exit(ff ? 0 : 1);
  }

  if (cmd === 'probe') {
    // Flags first, positionals second — see checkFlags. `probe --json <url>`
    // parses as `json: '<url>'` with no positional left, and reporting that as
    // "you gave me no url" describes the wrong half of the mistake.
    checkFlags(f, PROBE_FLAGS);
    const url = (f._ as string[])[1];
    if (!url) throw new UsageError('probe needs a url: gifsmith probe <url> [--json]');
    const result = await probe({ target: web(url), logLevel: bool(f, 'debug') ? 'debug' : 'warn' });
    if (bool(f, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.title}  (${result.url})`);
      console.log(`bridge: ${result.hasBridge ? 'window.__demo present' : 'none'} | props: ${result.props.join(', ') || '—'}`);
      console.log(`${result.elements.length} interactive elements:`);
      for (const el of result.elements.slice(0, 40)) {
        console.log(`  ${el.selector.padEnd(34)} ${el.clickable ? '•' : ' '} ${el.rect.x},${el.rect.y} ${el.rect.width}×${el.rect.height}  ${el.text}`);
      }
    }
    return;
  }

  if (cmd === 'render') {
    // The ordering that finding #1 was about. Every render flag is read for its
    // errors HERE, before the positional is looked at, because the commonest
    // mistake is a flag eating the positional: `--lossless demo.mjs` leaves no
    // config path, and "gifsmith render <config.mjs>" is then a true statement
    // that sends the reader hunting for an argument they did type.
    checkFlags(f, RENDER_FLAGS);
    const file = (f._ as string[])[1];
    if (!file) {
      const eaten = swallowedConfig(f);
      throw new UsageError(
        'render needs a config module: gifsmith render <config.(mjs|js)>' +
          (eaten ? ` — note --${eaten.key} took "${eaten.value}" as its value` : ''),
      );
    }
    const cfg = applyOverrides(await loadConfig(file), f);
    const result = await render(cfg);
    console.log('\n' + JSON.stringify(result, null, 2));
    return;
  }

  console.error(`gifsmith: unknown command "${cmd}"\n`);
  console.log(USAGE);
  process.exit(2);
}

/**
 * One prefix, wherever the message came from.
 *
 * The flag layer's messages carry no `gifsmith:` (this handler owns it) and the
 * library's do (a `dryRun` report and a programmatic caller have nothing else to
 * say who is speaking). Printing both produced the line the gate quoted —
 * `gifsmith: Error: gifsmith: capture.mode must be …` — so the prefix is added
 * only when it is not already there, and never twice.
 */
const oneLine = (message: string): string =>
  message.startsWith('gifsmith:') ? message : `gifsmith: ${message}`;

main().catch((e) => {
  // Three failures, three shapes, decided by TYPE and not by inspecting a
  // message — because the previous two rounds of this bug were both a validator
  // in a layer nobody had thought about. See errors.ts.
  //
  //   UsageError / ConfigError  the user's mistake      → one line, exit 2
  //   EnvironmentError          the machine's           → one line, exit 1
  //   anything else             ours                    → the stack, exit 1
  //
  // A stack for a typo is noise about something the user can already see; a
  // stack for a real failure is the only thing that makes it debuggable.
  if (isUserFacing(e)) {
    console.error(oneLine(e.message));
    process.exit(isEnvironmentError(e) ? 1 : 2);
  }
  console.error('gifsmith:', e?.stack || e?.message || e);
  process.exit(1);
});
