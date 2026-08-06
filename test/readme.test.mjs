/**
 * Every TypeScript example in the README, compiled against the SHIPPED types.
 *
 * The flagship feature of this release had a documented example that did not
 * typecheck. `dist/types.d.ts` declared `PageCallback = (page: unknown, ctx:
 * CallContext) => …`, so the README's own
 *
 *     t.call(async (page, ctx) => { await ctx.settle(page.evaluate(…)); });
 *
 * gave `TS18046: 'page' is of type 'unknown'` in any strict project — the first
 * thing a reader copies, failing on the first line, in the feature the release
 * is named after. Nothing could have caught it: the examples were prose.
 *
 * They are not prose any more. Each ```ts block is extracted, compiled against
 * `dist/*.d.ts` (the artifact consumers actually get, not `src/`) with `strict:
 * true`, and a failure names the block and quotes it.
 *
 * Two mechanical rules make a documentation snippet compilable without turning
 * the README into a program:
 *
 *  - IMPORTS ARE HOISTED. A block may show an import and then a fragment; the
 *    import lines are lifted to the top of the generated file.
 *  - A BLOCK THAT STARTS `key:` IS A CONFIG FRAGMENT — `loop: { … }`,
 *    `props: [ … ]` — and is compiled as `{ … } satisfies Partial<RenderConfig>`,
 *    which is a stronger check than a bare object literal: a fragment naming a
 *    field that does not exist fails.
 *
 * Names the surrounding prose establishes (`url`, `tl`, `t`, `scene`, `fn`, and
 * the demo app's own in-page `app`) are declared as globals — see GLOBALS. A
 * README is allowed to say "assume a timeline in `tl`"; it is not allowed to
 * call a method that does not exist on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the README's prose puts in scope without showing where it came from. */
const GLOBALS = `
declare const url: string;
declare const tl: import('gifsmith').CompiledTimeline;
declare const t: import('gifsmith').TimelineBuilder;
declare const scene: import('gifsmith').RenderConfig;
declare const fn: import('gifsmith').PageCallback;
/** The demo app's own bridge object, as it exists inside the page. */
declare const app: { ready: Promise<void> };
`;

/**
 * The package's own exports, read from the built modules rather than listed.
 *
 * A snippet that says `await render(…)` two sections after the import was shown
 * gets the import added back. Deriving the names from `dist/` is what makes that
 * safe: an example calling something the package does not export cannot be
 * papered over, it fails to resolve — which is a check the old prose examples
 * did not have either.
 */
const EXPORTS = {
  gifsmith: Object.keys(await import('../dist/index.js')),
  'gifsmith/props': Object.keys(await import('../dist/props/index.js')),
};

const { parse, checkFlags, RENDER_FLAGS, PROBE_FLAGS } = await import('../dist/flags.js');

/** Which flag spec each command is checked against. */
const SPECS = {
  render: RENDER_FLAGS,
  probe: PROBE_FLAGS,
};

/**
 * The README, with line endings normalised.
 *
 * Not a detail: this file is CRLF, `\r` is a LINE TERMINATOR in a JS regex, and
 * `.` does not match one — so a `\}.*$` that reads perfectly ran against every
 * line and matched nothing. It cost an hour of looking at a correct regex.
 */
function readme() {
  return readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n?/g, '\n');
}

