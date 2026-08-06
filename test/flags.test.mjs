/**
 * The CLI flag layer.
 *
 * Every failure here is a SILENT one — the render runs, prints a result, and is
 * quietly not the render that was asked for — which is why it is worth a test
 * file for what is, structurally, argv parsing.
 *
 * `str()` was added so a value-taking flag could not be misread, and applied to
 * the string flags only. The numeric ones kept a bare `Number(v)` behind them,
 * and `Number(true) === 1`, so `--bayer-scale` with its value left off rendered
 * at bayerScale 1 — the setting this project's own measurements call a disaster
 * at 30.2 dB — with no error and no warning. `--lossless false` set lossless.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, str, num, bool, applyOverrides, enumStr } from '../dist/flags.js';

/** The smallest config applyOverrides will accept, so a test reads as flags. */
const base = () => ({
  out: 'demo.gif',
  target: { url: 'http://localhost' },
  timeline: { steps: [], calls: {} },
});

const flags = (line) => parse(line.split(' ').filter(Boolean));
const overrides = (line) => applyOverrides(base(), flags(line));

// ── the parser itself ───────────────────────────────────────────────────────

test('parse separates positionals, values and bare flags', () => {
  const f = flags('render demo.mjs --width 900 --debug');
  assert.deepEqual(f._, ['render', 'demo.mjs']);
  assert.equal(f.width, '900');
  assert.equal(f.debug, true);
});

test('a flag followed by another flag takes no value', () => {
  const f = flags('render demo.mjs --debug --width 900');
  assert.equal(f.debug, true);
  assert.equal(f.width, '900');
});

// ── str: the half that was already done ─────────────────────────────────────

test('str refuses a value-taking flag with its value left off', () => {
  assert.throws(() => str(flags('render demo.mjs --out'), 'out'), /--out needs a value/);
});

test('str is undefined for an absent flag', () => {
  assert.equal(str(flags('render demo.mjs'), 'out'), undefined);
});

// ── num: the half that was missing ──────────────────────────────────────────

test('num refuses a numeric flag with its value left off, rather than reading 1', () => {
  // The bug, exactly: Number(true) === 1, so this used to render at bayerScale 1.
  assert.throws(
    () => num(flags('render demo.mjs --bayer-scale'), 'bayer-scale'),
    /--bayer-scale needs a value/,
  );
});

test('every numeric flag refuses a missing value', () => {
  for (const flag of ['width', 'fps', 'speed', 'colors', 'quality', 'target-mb', 'bayer-scale']) {
    assert.throws(
      () => overrides(`render demo.mjs --${flag}`),
      new RegExp(`--${flag} needs a value`),
      `--${flag} still silently reads as 1`,
    );
  }
});

test('num refuses a value that is not a number instead of passing NaN on', () => {
  assert.throws(() => num(flags('render demo.mjs --fps sixteen'), 'fps'), /needs a number/);
  // Number('   ') is 0, so a whitespace argument would have been 0 fps.
  assert.throws(() => num(parse(['--fps', '   ']), 'fps'), /needs a number/);
});

test('num reads real values, including zero and fractions', () => {
  assert.equal(num(flags('render demo.mjs --bayer-scale 0'), 'bayer-scale'), 0);
  assert.equal(num(flags('render demo.mjs --speed 1.5'), 'speed'), 1.5);
});

test('numeric flags reach the encode options they name', () => {
  const cfg = overrides(
    'render demo.mjs --width 900 --fps 16 --speed 1.5 --colors 128 --quality 88 --target-mb 4 --bayer-scale 5',
  );
  assert.deepEqual(cfg.encode, {
    width: 900,
    fps: 16,
    speed: 1.5,
    colors: 128,
    quality: 88,
    targetMB: 4,
    bayerScale: 5,
  });
});

test('a numeric flag that was not passed leaves the config alone', () => {
  const cfg = applyOverrides({ ...base(), encode: { fps: 20 } }, flags('render demo.mjs --width 900'));
  assert.equal(cfg.encode.fps, 20);
  assert.equal(cfg.encode.width, 900);
});

test('--bayer-scale 0 survives, rather than being dropped as falsy', () => {
  const cfg = applyOverrides({ ...base(), encode: { bayerScale: 4 } }, flags('render demo.mjs --bayer-scale 0'));
  assert.equal(cfg.encode.bayerScale, 0);
});

// ── bool: the same bug running the other way ────────────────────────────────

