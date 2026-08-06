/**
 * The anchor search, on synthetic thumbnails.
 *
 * `findAnchorLoop` takes an array of 32×18 gray thumbnails, which a test can
 * simply make up: a "pose" is a fill value, and two frames match exactly when
 * they hold the same pose. That is enough to pin the rule the 0.2.3 release was
 * about — lowest seam MSE, THEN longest span — which is invisible in any output
 * you would look at, and shows up only as a demo that quietly lost its tour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAnchorLoop } from '../dist/loop/anchor.js';
import { mse, THUMB_W, THUMB_H } from '../dist/loop/mse.js';

const frame = (value) => new Uint8Array(THUMB_W * THUMB_H).fill(value);

test('mse is zero for identical frames and grows with the difference', () => {
  assert.equal(mse(frame(10), frame(10)), 0);
  assert.equal(mse(frame(10), frame(20)), 100);
});

test('among equally-invisible seams the longest span wins', () => {
  // A walkthrough: 30 frames of the neutral pose, a tour through three others,
  // and a return to the neutral pose for the last 20. Every pair inside the
  // opening hold matches perfectly, so a lowest-MSE-only rule returns the
  // shortest qualifying loop and throws the tour away.
  const thumbs = [
    ...Array.from({ length: 30 }, () => frame(100)), // 0–29   home
    ...Array.from({ length: 30 }, () => frame(160)), // 30–59  elsewhere
    ...Array.from({ length: 30 }, () => frame(200)), // 60–89
    ...Array.from({ length: 30 }, () => frame(140)), // 90–119
    ...Array.from({ length: 20 }, () => frame(100)), // 120–139 home again
  ];
  const found = findAnchorLoop(thumbs, {
    anchorFrame: 10,
    frameCount: thumbs.length,
    fps: 10,
    minCycleSeconds: 1, // 10 frames — a lowest-MSE-only rule can satisfy this
  });
  assert.equal(found.seamMSE, 0, 'the seam is still perfect');
  assert.ok(found.end - found.start >= 110, `kept the tour (span ${found.end - found.start})`);
  assert.ok(found.start <= 20 && found.end >= 120, `wrapped home to home (${found.start}–${found.end})`);
});

test('minCycleSeconds is a floor on the returned span', () => {
  const thumbs = Array.from({ length: 100 }, (_, i) => frame(i < 50 ? 100 : 180));
  const found = findAnchorLoop(thumbs, {
    anchorFrame: 5,
    frameCount: thumbs.length,
    fps: 10,
    minCycleSeconds: 6,
  });
  assert.ok(found.end - found.start >= 60, `span ${found.end - found.start} >= 60`);
});

test('a short clip still returns a real, measured pair', () => {
  const thumbs = [frame(10), frame(90), frame(10)];
  const found = findAnchorLoop(thumbs, { anchorFrame: 0, frameCount: 3, fps: 10 });
  assert.ok(found.start >= 0 && found.end < 3 && found.end > found.start);
  assert.equal(found.seamMSE, mse(thumbs[found.end], thumbs[found.start]));
});
