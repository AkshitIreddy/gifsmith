/**
 * The GIF filter chain, and the timeline's compiled form.
 *
 * Nothing here runs ffmpeg — the point is that an option the README documents
 * actually reaches the command line, which is a class of bug that produces a
 * perfectly good render of the wrong thing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gifFilter } from '../dist/encode/gif.js';
import { timeline, estimateSeconds } from '../dist/timeline/timeline.js';

test('the defaults are the size-tuned chain, unchanged', () => {
  assert.equal(
    gifFilter({ colors: 128 }),
    'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];' +
      '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  );
});

test('palette modes map to the stats_mode they claim', () => {
  assert.match(gifFilter({ colors: 256, palette: 'full' }), /stats_mode=full/);
  assert.match(gifFilter({ colors: 256, palette: 'perFrame' }), /stats_mode=single/);
});

test('a per-frame palette asks for a new palette and drops diff_mode', () => {
  const f = gifFilter({ colors: 256, palette: 'perFrame', dither: 'none' });
  assert.match(f, /paletteuse=dither=none:new=1/);
  assert.doesNotMatch(f, /diff_mode/, 'unchanged pixels must not keep colours from a dead palette');
});

test('bayer_scale is only sent for bayer', () => {
  assert.match(gifFilter({ colors: 128, dither: 'bayer', bayerScale: 1 }), /bayer_scale=1/);
  assert.doesNotMatch(gifFilter({ colors: 128, dither: 'sierra2_4a' }), /bayer_scale/);
});

test('colors is clamped to what a GIF palette can hold', () => {
  assert.match(gifFilter({ colors: 4096 }), /max_colors=256/);
  assert.match(gifFilter({ colors: 1 }), /max_colors=2/);
});

test('t.call compiles to a labelled step and keeps the callback', () => {
  const seen = [];
  const tl = timeline((t) => {
    t.call(async function turnPage() { seen.push('a'); });
    t.call(() => seen.push('b'), { name: 'seed the shelf' });
    t.call(() => seen.push('c'));
  });
  const steps = tl.steps.filter((s) => s.kind === 'call');
  assert.equal(steps.length, 3);
  assert.equal(steps[0].name, 'turnPage', 'a named function names its own step');
  assert.equal(steps[1].name, 'seed the shelf');
  assert.equal(steps[2].name, undefined, 'an anonymous arrow gets no name, not a bad one');
  assert.equal(Object.keys(tl.calls).length, 3);
  assert.equal(typeof tl.calls[steps[0].label], 'function');
});

test('a call step counts for its declared seconds, and only if declared', () => {
  // Scoring a call as zero was true while a callback had no way to spend scene
  // time. With ctx it can hold the scene for most of a deterministic render, and
  // an author checks a script's length against this number before paying for a
  // capture — so an undeclared call is worth 0 (nothing can know) and a declared
  // one is worth what it says.
  const tl = timeline((t) => {
    t.hold(1);
    t.call(async () => {}, { seconds: 2.5 });
    t.call(async () => {});
  });
  assert.equal(estimateSeconds(tl.steps), 3.5);
  const calls = tl.steps.filter((s) => s.kind === 'call');
  assert.equal(calls[0].seconds, 2.5);
  assert.equal(calls[1].seconds, undefined, 'not invented');
});

test('a declared call duration survives a parallel branch', () => {
  const tl = timeline((t) => {
    t.parallel(
      (b) => b.call(async () => {}, { seconds: 3 }),
      (b) => b.hold(1),
    );
  });
  assert.equal(estimateSeconds(tl.steps), 3);
});

test('estimateSeconds still takes the longest branch of a parallel', () => {
  const tl = timeline((t) => {
    t.hold(1);
    t.parallel(
      (b) => b.hold(2),
      (b) => b.hold(0.5),
    );
    t.type('.x', 'abcd', { delayMs: 100 });
  });
  assert.equal(estimateSeconds(tl.steps), 1 + 2 + 0.4);
});