test('--lossless false turns lossless OFF', () => {
  // 'false' is a truthy string, so this used to turn it ON.
  assert.equal(overrides('render demo.mjs --lossless false').encode.lossless, false);
  assert.equal(overrides('render demo.mjs --lossless').encode.lossless, true);
  assert.equal(overrides('render demo.mjs --lossless true').encode.lossless, true);
});

test('--lossless left off does not touch the config', () => {
  const cfg = applyOverrides({ ...base(), encode: { lossless: true } }, flags('render demo.mjs'));
  assert.equal(cfg.encode.lossless, true);
});

test('a boolean flag that swallowed a positional says so', () => {
  // `gifsmith render --lossless demo.mjs` used to lose the config path entirely
  // and fail with "gifsmith render <config.mjs>".
  assert.throws(
    () => overrides('render --lossless demo.mjs'),
    /--lossless takes no value/,
  );
});

test('the other boolean flags read the same way', () => {
  assert.equal(overrides('render demo.mjs --headful').target.headful, true);
  assert.equal(overrides('render demo.mjs --headful false').target.headful, false);
  assert.equal(overrides('render demo.mjs --keep-frames').keepFrames, true);
  assert.equal(overrides('render demo.mjs --keep-frames false').keepFrames, false);
  assert.equal(overrides('render demo.mjs --debug').logLevel, 'debug');
  assert.equal(overrides('render demo.mjs --quiet').logLevel, 'warn');
  assert.deepEqual(overrides('render demo.mjs --also-webp').alsoEmit, ['webp']);
  assert.equal(bool(flags('render demo.mjs'), 'headful'), false);
});


test('an explicit false beats a config that said true — for every boolean', () => {
  // `flag || cfg.flag` cannot express "off", which is how `--lossless false`
  // came to mean lossless ON. The same shape was under --headful and
  // --keep-frames.
  const cfg = { ...base(), keepFrames: true, target: { url: 'http://localhost', headful: true } };
  const off = applyOverrides(cfg, flags('render demo.mjs --headful false --keep-frames false'));
  assert.equal(off.target.headful, false);
  assert.equal(off.keepFrames, false);

  // …and not passing the flag leaves the config's answer intact.
  const kept = applyOverrides(cfg, flags('render demo.mjs'));
  assert.equal(kept.target.headful, true);
  assert.equal(kept.keepFrames, true);
});

// ── capture, which is what str was written for in the first place ───────────

test('--capture with no value is refused, not spread into an options object', () => {
  assert.throws(() => overrides('render demo.mjs --capture'), /--capture needs a value/);
});

test('--frame-format normalises a bare capture mode to the long form', () => {
  const cfg = applyOverrides(
    { ...base(), capture: 'deterministic' },
    flags('render demo.mjs --frame-format png'),
  );
  assert.deepEqual(cfg.capture, { mode: 'deterministic', format: 'png' });
});

// ── every boolean, in both directions, against a config that disagrees ──────

/**
 * The six booleans and what each one actually sets, as a table — because the bug
 * that reached a gate was ONE of them behaving differently from the other five,
 * and a hand-written test per flag is exactly how that survives.
 *
 * Two kinds, and the difference is real rather than an oversight:
 *
 *  - an OVERRIDE owns a field of its own, so `--flag false` must turn the
 *    feature off even when the config asked for it. `--also-webp` is one of
 *    these and did not behave like one: its field is an ARRAY (`alsoEmit`), the
 *    false branch handed the config's array straight back, and `--also-webp
 *    false` against `alsoEmit: ['webp']` emitted the WebP anyway.
 *  - a REQUEST can only ask for one of several levels — `--debug` and `--quiet`
 *    both set `logLevel`, which has no "off". `--debug false` means "I am not
 *    asking for debug", and the config's own level stands.
 */
const OVERRIDE_BOOLEANS = [
  {
    flag: 'lossless',
    on: { encode: { lossless: true } },
    read: (c) => c.encode?.lossless === true,
  },
  {
    flag: 'headful',
    on: { target: { url: 'http://localhost', headful: true } },
    read: (c) => c.target.headful === true,
  },
  {
    flag: 'keep-frames',
    on: { keepFrames: true },
    read: (c) => c.keepFrames === true,
  },
  {
    flag: 'also-webp',
    on: { alsoEmit: ['webp'] },
    read: (c) => (c.alsoEmit ?? []).includes('webp'),
  },
];

