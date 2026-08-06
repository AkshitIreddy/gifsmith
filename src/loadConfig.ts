/**
 * Getting a RenderConfig out of a file the user pointed at — and, mostly, what
 * to say when that cannot be done.
 *
 * WHY THIS IS ITS OWN MODULE, and why it is not inside `cli.ts`.
 *
 * `errors.ts` records two rounds of "a typo printed a stack", each fixed at the
 * layer that reported it and each coming back from a layer nobody had looked at.
 * This is the third of exactly that shape, and it is the LOAD path rather than
 * the value path: `cli.ts` guarded one way a config module can fail to load (the
 * file is not there) and left every other way to node. So
 *
 *   a syntax error in the config          SyntaxError + 5 frames of node ESM
 *                                         internals — and node's message does
 *                                         not name the file, so the ONLY thing
 *                                         printed that identified it was… nothing
 *   an import in it that does not resolve  ERR_MODULE_NOT_FOUND + 8 frames
 *   `gifsmith render demo.ts`              ERR_UNKNOWN_FILE_EXTENSION + 5 frames
 *   `gifsmith render ./configs`            ERR_UNSUPPORTED_DIR_IMPORT + 10 frames
 *   `gifsmith render demo.json`            ERR_IMPORT_ASSERTION_TYPE_MISSING + 4
 *
 * all printed a stack and exited 1, while the CHANGELOG said a mistake is one
 * line and exit 2. And the same code was written a second time in
 * `mcp/server.ts`, where the dispatcher prints `e.message` and no stack at all —
 * so an agent handed a config with a syntax error was told `Unexpected
 * identifier 'out'`, with no file, no position and nothing else on the line.
 *
 * Both bins call this. That is the point: the previous two rounds were fixed at
 * a call site, and a call site is exactly what cannot cover the next one.
 *
 * THE DISCRIMINATION THIS FILE MAKES, and why it is structural rather than a
 * guess. A config that RUNS and throws keeps its stack — that stack has the
 * author's own frames in it and is the only debuggable thing about it, and
 * `test/cli.test.mjs` has asserted it since the file existed. A config that
 * never ran has a stack made entirely of node's module loader, which tells the
 * reader nothing they can act on. The test for "did it run" is not a heuristic
 * about error types: **code that ran must appear in its own stack trace**, so a
 * failure with no frame outside `node:` internals happened before the module
 * body did. Measured against every shape above, plus a `ReferenceError`, a bare
 * `throw`, and a `JSON.parse('{')` (which is a SyntaxError from user code and
 * must keep its stack — `at JSON.parse (<anonymous>)` is not a node: frame).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RenderConfig } from './types.js';

/**
 * Node's own module-system failures, by `code`.
 *
 * Spelled out rather than matched on a prefix: `ERR_` is also how a hundred
 * ordinary runtime failures are spelled (`ERR_INVALID_ARG_TYPE` from a config
 * calling `fs.readFile(undefined)`), and those are the author's bug and keep
 * their stack. Both spellings of the JSON-attribute error are here because node
 * renamed it mid-22.x, and a version-dependent list that silently covers one
 * node and not the other is the same defect this file is about.
 */
const MODULE_SYSTEM_CODES: ReadonlySet<string> = new Set([
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_UNSUPPORTED_ESM_URL_SCHEME',
  'ERR_INVALID_MODULE_SPECIFIER',
  'ERR_INVALID_PACKAGE_CONFIG',
  'ERR_INVALID_PACKAGE_TARGET',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
  'ERR_IMPORT_ASSERTION_TYPE_MISSING',
  'ERR_IMPORT_ATTRIBUTE_MISSING',
  'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED',
  'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE',
  'ERR_REQUIRE_ESM',
]);

/** The `at …` lines of a stack, if there are any to read. */
function stackFrames(e: unknown): string[] {
  const stack = (e as { stack?: unknown } | null)?.stack;
  return typeof stack === 'string' ? stack.split('\n').filter((l) => /^\s+at /.test(l)) : [];
}

/**
 * Did any of the user's code run before this failed?
 *
 * A frame is node's own if it points into a `node:` URL — `at
 * compileSourceTextModule (node:internal/modules/esm/utils:346:16)`. A frame
 * from the config points at a `file:` URL, and even a builtin called BY the
 * config leaves `at JSON.parse (<anonymous>)`, which is not a `node:` frame
 * either. So "every frame is node's" means the module body never started.
 *
 * No frames at all (someone set `Error.stackTraceLimit = 0`, or threw a
 * non-Error) answers YES, deliberately: this function decides whether to hide a
 * stack, and the safe answer when it cannot tell is to show everything.
 */
