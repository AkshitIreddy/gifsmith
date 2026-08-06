/**
 * The config rules, and the SHAPE of a failure.
 *
 * Two gates in a row found the same defect on a path the previous fix did not
 * cover. Round one: a usage error printed a stack, fixed in the flag layer.
 * Round two: `--capture Deterministic` printed a stack from the DIRECTOR, where
 * `captureOptions` threw a bare `Error` that the CLI could not tell apart from a
 * crash. So this file asserts two different things, and the second is the one
 * that stops a third round:
 *
 *   1. the rules themselves — which values are refused, and what the message says
 *   2. that every rule throws a `ConfigError`, checked by ENUMERATING the rules
 *      rather than by listing the ones somebody remembered
 *
 * `test/cli.test.mjs` then drives the same configs through the real binary,
 * because a validator that is right in isolation is not the same claim as a
 * command that prints one line and exits 2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configProblems, sceneProblems, assertConfig } from '../dist/config.js';
import { ConfigError, UsageError, EnvironmentError, isUserFacing } from '../dist/errors.js';
import { moduleLoadProblem } from '../dist/loadConfig.js';
import { captureOptions } from '../dist/capture/options.js';
import { render } from '../dist/director.js';
import { snapshot, contactSheet } from '../dist/ergonomics/snapshot.js';

/** Real paths, because these rules ask the filesystem rather than the string. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gifsmith-cfg-'));
const A_DIRECTORY = path.join(tmp, 'outdir');
fs.mkdirSync(A_DIRECTORY, { recursive: true });
const A_FILE = path.join(tmp, 'already.gif');
fs.writeFileSync(A_FILE, 'not really a gif');
const NOT_THERE = path.join(tmp, 'nested', 'fresh', 'demo.gif');
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

/** A config with nothing wrong with it. */
const ok = () => ({
  target: { url: 'http://localhost:5173' },
  out: 'demo.gif',
  timeline: { steps: [], calls: {}, cues: [], hasLoopAnchor: false },
});

const withCfg = (patch) => ({ ...ok(), ...patch });

/**
 * Every rule, as [what is wrong, the config, the message it must produce].
 *
 * The table is the point. A rule that is not in it is a rule nobody checked the
 * error shape of, and the error shape is what both gates were about.
 */
