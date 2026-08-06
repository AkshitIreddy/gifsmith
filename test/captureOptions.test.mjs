/**
 * The `capture` field, checked rather than merely normalised.
 *
 * Every case in here used to be accepted and quietly mean "screencast", because
 * the only question ever asked of the value was `mode === 'deterministic'` and
 * that question has no wrong answer. The failure it produced is the expensive
 * kind: a render that succeeds, takes as long as a screencast, and is a
 * screencast — of a demo the author asked to be rendered deterministically.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureOptions, captureProblem, stageConflict } from '../dist/capture/options.js';

test('the two real shapes are accepted, and mean the same thing', () => {
  assert.deepEqual(captureOptions(undefined), { mode: 'screencast' });
  assert.deepEqual(captureOptions('deterministic'), { mode: 'deterministic' });
  assert.deepEqual(captureOptions({ mode: 'deterministic', format: 'png' }), {
    mode: 'deterministic',
    format: 'png',
  });
  assert.equal(captureProblem({ mode: 'screencast', quality: 80 }), null);
});

test('a typo throws instead of rendering the other backend', () => {
  assert.throws(() => captureOptions('deterministc'), /capture\.mode must be/);
  assert.throws(() => captureOptions({ mode: 'deterministc' }), /deterministc/);
});

test("the CLI's valueless --capture is named as such", () => {
  assert.throws(() => captureOptions(true), /--capture needs a value/);
});

test('an object with no mode is not silently a screencast', () => {
  assert.throws(() => captureOptions({ format: 'png' }), /capture\.mode must be/);
});

test('a frame format Chromium would not recognise is refused', () => {
  // Sent verbatim to Page.captureScreenshot: a bad one stalls every frame, and
  // a stalled frame is silently the previous frame repeated.
  assert.throws(() => captureOptions({ mode: 'deterministic', format: 'jpg' }), /'jpeg' or 'png'/);
  assert.equal(captureProblem({ mode: 'screencast', format: 'png' }), null);
});

test('deterministic + stage is refused, and only that combination', () => {
  assert.match(
    stageConflict({ mode: 'deterministic' }, 'stage'),
    /does not support compose:'stage'/,
  );
  assert.equal(stageConflict({ mode: 'deterministic' }, 'overlay'), null);
  assert.equal(stageConflict({ mode: 'deterministic' }, undefined), null);
  assert.equal(stageConflict({ mode: 'screencast' }, 'stage'), null);
});
