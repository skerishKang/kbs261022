import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChangeHash, detectChanges, detectBatchChanges, extractSyncFields, SYNC_RELEVANT_FIELDS } from '../../lib/change-detect.mjs';

test('computeChangeHash is deterministic', () => {
  const record = { prodDes: 'Test Product', price: { value: 1000, state: 'public' }, stockQty: 5 };
  const h1 = computeChangeHash(record);
  const h2 = computeChangeHash(record);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test('computeChangeHash changes when relevant field changes', () => {
  const r1 = { prodDes: 'Product A', price: { value: 1000, state: 'public' } };
  const r2 = { prodDes: 'Product B', price: { value: 1000, state: 'public' } };
  assert.notEqual(computeChangeHash(r1), computeChangeHash(r2));
});

test('computeChangeHash ignores non-relevant fields', () => {
  const r1 = { prodDes: 'Product', price: { value: 1000, state: 'public' }, lastSyncedAt: '2026-01-01' };
  const r2 = { prodDes: 'Product', price: { value: 1000, state: 'public' }, lastSyncedAt: '2026-02-02' };
  assert.equal(computeChangeHash(r1), computeChangeHash(r2));
});

test('detectChanges reports no change for identical records', () => {
  const record = { prodDes: 'Product', price: { value: 1000, state: 'public' } };
  const result = detectChanges(record, { ...record });
  assert.equal(result.changed, false);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.modified, []);
});

test('detectChanges reports modified fields', () => {
  const before = { prodDes: 'Product', price: { value: 1000, state: 'public' } };
  const after = { prodDes: 'Product', price: { value: 2000, state: 'public' } };
  const result = detectChanges(before, after);
  assert.equal(result.changed, true);
  assert.ok(result.modified.includes('price'));
});

test('detectChanges reports added fields', () => {
  const before = { prodDes: 'Product' };
  const after = { prodDes: 'Product', barCode: '12345' };
  const result = detectChanges(before, after);
  assert.equal(result.changed, true);
  assert.ok(result.added.includes('barCode'));
});

test('detectChanges reports removed fields', () => {
  const before = { prodDes: 'Product', barCode: '12345' };
  const after = { prodDes: 'Product' };
  const result = detectChanges(before, after);
  assert.equal(result.changed, true);
  assert.ok(result.removed.includes('barCode'));
});

test('detectChanges handles null before (new product)', () => {
  const after = { prodDes: 'New Product', price: { value: 1000, state: 'public' } };
  const result = detectChanges(null, after);
  assert.equal(result.changed, true);
  assert.equal(result.hashBefore, null);
  assert.ok(result.hashAfter);
});

test('detectBatchChanges classifies changed/unchanged/new', () => {
  const prev = new Map();
  const r1 = { cgiId: 'a:1', prodDes: 'P1' };
  const r2 = { cgiId: 'a:2', prodDes: 'P2' };
  prev.set('a:1', computeChangeHash(r1));
  prev.set('a:3', computeChangeHash({ cgiId: 'a:3', prodDes: 'P3' }));

  const current = [
    { cgiId: 'a:1', prodDes: 'P1' },       // unchanged
    { cgiId: 'a:2', prodDes: 'P2-changed' }, // changed (was not in prev, so new)
    { cgiId: 'a:4', prodDes: 'P4' },         // new
  ];
  // a:2 is in current but not in prev -> new
  // a:3 is in prev but not in current -> not reported (only current records checked)
  const result = detectBatchChanges(prev, current);
  assert.equal(result.unchanged.length, 1);
  assert.equal(result.new.length, 2); // a:2 and a:4
  assert.equal(result.changed.length, 0);
});

test('extractSyncFields only includes sync-relevant fields', () => {
  const record = { prodDes: 'P', price: { value: 1 }, internalNote: 'secret', lastSyncedAt: '2026-01-01' };
  const fields = extractSyncFields(record);
  assert.ok(fields.prodDes);
  assert.ok(fields.price);
  assert.ok(!fields.internalNote);
  assert.ok(!fields.lastSyncedAt);
});

test('SYNC_RELEVANT_FIELDS is non-empty', () => {
  assert.ok(SYNC_RELEVANT_FIELDS.length > 0);
});
