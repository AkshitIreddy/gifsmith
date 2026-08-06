/**
 * The CLI, spawned for real — `node dist/cli.js …`, exit code and output.
 *
 * This file exists because of a green test that asserted a broken product.
 * `flags.test.mjs` proved that `--lossless demo.mjs` produces a named error, by
 * calling `applyOverrides()` directly. The shipped command printed the bare
 * `gifsmith render <config.mjs>` usage instead, for the whole of a release,
 * because `cli.ts` checked for a missing positional BEFORE it read a single
 * flag — so the naming the unit test asserted was never reached. The CHANGELOG,
 * the README and flags.ts's own comment all claimed the fix; the only thing that
 * could have contradicted them was a test that ran the binary, and there wasn't
 * one.
 *
 * So: the parser keeps its unit tests (faster, sharper, and they say what each
 * rule IS), and every rule a user can actually hit is asserted again here
 * through the process boundary. The two are not redundant. One says the function
 * is right; this one says the program reaches it.
 *
 * No browser, no ffmpeg, no render. The trick is a sentinel config module that
 * throws on import: reaching it proves the flags were accepted AND the config
 * path survived, and never reaching it proves the opposite — which makes "did
 * this argument get eaten?" a yes/no question rather than a matter of reading a
 * message.
 *
 *   exit 0  usage / help
 *   exit 1  a real failure (the sentinel — we got all the way to the config)
 *   exit 2  a mistake in the command line: one line, no stack
 *
 * Every case is its own process, so the cases inside a test run concurrently.
 * Serially this file is ~90 node startups and over a minute on Windows, which is
 * long enough that someone would eventually be tempted to thin it out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'dist', 'cli.js');

/** A config module that cannot be mistaken for anything else. */
const SENTINEL = 'GIFSMITH_E2E_CONFIG_WAS_LOADED';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gifsmith-cli-'));
const CONFIG = path.join(tmp, 'demo.mjs');
fs.writeFileSync(CONFIG, `throw new Error(${JSON.stringify(SENTINEL)});\n`);
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function gifsmith(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout,
        stderr,
        all: stdout + stderr,
      });
    });
  });
}

/**
 * The render flags that take a value, split by how a wrong one can be caught.
 *
 * `--out` is the only one whose value is free-form — any string is a plausible
 * output path, so a swallowed config path is not PROVABLY wrong there and the
 * CLI can only point at it. The other six name a mode from a closed set, which
 * makes them exactly as provable as the numeric flags: a config path is not a
 * dither kernel.
 */
const FREE_STRING_FLAGS = [['out', 'out.gif']];
const ENUM_FLAGS = [
  ['format', 'webp', ['gif', 'webp']],
  ['loop', 'anchor', ['auto', 'anchor', 'crossfade', 'none']],
  ['capture', 'deterministic', ['screencast', 'deterministic']],
  ['dither', 'bayer', ['bayer', 'floyd_steinberg', 'sierra2', 'sierra2_4a', 'atkinson', 'none']],
  ['palette', 'diff', ['diff', 'full', 'perFrame']],
  ['frame-format', 'png', ['jpeg', 'png']],
];
const STRING_FLAGS = [...FREE_STRING_FLAGS, ...ENUM_FLAGS.map(([flag, value]) => [flag, value])];
const NUMERIC_FLAGS = [
  ['width', '900'],
  ['fps', '16'],
  ['speed', '1.5'],
  ['colors', '128'],
  ['quality', '88'],
  ['target-mb', '4'],
  ['bayer-scale', '5'],
];
const VALUE_FLAGS = [...STRING_FLAGS, ...NUMERIC_FLAGS];
const BOOLEAN_FLAGS = ['lossless', 'headful', 'keep-frames', 'debug', 'quiet', 'also-webp'];