const BAD = [
  ['capture mode typo', { capture: 'deterministc' }, /capture\.mode must be/],
  ['capture mode wrong case', { capture: 'Deterministic' }, /capture\.mode must be/],
  ['capture as a bare true (the valueless CLI flag)', { capture: true }, /--capture needs a value/],
  ['capture object with no mode', { capture: { format: 'png' } }, /capture\.mode must be/],
  ['capture frame format', { capture: { mode: 'screencast', format: 'tiff' } }, /capture\.format must be/],
  ['deterministic + stage', { capture: 'deterministic', compose: 'stage' }, /does not support compose:'stage'/],
  ['compose', { compose: 'stag' }, /compose must be/],
  ['stage with no url', { compose: 'stage', target: { browserURL: 'http://x' } }, /needs target\.url/],
  ['stage on file://', { compose: 'stage', target: { url: 'file:///c:/a.html' } }, /can't frame a file:\/\/ app/],
  ['loop strategy', { loop: 'crossfde' }, /loop must be/],
  ['loop object strategy', { loop: { strategy: 'anchr' } }, /loop\.strategy must be/],
  ['loop object with no strategy', { loop: { minCycleSeconds: 4 } }, /loop\.strategy is required/],
  ['loop minCycleSeconds', { loop: { strategy: 'anchor', minCycleSeconds: -1 } }, /loop\.minCycleSeconds must be/],
  ['loop of the wrong type', { loop: 7 }, /loop must be/],
  ['output format', { format: 'jpg' }, /format must be/],
  ['alsoEmit entry', { alsoEmit: ['png'] }, /alsoEmit\[\] must be/],
  ['alsoEmit not an array', { alsoEmit: 'webp' }, /alsoEmit must be an array/],
  ['out missing', { out: undefined }, /out must be an output path/],
  ['out empty', { out: '   ' }, /out must be an output path/],
  ['out is a directory', { out: A_DIRECTORY }, /out is a directory, not a file/],
  ['out is the cwd', { out: '.' }, /out is a directory, not a file/],
  ['workDir is a file', { workDir: A_FILE }, /workDir is a file, not a directory/],
  ['workDir of the wrong type', { workDir: 42 }, /workDir must be a directory path/],
  ['target missing', { target: undefined }, /target is required/],
  ['timeline missing', { timeline: undefined }, /timeline must be a compiled timeline/],
  ['timeline not compiled', { timeline: { hold: () => {} } }, /timeline must be a compiled timeline/],
  ['props not an array', { props: { id: 'cursor' } }, /props must be an array/],
  ['dither', { encode: { dither: 'floyd' } }, /encode\.dither must be/],
  ['palette', { encode: { palette: 'ful' } }, /encode\.palette must be/],
  ['fps zero', { encode: { fps: 0 } }, /encode\.fps must be a number greater than 0/],
  ['fps NaN', { encode: { fps: NaN } }, /encode\.fps must be/],
  ['width negative', { encode: { width: -1 } }, /encode\.width must be/],
  ['speed zero', { encode: { speed: 0 } }, /encode\.speed must be/],
  ['quality out of range', { encode: { quality: 101 } }, /encode\.quality must be a number between 0 and 100/],
  ['targetMB zero', { encode: { targetMB: 0 } }, /encode\.targetMB must be/],
  ['bayerScale negative', { encode: { bayerScale: -1 } }, /encode\.bayerScale must be/],
  ['lossless not a boolean', { encode: { lossless: 'yes' } }, /encode\.lossless must be true or false/],
  ['encode not an object', { encode: 16 }, /encode must be an object/],
  ['viewport width', { viewport: { width: 0, height: 800 } }, /viewport\.width must be/],
  ['viewport dpr', { viewport: { width: 900, height: 600, deviceScaleFactor: 0 } }, /viewport\.deviceScaleFactor/],
  ['camera width', { camera: { x: 0, y: 0, width: 0, height: 10 } }, /camera\.width must be/],
  ['camera x', { camera: { x: -4, y: 0, width: 10, height: 10 } }, /camera\.x must be/],
  ['logLevel', { logLevel: 'lound' }, /logLevel must be/],
];

test('a good config has nothing to say about it', () => {
  assert.deepEqual(configProblems(ok()), []);
  assert.deepEqual(configProblems(withCfg({ capture: 'deterministic', loop: 'anchor', format: 'webp' })), []);
  assert.deepEqual(
    configProblems(
      withCfg({
        capture: { mode: 'deterministic', format: 'png', quality: 92, frameTimeoutMs: 8000, waitForNetwork: true },
        loop: { strategy: 'anchor', minCycleSeconds: 30 },
        alsoEmit: ['webp'],
        encode: { width: 900, fps: 14, speed: 1.35, colors: 256, quality: 88, dither: 'none', palette: 'full', lossless: true },
        viewport: { width: 1360, height: 850, deviceScaleFactor: 2 },
        camera: { x: 0, y: 0, width: 800, height: 600 },
        compose: 'overlay',
        props: [],
      }),
    ),
    [],
  );
});

test('the knobs the encoder documents as clamped are not refused', () => {
  // `colors: 300` and `bayerScale: 9` render exactly as the README says they
  // will. A validator that refuses them breaks configs that work today.
  assert.deepEqual(configProblems(withCfg({ encode: { colors: 300, bayerScale: 9 } })), []);
});

/**
 * `out`, which was checked for being a non-empty string and nothing else.
 *
 * `--out .` is a non-empty string, so it was accepted — and then Chrome
 * launched, the scene played, the frames were paced, the loop was planned, and
 * the run died at ffmpeg refusing to open a directory: 29 lines of stderr with
 * its whole `configuration:` line in them, minutes after the mistake, none of
 * them containing the word `out`.
 *
 * Three cases, and the FIRST is the one that makes the rule safe to have. A path
 * that does not exist is the ordinary case — it is what every correct render
 * passes — so a rule that refused it would refuse every correct render.
 */
test('out that does not exist yet is fine — that is the ordinary case', () => {
  assert.deepEqual(configProblems(withCfg({ out: 'demo.gif' })), []);
  assert.deepEqual(configProblems(withCfg({ out: NOT_THERE })), [], 'nor does its directory have to exist');
  assert.deepEqual(configProblems(withCfg({ out: 'docs/nothing/here/demo.gif' })), []);
  // A file that IS there is fine too: a re-render overwrites its own output, and
  // that is the second most ordinary case there is.
  assert.deepEqual(configProblems(withCfg({ out: A_FILE })), []);
});

test('out that is a directory is refused, and the message names out and offers a filename', () => {
  for (const dir of [A_DIRECTORY, '.', `${A_DIRECTORY}${path.sep}`]) {
    const [problem, ...rest] = configProblems(withCfg({ out: dir }));
    assert.deepEqual(rest, [], `${dir}: nothing else should be wrong with this config`);
    assert.match(problem, /^gifsmith: out is a directory, not a file/, dir);
    assert.match(problem, /Give it a filename/, dir);
    // The suggestion has to be a filename inside the directory they gave, with
    // no doubled separator when the path already ended in one.
    assert.match(problem, /'[^']*demo\.gif'/, `${dir}: no example filename`);
    assert.doesNotMatch(problem, /[\\/]{2}demo\.gif/, `${dir}: doubled separator in the example`);
  }
});

test('out that is a directory is refused BEFORE anything is launched', async () => {
  // The whole point of the rule is when it fires. `render()` validates before
  // `assertFfmpeg` and before `connect`, so this rejects on a machine with
  // neither — and takes no measurable time.
  const started = Date.now();
  await assert.rejects(() => render(withCfg({ out: A_DIRECTORY })), (e) => {
    assert.ok(e instanceof ConfigError, `render threw ${e?.constructor?.name}`);
    assert.match(e.message, /out is a directory, not a file/);
    return true;
  });
  assert.ok(Date.now() - started < 2000, 'a browser launch would be visible here');
});

test('workDir gets the same rule the other way round', () => {
  // The only other path in a RenderConfig, found by asking which fields ARE one.
  // A workDir naming an existing file died at fs.mkdirSync with `EEXIST: file
  // already exists` and three frames, from inside render(), naming nothing.
  assert.match(assertMessage({ workDir: A_FILE }), /workDir is a file, not a directory/);
  assert.match(assertMessage({ workDir: A_FILE }), /Point it at a directory/);
  // A directory that is not there yet is normal — the Director creates it.
  assert.deepEqual(configProblems(withCfg({ workDir: path.join(tmp, 'not-yet') })), []);
  assert.deepEqual(configProblems(withCfg({ workDir: A_DIRECTORY })), []);
  assert.deepEqual(configProblems(withCfg({ workDir: undefined })), []);
});

test('a target with no url is a blank page, not an error', () => {
  // Occasionally deliberate: a timeline that navigates itself inside a `call`.
  // dryRun warns about it; render does not refuse it.
  assert.deepEqual(configProblems(withCfg({ target: {} })), []);
});

test('every rule refuses what it says it refuses', () => {
  for (const [what, patch, message] of BAD) {
    const problems = configProblems(withCfg(patch));
    assert.ok(problems.length > 0, `${what}: reported no problem at all`);
    assert.ok(
      problems.some((p) => message.test(p)),
      `${what}: expected ${message}, got ${JSON.stringify(problems)}`,
    );
  }
});

test('every rule throws a ConfigError — not a bare Error the CLI must guess about', () => {
  // The whole of the second gate's finding, as an assertion over the table
  // rather than over the one example that was reported.
  for (const [what, patch] of BAD) {
    let thrown;
    try {
      assertConfig(withCfg(patch));
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, `${what}: assertConfig did not throw`);
    assert.ok(thrown instanceof ConfigError, `${what}: threw ${thrown?.constructor?.name}, not ConfigError`);
    assert.equal(thrown.name, 'ConfigError', `${what}: name is what a cross-copy check reads`);
    assert.ok(isUserFacing(thrown), `${what}: the CLI would have printed a stack for this`);
    assert.doesNotMatch(thrown.message, /\n/, `${what}: a usage error is ONE line`);
    assert.doesNotMatch(thrown.message, /gifsmith:.*gifsmith:/, `${what}: doubled the program prefix`);
  }
});

test('every message quotes the value it refused', () => {
  assert.match(assertMessage({ capture: 'Deterministic' }), /'Deterministic'/);
  assert.match(assertMessage({ loop: 'crossfde' }), /'crossfde'/);
  assert.match(assertMessage({ encode: { fps: 0 } }), /got 0/);
  assert.match(assertMessage({ format: 'jpg' }), /'jpg'/);
  // …and lists what it would have accepted.
  assert.match(assertMessage({ loop: 'crossfde' }), /'auto' \| 'anchor' \| 'crossfade' \| 'none'/);
});

function assertMessage(patch) {
  try {
    assertConfig(withCfg(patch));
  } catch (e) {
    return e.message;
  }
  return '(no error)';
}

test('one problem is reported, with a count of the rest', () => {
  const msg = assertMessage({ format: 'jpg', loop: 'nope', encode: { fps: 0 } });
  assert.match(msg, /\(\+2 more problems — dryRun\(\) lists them all\.\)/);
  assert.doesNotMatch(msg, /\n/);
  // …and a single problem says nothing about others.
  assert.doesNotMatch(assertMessage({ format: 'jpg' }), /more problem/);
});

test('render() refuses a bad config before it looks for ffmpeg or a browser', async () => {
  // The ordering matters twice: a mistyped mode is worth naming on a machine
  // that has not installed ffmpeg yet, and this test can run anywhere.
  await assert.rejects(() => render(withCfg({ capture: 'Deterministic' })), (e) => {
    assert.ok(e instanceof ConfigError, `render threw ${e?.constructor?.name}`);
    assert.match(e.message, /capture\.mode must be/);
    return true;
  });
  await assert.rejects(() => render(withCfg({ target: undefined })), /target is required/);
});

test('snapshot and contactSheet refuse the same scene, before a browser is launched', async () => {
  // They validated `capture` and nothing else, which left the identical hole one
  // field over. Nothing here reaches `connect()` — a bad scene costs nothing.
  const scene = { target: { url: 'http://localhost:5173' }, timeline: { steps: [], calls: {} } };
  await assert.rejects(() => snapshot({ ...scene, logLevel: 'lound' }, 1), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /logLevel must be/);
    return true;
  });
  await assert.rejects(() => contactSheet({ ...scene, viewport: { width: 0, height: 8 } }, 4), /viewport\.width/);
  await assert.rejects(() => snapshot({ ...scene, capture: 'Deterministic' }, 1), /capture\.mode must be/);
});

