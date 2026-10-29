// 재고 동기화 계약(순수 판단 함수) — 등록된 상품의 공급처 재고 관측값과 원상품 현재
// 상태를 비교해 '수정 API를 보낼지, 무엇을 보낼지'를 결정한다.
//
// 기존 자산 재사용(8단계 지시 §6): 변경 감지는 change-detect.mjs의 detectChanges를
// 그대로 사용하고, 상태 전환 계약은 ncom-batch-contracts(C10~C12)를 따른다.
//   - 동일 수량·동일 상태 → 쓰기 생략(noop) — 변경 없는 상품에 PUT을 보내지 않는다.
//   - 공급처 품절 → 재고 0 수정(statusType=SALE) → 서버가 OUTOFSTOCK 저장(C11·C12).
//   - 공급처 재입고(판매중) → 재고 동기화 + SALE 유지. 수량은 공급처 표기값, 미공개면
//     등록 하한 1 계약(C10 계열) — 임의 수량 발명 금지, stock_source로 근거를 남긴다.
//   - 공급처 조회 실패·원상품 미발견 → blocked(쓰기 금지, 보고).
//   - 조인은 판매자코드 정확 일치만 허용한다(C20 — 접두어 히트는 다른 상품이다).
//
// 이 모듈은 전송하지 않는다. 실행 주체(배치 러너)가 계획을 받아 수정 API를 호출하고
// 재조회로 검증하며, 변경 전후를 실행 장부에 기록한다.

import { detectChanges } from './change-detect.mjs';
import { assertLegalBatchIntent } from './ncom-batch-contracts.mjs';

export const STOCK_SYNC_ACTIONS = Object.freeze({
  noop: 'noop',
  sync_quantity: 'sync_quantity',
  sold_out_transition: 'sold_out_transition',
  restock: 'restock',
  blocked: 'blocked',
});

/**
 * 재고 동기화 계획 산정.
 *
 * @param sellerManagementCode 정확 일치로 검증된 판매자코드(C20)
 * @param supplier             { observedAt, onSale, stockQuantity(null=미공개) } — 공급처 관측값
 * @param remote               { exists, originProductNo, statusType, stockQuantity } — 원상품 단건조회 관측값
 * @param stockQuantityFallback 수량 미공개 판매중 상품의 등록 하한(기본 1 — C10 계열)
 */
export function planStockSync({ sellerManagementCode = '', supplier = null, remote = null, stockQuantityFallback = 1 } = {}) {
  const blocked = (reason, note) => ({ action: STOCK_SYNC_ACTIONS.blocked, reason, note, sellerManagementCode, modify: null, changes: null, before: null, after: null });

  if (!String(sellerManagementCode ?? '').trim()) return blocked('seller_code_missing', '정확 일치 조인을 위한 판매자코드가 없다(C20)');
  if (!supplier || typeof supplier.onSale !== 'boolean' || !supplier.observedAt) {
    return blocked('supplier_unreadable', '공급처 관측값이 불완전하다 — 임의 수량 입력 금지, 별도 보류');
  }
  if (!remote || remote.exists !== true || remote.originProductNo == null) {
    return blocked('remote_not_found', '원상품 단건조회 실패 — 조인 실패 상품은 쓰기 없이 보고(C20)');
  }

  const before = {
    sellerManagementCode,
    stockQty: Number(remote.stockQuantity),
    availability: String(remote.statusType) === 'OUTOFSTOCK' ? 'OUT_OF_STOCK' : 'IN_STOCK',
  };
  const quantity = supplier.onSale
    ? Math.max(1, Math.floor(Number(supplier.stockQuantity) || 0) || Number(stockQuantityFallback) || 1)
    : 0;
  const stockSource = supplier.onSale
    ? (supplier.stockQuantity != null && Number(supplier.stockQuantity) > 0 ? 'supplier_label' : `fallback_${stockQuantityFallback || 1}_수량미공개`)
    : 'supplier_sold_out';
  const after = {
    sellerManagementCode,
    stockQty: quantity,
    availability: supplier.onSale ? 'IN_STOCK' : 'OUT_OF_STOCK',
  };
  const changes = detectChanges(before, after);
  const base = {
    sellerManagementCode,
    originProductNo: remote.originProductNo,
    changes,
    before,
    after,
    stock_source: stockSource,
    supplier_observed_at: supplier.observedAt,
  };

  // 수량 미공개(E25 실측): 하한 1로 알려진 수량을 덮어쓰면 구매 가능 수량을 근거 없이 축소한다 —
  // 상태 전환(재입고)이 아닌 순수 수량 판정은 쓰기를 차단하고 보고한다. noop 판정보다 먼저 평가한다.
  if (supplier.onSale === true && (supplier.stockQuantity == null || Number(supplier.stockQuantity) <= 0) && before.availability === 'IN_STOCK') {
    return blocked('supplier_quantity_unpublished', '공급처가 수량을 공개하지 않는다 — 알려진 수량을 하한 1로 덮어쓰지 않는다(E25)');
  }

  if (!changes.changed) {
    return { ...base, action: STOCK_SYNC_ACTIONS.noop, modify: null, note: '동일 수량·동일 상태 — API 쓰기 생략' };
  }
  if (supplier.onSale === false) {
    assertLegalBatchIntent({ kind: 'modify', statusType: 'SALE', stockQuantity: 0 });
    return {
      ...base,
      action: STOCK_SYNC_ACTIONS.sold_out_transition,
      modify: { statusType: 'SALE', stockQuantity: 0 },
      note: '공급처 품절 — 재고 0 수정 후 서버가 OUTOFSTOCK 저장(C11·C12). OUTOFSTOCK은 입력으로 보내지 않는다',
      verify: { statusType: 'OUTOFSTOCK', stockQuantity: 0 },
    };
  }
  // 공급처 판매중 — 재입고 또는 수량 변경
  assertLegalBatchIntent({ kind: 'modify', statusType: 'SALE', stockQuantity: quantity });
  if (before.availability === 'OUT_OF_STOCK' || Number(before.stockQty) === 0) {
    return {
      ...base,
      action: STOCK_SYNC_ACTIONS.restock,
      modify: { statusType: 'SALE', stockQuantity: quantity },
      note: '재입고 — 재고 동기화 후 SALE 유지, 전시 ON은 기존 상태 유지(변경 없음)',
      verify: { statusType: 'SALE', stockQuantity: quantity },
    };
  }
  return {
    ...base,
    action: STOCK_SYNC_ACTIONS.sync_quantity,
    modify: { statusType: 'SALE', stockQuantity: quantity },
    note: '수량 변경 동기화 — 상태 전환 없음',
    verify: { statusType: 'SALE', stockQuantity: quantity },
  };
}

/**
 * 실행 장부 행 생성(변경 전후 증적 포함). 러너가 수정·재조회 성공 후 호출한다.
 */
export function stockSyncLedgerEntry({ plan, verify = null, synced_at = new Date().toISOString() } = {}) {
  if (!plan || plan.action === STOCK_SYNC_ACTIONS.blocked) return null;
  return {
    kind: 'cgi-ncom-stock-sync',
    cgiId: plan.sellerManagementCode,
    sellerManagementCode: plan.sellerManagementCode,
    originProductNo: plan.originProductNo,
    action: plan.action,
    before: plan.before,
    after: plan.after,
    modify_body: plan.modify,
    verify: verify ?? null,
    stock_source: plan.stock_source,
    supplier_observed_at: plan.supplier_observed_at,
    synced_at,
    mode: 'live',
  };
}