test('an explicit false turns the feature off even when the config turned it on', () => {
  for (const { flag, on, read } of OVERRIDE_BOOLEANS) {
    const cfg = { ...base(), ...on };
    assert.equal(read(applyOverrides(cfg, flags(`render demo.mjs --${flag} false`))), false, `--${flag} false`);
    assert.equal(read(applyOverrides(cfg, flags(`render demo.mjs --${flag}`))), true, `--${flag}`);
    assert.equal(read(applyOverrides(cfg, flags(`render demo.mjs --${flag} true`))), true, `--${flag} true`);
    // Absent: the config keeps its answer, whichever way it pointed.
    assert.equal(read(applyOverrides(cfg, flags('render demo.mjs'))), true, `--${flag} absent (config on)`);
    assert.equal(read(applyOverrides(base(), flags('render demo.mjs'))), false, `--${flag} absent (config off)`);
    // …and it can be turned on from a config that never mentioned it.
    assert.equal(read(applyOverrides(base(), flags(`render demo.mjs --${flag}`))), true, `--${flag} from nothing`);
  }
});

test('--also-webp is an array, and is edited rather than replaced', () => {
  // The reported defect: bare, `true` and `false` all yielded ["webp"].
  const withWebp = { ...base(), alsoEmit: ['webp'] };
  assert.deepEqual(applyOverrides(withWebp, flags('render demo.mjs --also-webp false')).alsoEmit, []);
  assert.deepEqual(applyOverrides(withWebp, flags('render demo.mjs --also-webp')).alsoEmit, ['webp'], 'no duplicate');
  assert.deepEqual(applyOverrides(withWebp, flags('render demo.mjs')).alsoEmit, ['webp']);
  assert.deepEqual(applyOverrides(base(), flags('render demo.mjs --also-webp')).alsoEmit, ['webp']);
  assert.deepEqual(applyOverrides(base(), flags('render demo.mjs --also-webp false')).alsoEmit, []);
  // Only the webp entry is the flag's business.
  const both = { ...base(), alsoEmit: ['gif', 'webp'] };
  assert.deepEqual(applyOverrides(both, flags('render demo.mjs --also-webp false')).alsoEmit, ['gif']);
});

test('--debug and --quiet are requests, so false leaves the config level alone', () => {
  const cfg = { ...base(), logLevel: 'debug' };
  assert.equal(applyOverrides(cfg, flags('render demo.mjs --debug false')).logLevel, 'debug');
  assert.equal(applyOverrides(cfg, flags('render demo.mjs --quiet false')).logLevel, 'debug');
  assert.equal(applyOverrides(cfg, flags('render demo.mjs --quiet')).logLevel, 'warn');
  assert.equal(applyOverrides(base(), flags('render demo.mjs --debug')).logLevel, 'debug');
});

/**
 * …and that difference is a DECISION, so it is pinned rather than merely
 * observed. A gate asked why these two alone do not honour `false`; the answer
 * is that the other four own a field with two states, and these two are
 * shortcuts onto `logLevel`, which has four. "Not debug" does not name one of
 * `silent | warn | info | debug`, so any answer gifsmith picked would be a level
 * the reader never asked for, overriding one they did write down.
 *
 * The CLI's help text and the README both say so now, which is the other half of
 * the decision — an intentional asymmetry nobody is told about is
 * indistinguishable from the bug it looks like.
 */
test('the four levels are why: an explicit false cannot name one, so it asks for nothing', () => {
  for (const level of ['silent', 'warn', 'info', 'debug']) {
    const cfg = { ...base(), logLevel: level };
    for (const line of ['--debug false', '--quiet false', '--debug false --quiet false']) {
      assert.equal(
        applyOverrides(cfg, flags(`render demo.mjs ${line}`)).logLevel,
        level,
        `${line} against logLevel:'${level}'`,
      );
    }
  }
  // A config that set no level keeps not having one — the flag does not invent
  // a default on the way past.
  assert.equal(applyOverrides(base(), flags('render demo.mjs --debug false')).logLevel, undefined);
  // Given both, the one asking for LESS output wins. Documented in the help text.
  assert.equal(applyOverrides(base(), flags('render demo.mjs --debug --quiet')).logLevel, 'warn');
  assert.equal(applyOverrides(base(), flags('render demo.mjs --quiet --debug')).logLevel, 'warn');
});

// ── flags whose shape is narrower than the config field they write ──────────