function ranUserCode(e: unknown): boolean {
  const frames = stackFrames(e);
  return frames.length === 0 || frames.some((l) => !/(^|[\s(])node:/.test(l));
}

/**
 * Node ends a resolution failure with " imported from <the importer>", which is
 * the useful half when the importer is the user's own config — that is how they
 * find which of their imports is broken — and pure noise when the importer is
 * THIS file, because nobody typing `gifsmith render ./configs` asked about
 * gifsmith's loader. Trimmed only in the second case, by comparing the tail
 * against our own path rather than by pattern-matching it.
 */
function withoutOurOwnFile(message: string): string {
  const at = message.indexOf(' imported from ');
  if (at < 0) return message;
  const importer = message.slice(at + ' imported from '.length).trim();
  return importer === fileURLToPath(import.meta.url) ? message.slice(0, at) : message;
}

/**
 * The one-line reason a config module could not be LOADED, or null if what
 * happened is not that.
 *
 * Exported so `test/config.test.mjs` can put every shape through it without
 * spawning a process, and so the two bins cannot drift apart on the wording.
 */
export function moduleLoadProblem(e: unknown, file: string): string | null {
  // Node 24 can strip types from `.ts` files while Node 18/20 report
  // ERR_UNKNOWN_FILE_EXTENSION. Gifsmith supports all three, so accepting the
  // same config on only one runner would make the CLI version-dependent. Keep
  // the documented JavaScript-module contract stable across the support
  // matrix, including when a newer Node happens to import the file.
  const extension = path.extname(file).toLowerCase();
  if (['.ts', '.mts', '.cts', '.tsx'].includes(extension)) {
    return (
      `cannot load config ${file} — node cannot import a ${extension} module consistently across ` +
      `gifsmith's supported versions. Write the config as .mjs (or .js in a "type":"module" package).`
    );
  }

  if (ranUserCode(e)) return null;
  const err = e as { code?: unknown; message?: unknown; name?: unknown };
  const message = withoutOurOwnFile(String(err?.message ?? e).split('\n')[0]);

  // A parse failure is the one node does not name the file in — the message is
  // `Unexpected identifier 'out'` and that is the whole of it — which is why
  // this branch exists separately from the coded ones below.
  if (err?.name === 'SyntaxError') {
    return `cannot load config ${file} — it is not valid JavaScript: ${message}`;
  }

  if (typeof err?.code === 'string' && MODULE_SYSTEM_CODES.has(err.code)) {
    // The extension is worth its own sentence. node's own message ("Unknown
    // file extension \".ts\"") is a true statement that leaves the reader with
    // nowhere to go, and a `.ts` config is a thing people reasonably try — the
    // usage line says `.mjs|.js` and this is where they find out why.
    //
    if (err.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      const ext = path.extname(file);
      return (
        `cannot load config ${file} — node cannot import ${ext ? `a ${ext} module` : 'a module with no extension'}. ` +
        `Write the config as .mjs (or .js in a "type":"module" package), or run node with a ` +
        `TypeScript loader (NODE_OPTIONS=--import=tsx).`
      );
    }
    return `cannot load config ${file} — ${message}`;
  }

  return null;
}

/**
 * Import a config module and hand back what it exports.
 *
 * `asError` is how the caller says what KIND of failure this is in its world —
 * the CLI wants a `UsageError` (one line, exit 2) with no program prefix,
 * because `cli.ts` owns the prefix; the MCP server wants a `ConfigError`
 * carrying one, because a client sees the message and nothing else. The rules
 * are identical either way, which is the entire reason this is one function.
 */
export async function loadConfigModule(
  file: string,
  asError: (message: string) => Error,
): Promise<RenderConfig> {
  // A non-string reaches `path.resolve` as `TypeError: The "paths[0]" argument
  // must be of type string. Received undefined` — which names no tool, no
  // argument and not gifsmith. The CLI cannot produce one (a positional is
  // always a string, and an absent one is caught before this is called), but the
  // MCP server hands over whatever an agent put in `configPath`, and this is the
  // layer both go through. Guarded here rather than there for exactly the reason
  // this module exists.
  if (typeof file !== 'string' || file.trim() === '') {
    throw asError(`a config module path is required; got ${file === undefined ? 'undefined' : JSON.stringify(file)}`);
  }
  const abs = path.resolve(file);
  // Asked before the import rather than left to the loader: a missing file
  // reaches the handler as ERR_MODULE_NOT_FOUND, and while that is now caught
  // below and printed as one line, the message it produces is about a module
  // specifier. This one is about a filename, and says where it looked.
  if (!fs.existsSync(abs)) {
    throw asError(`cannot open config ${file} — no such file (looked in ${abs})`);
  }

  const unsupported = moduleLoadProblem(null, file);
  if (unsupported) throw asError(unsupported);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  } catch (e) {
    const problem = moduleLoadProblem(e, file);
    if (problem) throw asError(problem);
    throw e; // the module ran and threw: the author's own failure, stack and all
  }

  const cfg = mod.default ?? mod.config;
  if (!cfg) throw asError(`${file} must default-export (or export \`config\`) a RenderConfig`);
  return (typeof cfg === 'function' ? (cfg as () => RenderConfig)() : cfg) as RenderConfig;
}