test('a mistyped logLevel is refused, because it silences the logger entirely', () => {
  // `Logger.enabled` compares ORDER[level] >= ORDER[l]; ORDER['lound'] is
  // undefined, and `undefined >= 1` is false — so every warning the render would
  // have given, including "this GIF is over targetMB", disappears.
  assert.match(assertMessage({ logLevel: 'lound' }), /logLevel must be 'silent' \| 'warn' \| 'info' \| 'debug'/);
  for (const level of ['silent', 'warn', 'info', 'debug']) {
    assert.deepEqual(configProblems(withCfg({ logLevel: level })), [], level);
  }
});

test('captureOptions still throws for a programmatic caller, and still returns the same shapes', () => {
  // The library API does not change: a ConfigError IS an Error, with the same
  // message a bare one carried.
  assert.deepEqual(captureOptions(undefined), { mode: 'screencast' });
  assert.deepEqual(captureOptions('deterministic'), { mode: 'deterministic' });
  assert.throws(() => captureOptions('nope'), Error);
  assert.throws(() => captureOptions('nope'), ConfigError);
  assert.throws(() => captureOptions('nope'), /gifsmith: capture\.mode must be/);
});

test('the three failure classes are distinct, and all three are Errors', () => {
  const u = new UsageError('u');
  const c = new ConfigError('c');
  const e = new EnvironmentError('e');
  for (const err of [u, c, e]) {
    assert.ok(err instanceof Error);
    assert.ok(isUserFacing(err));
    assert.ok(err.stack, 'a user-facing error still carries a stack for whoever wants it');
  }
  assert.ok(!isUserFacing(new Error('a real bug')));
  assert.ok(!isUserFacing(new TypeError('a real bug')));
  assert.deepEqual([u.name, c.name, e.name], ['UsageError', 'ConfigError', 'EnvironmentError']);
});