/**
 * The same class as `--also-webp`, found by asking the question the other way
 * round: which flags write a config field whose SHAPE they cannot express?
 *
 * Three of them, and two were silently discarding everything they could not say.
 * A flag that claims to pick a backend must not also erase the frame format.
 */
test('--capture sets the mode without discarding the rest of the capture options', () => {
  const cfg = {
    ...base(),
    capture: { mode: 'deterministic', format: 'png', frameTimeoutMs: 20000, waitForNetwork: true },
  };
  assert.deepEqual(applyOverrides(cfg, flags('render demo.mjs --capture screencast')).capture, {
    mode: 'screencast',
    format: 'png',
    frameTimeoutMs: 20000,
    waitForNetwork: true,
  });
  // Both flags together, onto a config that said nothing at all.
  assert.deepEqual(
    applyOverrides(base(), flags('render demo.mjs --capture deterministic --frame-format png')).capture,
    { mode: 'deterministic', format: 'png' },
  );
  // …and neither flag leaves the field exactly as the config had it.
  assert.deepEqual(applyOverrides(cfg, flags('render demo.mjs')).capture, cfg.capture);
  assert.equal(applyOverrides(base(), flags('render demo.mjs')).capture, undefined);
});

test('--frame-format alone against a config with no capture still produces a valid mode', () => {
  assert.deepEqual(applyOverrides(base(), flags('render demo.mjs --frame-format png')).capture, {
    mode: 'screencast',
    format: 'png',
  });
});

test('--loop sets the strategy without discarding minCycleSeconds', () => {
  // The knob 0.2.3 added specifically so a long walkthrough survives the anchor
  // search. Replacing the field wholesale put it back to the 3-second default.
  const cfg = { ...base(), loop: { strategy: 'crossfade', minCycleSeconds: 30 } };
  assert.deepEqual(applyOverrides(cfg, flags('render demo.mjs --loop anchor')).loop, {
    strategy: 'anchor',
    minCycleSeconds: 30,
  });
  assert.deepEqual(applyOverrides(cfg, flags('render demo.mjs')).loop, cfg.loop);
  assert.equal(applyOverrides(base(), flags('render demo.mjs --loop none')).loop, 'none');
});

// ── the closed sets ─────────────────────────────────────────────────────────

/**
 * Six flags name a mode, and every one of them used to be handed through
 * unchecked — `str()` proved a value was a string and asked nothing else.
 *
 * What that cost, per flag: `--capture Deterministic` reached the director and
 * printed a stack; `--loop crossfde` matched none of the planner's three tests
 * and silently rendered with the ANCHOR strategy; `--palette ful` silently
 * rendered the default; `--format jpg` wrote a WebP to a path ending .jpg.
 */
const ENUMS = {
  format: ['gif', 'webp'],
  loop: ['auto', 'anchor', 'crossfade', 'none'],
  capture: ['screencast', 'deterministic'],
  dither: ['bayer', 'floyd_steinberg', 'sierra2', 'sierra2_4a', 'atkinson', 'none'],
  palette: ['diff', 'full', 'perFrame'],
  'frame-format': ['jpeg', 'png'],
};

test('every mode flag accepts exactly its own values', () => {
  for (const [flag, allowed] of Object.entries(ENUMS)) {
    for (const value of allowed) {
      assert.doesNotThrow(() => overrides(`render demo.mjs --${flag} ${value}`), `--${flag} ${value}`);
    }
    assert.throws(
      () => overrides(`render demo.mjs --${flag} nonsense`),
      new RegExp(`--${flag} must be`),
      `--${flag} nonsense`,
    );
    // The typo that is actually made: right word, wrong case.
    assert.throws(
      () => overrides(`render demo.mjs --${flag} ${allowed[0].toUpperCase()}`),
      /did you mean/,
      `--${flag} ${allowed[0].toUpperCase()}`,
    );
  }
});

// ── the near-miss hint, which has to survive being read ─────────────────────

/** The message `--<flag> <value>` produces, or '(accepted)' if it produces none. */
function refusal(flag, value) {
  try {
    overrides(`render demo.mjs --${flag} ${value}`);
  } catch (e) {
    return e.message;
  }
  return '(accepted)';
}

