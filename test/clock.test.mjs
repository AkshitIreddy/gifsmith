/**
 * The clock seam, real half.
 *
 * `realClock` is the default path's clock, and its whole specification is "what
 * the player did before the seam existed": `advance` is `setTimeout`, `settle`
 * is `await`, and neither has an opinion of its own. That is easy to break by
 * improving it — a cap here, a timeout there — so it is pinned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { realClock, sleep } from '../dist/timeline/clock.js';

test('realClock advances by sleeping, and reports it', async () => {
  const c = realClock();
  assert.equal(c.kind, 'real');
  assert.equal(c.frameMs, 0, 'real time has no frame quantum');
  const t0 = Date.now();
  await c.advance(80);
  const real = Date.now() - t0;
  assert.ok(real >= 70, `advance(80) slept ${real}ms`);
  assert.ok(c.nowMs() >= 70, `nowMs() reads the wall clock (${c.nowMs()}ms)`);
});

test('realClock.advance tolerates a negative or zero span', async () => {
  const c = realClock();
  await c.advance(0);
  await c.advance(-500); // must not sleep backwards, must not throw
  assert.ok(c.nowMs() < 500);
});

test('realClock.mark re-zeros the scene-time origin', async () => {
  const c = realClock(Date.now() - 5_000);
  assert.ok(c.nowMs() >= 5_000, 'an origin in the past reports elapsed time from it');
  c.mark();
  assert.ok(c.nowMs() < 50, `mark() re-zeroed (${c.nowMs()}ms)`);
});

test('realClock.settle is a plain await, and ignores the cap', async () => {
  const c = realClock();
  let done = false;
  const p = sleep(120).then(() => {
    done = true;
    return 'value';
  });
  // A cap of 1ms would abandon this on the virtual clock. The real one must not
  // acquire a new way for a working render to fail.
  const settled = await c.settle(p, 1);
  assert.equal(settled, true);
  assert.equal(done, true, 'settle returned before the promise resolved');
});

test('realClock.settle propagates a rejection, as await does', async () => {
  const c = realClock();
  await assert.rejects(
    () => c.settle(Promise.reject(new Error('boom')), 1000),
    /boom/,
  );
});