test('isUserFacing survives a second copy of the module', () => {
  // A linked checkout, a duplicated install, a bundler that inlined one path:
  // `instanceof` says no, and the user gets a stack trace for a typo. The name
  // is the backstop, and this is the shape it has to catch.
  const fromAnotherCopy = new Error('gifsmith: capture.mode must be …');
  fromAnotherCopy.name = 'ConfigError';
  assert.ok(isUserFacing(fromAnotherCopy));
});

// ── loading the config module: the third round of the same defect ───────────

/**
 * `cli.ts` guarded ONE way a config module can fail to load — the file is not
 * there — and left the rest to node, so every other way printed node's ESM stack
 * and exited 1 while the CHANGELOG said a mistake is one line and exit 2. The
 * worst of them was the syntax error, because node's message for that is
 * `Unexpected identifier 'out'` and does not name the file: the only thing on
 * screen that identified which config was broken was nothing at all.
 *
 * The rule `loadConfig.ts` applies is structural rather than a list of error
 * types: **code that ran must appear in its own stack**, so a failure with no
 * frame outside `node:` internals happened before the module body did. These
 * cases are the evidence for both halves of it — the shapes that must be caught,
 * and the shapes that must NOT be, because a config that runs and throws keeps
 * its stack and that is the only debuggable thing about it.
 */