/** A usage error is one line: no stack frames, no node_modules, no doubled prefix. */
function assertCleanUsageError(r, what) {
  assert.equal(r.code, 2, `${what}: expected exit 2, got ${r.code}\n${r.all}`);
  assert.doesNotMatch(r.stderr, /^\s+at /m, `${what}: printed a stack trace\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /node_modules/, `${what}: printed frames through node_modules\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /gifsmith:.*gifsmith:/, `${what}: doubled the program prefix\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Error:/, `${what}: leaked an Error class name\n${r.stderr}`);
  assert.doesNotMatch(r.all, new RegExp(SENTINEL), `${what}: reached the config it should have refused`);
  const lines = r.stderr.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `${what}: expected exactly one line of error\n${r.stderr}`);
}

/** The command got past the flag layer, kept its positional, and loaded a config. */
function assertReachedConfig(r, what) {
  assert.match(r.all, new RegExp(SENTINEL), `${what}: never reached the config module\n${r.all}`);
  assert.equal(r.code, 1, `${what}: expected exit 1 (a real failure), got ${r.code}`);
}

// ── the defect this file was written for ────────────────────────────────────

test('a boolean flag that swallows the config path says so — from the real CLI', async () => {
  // The exact command from the CHANGELOG. It printed `gifsmith render
  // <config.mjs>` for a release while a unit test asserted otherwise.
  const r = await gifsmith('render', '--lossless', CONFIG);
  assertCleanUsageError(r, 'render --lossless <config>');
  assert.match(r.stderr, /--lossless takes no value/);
  assert.doesNotMatch(
    r.stderr,
    /^gifsmith render <config/m,
    'the bare usage line is the wrong answer: the config path WAS given, --lossless ate it',
  );
});

test('every render boolean names the mistake when it swallows the config path', async () => {
  await Promise.all(
    BOOLEAN_FLAGS.map(async (flag) => {
      const r = await gifsmith('render', `--${flag}`, CONFIG);
      assertCleanUsageError(r, `render --${flag} <config>`);
      assert.match(r.stderr, new RegExp(`--${flag} takes no value`), `--${flag} did not name itself`);
    }),
  );
});

test('probe --json <url> names the flag, rather than claiming no url was given', async () => {
  const r = await gifsmith('probe', '--json', 'http://localhost:5173');
  assertCleanUsageError(r, 'probe --json <url>');
  assert.match(r.stderr, /--json takes no value/);
  assert.doesNotMatch(r.stderr, /probe needs a url/, 'a url was given; --json ate it');
});

// ── booleans: bare, valued, absent, and given nonsense ──────────────────────

test('every render boolean is accepted bare, and as true|false', async () => {
  await Promise.all(
    BOOLEAN_FLAGS.flatMap((flag) =>
      [[], ['true'], ['false']].map(async (value) => {
        const r = await gifsmith('render', CONFIG, `--${flag}`, ...value);
        assertReachedConfig(r, `--${flag} ${value.join('')}`);
      }),
    ),
  );
});

test('a render boolean given something that is not a boolean is refused', async () => {
  await Promise.all(
    BOOLEAN_FLAGS.map(async (flag) => {
      const r = await gifsmith('render', CONFIG, `--${flag}`, 'sometimes');
      assertCleanUsageError(r, `--${flag} sometimes`);
      assert.match(r.stderr, new RegExp(`--${flag} takes no value`));
    }),
  );
});

test('an absent boolean is not an error — the config decides', async () => {
  assertReachedConfig(await gifsmith('render', CONFIG), 'no flags at all');
});

// ── value-taking flags: present, absent, absent-before-another-flag ─────────

test('every value-taking flag is accepted with its value', async () => {
  await Promise.all(
    VALUE_FLAGS.map(async ([flag, value]) => {
      const r = await gifsmith('render', CONFIG, `--${flag}`, value);
      assertReachedConfig(r, `--${flag} ${value}`);
    }),
  );
});

test('every value-taking flag refuses to be read with its value left off', async () => {
  await Promise.all(
    VALUE_FLAGS.map(async ([flag]) => {
      // At the end of the line…
      const last = await gifsmith('render', CONFIG, `--${flag}`);
      assertCleanUsageError(last, `--${flag} (trailing)`);
      assert.match(last.stderr, new RegExp(`--${flag} needs a value`));

      // …and immediately before another flag, which is the same hole and the
      // one that reads like a working command line.
      const before = await gifsmith('render', CONFIG, `--${flag}`, '--quiet');
      assertCleanUsageError(before, `--${flag} --quiet`);
      assert.match(before.stderr, new RegExp(`--${flag} needs a value`));
    }),
  );
});

