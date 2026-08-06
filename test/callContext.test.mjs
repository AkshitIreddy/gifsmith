/**
 * `t.call()`'s second argument, and the four guards behind it.
 *
 * The rules being pinned here are the ones a future edit is most likely to
 * break, in the order they matter:
 *   1. the existing one-argument callback keeps working, untouched;
 *   2. under the real clock the new verbs ARE `setTimeout` and `await` — no cap,
 *      no watchdog, no new way for the default path to fail;
 *   3. under a virtual clock nothing can wait silently forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCall } from '../dist/timeline/callContext.js';
import { realClock } from '../dist/timeline/clock.js';

const PAGE = { iam: 'page' };

function fakeLog() {
  const warnings = [];
  return {
    warnings,
    warn: (...a) => warnings.push(a.join(' ')),
    info() {}, debug() {}, step() {},
  };
}

/**
 * A virtual clock with the CDP taken out: advancing is instant and only moves a
 * number, which is what a virtual clock is once you stop looking at the browser.
 */
function fakeVirtualClock(frameMs = 50, onAdvance) {
  let now = 0;
  let origin = 0;
  return {
    kind: 'virtual',
    frameMs,
    advance: async (ms) => {
      now += Math.max(0, ms);
      onAdvance?.(now);
      await new Promise((r) => setImmediate(r));
    },
    nowMs: () => now - origin,
    mark: () => { origin = now; },
    settle: async () => true,
    /** test-only */
    absolute: () => now,
  };
}

// ── 1. the legacy form ───────────────────────────────────────────────────────

test('a one-argument callback still receives the page, on both clocks', async () => {
  for (const clock of [realClock(), fakeVirtualClock()]) {
    let got = null;
    await runCall((page) => { got = page; }, PAGE, { clock, log: fakeLog(), label: 'call#0' });
    assert.equal(got, PAGE);
  }
});

test('a callback that throws still fails the render', async () => {
  await assert.rejects(
    () => runCall(async () => { throw new Error('scene is broken'); }, PAGE, {
      clock: realClock(), log: fakeLog(), label: 'call#0',
    }),
    /scene is broken/,
  );
  await assert.rejects(
    () => runCall(async () => { throw new Error('scene is broken'); }, PAGE, {
      clock: fakeVirtualClock(), log: fakeLog(), label: 'call#0',
    }),
    /scene is broken/,
  );
});

// ── 2. the real clock, unmoved ───────────────────────────────────────────────

test('real clock: ctx.advance sleeps, ctx.settle awaits', async () => {
  const t0 = Date.now();
  let value;
  await runCall(async (page, ctx) => {
    assert.equal(ctx.clock, 'real');
    assert.equal(ctx.frameMs, 0);
    await ctx.advance(80);
    value = await ctx.settle(Promise.resolve('answer'));
  }, PAGE, { clock: realClock(), log: fakeLog(), label: 'call#0' });
  assert.ok(Date.now() - t0 >= 70, 'advance actually slept');
  assert.equal(value, 'answer');
});

test('real clock: ctx.settle ignores the cap (no new timeout on the default path)', async () => {
  const log = fakeLog();
  let done = false;
  await runCall(async (page, ctx) => {
    await ctx.settle(new Promise((r) => setTimeout(() => { done = true; r(1); }, 120)), { capMs: 1 });
  }, PAGE, { clock: realClock(), log, label: 'call#0' });
  assert.equal(done, true);
  assert.deepEqual(log.warnings, [], 'and says nothing about it');
});

test('real clock: a raw setTimeout is not reported (it is the correct thing there)', async () => {
  const log = fakeLog();
  await runCall(async () => { await new Promise((r) => setTimeout(r, 600)); }, PAGE, {
    clock: realClock(), log, label: 'call#0',
  });
  assert.deepEqual(log.warnings, []);
});

// ── 3. the virtual clock ─────────────────────────────────────────────────────

