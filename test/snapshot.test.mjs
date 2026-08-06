/**
 * `playCapturing` — the seeking arithmetic behind `snapshot()` and
 * `contactSheet()`.
 *
 * The bug: it split only `hold` steps around a requested stop. Everything else
 * with a duration fell through to "run the whole step, then screenshot", which
 * was harmless while a `call` counted as zero planned seconds — a stop could not
 * land inside a step that had no length. Once `t.call(fn, { seconds: 2 })`
 * became how a scene declares its real duration, asking to see 1s into a 2s
 * callback handed back the frame taken AFTER the callback finished: the one
 * moment the author explicitly did not ask for, substituted silently, in a
 * helper whose entire job is to answer "what does it look like at this
 * instant?".
 *
 * It was fixed and verified by one manual measurement, and a manual measurement
 * is not repeated. Nothing under test/ named `playCapturing` or `snapshot` — in
 * a release whose stated theme is a suite for the things that fail invisibly,
 * about a bug whose nature was silently returning the wrong moment.
 *
 * No browser is needed to check any of it. A screenshot here is whatever a fake
 * page says the app looks like right now, so a step that mutates that string is
 * a clock and a subject at once: ask for a frame at 100ms of a 400ms callback
 * and the answer either says 'during' or it does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playCapturing } from '../dist/ergonomics/snapshot.js';
import { Logger } from '../dist/log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A page whose "screenshot" is the caller-visible state at the moment it is taken. */
function fakePage(read) {
  let shots = 0;
  return {
    shotCount: () => shots,
    async screenshot(opts) {
      assert.equal(opts.encoding, 'base64', 'the callers decode this as base64');
      shots++;
      return read();
    },
  };
}

function ctx() {
  return { startMs: Date.now(), cueTimes: {}, anchorMs: null, log: new Logger('error'), appFrame: null };
}

/** A scene whose only moving part is what the fake page reports. */
function scene(steps, calls = {}) {
  return { target: { url: 'http://localhost' }, timeline: { steps, calls } };
}

// ── the defect ──────────────────────────────────────────────────────────────

test('a stop inside a `call` step is served DURING the callback, not after it', async () => {
  let state = 'before';
  const page = fakePage(() => state);
  const cfg = scene([{ kind: 'call', label: 'c0', seconds: 0.4 }], {
    c0: async () => {
      state = 'during';
      await sleep(400);
      state = 'after';
    },
  });

  const shots = await playCapturing(page, cfg, ctx(), [150]);

  // The whole bug in one assertion: this used to be 'after'.
  assert.equal(shots[150], 'during', 'the frame came from after the callback finished');
  assert.equal(state, 'after', 'the step must still be awaited to completion');
});

test('several stops inside one indivisible step each get their own moment', async () => {
  const marks = [];
  let state = '0';
  const page = fakePage(() => state);
  const cfg = scene([{ kind: 'call', label: 'c0', seconds: 0.6 }], {
    c0: async () => {
      for (const s of ['1', '2', '3']) {
        state = s;
        marks.push(s);
        await sleep(200);
      }
      state = 'done';
    },
  });

  const shots = await playCapturing(page, cfg, ctx(), [100, 300, 500]);

  assert.deepEqual(Object.keys(shots).map(Number), [100, 300, 500]);
  assert.equal(shots[100], '1');
  assert.equal(shots[300], '2');
  assert.equal(shots[500], '3');
  assert.deepEqual(marks, ['1', '2', '3'], 'the callback ran once, start to finish');
});

test('a stop inside a `hold` is still split, not raced — the precise path stays', async () => {
  // A hold is pure waiting, so the frame lands at exactly the moment asked for
  // and nothing is in flight while it is taken. That is the better answer where
  // it is available, and racing must not have replaced it.
  const page = fakePage(() => 'held');
  const started = Date.now();
  let at = null;
  const readingPage = {
    ...page,
    async screenshot(o) {
      at = Date.now() - started;
      return page.screenshot(o);
    },
  };

  const shots = await playCapturing(readingPage, scene([{ kind: 'hold', ms: 400 }]), ctx(), [200]);

  assert.equal(shots[200], 'held');
  assert.ok(at >= 150 && at < 400, `the frame was taken at ${at}ms, not around 200ms`);
  const total = Date.now() - started;
  assert.ok(total >= 380, `the hold was cut short: ${total}ms of a 400ms hold`);
});