test('a free-form string flag that swallows the config path is told what it swallowed', async () => {
  // Not provable the way the boolean case is — `--out demo.mjs` is a well-formed
  // command line that happens to be missing its config — so the CLI says what it
  // CAN say: no config module, and here is the argument that looks like one.
  await Promise.all(
    FREE_STRING_FLAGS.map(async ([flag]) => {
      const r = await gifsmith('render', `--${flag}`, CONFIG);
      assertCleanUsageError(r, `render --${flag} <config>`);
      assert.match(r.stderr, /render needs a config module/);
      assert.match(r.stderr, new RegExp(`--${flag} took "`), `--${flag} did not point at what it ate`);
    }),
  );
});

test('a mode flag that swallows the config path is refused outright', async () => {
  // The stronger half. A config path is not a capture backend, so this is as
  // provable as the numeric case and gets the better message: name the flag,
  // list what it accepts, quote what it was handed.
  await Promise.all(
    ENUM_FLAGS.map(async ([flag]) => {
      const r = await gifsmith('render', `--${flag}`, CONFIG);
      assertCleanUsageError(r, `render --${flag} <config>`);
      assert.match(r.stderr, new RegExp(`--${flag} must be`));
      assert.match(r.stderr, /demo\.mjs/, `--${flag} did not quote what it was handed`);
    }),
  );
});

test('a numeric flag that swallows the config path is refused outright', async () => {
  // A path is not a number, so this half IS provable, and the better message
  // wins: name the flag and quote what it was handed.
  await Promise.all(
    NUMERIC_FLAGS.map(async ([flag]) => {
      const r = await gifsmith('render', `--${flag}`, CONFIG);
      assertCleanUsageError(r, `render --${flag} <config>`);
      assert.match(r.stderr, new RegExp(`--${flag} needs a number`));
      assert.match(r.stderr, /demo\.mjs/, `--${flag} did not quote what it was handed`);
    }),
  );
});

test('a numeric flag given a non-number is refused rather than reaching ffmpeg as NaN', async () => {
  await Promise.all(
    NUMERIC_FLAGS.map(async ([flag]) => {
      const r = await gifsmith('render', CONFIG, `--${flag}`, 'sixteen');
      assertCleanUsageError(r, `--${flag} sixteen`);
      assert.match(r.stderr, new RegExp(`--${flag} needs a number`));
    }),
  );
});

// ── mode flags: the closed sets, from the real CLI ─────────────────────────

test('a mode flag given a value that is not one of its modes is refused', async () => {
  // `--capture Deterministic` — a capital D, which the help text spells
  // lowercase — used to reach the DIRECTOR, where a bare `throw new Error` gave
  // the user four lines of stack, the word `gifsmith:` twice, and exit 1.
  await Promise.all(
    ENUM_FLAGS.map(async ([flag, value, allowed]) => {
      const wrong = value.toUpperCase();
      const r = await gifsmith('render', CONFIG, `--${flag}`, wrong);
      assertCleanUsageError(r, `--${flag} ${wrong}`);
      assert.match(r.stderr, new RegExp(`--${flag} must be`));
      for (const a of allowed) {
        assert.match(r.stderr, new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `--${flag} did not list ${a}`);
      }
      // The near-miss is worth naming: a case-only difference is a typo, not a
      // misunderstanding of what the flag is for.
      assert.match(r.stderr, new RegExp(`did you mean --${flag} ${value}`));
    }),
  );
});