test('virtual clock: ctx.advance spends exactly that much scene time', async () => {
  const clock = fakeVirtualClock(50);
  await runCall(async (page, ctx) => {
    assert.equal(ctx.clock, 'virtual');
    assert.equal(ctx.frameMs, 50);
    await ctx.advance(1900);
    await ctx.advance(250);
  }, PAGE, { clock, log: fakeLog(), label: 'call#0' });
  // Chunked internally so the stall watchdog can see progress — and chunking
  // must not cost a millisecond.
  assert.equal(clock.nowMs(), 2150);
});

test('virtual clock: a long advance is walked against an absolute target (no drift)', async () => {
  const clock = fakeVirtualClock(1000 / 3);
  await runCall(async (page, ctx) => {
    for (let i = 0; i < 20; i++) await ctx.advance(1000 / 7);
  }, PAGE, { clock, log: fakeLog(), label: 'call#0' });
  assert.ok(Math.abs(clock.nowMs() - (20 * 1000) / 7) < 1e-6, `spent ${clock.nowMs()}`);
});

test('virtual clock: ctx.settle drives the scene until the promise resolves', async () => {
  // The promise resolves only once the scene has moved — an in-page animation,
  // or an awaited page.evaluate, in effect. Awaiting it directly is the deadlock
  // the whole seam exists to avoid; settle inverts it.
  let resolve;
  const pageWork = new Promise((r) => { resolve = r; });
  const clock = fakeVirtualClock(50, (now) => { if (now >= 500) resolve('painted'); });
  let value;
  await runCall(async (page, ctx) => {
    value = await ctx.settle(pageWork);
  }, PAGE, { clock, log: fakeLog(), label: 'call#0' });
  assert.equal(value, 'painted');
  assert.equal(clock.nowMs(), 500, 'ten frames of scene time, and it stopped there');
});

test('virtual clock: ctx.settle throws (naming the step) instead of waiting forever', async () => {
  const clock = fakeVirtualClock(50);
  await assert.rejects(
    () => runCall(async (page, ctx) => {
      await ctx.settle(new Promise(() => {}), { capMs: 500, label: '.never-appears' });
    }, PAGE, { clock, log: fakeLog(), label: 'call step "turn" (call#7)' }),
    (e) => {
      assert.match(e.message, /call step "turn" \(call#7\)/);
      assert.match(e.message, /500ms of scene time/);
      assert.match(e.message, /\.never-appears/);
      return true;
    },
  );
  assert.equal(clock.nowMs(), 500, 'it gave up after exactly the cap, not before');
});

test('virtual clock: ctx.settle propagates the promise it was given', async () => {
  const clock = fakeVirtualClock(50);
  await assert.rejects(
    () => runCall(async (page, ctx) => {
      await ctx.settle(Promise.reject(new Error('selector not found')));
    }, PAGE, { clock, log: fakeLog(), label: 'call#0' }),
    /selector not found/,
  );
});

test('virtual clock: a callback that only sleeps in real time is reported', async () => {
  const log = fakeLog();
  const clock = fakeVirtualClock(50);
  await runCall(async () => {
    await new Promise((r) => setTimeout(r, 600)); // the mistake, exactly
  }, PAGE, { clock, log, label: 'call step "turn" (call#7)' });
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /call step "turn" \(call#7\)/);
  assert.match(log.warnings[0], /without asking the clock/);
  assert.match(log.warnings[0], /ctx\.advance/);
});

test('virtual clock: a callback that advances and THEN sleeps is reported too', async () => {
  // The shape worth catching, and the one the first version of this guard could
  // not see: it only fired when a callback spent EXACTLY zero scene time across
  // its whole run, so `advance(250); sleep(1900)` — spend a little, then wait
  // out an animation on the machine's clock — passed silently while rendering
  // none of the animation.
  const log = fakeLog();
  const clock = fakeVirtualClock(50);
  await runCall(async (page, ctx) => {
    await ctx.advance(250);
    await new Promise((r) => setTimeout(r, 600));
  }, PAGE, { clock, log, label: 'call step "turn" (call#7)' });
  assert.equal(clock.nowMs(), 250, 'the scene time it did spend is still spent');
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /call step "turn" \(call#7\)/);
  assert.match(log.warnings[0], /without asking the clock/);
});

test('virtual clock: it is the longest single stretch, not the total', async () => {
  // Four unclocked stretches adding up to well over the threshold, none of them
  // long enough to be a sleep. That is a callback doing its job through CDP,
  // and nagging about it would train the reader to ignore the warning that
  // matters.
  const log = fakeLog();
  await runCall(async (page, ctx) => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 150));
      await ctx.advance(100);
    }
  }, PAGE, { clock: fakeVirtualClock(50), log, label: 'call#0' });
  assert.deepEqual(log.warnings, []);
});