// ── the ordinary cases, which must not have been broken to fix the above ────

test('a stop at 0 is the state before anything runs', async () => {
  let state = 'initial';
  const page = fakePage(() => state);
  const cfg = scene([{ kind: 'call', label: 'c0', seconds: 0.2 }], {
    c0: async () => {
      state = 'running';
      await sleep(200);
      state = 'done';
    },
  });

  const shots = await playCapturing(page, cfg, ctx(), [0]);
  assert.equal(shots[0], 'initial');
  assert.equal(state, 'done');
});

test('a stop past the end of the timeline is the final state', async () => {
  let state = 'initial';
  const page = fakePage(() => state);
  const cfg = scene([{ kind: 'call', label: 'c0', seconds: 0.1 }], {
    c0: async () => {
      state = 'done';
    },
  });

  const shots = await playCapturing(page, cfg, ctx(), [5_000]);
  assert.equal(shots[5_000], 'done');
});

test('stops spread across several steps land in the step they belong to', async () => {
  const page = fakePage(() => state);
  let state = 'a';
  const cfg = scene(
    [
      { kind: 'hold', ms: 200 },
      { kind: 'call', label: 'b', seconds: 0.4 },
      { kind: 'hold', ms: 200 },
    ],
    {
      b: async () => {
        state = 'b';
        await sleep(400);
        state = 'c';
      },
    },
  );

  const shots = await playCapturing(page, cfg, ctx(), [100, 400, 700]);
  assert.equal(shots[100], 'a', 'inside the first hold');
  assert.equal(shots[400], 'b', 'inside the callback');
  assert.equal(shots[700], 'c', 'inside the trailing hold');
});

test('a step with no duration is run whole, and the stop after it sees the result', async () => {
  let state = 'before';
  const page = fakePage(() => state);
  // `cue` costs nothing, so no stop can land inside it.
  const cfg = scene([
    { kind: 'call', label: 'c0' },
    { kind: 'hold', ms: 200 },
  ], { c0: async () => { state = 'after'; } });

  const shots = await playCapturing(page, cfg, ctx(), [100]);
  assert.equal(shots[100], 'after');
});

test('every requested stop produces exactly one frame', async () => {
  const page = fakePage(() => 'x');
  const stops = [0, 50, 150, 300, 900];
  const cfg = scene([{ kind: 'hold', ms: 200 }, { kind: 'hold', ms: 200 }]);

  const shots = await playCapturing(page, cfg, ctx(), stops);
  assert.deepEqual(Object.keys(shots).map(Number).sort((a, b) => a - b), stops);
  assert.equal(page.shotCount(), stops.length, 'a frame was taken twice, or not at all');
});

test('stops are served in time order however they were asked for', async () => {
  const order = [];
  let state = 'a';
  const page = fakePage(() => {
    order.push(state);
    return state;
  });
  const cfg = scene(
    [
      { kind: 'call', label: 'c0', seconds: 0.3 },
      { kind: 'hold', ms: 200 },
    ],
    { c0: async () => { await sleep(300); state = 'b'; } },
  );

  const shots = await playCapturing(page, cfg, ctx(), [400, 100]);
  assert.deepEqual(order, ['a', 'b'], 'an out-of-order request rewound the scene');
  assert.equal(shots[100], 'a');
  assert.equal(shots[400], 'b');
});

// ── the failure path, which racing had to be careful with ───────────────────

test('a step that throws while being shot through still fails the run', async () => {
  // The raced step is started without an await, so its rejection has to be
  // caught and re-thrown after the frames are taken — otherwise it is either an
  // unhandled rejection or a snapshot that quietly reports a scene that broke.
  const page = fakePage(() => 'x');
  const cfg = scene([{ kind: 'call', label: 'boom', seconds: 0.3 }], {
    boom: async () => {
      await sleep(100);
      throw new Error('the callback failed');
    },
  });

  await assert.rejects(() => playCapturing(page, cfg, ctx(), [200]), /the callback failed/);
});