test('--palette PerFrame is refused with a hint that does not contradict itself', async () => {
  // The near-miss hint used to end "the values are lowercase", which is true of
  // five of the six enums and false of exactly this one — so the answer to the
  // likeliest typo in the product suggested `perFrame` and then told the reader
  // it could not be spelled that way. Asserted through the binary because the
  // wording is the whole of the defect, and a unit test that passes while the
  // shipped command says something else is how this project got here.
  const r = await gifsmith('render', CONFIG, '--palette', 'PerFrame');
  assertCleanUsageError(r, '--palette PerFrame');
  assert.match(r.stderr, /--palette must be 'diff' \| 'full' \| 'perFrame'; got "PerFrame"/);
  assert.match(r.stderr, /\(did you mean --palette perFrame\?\)/);
  assert.doesNotMatch(r.stderr, /lower ?case/i, 'the hint suggests perFrame; it cannot also say lowercase');
  // …and the value it suggests is one the CLI actually takes.
  assertReachedConfig(await gifsmith('render', CONFIG, '--palette', 'perFrame'), '--palette perFrame');
});

test('every mode flag accepts every value it lists', async () => {
  await Promise.all(
    ENUM_FLAGS.flatMap(([flag, , allowed]) =>
      allowed.map(async (value) => {
        const r = await gifsmith('render', CONFIG, `--${flag}`, value);
        assertReachedConfig(r, `--${flag} ${value}`);
      }),
    ),
  );
});

test('a numeric flag outside the range a render can survive is refused', async () => {
  // Not taste — arithmetic. `--fps 0` is a division by zero, an Infinity in the
  // reported duration and an ffmpeg failure a dozen steps downstream.
  const cases = [
    ['fps', '0', /--fps must be a number greater than 0/],
    ['width', '0', /--width must be a number greater than 0/],
    ['speed', '-1', /--speed must be a number greater than 0/],
    ['quality', '120', /--quality must be a number between 0 and 100/],
    ['target-mb', '0', /--target-mb must be a number greater than 0/],
  ];
  await Promise.all(
    cases.map(async ([flag, value, message]) => {
      const r = await gifsmith('render', CONFIG, `--${flag}`, value);
      assertCleanUsageError(r, `--${flag} ${value}`);
      assert.match(r.stderr, message);
    }),
  );
});

test('the two knobs the encoder documents as clamped are still accepted', async () => {
  // `colors: 300` and `bayerScale: 9` render exactly as the README says they
  // will, so refusing them would break a command line that works today.
  await Promise.all(
    [['colors', '300'], ['bayer-scale', '9']].map(async ([flag, value]) => {
      const r = await gifsmith('render', CONFIG, `--${flag}`, value);
      assertReachedConfig(r, `--${flag} ${value}`);
    }),
  );
});

// ── the config's own values, checked with the same manners ─────────────────

/**
 * A config module that loads cleanly and is wrong — the half of the surface the
 * flag layer cannot see.
 *
 * This is the exact shape of the second gate's finding: `--capture Deterministic`
 * was fixed in the flag layer while `capture: 'Deterministic'` inside a config
 * module still printed a stack, because the validation lives in the director. A
 * config value is as much user input as an argv token, and both now produce one
 * line and exit 2.
 */
let badConfigs = 0;
function badConfig(body) {
  const file = path.join(tmp, `bad-${++badConfigs}.mjs`);
  fs.writeFileSync(
    file,
    'export default {\n' +
      "  target: { url: 'http://localhost:5173' },\n" +
      "  out: 'demo.gif',\n" +
      '  timeline: { steps: [], calls: {}, cues: [], hasLoopAnchor: false },\n' +
      `${body}\n};\n`,
  );
  return file;
}

