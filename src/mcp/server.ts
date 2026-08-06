#!/usr/bin/env node
/**
 * gifsmith MCP server (experimental) — exposes the AI-author surface as tools so
 * an agent drives gifsmith directly: probe a page, dry-run a scene, grab a
 * contact sheet or a single snapshot to "see" a moment, then render. Scenes are
 * authored as a config module (the timeline is code); tools take its file path.
 *
 * The MCP SDK is an OPTIONAL PEER dependency, and the distinction is the whole
 * reason this comment exists. It used to sit in `optionalDependencies`, which
 * reads like "opt in" and means nothing of the sort: npm installs optional
 * dependencies BY DEFAULT and "optional" only says "tolerate a failure to build
 * or install one". So every consumer of a 300 KB GIF library was handed express,
 * hono, @hono/node-server, cors and the rest of an HTTP server stack — measured
 * at 171 packages and 49.5 MB in a clean project, against 43 packages and 15.5 MB
 * without it.
 *
 * An OPTIONAL PEER dependency is the shape that says what was meant: npm 7+ does
 * not auto-install a peer marked `optional`, the version range is still declared
 * and still checked if the consumer does install one, and this file's lazy
 * `import()` of string specifiers means neither `tsc` nor `import 'gifsmith'`
 * ever resolves it. Only running `gifsmith-mcp` does. Install it to use this:
 *   npm i @modelcontextprotocol/sdk
 */
import { createRequire } from 'node:module';
import type { RenderConfig } from '../types.js';
import { ConfigError } from '../errors.js';
import { loadConfigModule } from '../loadConfig.js';
import { render } from '../director.js';
import { probe } from '../ergonomics/probe.js';
import { dryRun } from '../ergonomics/dryRun.js';
import { contactSheet, snapshot } from '../ergonomics/snapshot.js';
import { web } from '../adapters/index.js';

/**
 * A ConfigError for the same reason the CLI's caller throws a UsageError: this
 * is a scene file an agent pointed at, and "unusable input" is a different thing
 * from "gifsmith broke". The message carries the `gifsmith: ` prefix here and
 * not there, because the dispatch handler below reports `e.message` verbatim —
 * with no stack and nothing else on the line to say who is speaking.
 *
 * Which is why this copy mattered more than the CLI's, and it was the one with
 * no guards at all: it did not check the file existed and it did not classify a
 * load failure, so an agent that handed it a config with a syntax error got back
 * `error: Unexpected identifier 'out'` — no file, no position, no stack, and no
 * way to find out which of its scenes was broken. The rules live in
 * `loadConfig.ts` now, once, for both bins.
 */
const loadConfig = (file: string): Promise<RenderConfig> =>
  loadConfigModule(file, (m) => new ConfigError(`gifsmith: ${m}`));

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

/**
 * The `inputSchema` above, enforced — DERIVED from it rather than restated.
 *
 * Every tool declares what it takes and which of those are required, and none of
 * it was checked: an MCP client is trusted to honour a schema it was merely
 * shown. So `gifsmith_render` called with `{}` reached `path.resolve(undefined)`
 * and answered `error: The "paths[0]" argument must be of type string. Received
 * undefined` — no tool name, no argument name, nothing saying gifsmith was
 * speaking, to a caller that is usually a model and will try again.
 *
 * Deriving it is the point. The same defect has now been fixed three times by
 * writing a check beside the value it guards, and each time the next value one
 * layer over still had none. A tool added to `TOOLS` tomorrow is checked
 * tomorrow, without anyone remembering to come here.
 */
function checkArgs(tool: string, args: Record<string, unknown>): void {
  const schema = TOOLS.find((t) => t.name === tool)?.inputSchema as
    | { properties?: Record<string, { type?: string }>; required?: string[] }
    | undefined;
  if (!schema) return;
  for (const key of schema.required ?? []) {
    if (args[key] == null) {
      throw new ConfigError(`gifsmith: ${tool} needs \`${key}\` (${schema.properties?.[key]?.type ?? 'a value'}).`);
    }
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const v = args[key];
    if (v == null || spec.type == null) continue; // absent optionals are the callee's default
    const actual = typeof v;
    // `number` also has to be a usable one: JSON has no NaN, but a client that
    // computed `atSeconds` can still send one through a JS bridge.
    const ok = spec.type === 'number' ? actual === 'number' && Number.isFinite(v) : actual === spec.type;
    if (!ok) {
      throw new ConfigError(
        `gifsmith: ${tool}'s \`${key}\` must be a ${spec.type}; got ${JSON.stringify(v) ?? actual}.`,
      );
    }
  }
}

async function dispatch(name: string, args: any): Promise<any> {
  checkArgs(name, args ?? {});
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
    // The one message a consumer can act on without reading anything else: what
    // is missing, why they are seeing it, and the exact command. gifsmith does
    // not install this for you on purpose — see the header.
    console.error(
      'gifsmith-mcp: install @modelcontextprotocol/sdk to use gifsmith-mcp.\n' +
        '  npm i @modelcontextprotocol/sdk\n' +
        '  (It is an optional peer dependency, so installing gifsmith does not pull in\n' +
        '   the MCP SDK and its HTTP server stack. Nothing else in gifsmith needs it —\n' +
        '   the library, the `gifsmith` CLI and every render path work without it.)',
    );
    process.exit(1);
  }

  // The version an MCP client displays should be gifsmith's, not a literal that
  // was right once — this said 0.1.0 while the package was 0.3.0. Read at
  // runtime through createRequire rather than imported, so it stays outside
  // tsc's rootDir and out of dist/.
  let version = '0.0.0';
  try {
    version = createRequire(import.meta.url)('../../package.json').version ?? version;
  } catch {
    /* running from an unusual layout — a wrong version is not worth a failure */
  }

  const server = new Server({ name: 'gifsmith', version }, { capabilities: { tools: {} } });
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
