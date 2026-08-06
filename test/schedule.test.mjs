/**
 * The deterministic backend's arithmetic, with the browser taken out.
 *
 * `createFrameScheduler` talks to the outside world through two callbacks, so a
 * test can hand it two functions that push to an array and check the three
 * properties a deterministic render's whole promise rests on. None of them is
 * visible in the output when it goes wrong, which is exactly why they are here:
 * a scheduler that drifts renders a GIF that looks fine and is a frame short
 * every second.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameScheduler } from '../dist/capture/schedule.js';

/** A scheduler wired to two recorders. `spend` is instant — this is arithmetic. */
function harness(frameMs, opts = {}) {
  const spends = [];
  const captures = [];
  const errors = [];
  const s = createFrameScheduler({
    frameMs,
    async spend(ms) {
      spends.push(ms);
      if (opts.spendDelay) await new Promise((r) => setTimeout(r, opts.spendDelay));
    },
    async capture(atMs) {
      captures.push(atMs);
      if (opts.captureDelay) await new Promise((r) => setTimeout(r, opts.captureDelay));
    },
    onError: (e) => errors.push(e),
  });
  return { s, spends, captures, errors, spent: () => spends.reduce((a, b) => a + b, 0) };
}

test('one frame per frame interval, starting at scene zero', async () => {
  const { s, captures, spent } = harness(100);
  await s.advance(1000);
  // 0, 100, … 1000 — the boundary at the start of the scene is a frame too.
  assert.deepEqual(captures, [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  assert.equal(s.nowMs(), 1000);
  assert.equal(spent(), 1000, 'scene time spent equals scene time asked for');

  // A second beat continues the same grid rather than restarting it.
  await s.advance(1000);
  assert.equal(captures.length, 21);
  assert.equal(captures[captures.length - 1], 2000);
  assert.equal(s.nowMs(), 2000);
});

test('sub-frame advances still land frames on the grid (a drag ticks like this)', async () => {
  const frameMs = 1000 / 3; // deliberately not representable in binary
  const { s, captures } = harness(frameMs);
  for (let i = 0; i < 3000; i++) await s.advance(1); // 3000 pointer ticks

  const expected = Math.floor(3000 / frameMs) + 1; // + the frame at t=0
  assert.equal(captures.length, expected);
  assert.equal(Math.round(s.nowMs()), 3000);
  // No drift: frame k is on k × frameMs, not near it. A per-call remainder
  // implementation passes the count above and fails this.
  for (let k = 0; k < captures.length; k++) {
    assert.ok(
      Math.abs(captures[k] - k * frameMs) < 1e-6,
      `frame ${k} landed at ${captures[k]}, expected ${k * frameMs}`,
    );
  }
});

test('no drift over a long run at a non-integer frame interval', async () => {
  const frameMs = (1000 * 1.4) / 24; // the default speed at 24fps: 58.333…
  const { s, captures } = harness(frameMs);
  await s.advance(frameMs * 5000);
  assert.equal(captures.length, 5001);
  const last = captures[captures.length - 1];
  assert.ok(
    Math.abs(last - 5000 * frameMs) < 1e-6,
    `frame 5000 landed at ${last}, expected ${5000 * frameMs}`,
  );
});

test('parallel branches cost the longest, not the sum', async () => {
  const { s, captures, spent } = harness(100);
  // Two branches of a `parallel`, started together the way the player starts them.
  await Promise.all([s.advance(1000), s.advance(400), s.advance(700)]);
  assert.equal(s.nowMs(), 1000, 'the beat is as long as its longest branch');
  assert.equal(spent(), 1000, 'and the page lived through that once, not three times');
  assert.equal(captures.length, 11);
});

test('a branch that finishes early resolves at its own deadline', async () => {
  const { s } = harness(100);
  const order = [];
  const short = s.advance(300).then(() => order.push('short'));
  const long = s.advance(900).then(() => order.push('long'));
  await Promise.all([short, long]);
  assert.deepEqual(order, ['short', 'long']);
});

test('a deadline between frame boundaries is honoured without inventing a frame', async () => {
  const { s, captures, spends } = harness(100);
  await s.advance(250);
  assert.deepEqual(captures, [0, 100, 200], 'no frame at 250');
  assert.equal(s.nowMs(), 250);
  assert.deepEqual(spends, [0, 100, 100, 50]);
});

test('stop() releases every waiter and refuses to advance again', async () => {
  const { s, captures } = harness(100, { spendDelay: 5 });
  const waiting = s.advance(10_000);
  setTimeout(() => s.stop(), 30);
  await waiting; // must not hang
  assert.ok(s.isStopped());
  const before = captures.length;
  await s.advance(1000);
  assert.equal(captures.length, before, 'a stopped scheduler captures nothing further');
});

test('a throwing spend releases the timeline instead of hanging it', async () => {
  const errors = [];
  const s = createFrameScheduler({
    frameMs: 100,
    spend: async (ms) => {
      if (ms > 0) throw new Error('page is gone');
    },
    capture: async () => {},
    onError: (e) => errors.push(e),
  });
  await s.advance(500); // resolves rather than waiting for a deadline that cannot come
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].message), /page is gone/);
});

test('reset() re-zeros the clock and the frame grid', async () => {
  const { s, captures } = harness(100);
  await s.advance(350);
  s.reset();
  assert.equal(s.nowMs(), 0);
  const before = captures.length;
  await s.advance(100);
  assert.deepEqual(captures.slice(before), [0, 100]);
});

test('drain() waits for a pump that is still mid-frame', async () => {
  const { s, captures } = harness(100, { captureDelay: 10 });
  const p = s.advance(300);
  await p;
  await s.drain();
  assert.equal(captures.length, 4);
});
