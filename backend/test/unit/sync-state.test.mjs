import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncState, acquireLock, releaseLock, updateTargetStatus,
  needsSync, isFullySynced, overallStatus, retryableTargets,
  resetTargetForRetry, serializeState, deserializeState, createSyncStore,
  SYNC_TARGETS, SYNC_STATES,
} from '../../lib/sync-state.mjs';

test('createSyncState initializes both targets as pending', () => {
  const state = createSyncState('cgi:1', 'hash123');
  assert.equal(state.cgiId, 'cgi:1');
  assert.equal(state.changeHash, 'hash123');
  assert.equal(state.targets.erp.status, SYNC_STATES.PENDING);
  assert.equal(state.targets.naver.status, SYNC_STATES.PENDING);
  assert.equal(state.locked, false);
});

test('acquireLock and releaseLock work', () => {
  const state = createSyncState('cgi:1');
  assert.equal(acquireLock(state, 'worker-1'), true);
  assert.equal(state.locked, true);
  assert.equal(state.lockedBy, 'worker-1');
  assert.equal(acquireLock(state, 'worker-2'), false); // already locked
  releaseLock(state);
  assert.equal(state.locked, false);
  assert.equal(acquireLock(state, 'worker-2'), true); // now available
});

test('updateTargetStatus tracks success', () => {
  const state = createSyncState('cgi:1');
  updateTargetStatus(state, 'erp', SYNC_STATES.SUCCESS);
  assert.equal(state.targets.erp.status, SYNC_STATES.SUCCESS);
  assert.ok(state.targets.erp.lastSuccessAt);
  assert.equal(state.targets.erp.lastError, null);
  assert.equal(state.targets.erp.transmitted, true);
});

test('updateTargetStatus tracks failure with error', () => {
  const state = createSyncState('cgi:1');
  updateTargetStatus(state, 'naver', SYNC_STATES.FAILED, { error: 'timeout' });
  assert.equal(state.targets.naver.status, SYNC_STATES.FAILED);
  assert.equal(state.targets.naver.lastError, 'timeout');
  assert.equal(state.targets.naver.retryCount, 1);
});

test('needsSync returns true for pending/failed/retry_pending', () => {
  const state = createSyncState('cgi:1', 'hash1');
  assert.equal(needsSync(state, 'erp', 'hash1'), true); // pending
  updateTargetStatus(state, 'erp', SYNC_STATES.SUCCESS);
  assert.equal(needsSync(state, 'erp', 'hash1'), false); // success + same hash
  assert.equal(needsSync(state, 'erp', 'hash2'), true); // success but hash changed
});

test('isFullySynced requires all targets success', () => {
  const state = createSyncState('cgi:1');
  assert.equal(isFullySynced(state), false);
  updateTargetStatus(state, 'erp', SYNC_STATES.SUCCESS);
  assert.equal(isFullySynced(state), false);
  updateTargetStatus(state, 'naver', SYNC_STATES.SUCCESS);
  assert.equal(isFullySynced(state), true);
});

test('overallStatus aggregates correctly', () => {
  const state = createSyncState('cgi:1');
  assert.equal(overallStatus(state), SYNC_STATES.PENDING);
  updateTargetStatus(state, 'erp', SYNC_STATES.SUCCESS);
  updateTargetStatus(state, 'naver', SYNC_STATES.FAILED, { error: 'err' });
  assert.equal(overallStatus(state), SYNC_STATES.FAILED);
});

test('retryableTargets returns failed/retry_pending targets', () => {
  const state = createSyncState('cgi:1');
  updateTargetStatus(state, 'erp', SYNC_STATES.FAILED, { error: 'err' });
  updateTargetStatus(state, 'naver', SYNC_STATES.SUCCESS);
  const retryable = retryableTargets(state);
  assert.deepEqual(retryable, ['erp']);
});

test('resetTargetForRetry sets status to retry_pending', () => {
  const state = createSyncState('cgi:1');
  updateTargetStatus(state, 'erp', SYNC_STATES.FAILED, { error: 'err' });
  resetTargetForRetry(state, 'erp');
  assert.equal(state.targets.erp.status, SYNC_STATES.RETRY_PENDING);
  assert.equal(state.targets.erp.transmitted, false);
});

test('serializeState and deserializeState round-trip', () => {
  const state = createSyncState('cgi:1', 'hash123');
  updateTargetStatus(state, 'erp', SYNC_STATES.SUCCESS);
  const serialized = serializeState(state);
  const deserialized = deserializeState(serialized);
  assert.equal(deserialized.cgiId, 'cgi:1');
  assert.equal(deserialized.targets.erp.status, SYNC_STATES.SUCCESS);
});

test('createSyncStore basic operations', () => {
  const store = createSyncStore();
  assert.equal(store.size(), 0);
  const state = createSyncState('cgi:1');
  store.set('cgi:1', state);
  assert.equal(store.size(), 1);
  assert.equal(store.has('cgi:1'), true);
  assert.equal(store.get('cgi:1').cgiId, 'cgi:1');
  assert.equal(store.get('nonexistent'), null);
  store.delete('cgi:1');
  assert.equal(store.size(), 0);
});

test('SYNC_TARGETS includes erp and naver', () => {
  assert.ok(SYNC_TARGETS.includes('erp'));
  assert.ok(SYNC_TARGETS.includes('naver'));
});

test('updateTargetStatus rejects unknown target/status', () => {
  const state = createSyncState('cgi:1');
  assert.throws(() => updateTargetStatus(state, 'unknown', SYNC_STATES.SUCCESS), /unknown target/);
  assert.throws(() => updateTargetStatus(state, 'erp', 'bogus'), /unknown status/);
});