test('virtual clock: a short callback that spends no scene time is not nagged at', async () => {
  const log = fakeLog();
  await runCall(async () => { /* a couple of instant CDP calls */ }, PAGE, {
    clock: fakeVirtualClock(50), log, label: 'call#0',
  });
  assert.deepEqual(log.warnings, []);
});

test('virtual clock: a callback stuck on the page fails with the step named', async () => {
  const clock = fakeVirtualClock(50);
  await assert.rejects(
    () => runCall(
      // An awaited async page.evaluate under a paused clock looks exactly like
      // this from Node: a promise that is never going to settle.
      async () => { await new Promise(() => {}); },
      PAGE,
      { clock, log: fakeLog(), label: 'call step "seed" (call#1)', stallMs: 200 },
    ),
    (e) => {
      assert.match(e.message, /call step "seed" \(call#1\)/);
      assert.match(e.message, /never used ctx at all/);
      assert.match(e.message, /ctx\.settle/);
      return true;
    },
  );
});

test('virtual clock: advance fails when the clock stops moving under it', async () => {
  // A stopped scheduler resolves `advance` immediately and moves nothing — what
  // a dead frame pump or a detached CDP session looks like from in here. The
  // chunk loop used to walk toward a target it could never reach, at full speed,
  // forever; and because it beat as it went, the stall watchdog it is standing
  // next to was being told everything was fine. A render with no output and no
  // error is the worst failure this file has, so it must end in a message.
  const clock = fakeVirtualClock(50);
  clock.advance = async () => { await new Promise((r) => setImmediate(r)); }; // dead
  await assert.rejects(
    () => runCall(async (page, ctx) => { await ctx.advance(2_000); }, PAGE, {
      clock, log: fakeLog(), label: 'call step "turn" (call#7)',
      stallMs: 60_000, // far longer than this test: the guard must be advance's own
    }),
    (e) => {
      assert.match(e.message, /call step "turn" \(call#7\)/);
      assert.match(e.message, /clock did not move/);
      return true;
    },
  );
});

test('virtual clock: a clock that pauses briefly is not mistaken for a dead one', async () => {
  // One no-op tick is legitimate — a waiter whose deadline is already met costs
  // a round trip and no scene time. Only a clock that keeps not moving is dead.
  const clock = fakeVirtualClock(50);
  const realAdvance = clock.advance;
  let calls = 0;
  clock.advance = async (ms) => {
    calls++;
    if (calls % 3 === 0) { await new Promise((r) => setImmediate(r)); return; } // a stutter
    await realAdvance(ms);
  };
  await runCall(async (page, ctx) => { await ctx.advance(2_000); }, PAGE, {
    clock, log: fakeLog(), label: 'call#0',
  });
  assert.equal(clock.nowMs(), 2_000);
});

test('virtual clock: the watchdog does not fire while the clock is being spent', async () => {
  const clock = fakeVirtualClock(50);
  // 30 seconds of scene time, spent in real time far longer than the stall
  // window — a legitimate long hold on a slow render must never look stuck.
  await runCall(async (page, ctx) => {
    for (let i = 0; i < 12; i++) {
      await ctx.advance(2_500);
      await new Promise((r) => setTimeout(r, 30)); // the CDP round trips
    }
  }, PAGE, { clock, log: fakeLog(), label: 'call#0', stallMs: 200 });
  assert.equal(clock.nowMs(), 30_000);
});
