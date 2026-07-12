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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RenderConfig } from './types.js';
import { render } from './director.js';
import { probe } from './ergonomics/probe.js';
import { web } from './adapters/index.js';
import { ffmpegAvailable, FFMPEG } from './encode/ffmpeg.js';
import { findChrome } from './browser.js';

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parse(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

const num = (v: unknown): number | undefined => (v == null ? undefined : Number(v));

async function loadConfig(file: string): Promise<RenderConfig> {
  const abs = path.resolve(file);
  const mod = await import(pathToFileURL(abs).href);
  const cfg = mod.default ?? mod.config;
  if (!cfg) throw new Error(`gifsmith: ${file} must default-export (or export \`config\`) a RenderConfig`);
  return typeof cfg === 'function' ? cfg() : cfg;
}

function applyOverrides(cfg: RenderConfig, f: Flags): RenderConfig {
  const encode = { ...(cfg.encode ?? {}) };
  if (f.width) encode.width = num(f.width);
  if (f.fps) encode.fps = num(f.fps);
  if (f.speed) encode.speed = num(f.speed);
  if (f.colors) encode.colors = num(f.colors);
  if (f.quality) encode.quality = num(f.quality);
  if (f['target-mb']) encode.targetMB = num(f['target-mb']);
  return {
    ...cfg,
    out: (f.out as string) ?? cfg.out,
    format: (f.format as any) ?? cfg.format,
    alsoEmit: f['also-webp'] ? Array.from(new Set([...(cfg.alsoEmit ?? []), 'webp' as const])) : cfg.alsoEmit,
    loop: (f.loop as any) ?? cfg.loop,
    encode,
    keepFrames: !!f['keep-frames'] || cfg.keepFrames,
    logLevel: f.quiet ? 'warn' : f.debug ? 'debug' : cfg.logLevel,
    target: {
      ...cfg.target,
      headful: !!f.headful || cfg.target.headful,
    },
  };
}

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
  --headful           --keep-frames         --debug   --quiet
`;

async function main(): Promise<void> {
  const f = parse(process.argv.slice(2));
  const cmd = (f._ as string[])[0] ?? 'help';

  if (cmd === 'help' || f.help) { console.log(USAGE); return; }

  if (cmd === 'doctor') {
    const ff = ffmpegAvailable();
    console.log(`ffmpeg (${FFMPEG}): ${ff ? 'OK' : 'MISSING'}`);
    try { console.log(`browser: ${findChrome()}`); } catch (e) { console.log(`browser: MISSING (${(e as Error).message})`); }
    process.exit(ff ? 0 : 1);
  }

  if (cmd === 'probe') {
    const url = (f._ as string[])[1];
    if (!url) { console.error('gifsmith probe <url>'); process.exit(2); }
    const result = await probe({ target: web(url), logLevel: f.debug ? 'debug' : 'warn' });
    if (f.json) console.log(JSON.stringify(result, null, 2));
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
    const file = (f._ as string[])[1];
    if (!file) { console.error('gifsmith render <config.mjs>'); process.exit(2); }
    const cfg = applyOverrides(await loadConfig(file), f);
    const result = await render(cfg);
    console.log('\n' + JSON.stringify(result, null, 2));
    return;
  }

  console.error(`gifsmith: unknown command "${cmd}"\n`);
  console.log(USAGE);
  process.exit(2);
}

main().catch((e) => {
  console.error('gifsmith:', e?.stack || e?.message || e);
  process.exit(1);
});