test('a config value gifsmith cannot honour is one line and exit 2, not a stack', async () => {
  const cases = [
    ["  capture: 'Deterministic',", /capture\.mode must be/],
    ["  capture: 'det',", /capture\.mode must be/],
    ["  capture: { mode: 'deterministic', format: 'tiff' },", /capture\.format must be/],
    ["  loop: 'crossfde',", /loop must be/],
    ["  loop: { strategy: 'anchr' },", /loop\.strategy must be/],
    ['  loop: { strategy: 0 },', /loop\.strategy must be/],
    ["  format: 'jpg',", /format must be/],
    ["  alsoEmit: ['png'],", /alsoEmit\[\] must be/],
    ["  encode: { dither: 'floyd' },", /encode\.dither must be/],
    ["  encode: { palette: 'ful' },", /encode\.palette must be/],
    ['  encode: { fps: 0 },', /encode\.fps must be/],
    ['  encode: { quality: 900 },', /encode\.quality must be/],
    ['  encode: { width: -5 },', /encode\.width must be/],
    ['  viewport: { width: 0, height: 800 },', /viewport\.width must be/],
    ['  camera: { x: 0, y: 0, width: 0, height: 10 },', /camera\.width must be/],
    ["  compose: 'stag',", /compose must be/],
    ["  compose: 'stage', capture: 'deterministic',", /does not support compose:'stage'/],
  ];
  await Promise.all(
    cases.map(async ([body, message]) => {
      const r = await gifsmith('render', badConfig(body));
      assertCleanUsageError(r, `config with ${body.trim()}`);
      assert.match(r.stderr, message);
    }),
  );
});

test('a config missing a field the render needs says which, without a TypeError', async () => {
  const cases = [
    ['export default { out: "d.gif", timeline: { steps: [] } };', /target is required/],
    ['export default { target: { url: "http://x" }, out: "d.gif" };', /timeline must be a compiled timeline/],
    ['export default { target: { url: "http://x" }, timeline: { steps: [] } };', /out must be an output path/],
  ];
  await Promise.all(
    cases.map(async ([source, message], i) => {
      const file = path.join(tmp, `missing-${i}.mjs`);
      fs.writeFileSync(file, source);
      const r = await gifsmith('render', file);
      assertCleanUsageError(r, source);
      assert.match(r.stderr, message);
    }),
  );
});

/**
 * `--out .` — a well-formed command line that cost minutes before it failed.
 *
 * `out` was validated as a non-empty string, so a directory went straight
 * through: Chrome launched, the scene played, the frames were paced and looped,
 * and the run died at ffmpeg refusing to open a directory — 29 lines of stderr
 * with its whole `configuration:` line in them, minutes after the typo, none of
 * them containing the word `out`.
 *
 * The assertion that matters is not the message, it is the ABSENCE of the
 * launch: `assertCleanUsageError` requires exactly one line of stderr, and the
 * Logger's `[gifsmith] › launch …` goes to stderr, so a browser starting would
 * fail this test on its own.
 */
test('--out pointed at a directory is refused before a browser is launched', async () => {
  const good = badConfig('');
  await Promise.all(
    ['.', tmp, `${tmp}${path.sep}`].map(async (dir) => {
      const r = await gifsmith('render', good, '--out', dir);
      assertCleanUsageError(r, `--out ${dir}`);
      assert.match(r.stderr, /out is a directory, not a file/, dir);
      assert.match(r.stderr, /Give it a filename/, dir);
      assert.doesNotMatch(r.stderr, /launch/, `${dir}: a browser was started for a config error`);
    }),
  );
});

