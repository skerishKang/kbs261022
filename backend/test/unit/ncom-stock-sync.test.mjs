// 재고 동기화 계약 단위 테스트 — ncom-stock-sync.mjs(8단계 지시 §6).
// 전송 수준(수정 요청·재조회·쓰기 생략)은 e2e/ncom-stock-sync.test.mjs가 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { planStockSync, stockSyncLedgerEntry, STOCK_SYNC_ACTIONS } from '../../lib/ncom-stock-sync.mjs';

const remote = (overrides = {}) => ({ exists: true, originProductNo: 13777135790, statusType: 'SALE', stockQuantity: 3, displayStatusType: 'ON', ...overrides });
const supplier = (overrides = {}) => ({ observedAt: '2026-10-29T11:00:00Z', onSale: true, stockQuantity: 3, ...overrides });

test('identical quantity and state is a no-op — no write is planned', () => {
  const plan = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: supplier(), remote: remote() });
  assert.equal(plan.action, 'noop');
  assert.equal(plan.modify, null);
  assert.equal(plan.changes.changed, false);
});

test('supplier sold out plans the measured transition: stock 0 modify, server saves OUTOFSTOCK', () => {
  const plan = planStockSync({ sellerManagementCode: 'samamusic:1978', supplier: supplier({ onSale: false, stockQuantity: 0 }), remote: remote({ stockQuantity: 3 }) });
  assert.equal(plan.action, 'sold_out_transition');
  assert.equal(plan.modify.statusType, 'SALE', '수정 statusType은 SALE만(C12) — OUTOFSTOCK은 서버 결과 상태다');
  assert.equal(plan.modify.stockQuantity, 0);
  assert.equal(plan.verify.statusType, 'OUTOFSTOCK');
});

test('restock plans quantity sync with statusType SALE', () => {
  const plan = planStockSync({ sellerManagementCode: 'samamusic:1990', supplier: supplier({ onSale: true, stockQuantity: 5 }), remote: remote({ statusType: 'OUTOFSTOCK', stockQuantity: 0 }) });
  assert.equal(plan.action, 'restock');
  assert.equal(plan.modify.statusType, 'SALE');
  assert.equal(plan.modify.stockQuantity, 5);
});

test('a quantity change without a state change plans quantity sync only', () => {
  const plan = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: supplier({ onSale: true, stockQuantity: 9 }), remote: remote({ stockQuantity: 3 }) });
  assert.equal(plan.action, 'sync_quantity');
  assert.equal(plan.modify.stockQuantity, 9);
  assert.equal(plan.changes.modified.includes('stockQty'), true);
});

test('a supplier quantity that is not published blocks the write — known quantities are never overwritten with the floor', () => {
  const sameState = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: supplier({ onSale: true, stockQuantity: null }), remote: remote({ stockQuantity: 1 }) });
  assert.equal(sameState.action, 'blocked');
  assert.equal(sameState.reason, 'supplier_quantity_unpublished', '수량 미공개 순수 동기화는 알려진 수량을 하한 1로 덮어쓰지 않는다(E25)');
  const differentQty = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: supplier({ onSale: true, stockQuantity: null }), remote: remote({ stockQuantity: 8 }) });
  assert.equal(differentQty.action, 'blocked');
  assert.equal(differentQty.reason, 'supplier_quantity_unpublished', '수량이 달라도 출처가 없으면 쓰지 않는다');
  const restock = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: supplier({ onSale: true, stockQuantity: null }), remote: remote({ stockQuantity: 0, statusType: 'OUTOFSTOCK' }) });
  assert.equal(restock.action, 'restock', '상태 전환(재입고)은 실측된 변경 — 하한 1(C10 계열)로 수행하고 출처를 기록한다');
  assert.equal(restock.modify.stockQuantity, 1);
  assert.equal(restock.stock_source.includes('fallback'), true);
});

test('a fractional or zero supplier quantity floors to at least 1 while on sale', () => {
  const plan = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: supplier({ onSale: true, stockQuantity: 2.7 }), remote: remote({ stockQuantity: 9 }) });
  assert.equal(plan.modify.stockQuantity, 2);
  const zero = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: supplier({ onSale: true, stockQuantity: 0 }), remote: remote({ stockQuantity: 9 }) });
  assert.equal(zero.action, 'blocked', '판매중인데 수량 0 표기는 판독 불가 — 하한으로 덮어쓰지 않는다(E25)');
  assert.equal(zero.reason, 'supplier_quantity_unpublished');
});

test('unreadable supplier observation is blocked — no invented quantity', () => {
  const plan = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: null, remote: remote() });
  assert.equal(plan.action, 'blocked');
  assert.equal(plan.reason, 'supplier_unreadable');
  const partial = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: { observedAt: '2026-10-29T11:00:00Z' }, remote: remote() });
  assert.equal(partial.reason, 'supplier_unreadable');
});

test('a failed origin lookup is blocked and never written', () => {
  const plan = planStockSync({ sellerManagementCode: 'samamusic:1048', supplier: supplier(), remote: { exists: false, originProductNo: null } });
  assert.equal(plan.action, 'blocked');
  assert.equal(plan.reason, 'remote_not_found');
});

test('a missing seller code is blocked before anything else', () => {
  const plan = planStockSync({ sellerManagementCode: '', supplier: supplier(), remote: remote() });
  assert.equal(plan.reason, 'seller_code_missing');
});

test('the ledger entry carries before/after and the modify body for the audit trail', () => {
  const plan = planStockSync({ sellerManagementCode: 'samamusic:1978', supplier: supplier({ onSale: false, stockQuantity: 0 }), remote: remote({ stockQuantity: 3 }) });
  const entry = stockSyncLedgerEntry({ plan, verify: { statusType: 'OUTOFSTOCK', stockQuantity: 0 }, synced_at: '2026-10-29T12:00:00Z' });
  assert.equal(entry.kind, 'cgi-ncom-stock-sync');
  assert.equal(entry.before.stockQty, 3);
  assert.equal(entry.after.stockQty, 0);
  assert.equal(entry.modify_body.stockQuantity, 0);
  assert.equal(entry.verify.statusType, 'OUTOFSTOCK');
  assert.equal(stockSyncLedgerEntry({ plan: { action: 'blocked' } }), null);
});

test('actions stay within the frozen contract set', () => {
  assert.deepEqual([...Object.values(STOCK_SYNC_ACTIONS)], ['noop', 'sync_quantity', 'sold_out_transition', 'restock', 'blocked']);
});