/**
 * The hint may not contradict the value it suggests.
 *
 * It used to end "the values are lowercase" — true of five of the six enums and
 * FALSE of `--palette perFrame`, which is both the only camelCase value in the
 * product and the one a reader is most likely to get wrong. So the answer to
 * `--palette PerFrame` was "did you mean --palette perFrame? the values are
 * lowercase", and a reader who believes the second half types `perframe` and is
 * refused again.
 *
 * This is asserted as an IMPLICATION rather than as a banned word, because that
 * is the rule that survives a rewrite: whatever the hint claims about the shape
 * of the values, the value it hands over has to satisfy it. A future hint that
 * says "lowercase" while suggesting `perFrame` fails here no matter how it is
 * phrased.
 */
test('--palette PerFrame is refused with a hint that does not argue with itself', () => {
  const msg = refusal('palette', 'PerFrame');
  assert.match(msg, /--palette must be 'diff' \| 'full' \| 'perFrame'/);
  assert.match(msg, /got "PerFrame"/, 'the hint has to quote what was typed');
  assert.match(msg, /\(did you mean --palette perFrame\?\)/);
  assert.ok(
    !/lower ?case/i.test(msg),
    `the hint suggests 'perFrame' and must not also claim the values are lowercase: ${msg}`,
  );
});

test('the hint reads consistently for every enumerated flag, at every value', () => {
  for (const [flag, allowed] of Object.entries(ENUMS)) {
    for (const value of allowed) {
      // Every case-only typo a reader can make of a real value: the whole thing
      // shouted, and the first letter capitalised (`--capture Deterministic`).
      for (const wrong of [value.toUpperCase(), value[0].toUpperCase() + value.slice(1)]) {
        if (wrong === value) continue;
        const msg = refusal(flag, wrong);
        assert.match(msg, new RegExp(`--${flag} must be`), `--${flag} ${wrong}`);
        assert.ok(
          msg.includes(`(did you mean --${flag} ${value}?)`),
          `--${flag} ${wrong} did not suggest the exact spelling ${value}: ${msg}`,
        );
        // The implication: a claim about the shape of the values has to hold for
        // the value being suggested.
        assert.ok(
          !/lower ?case/i.test(msg) || value === value.toLowerCase(),
          `--${flag} ${wrong} suggests ${value} and calls the values lowercase: ${msg}`,
        );
        assert.ok(
          !/upper ?case/i.test(msg) || value === value.toUpperCase(),
          `--${flag} ${wrong} suggests ${value} and calls the values uppercase: ${msg}`,
        );
        // Nothing in the message may quote a value gifsmith does not accept —
        // the list, the suggestion and the rejected value are the only tokens.
        for (const quoted of msg.match(/'[^']+'/g) ?? []) {
          const bare = quoted.slice(1, -1);
          assert.ok(allowed.includes(bare), `--${flag} ${wrong} quoted '${bare}', which is not a value`);
        }
      }
    }
  }
});

test('a value that is not a near miss gets the list and no suggestion', () => {
  // The hint is for a typo. "nonsense" is a misunderstanding of what the flag is
  // for, and inventing a nearest match for it would be a guess presented as help.
  const msg = refusal('palette', 'nonsense');
  assert.match(msg, /--palette must be 'diff' \| 'full' \| 'perFrame'; got "nonsense"/);
  assert.doesNotMatch(msg, /did you mean/);
});

test('enumStr is undefined for an absent flag and passes an exact value through', () => {
  assert.equal(enumStr(flags('render demo.mjs'), 'palette', ['diff', 'perFrame']), undefined);
  assert.equal(enumStr(flags('render demo.mjs --palette perFrame'), 'palette', ['diff', 'perFrame']), 'perFrame');
});

test('a numeric flag outside the range the render needs is refused', () => {
  assert.throws(() => overrides('render demo.mjs --fps 0'), /--fps must be a number greater than 0/);
  assert.throws(() => overrides('render demo.mjs --width -1'), /--width must be a number greater than 0/);
  assert.throws(() => overrides('render demo.mjs --speed 0'), /--speed must be a number greater than 0/);
  assert.throws(() => overrides('render demo.mjs --quality 101'), /--quality must be a number between 0 and 100/);
  assert.throws(() => overrides('render demo.mjs --target-mb -2'), /--target-mb must be a number greater than 0/);
  assert.throws(() => overrides('render demo.mjs --bayer-scale -1'), /--bayer-scale must be a number at least 0/);
});

test('the clamped knobs keep working, because the encoder documents the clamp', () => {
  assert.equal(overrides('render demo.mjs --colors 300').encode.colors, 300);
  assert.equal(overrides('render demo.mjs --bayer-scale 9').encode.bayerScale, 9);
  assert.equal(overrides('render demo.mjs --quality 0').encode.quality, 0);
});