test('--out pointed at a path that does not exist adds no problem at all', async () => {
  // The half that makes the rule safe to have: every correct render passes a
  // path that is not there yet, so a rule that refused one would refuse every
  // correct render.
  //
  // Proved by COUNTING, which needs no browser: a config with only its `target`
  // missing has exactly one problem, and `assertConfig` appends "(+N more)" for
  // any others. One problem and no count means `out` contributed nothing.
  const noTarget = path.join(tmp, 'no-target.mjs');
  fs.writeFileSync(noTarget, 'export default { out: "demo.gif", timeline: { steps: [] } };\n');
  await Promise.all(
    [path.join(tmp, 'fresh.gif'), path.join(tmp, 'nested', 'deep', 'fresh.gif'), 'demo.gif'].map(async (out) => {
      const r = await gifsmith('render', noTarget, '--out', out);
      assertCleanUsageError(r, `--out ${out}`);
      assert.match(r.stderr, /target is required/, `--out ${out}`);
      assert.doesNotMatch(r.stderr, /more problem/, `--out ${out} was counted as a problem of its own`);
    }),
  );
  // …and the contrast, on the same config: a directory adds exactly one.
  const dir = await gifsmith('render', noTarget, '--out', tmp);
  assertCleanUsageError(dir, `--out ${tmp}`);
  assert.match(dir.stderr, /\(\+1 more problem —/, 'the directory rule did not fire');
});

test('a workDir that names an existing file is refused with the same manners', async () => {
  // The only other path in a RenderConfig. It died at `fs.mkdirSync` with
  // `EEXIST: file already exists` and three frames, from inside render().
  const file = path.join(tmp, 'not-a-workdir');
  fs.writeFileSync(file, 'a file\n');
  const r = await gifsmith('render', badConfig(`  workDir: ${JSON.stringify(file)},`));
  assertCleanUsageError(r, 'workDir is a file');
  assert.match(r.stderr, /workDir is a file, not a directory/);
  assert.doesNotMatch(r.stderr, /EEXIST/);
});

test('the config error names the first problem and says how many others there are', async () => {
  const r = await gifsmith('render', badConfig("  format: 'jpg',\n  loop: 'nope',\n  encode: { fps: 0 },"));
  assertCleanUsageError(r, 'three problems at once');
  assert.match(r.stderr, /\(\+2 more problems — dryRun\(\) lists them all\.\)/);
});

test("compose:'stage' with an unframeable target fails before a browser is launched", async () => {
  // Both rules used to be discovered inside composeScene — one browser launch,
  // one profile dir and one page load after they could have been known.
  const r = await gifsmith('render', badConfig("  compose: 'stage', target: { url: 'file:///c:/app/index.html' },"));
  assertCleanUsageError(r, 'stage + file://');
  assert.match(r.stderr, /can't frame a file:\/\/ app/);

  const noUrl = await gifsmith('render', badConfig("  compose: 'stage', target: { browserURL: 'http://127.0.0.1:9222' },"));
  assertCleanUsageError(noUrl, 'stage without a url');
  assert.match(noUrl.stderr, /needs target\.url/);
});

// ── the rest of the command surface ────────────────────────────────────────

test('render with no config module asks for one, and does not print a stack', async () => {
  const r = await gifsmith('render');
  assertCleanUsageError(r, 'render');
  assert.match(r.stderr, /render needs a config module/);
});

test('probe with no url asks for one', async () => {
  const r = await gifsmith('probe');
  assertCleanUsageError(r, 'probe');
  assert.match(r.stderr, /probe needs a url/);
});

test('a config module that does not exist is a usage error, not a module-loader stack', async () => {
  const r = await gifsmith('render', path.join(tmp, 'not-here.mjs'));
  assertCleanUsageError(r, 'render <missing>');
  assert.match(r.stderr, /no such file/);
});

/**
 * …and every OTHER way a config module fails to load, which is where the same
 * defect was still sitting after two gates.
 *
 * `cli.ts` guarded exactly one of these (the file is not there). The rest went
 * to node and came back as a stack: a syntax error printed five frames of
 * `node:internal/modules/esm/*` and — this is the part worth the test — did NOT
 * name the file anywhere, because node's message for a parse failure is
 * `Unexpected identifier 'out'` and nothing else. So the CHANGELOG's "a mistake
 * in the command line is one line and exit 2, not a stack" was false for the
 * commonest mistake there is: a typo in the config you are writing.
 */
const UNLOADABLE = [
  ['a syntax error', 'syn.mjs', "export default {\n  target: { url: 'http://x' \n  out: 'd.gif',\n};\n",
    /it is not valid JavaScript/],
  ['an import that does not resolve', 'badrel.mjs', "import x from './nope.mjs';\nexport default x;\n",
    /Cannot find module/],
  ['a package that is not installed', 'badpkg.mjs', "import x from 'no-such-package-anywhere';\nexport default x;\n",
    /Cannot find package/],
  ['a TypeScript path', 'demo.ts', 'export default {};\n', /node cannot import a \.ts module/],
  ['a json file', 'demo.json', '{"out":"d.gif"}\n', /import attribute/],
];

test('a config module that cannot be loaded is one line and exit 2, and names the file', async () => {
  await Promise.all(
    UNLOADABLE.map(async ([what, name, source, message]) => {
      const file = path.join(tmp, name);
      fs.writeFileSync(file, source);
      const r = await gifsmith('render', file);
      assertCleanUsageError(r, `render <${what}>`);
      assert.match(r.stderr, /cannot load config/, what);
      assert.match(r.stderr, message, what);
      assert.ok(r.stderr.includes(file), `${what}: never named the file\n${r.stderr}`);
    }),
  );
});

test('a directory given where a config module goes is refused the same way', async () => {
  const dir = path.join(tmp, 'a-directory');
  fs.mkdirSync(dir, { recursive: true });
  const r = await gifsmith('render', dir);
  assertCleanUsageError(r, 'render <a directory>');
  assert.match(r.stderr, /cannot load config/);
  // node's resolution failures end with "imported from <the importer>", which is
  // gifsmith's own loader here and means nothing to the reader.
  assert.doesNotMatch(r.stderr, /imported from .*gifsmith/, 'leaked gifsmith\'s own module path');
});

test('an unresolved import inside the config still says which file imported it', async () => {
  // The other side of that trim: here the importer IS the user's config, and it
  // is how they find which of their own imports is broken.
  const file = path.join(tmp, 'badrel2.mjs');
  fs.writeFileSync(file, "import x from './missing-helper.mjs';\nexport default x;\n");
  const r = await gifsmith('render', file);
  assertCleanUsageError(r, 'render <unresolved import>');
  assert.match(r.stderr, /missing-helper\.mjs/, 'did not name the import that failed');
  assert.match(r.stderr, /imported from .*badrel2\.mjs/, 'did not name the file that imports it');
});

test('a config module that exports nothing says what it should have exported', async () => {
  const empty = path.join(tmp, 'empty.mjs');
  fs.writeFileSync(empty, 'export const unrelated = 1;\n');
  const r = await gifsmith('render', empty);
  assertCleanUsageError(r, 'render <no default export>');
  assert.match(r.stderr, /must default-export/);
});

test("a config that throws keeps its stack — that failure is not the user's typo", async () => {
  const r = await gifsmith('render', CONFIG);
  assertReachedConfig(r, 'render <sentinel>');
  assert.match(r.stderr, /^\s+at /m, 'a genuine failure should still be debuggable');
});

test('an unknown flag warns and is otherwise ignored', async () => {
  const r = await gifsmith('render', CONFIG, '--fsp', '16');
  assert.match(r.stderr, /unknown flag --fsp/);
  assertReachedConfig(r, 'render --fsp 16');
});

test('help prints usage and exits 0, whatever else is on the line', async () => {
  await Promise.all(
    [[], ['help'], ['render', '--help'], ['render', '--help', CONFIG]].map(async (args) => {
      const r = await gifsmith(...args);
      assert.equal(r.code, 0, `gifsmith ${args.join(' ')} should exit 0\n${r.all}`);
      assert.match(r.stdout, /Usage:/);
      assert.doesNotMatch(r.all, new RegExp(SENTINEL), 'help must not run anything');
    }),
  );
});

test('an unknown command exits 2 with the usage text', async () => {
  const r = await gifsmith('renderr', CONFIG);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command "renderr"/);
  assert.match(r.stdout, /Usage:/);
  assert.doesNotMatch(r.stderr, /^\s+at /m, 'a wrong command is not a crash');
});

// ── the CHANGELOG sentence, as an assertion ────────────────────────────────

/**
 * "A mistake in the command line is one line and exit 2, not a stack."
 *
 * That sentence is in the 0.3.0 CHANGELOG and it has been false three times, in
 * three different places, because each round was fixed where it was REPORTED.
 * Round one was the flag layer; round two was the director, which validated
 * `--capture` a layer further in; round three was the config LOAD path, where a
 * syntax error printed node's ESM stack and did not even name the file.
 *
 * So the claim is enumerated rather than sampled. Every category a reader could
 * put in the phrase "a mistake in the command line" is listed here, derived from
 * the flag tables above wherever there is a table to derive it from — a new
 * enum, a new numeric flag or a new boolean joins this test the day it is added
 * to `RENDER_FLAGS`, not the day someone remembers. What cannot be derived (the
 * ways a config module goes wrong) is spelled out, and each entry says which
 * round of this bug it belongs to.
 *
 * The other tests in this file are sharper and say what each rule IS. This one
 * says the sentence in the CHANGELOG is true, which is a different claim and the
 * one that kept not being.
 */
test('every category of "a mistake in the command line" is one line and exit 2', async () => {
  const badConfigBody = (body) => ['render', badConfig(body)];
  const cases = [
    // Round one: the flag layer. Every value-taking flag with its value left off.
    ...VALUE_FLAGS.map(([flag]) => [`--${flag} with no value`, ['render', CONFIG, `--${flag}`]]),
    // Every enumerated flag, given a value that is not one of its own.
    ...ENUM_FLAGS.map(([flag]) => [`--${flag} <not a mode>`, ['render', CONFIG, `--${flag}`, 'nonsense']]),
    // …and given the case-only typo, which is the one people actually make.
    ...ENUM_FLAGS.map(([flag, value]) => [`--${flag} <wrong case>`, ['render', CONFIG, `--${flag}`, value.toUpperCase()]]),
    // Every numeric flag, given something that is not a number.
    ...NUMERIC_FLAGS.map(([flag]) => [`--${flag} <not a number>`, ['render', CONFIG, `--${flag}`, 'sixteen']]),
    // …and the ranged ones, given a number no render survives.
    ['--fps 0', ['render', CONFIG, '--fps', '0']],
    ['--width -1', ['render', CONFIG, '--width', '-1']],
    ['--quality 120', ['render', CONFIG, '--quality', '120']],
    // Every boolean, given something that is not one.
    ...BOOLEAN_FLAGS.map((flag) => [`--${flag} <not a boolean>`, ['render', CONFIG, `--${flag}`, 'sometimes']]),
    // …and swallowing the config path, which is how they are usually got wrong.
    ...BOOLEAN_FLAGS.map((flag) => [`--${flag} <ate the config>`, ['render', `--${flag}`, CONFIG]]),
    // The positionals.
    ['render with no config', ['render']],
    ['probe with no url', ['probe']],
    // Round two: the config's own values, validated a layer further in.
    ['config: a capture mode', badConfigBody("  capture: 'Deterministic',")],
    ['config: a loop strategy', badConfigBody("  loop: 'crossfde',")],
    ['config: a number', badConfigBody('  encode: { fps: 0 },')],
    ['config: a log level', badConfigBody("  logLevel: 'lound',")],
    ['config: out is a directory', ['render', badConfig(''), '--out', tmp]],
    // Round three: the module could not be loaded at all.
    ['config: missing', ['render', path.join(tmp, 'definitely-not-here.mjs')]],
    ['config: a syntax error', ['render', unloadable('claim-syn.mjs', 'export default { out:\n')]],
    ['config: an unresolved import', ['render', unloadable('claim-imp.mjs', "import x from './no.mjs';\nexport default x;\n")]],
    ['config: a .ts path', ['render', unloadable('claim.ts', 'export default {};\n')]],
    ['config: exports nothing', ['render', unloadable('claim-empty.mjs', 'export const unrelated = 1;\n')]],
  ];

  await Promise.all(
    cases.map(async ([what, args]) => {
      const r = await gifsmith(...args);
      assertCleanUsageError(r, what);
    }),
  );

  // And the boundary the claim depends on: an unknown COMMAND is a mistake too,
  // but it answers with the usage text on stdout, so it is exit 2 without a
  // stack rather than exactly one line of stderr.
  const unknown = await gifsmith('renderr');
  assert.equal(unknown.code, 2);
  assert.doesNotMatch(unknown.stderr, /^\s+at /m);
});

function unloadable(name, source) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, source);
  return file;
}
