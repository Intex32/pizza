import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glyphBucket, glyphCount } from '../client/src/glyphs.ts';

test('a single emoji counts as one, whatever its UTF-16 length', () => {
  assert.equal(glyphCount('🍕'), 1);
  assert.equal('🍕'.length, 2, 'guard: the naive .length really is wrong here');
  assert.equal(glyphCount('🧀'), 1);
  assert.equal(glyphCount('🫑'), 1);
});

test('a variation selector does not make a second glyph', () => {
  // 🌶️ is U+1F336 U+FE0F. The starter menu ships this one, so it is not hypothetical.
  assert.equal(glyphCount('🌶️'), 1);
  assert.equal([...'🌶️'].length, 2, 'guard: spreading code points really is wrong here');
});

test('a ZWJ sequence is one person, not three code points', () => {
  assert.equal(glyphCount('🧑‍🍳'), 1);
  assert.equal([...'🧑‍🍳'].length, 3, 'guard: spreading code points really is wrong here');
  assert.equal(glyphCount('👨‍👩‍👧‍👦'), 1);
});

test('a skin tone modifier stays attached to its glyph', () => {
  assert.equal(glyphCount('👍🏽'), 1);
});

test('two emoji count as two - the case the whole fix exists for', () => {
  assert.equal(glyphCount('🍕🌿'), 2);
  assert.equal(glyphCount('🫑🌿'), 2);
  assert.equal(glyphCount('🍕🌿🧀'), 3);
});

test('empty and whitespace-only count as zero rather than throwing', () => {
  assert.equal(glyphCount(''), 0);
  assert.equal(glyphCount('   '), 0);
});

test('surrounding whitespace is not counted as a glyph', () => {
  assert.equal(glyphCount(' 🍕 '), 1);
});

test('the bucket clamps at three, because the stylesheet stops there', () => {
  assert.equal(glyphBucket('🍕'), 1);
  assert.equal(glyphBucket('🍕🌿'), 2);
  assert.equal(glyphBucket('🍕🌿🧀'), 3);
  assert.equal(glyphBucket('🍕🌿🧀🫑🍄'), 3);
});
