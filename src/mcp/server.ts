#!/usr/bin/env node
/**
 * gifsmith MCP server (experimental) — exposes the AI-author surface as tools so
 * an agent drives gifsmith directly: probe a page, dry-run a scene, grab a
 * contact sheet or a single snapshot to "see" a moment, then render. Scenes are
 * authored as a config module (the timeline is code); tools take its file path.
 *
 * The MCP SDK is an OPTIONAL dependency (loaded lazily via string specifiers so
 * a plain `npm i gifsmith` / `tsc` never requires it). Install it to use this:
 *   npm i @modelcontextprotocol/sdk
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RenderConfig } from '../types.js';
import { render } from '../director.js';
import { probe } from '../ergonomics/probe.js';
import { dryRun } from '../ergonomics/dryRun.js';
import { contactSheet, snapshot } from '../ergonomics/snapshot.js';
import { web } from '../adapters/index.js';

async function loadConfig(file: string): Promise<RenderConfig> {
  const mod = await import(pathToFileURL(path.resolve(file)).href);
  const cfg = mod.default ?? mod.config;
  if (!cfg) throw new Error(`${file} must default-export a RenderConfig`);
  return typeof cfg === 'function' ? cfg() : cfg;
}

const text = (obj: unknown) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const image = (base64: string) => ({ content: [{ type: 'image', data: base64, mimeType: 'image/png' }] });

const TOOLS = [
  {
    name: 'gifsmith_probe',
    description: 'List interactive elements (with selectors + bounding boxes) and bridge status for a URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'gifsmith_dry_run',
    description: 'Validate a scene config module (selectors resolve, loop anchor, planned duration) without rendering.',
    inputSchema: { type: 'object', properties: { configPath: { type: 'string' } }, required: ['configPath'] },
  },
  {
    name: 'gifsmith_contact_sheet',
    description: 'Render N frames across the timeline as a single tiled PNG for visual QA. Returns an image.',
    inputSchema: { type: 'object', properties: { configPath: { type: 'string' }, n: { type: 'number' } }, required: ['configPath'] },
  },
  {
    name: 'gifsmith_snapshot',
    description: 'Render a single frame at a timeline time (seconds). Returns an image.',
    inputSchema: { type: 'object', properties: { configPath: { type: 'string' }, atSeconds: { type: 'number' } }, required: ['configPath', 'atSeconds'] },
  },
  {
    name: 'gifsmith_render',
    description: 'Render the full looping GIF/WebP from a config module. Returns the structured result (paths, bytes, loop-seam MSE, warnings).',
    inputSchema: { type: 'object', properties: { configPath: { type: 'string' } }, required: ['configPath'] },
  },
];

async function dispatch(name: string, args: any): Promise<any> {
  switch (name) {
    case 'gifsmith_probe':
      return text(await probe({ target: web(args.url), logLevel: 'warn' }));
    case 'gifsmith_dry_run':
      return text(await dryRun(await loadConfig(args.configPath)));
    case 'gifsmith_contact_sheet': {
      const sheet = await contactSheet(await loadConfig(args.configPath), args.n ?? 6);
      return image(sheet.gridBase64);
    }
    case 'gifsmith_snapshot': {
      const snap = await snapshot(await loadConfig(args.configPath), args.atSeconds);
      return image(snap.base64);
    }
    case 'gifsmith_render':
      return text(await render(await loadConfig(args.configPath)));
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function main(): Promise<void> {
  let Server: any, StdioServerTransport: any, ListToolsRequestSchema: any, CallToolRequestSchema: any;
  try {
    const serverMod = '@modelcontextprotocol/sdk/server/index.js';
    const stdioMod = '@modelcontextprotocol/sdk/server/stdio.js';
    const typesMod = '@modelcontextprotocol/sdk/types.js';
    ({ Server } = await import(serverMod));
    ({ StdioServerTransport } = await import(stdioMod));
    ({ ListToolsRequestSchema, CallToolRequestSchema } = await import(typesMod));
  } catch {
    console.error('gifsmith-mcp: the MCP SDK is not installed. Run: npm i @modelcontextprotocol/sdk');
    process.exit(1);
  }

  const server = new Server({ name: 'gifsmith', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    try {
      return await dispatch(req.params.name, req.params.arguments ?? {});
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  console.error('gifsmith-mcp: ready (stdio)');
}

main().catch((e) => {
  console.error('gifsmith-mcp:', e?.stack || e);
  process.exit(1);
});
