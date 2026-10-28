import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../../lib/sync-engine.mjs';
import { createSyncStore } from '../../lib/sync-state.mjs';

test('syncProduct syncs a product in mock mode', async () => {
  const store = createSyncStore();
  const engine = createSyncEngine({ store, mode: 'mock' });
  const product = { cgiId: 'test:1', prodDes: 'Test Product', price: { value: 1000, state: 'public' } };
  const result = await engine.syncProduct(product);
  assert.equal(result.cgiId, 'test:1');
  assert.ok(result.overall);
  assert.equal(result.targets.erp.status, 'success');
  assert.equal(result.targets.naver.status, 'success');
});

test('syncProduct skips unchanged product on second call', async () => {
  const store = createSyncStore();
  const engine = createSyncEngine({ store, mode: 'mock' });
  const product = { cgiId: 'test:1', prodDes: 'Test Product', price: { value: 1000, state: 'public' } };
  await engine.syncProduct(product);
  const result2 = await engine.syncProduct(product);
  assert.equal(result2.targets.erp.status, 'skipped');
  assert.equal(result2.targets.naver.status, 'skipped');
});

test('syncProduct re-syncs when product changes', async () => {
  const store = createSyncStore();
  const engine = createSyncEngine({ store, mode: 'mock' });
  const product1 = { cgiId: 'test:1', prodDes: 'Product V1', price: { value: 1000, state: 'public' } };
  await engine.syncProduct(product1);
  const product2 = { cgiId: 'test:1', prodDes: 'Product V2', price: { value: 2000, state: 'public' } };
  const result2 = await engine.syncProduct(product2);
  assert.equal(result2.targets.erp.status, 'success');
  assert.equal(result2.targets.naver.status, 'success');
});

test('syncProduct with force re-syncs even if unchanged', async () => {
  const store = createSyncStore();
  const engine = createSyncEngine({ store, mode: 'mock' });
  const product = { cgiId: 'test:1', prodDes: 'Test Product', price: { value: 1000, state: 'public' } };
  await engine.syncProduct(product);
  const result2 = await engine.syncProduct(product, { force: true });
  assert.equal(result2.targets.erp.status, 'success');
});

test('syncBatch processes multiple products', async () => {
  const store = createSyncStore();
  const engine = createSyncEngine({ store, mode: 'mock' });
  const products = [
    { cgiId: 'test:1', prodDes: 'P1', price: { value: 1000, state: 'public' } },
    { cgiId: 'test:2', prodDes: 'P2', price: { value: 2000, state: 'public' } },
  ];
  const result = await engine.syncBatch(products);
  assert.equal(result.total, 2);
  assert.equal(result.succeeded, 2);
});

test('syncProduct respects concurrency lock', async () => {
  const store = createSyncStore();
  const state = (await import('../../lib/sync-state.mjs')).createSyncState('test:1');
  store.set('test:1', state);
  // Manually lock
  state.locked = true;
  state.lockedBy = 'other';
  const engine = createSyncEngine({ store, mode: 'mock' });
  const product = { cgiId: 'test:1', prodDes: 'Test', price: { value: 1000, state: 'public' } };
  const result = await engine.syncProduct(product);
  assert.equal(result.status, 'locked');
});

test('status returns summary', () => {
  const store = createSyncStore();
  const engine = createSyncEngine({ store, mode: 'mock' });
  const s = engine.status();
  assert.equal(s.total, 0);
  assert.equal(s.fullySynced, 0);
});

test('engine stats track processed count', async () => {
  const store = createSyncStore();
  const engine = createSyncEngine({ store, mode: 'mock' });
  const product = { cgiId: 'test:1', prodDes: 'Test', price: { value: 1000, state: 'public' } };
  await engine.syncProduct(product);
  assert.equal(engine.stats.processed, 1);
  assert.equal(engine.stats.succeeded, 1);
});