const loadFixtures = {
  'a syntax error': ['syn.mjs', "export default {\n  target: { url: 'http://x' \n  out: 'd.gif',\n};\n"],
  'an unresolved relative import': ['badrel.mjs', "import x from './nope.mjs';\nexport default x;\n"],
  'an unresolved package import': ['badpkg.mjs', "import x from 'no-such-package-anywhere';\nexport default x;\n"],
  'an unimportable extension': ['x.ts', 'export default {};\n'],
  'json with no import attribute': ['d.json', '{"a":1}\n'],
};
const ranFixtures = {
  'a reference error': ['run1.mjs', 'export default nope;\n'],
  'a bare throw': ['run2.mjs', "throw new Error('boom');\n"],
  // A SyntaxError thrown BY the config, which the name alone cannot tell from a
  // parse failure — and `at JSON.parse (<anonymous>)` is not a node: frame.
  "the config's own JSON.parse": ['run3.mjs', "export default JSON.parse('{');\n"],
};

async function importError(file) {
  try {
    await import(pathToFileURL(file).href);
  } catch (e) {
    return e;
  }
  return null;
}

test('every way a config module fails to LOAD is one line that names the file', async () => {
  for (const [what, [name, source]] of Object.entries(loadFixtures)) {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, source);
    const problem = moduleLoadProblem(await importError(file), file);
    assert.ok(problem, `${what}: reported nothing, so the CLI would print a stack`);
    assert.match(problem, /^cannot load config /, what);
    assert.ok(problem.includes(file), `${what}: did not name the file — ${problem}`);
    assert.doesNotMatch(problem, /\n/, `${what}: a usage error is ONE line`);
    assert.doesNotMatch(problem, /^\s+at /m, `${what}: carried a stack frame into the message`);
  }
  // The one node does not name itself, spelled out: this is the case the gate
  // reported, and "it is not valid JavaScript" is what the reader needs first.
  const syn = path.join(tmp, 'syn.mjs');
  assert.match(moduleLoadProblem(await importError(syn), syn), /it is not valid JavaScript: Unexpected identifier/);
  // …and the one whose node message is a dead end gets a way forward instead.
  const ts = path.join(tmp, 'x.ts');
  assert.match(moduleLoadProblem(await importError(ts), ts), /node cannot import a \.ts module/);
  assert.match(moduleLoadProblem(await importError(ts), ts), /Write the config as \.mjs/);
});

test('a config that RUNS and throws keeps its stack — that failure is not a typo', async () => {
  for (const [what, [name, source]] of Object.entries(ranFixtures)) {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, source);
    const e = await importError(file);
    assert.ok(e, `${what}: did not throw at all`);
    assert.equal(
      moduleLoadProblem(e, file),
      null,
      `${what}: was reported as a load failure, so the author lost the stack that names their line`,
    );
  }
});

test('the classifier answers null when it cannot tell, so nothing is hidden by accident', () => {
  // The fallback matters more than the rule: getting this wrong swallows a real
  // bug's stack. An error with no stack at all (Error.stackTraceLimit = 0, a
  // thrown string, a plain object) is not provably a load failure, so it is not
  // treated as one.
  assert.equal(moduleLoadProblem(Object.assign(new Error('x'), { stack: undefined }), 'd.mjs'), null);
  assert.equal(moduleLoadProblem('a thrown string', 'd.mjs'), null);
  assert.equal(moduleLoadProblem(null, 'd.mjs'), null);
  // And an ERR_ code that is not the module system's is an ordinary runtime
  // failure — a config calling fs.readFile(undefined), not a module that would
  // not load.
  const runtime = Object.assign(new TypeError('bad arg'), {
    code: 'ERR_INVALID_ARG_TYPE',
    stack: 'TypeError: bad arg\n    at node:internal/fs/utils:1:1',
  });
  assert.equal(moduleLoadProblem(runtime, 'd.mjs'), null);
});

test('sceneProblems is the subset dryRun can check, and agrees with configProblems', () => {
  const scene = { target: { url: 'http://x' }, timeline: { steps: [], calls: {} }, capture: 'deterministc' };
  assert.match(sceneProblems(scene).join('\n'), /capture\.mode must be/);
  // A scene knows nothing about `out` or `encode`, so it must not invent
  // problems with them.
  assert.deepEqual(sceneProblems({ target: { url: 'http://x' }, timeline: { steps: [], calls: {} } }), []);
});