/** Fenced TypeScript blocks, with the line they start on. */
function tsBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```(\w*)/.exec(lines[i]);
    if (!fence) {
      if (open) open.body.push(lines[i]);
      continue;
    }
    if (open) {
      blocks.push(open);
      open = null;
    } else if (fence[1] === 'ts' || fence[1] === 'typescript') {
      open = { line: i + 1, body: [] };
    }
  }
  return blocks.map((b) => ({ line: b.line, code: b.body.join('\n') }));
}

/** One block as a compilable module: imports hoisted and completed, fragments wrapped. */
function harness(code, index) {
  const lines = code.split('\n');
  const imports = [];
  const rest = [];
  for (const line of lines) {
    if (/^\s*import\s/.test(line)) imports.push(line);
    else rest.push(line);
  }
  const body = rest.join('\n').trim();

  // Names the block already binds — importing them again is a duplicate.
  const bound = new Set();
  for (const line of imports) {
    for (const name of line.replace(/^[^{]*\{|\}.*$/g, '').split(',')) {
      const trimmed = name.trim().split(/\s+as\s+/).pop();
      if (trimmed) bound.add(trimmed);
    }
  }
  for (const [, name] of body.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    bound.add(name);
  }
  const used = new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const restored = [];
  for (const [module, names] of Object.entries(EXPORTS)) {
    const want = names.filter((n) => used.has(n) && !bound.has(n));
    if (want.length) restored.push(`import { ${want.join(', ')} } from '${module}';`);
  }

  const isFragment = /^[A-Za-z_$][\w$]*\s*:/.test(body);
  const wrapped = isFragment
    ? `const __fragment_${index} = {\n${body.replace(/,\s*$/, '')}\n} satisfies Partial<__RenderConfig>;`
    : body;
  return [
    `import type { RenderConfig as __RenderConfig } from 'gifsmith';`,
    ...imports,
    ...restored,
    wrapped,
    'export {};',
  ].join('\n');
}

test('every TypeScript example in the README compiles against the shipped types', () => {
  const blocks = tsBlocks(readme());
  assert.ok(blocks.length >= 8, `expected the README's examples, found ${blocks.length}`);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'gifsmith-readme-'));
  try {
    mkdirSync(path.join(dir, 'snippets'));
    // ESM, like the package: without this, `module: NodeNext` reads the
    // snippets as CommonJS and every top-level `await render(…)` is an error
    // about the module system rather than about the example.
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(path.join(dir, 'globals.d.ts'), GLOBALS);
    blocks.forEach((b, i) => {
      writeFileSync(path.join(dir, 'snippets', `readme-line-${b.line}.ts`), harness(b.code, i));
    });

    // Point `gifsmith` at dist/, not src/ — the whole failure was in a shipped
    // .d.ts, and compiling the sources would have said everything was fine.
    const dist = path.join(root, 'dist').replace(/\\/g, '/');
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            // A snippet is an excerpt: it may import something it only mentions.
            noUnusedLocals: false,
            noUnusedParameters: false,
            baseUrl: '.',
            paths: {
              gifsmith: [`${dist}/index.d.ts`],
              'gifsmith/props': [`${dist}/props/index.d.ts`],
            },
            typeRoots: [path.join(root, 'node_modules', '@types').replace(/\\/g, '/')],
          },
          include: ['globals.d.ts', 'snippets/**/*.ts'],
        },
        null,
        2,
      ),
    );

    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    let output = '';
    let failed = false;
    try {
      execFileSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      failed = true;
      output = (e.stdout ?? '') + (e.stderr ?? '');
    }

    if (failed) {
      // Name the block by its README line and quote it, so the failure is a
      // pointer into the document rather than into a temp dir.
      const detail = output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const m = /readme-line-(\d+)\.ts/.exec(line);
          if (!m) return line;
          const block = blocks.find((b) => String(b.line) === m[1]);
          return `${line}\n      README.md:${m[1]} — ${block?.code.split('\n')[0] ?? ''}`;
        })
        .join('\n');
      assert.fail(`README examples do not compile:\n${detail}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Every `gifsmith …` command the README shows — in a fenced shell block, and in
 * an inline code span (`npx gifsmith doctor` is documented that way).
 */
function shellLines(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let open = false;
  for (const line of lines) {
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      open = !open && (fence[1] === 'bash' || fence[1] === 'sh' || fence[1] === 'shell');
      continue;
    }
    if (open) {
      if (/^\s*(npx\s+)?gifsmith\s/.test(line)) out.push(line.trim());
      continue;
    }
    for (const [, span] of line.matchAll(/`((?:npx\s+)?gifsmith\s[^`]*)`/g)) out.push(span.trim());
  }
  return out;
}

test('every gifsmith command line in the README is one the CLI accepts', () => {
  // The same class as the TypeScript examples, in the other language: a
  // documented flag that does not exist, or a value the CLI now refuses, is a
  // README that lies. Checked against the real flag layer from dist/, so a
  // renamed flag fails here rather than in someone's terminal.
  const commands = shellLines(readme());
  assert.ok(commands.length >= 5, `expected the README's CLI examples, found ${commands.length}`);

  const warnings = [];
  const realError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  try {
    for (const command of commands) {
      const argv = command.replace(/^npx\s+/, '').split(/\s+/).slice(1);
      const f = parse(argv);
      const cmd = f._[0];
      assert.ok(
        [...Object.keys(SPECS), 'doctor', 'help'].includes(cmd),
        `unknown command in README: ${command}`,
      );
      const spec = SPECS[cmd];
      if (!spec) continue; // doctor and help take no flags of their own
      assert.doesNotThrow(
        () => checkFlags(f, spec),
        `README documents a command the CLI refuses: ${command}`,
      );
    }
  } finally {
    console.error = realError;
  }
  assert.deepEqual(warnings, [], 'the README documents a flag the CLI does not know');
});

test("the README's t.call example is the one that has to compile", () => {
  // A guard on the guard: if the flagship example is ever removed or renamed,
  // the suite above would pass over a README that no longer documents it.
  const blocks = tsBlocks(readme()).map((b) => b.code);
  assert.ok(
    blocks.some((c) => /t\.call\(async \(page, ctx\)/.test(c) && /ctx\.settle\(/.test(c)),
    'the two-argument t.call example should be in the README',
  );
  assert.ok(
    blocks.some((c) => /page\.evaluate\(/.test(c)),
    'and it should still use the page, which is what TS18046 was about',
  );
});
