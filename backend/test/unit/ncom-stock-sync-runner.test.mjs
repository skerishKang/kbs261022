// 재고 동기화 운영 CLI(tools/naver/ncom-stock-sync.mjs) 순수 헬퍼 단위 테스트 — 9단계 지시 §5·§6.
// 전송 수준은 e2e/ncom-stock-sync.test.mjs가 담당한다. 이 테스트는 전송하지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseSupplierPage,
  selectApplicablePlans,
  selectWritablePlans,
  isQuantitySourceConfirmed,
  buildRestoreModify,
  needsRestore,
  summarizePlans,
  summarizeApply,
  acquireLock,
  releaseLock,
} from '../../../tools/naver/ncom-stock-sync.mjs';

test('parseSupplierPage — 판매중·수량 표기 페이지는 관측 수량을 돌려준다', () => {
  const html = '<table><tr><th>재고수량</span></th><td><span class="x">14</span></td></tr></table>'.replace('</th>', '</th>');
  const html2 = '<tr><th><span>재고수량</span></th><td><span class="txt">14</span></td></tr>';
  const observed = parseSupplierPage(html2);
  assert.equal(observed.onSale, true);
  assert.equal(observed.stockQuantity, 14);
  assert.ok(html.length > 0);
});

test('parseSupplierPage — 재입고 알림 페이지는 품절(false)이고 수량 미표기는 null이다', () => {
  const soldOut = parseSupplierPage('<div>재입고 알림 신청</div>');
  assert.equal(soldOut.onSale, false);
  assert.equal(soldOut.stockQuantity, null);
  const noQty = parseSupplierPage('<div>판매중</div>');
  assert.equal(noQty.onSale, true);
  assert.equal(noQty.stockQuantity, null);
});

test('selectApplicablePlans — blocked·noop은 전송 대상에서 제외된다(E25)', () => {
  const planDoc = {
    plans: {
      a: { cgiId: 'a', plan: { action: 'sync_quantity', modify: { statusType: 'SALE', stockQuantity: 5 } } },
      b: { cgiId: 'b', plan: { action: 'noop', modify: null } },
      c: { cgiId: 'c', plan: { action: 'blocked', reason: 'supplier_quantity_unpublished', modify: null } },
      d: { cgiId: 'd', plan: { action: 'restock', modify: { statusType: 'SALE', stockQuantity: 1 } } },
      e: { cgiId: 'e', plan: { action: 'sold_out_transition', modify: { statusType: 'SALE', stockQuantity: 0 } } },
      f: { cgiId: 'f', plan: { action: 'sync_quantity', modify: null } },
    },
  };
  const ids = selectApplicablePlans(planDoc).map((r) => r.cgiId);
  assert.deepEqual(ids, ['a', 'd', 'e']);
});

test('selectWritablePlans — 출처 불명확(fallback·미기록) 계획은 쓰기 대상에서 제외한다(운영 가드)', () => {
  const planDoc = {
    plans: {
      label: { cgiId: 'label', plan: { action: 'sync_quantity', modify: { statusType: 'SALE', stockQuantity: 5 }, stock_source: 'supplier_label' } },
      sold: { cgiId: 'sold', plan: { action: 'sold_out_transition', modify: { statusType: 'SALE', stockQuantity: 0 }, stock_source: 'supplier_sold_out' } },
      fallback: { cgiId: 'fallback', plan: { action: 'restock', modify: { statusType: 'SALE', stockQuantity: 1 }, stock_source: 'fallback_1_수량미공개' } },
      legacy: { cgiId: 'legacy', plan: { action: 'sync_quantity', modify: { statusType: 'SALE', stockQuantity: 2 } } },
      noop: { cgiId: 'noop', plan: { action: 'noop', modify: null, stock_source: 'supplier_label' } },
    },
  };
  const { writable, blocked } = selectWritablePlans(planDoc);
  assert.deepEqual(writable.map((r) => r.cgiId), ['label', 'sold']);
  assert.deepEqual(blocked.map((r) => r.cgiId), ['fallback', 'legacy']);
  assert.equal(blocked.every((r) => r.reason === 'quantity_source_unconfirmed'), true);
  assert.equal(isQuantitySourceConfirmed({ stock_source: 'supplier_label' }), true);
  assert.equal(isQuantitySourceConfirmed({ stock_source: 'supplier_sold_out' }), true);
  assert.equal(isQuantitySourceConfirmed({ stock_source: 'fallback_1_수량미공개' }), false);
  assert.equal(isQuantitySourceConfirmed({}), false);
});

test('buildRestoreModify — OUTOFSTOCK before는 SALE+재고0으로 복원한다(C11·C12)', () => {
  assert.deepEqual(buildRestoreModify({ statusType: 'SALE', stockQuantity: 8 }), { statusType: 'SALE', stockQuantity: 8 });
  assert.deepEqual(buildRestoreModify({ statusType: 'OUTOFSTOCK', stockQuantity: 0 }), { statusType: 'SALE', stockQuantity: 0 });
  assert.deepEqual(buildRestoreModify(null), { statusType: 'SALE', stockQuantity: 0 });
});

test('needsRestore — verify 불일치만 원복 대상이다', () => {
  assert.equal(needsRestore({ statusType: 'SALE', stockQuantity: 5 }, { statusType: 'SALE', stockQuantity: 5 }), false);
  assert.equal(needsRestore({ statusType: 'SALE', stockQuantity: 1 }, { statusType: 'SALE', stockQuantity: 5 }), true);
  assert.equal(needsRestore({ statusType: 'OUTOFSTOCK', stockQuantity: 0 }, { statusType: 'SALE', stockQuantity: 5 }), true);
  assert.equal(needsRestore(null, { statusType: 'SALE', stockQuantity: 5 }), false);
  assert.equal(needsRestore({ statusType: 'SALE', stockQuantity: 5 }, null), false);
});

test('summarizePlans·summarizeApply — 행동·상태별 집계', () => {
  const plans = [
    { plan: { action: 'noop' } },
    { plan: { action: 'blocked', reason: 'supplier_quantity_unpublished' } },
    { plan: { action: 'restock' } },
    { plan: {} },
  ];
  assert.deepEqual(summarizePlans(plans), { total: 4, by_action: { noop: 1, blocked: 1, restock: 1, unknown: 1 } });
  const results = [{ state: 'SYNCED' }, { state: 'RESTORED' }, { state: 'FAILED_X' }];
  assert.deepEqual(summarizeApply(results), { applied: 3, by_state: { SYNCED: 1, RESTORED: 1, FAILED_X: 1 } });
});

test('단일 실행 잠금 — 신선한 잠금은 거부, stale(2h)은 자동 해제, release 후 재획득 된다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncom-lock-'));
  const lockPath = path.join(dir, '.ncom-stock-sync.lock');
  const first = await acquireLock(lockPath, { now: 1_000_000 });
  assert.equal(first.ok, true);
  const second = await acquireLock(lockPath, { now: 1_000_000 + 60_000 });
  assert.equal(second.ok, false);
  assert.match(second.reason, /fresh lock/);
  const stale = await acquireLock(lockPath, { now: 1_000_000 + 2 * 60 * 60 * 1000 + 1 });
  assert.equal(stale.ok, true);
  releaseLock(lockPath);
  const afterRelease = await acquireLock(lockPath, { now: 1_000_000 + 2 * 60 * 60 * 1000 + 2 });
  assert.equal(afterRelease.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
