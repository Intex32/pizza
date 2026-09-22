import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  PICKUP_ALPHABET,
  PICKUP_CODE_LENGTH,
  looksLikePickupCode,
  normalizePickupCode,
} from '../shared/pickupCode.ts';
import { pickupCodeFor } from '../server/pickupCode.ts';

// The pickup code is the second SILENT-failure surface in this app. A crew member typing a
// code that never matches looks like a broken feature, not a bug, so it gets tests.

const token = () => randomBytes(16).toString('base64url');

test('the alphabet is exactly 32 distinct symbols with no ambiguous glyphs', () => {
  assert.equal(PICKUP_ALPHABET.length, 32);
  assert.equal(new Set(PICKUP_ALPHABET).size, 32);
  for (const bad of ['0', 'O', '1', 'I']) {
    assert.equal(PICKUP_ALPHABET.includes(bad), false, `${bad} must not be in the alphabet`);
  }
});

test('every code is the right length and drawn only from the alphabet', () => {
  for (let i = 0; i < 5000; i += 1) {
    const code = pickupCodeFor(token());
    assert.equal(code.length, PICKUP_CODE_LENGTH);
    for (const ch of code) {
      assert.ok(PICKUP_ALPHABET.includes(ch), `${code} contains ${ch}, which is not in the alphabet`);
    }
  }
});

// THIS IS THE LOAD-BEARING TEST. The code is printed on tickets guests have saved as PDFs.
// If a refactor of the bit extraction changes the mapping, every one of those tickets
// silently stops matching. This must fail loudly rather than drift.
test('the derivation is pinned - changing it orphans every saved ticket', () => {
  assert.equal(pickupCodeFor('AAAAAAAAAAAAAAAAAAAAAA'), 'KBFXQ');
  assert.equal(pickupCodeFor('pizza-night-fixed-token'), 'RHY6Q');
  assert.equal(pickupCodeFor(''), 'WGSEA');
});

test('the same token always gives the same code', () => {
  for (let i = 0; i < 200; i += 1) {
    const t = token();
    assert.equal(pickupCodeFor(t), pickupCodeFor(t));
  }
});

// Catches "the encoder is silently only using 20 bits", which would look fine by eye and
// collide 32x more often than the design assumes.
test('all 32 symbols are reachable in every position', () => {
  const seen = Array.from({ length: PICKUP_CODE_LENGTH }, () => new Set<string>());
  for (let i = 0; i < 20000; i += 1) {
    const code = pickupCodeFor(token());
    for (let p = 0; p < PICKUP_CODE_LENGTH; p += 1) seen[p].add(code[p]);
  }
  for (let p = 0; p < PICKUP_CODE_LENGTH; p += 1) {
    assert.equal(seen[p].size, 32, `position ${p} only reached ${seen[p].size} of 32 symbols`);
  }
});

test('collision rate matches the birthday prediction for 25 bits', () => {
  const n = 20000;
  const codes = new Set<string>();
  for (let i = 0; i < n; i += 1) codes.add(pickupCodeFor(token()));
  const collisions = n - codes.size;
  // Expected ~ n^2 / (2 * 32^5) ~= 5.96. Anything near 0 or above 30 means the output
  // space is not 25 bits.
  assert.ok(collisions < 30, `${collisions} collisions in ${n} - output space is too small`);
});

test('normalize strips the noise a crew member will type', () => {
  assert.equal(normalizePickupCode('k7m-2q'), 'K7M2Q');
  assert.equal(normalizePickupCode(' k7 m2q '), 'K7M2Q');
  assert.equal(normalizePickupCode('#K7M2Q'), 'K7M2Q');
});

test('looksLikePickupCode separates a code from a name', () => {
  assert.equal(looksLikePickupCode('K7M2Q'), true);
  assert.equal(looksLikePickupCode('k7m2q'), true);
  assert.equal(looksLikePickupCode('Anna'), false);
  assert.equal(looksLikePickupCode('K7M2'), false, 'too short');
  assert.equal(looksLikePickupCode('K7M2QQ'), false, 'too long');
  // The whole point of the alphabet: these must be rejected, not silently accepted.
  assert.equal(looksLikePickupCode('K7M2O'), false, 'O is not in the alphabet');
  assert.equal(looksLikePickupCode('K7M21'), false, '1 is not in the alphabet');
});
