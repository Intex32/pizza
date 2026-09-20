import assert from 'node:assert/strict';
import test from 'node:test';
import { STATUS, STATUS_ORDER, canTransition, isStatus } from '../shared/status.ts';

// The status guard is the one place in this app where a bug is SILENT - everything else you
// notice by looking at a tablet. So this is the one thing with tests.

test('every adjacent pair moves forward', () => {
  for (let i = 0; i < STATUS_ORDER.length - 1; i += 1) {
    assert.equal(canTransition(STATUS_ORDER[i], STATUS_ORDER[i + 1]), true);
  }
});

test('every adjacent pair moves backward - crew mis-tap recovery', () => {
  for (let i = STATUS_ORDER.length - 1; i > 0; i -= 1) {
    assert.equal(canTransition(STATUS_ORDER[i], STATUS_ORDER[i - 1]), true);
  }
});

test('a status cannot transition to itself', () => {
  for (const s of STATUS_ORDER) {
    assert.equal(canTransition(s, s), false);
  }
});

test('two-step jumps are rejected', () => {
  assert.equal(canTransition(STATUS.ORDERED, STATUS.WAITING_FOR_OVEN), false);
  assert.equal(canTransition(STATUS.IN_PREPARATION, STATUS.BAKING), false);
  assert.equal(canTransition(STATUS.BAKING, STATUS.PICKED_UP), false);
  assert.equal(canTransition(STATUS.READY, STATUS.WAITING_FOR_OVEN), false);
});

test('the oven cannot be skipped in either direction', () => {
  assert.equal(canTransition(STATUS.WAITING_FOR_OVEN, STATUS.READY), false);
  assert.equal(canTransition(STATUS.READY, STATUS.WAITING_FOR_OVEN), false);
});

test('ORDERED has no predecessor and PICKED_UP has no successor', () => {
  for (const s of STATUS_ORDER) {
    if (s !== STATUS.IN_PREPARATION) assert.equal(canTransition(s, STATUS.ORDERED), false);
  }
  for (const s of STATUS_ORDER) {
    if (s !== STATUS.READY) assert.equal(canTransition(STATUS.PICKED_UP, s), false);
  }
});

test('garbage is rejected rather than coerced', () => {
  const junk = ['', 'ordered', 'BAKING ', 'DONE', 'CANCELLED', '0', 'undefined'];
  for (const j of junk) {
    assert.equal(isStatus(j), false, `${j} should not be a status`);
    assert.equal(canTransition(j as never, STATUS.ORDERED), false);
    assert.equal(canTransition(STATUS.ORDERED, j as never), false);
  }
});

test('isStatus accepts exactly the six real statuses', () => {
  assert.equal(STATUS_ORDER.length, 6);
  for (const s of STATUS_ORDER) assert.equal(isStatus(s), true);
});

test('cancelled is a flag, never a status', () => {
  // If this ever fails someone added CANCELLED to the enum, which would break the
  // "the pipeline is a straight line" assumption that canTransition relies on.
  assert.equal((STATUS_ORDER as string[]).includes('CANCELLED'), false);
});
