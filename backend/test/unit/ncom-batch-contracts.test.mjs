// 배치 운영 계약 단위 테스트 — ncom-batch-contracts.mjs.
//
// CTO 지시(#130, 2026-10-29) 우선 3항목 중 '카테고리 의미 오분류 방지'의 판단부를
// 고정한다. 증적: bulk/category_mapping_bulk_20261029.json(임계치), PR #139
// (스탠드→차량용 스피커·기타→앰프·바늘→낚싯바늘 오매핑 회귀), PR #137(2,038건
// 자동확정 중 ambiguous/unresolved 는 후보 유지 계약).
//
// 크래시 복구·품절 재개의 판단부도 함께 고정한다 — 라이브 전 구간(게이트웨이 전송)
// 은 e2e/ncom-batch-recovery.test.mjs 가 mock 게이트웨이로 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertLegalBatchIntent,
  auditCategoryMapping,
  planCrashRecovery,
  planZeroStockResume,
  CATEGORY_THRESHOLDS,
  MODIFY_ALLOWED_STATUS_TYPES,
} from '../../lib/ncom-batch-contracts.mjs';

const LEAVES = [
  { id: '50001516', name: '그래픽/멀티미디어', wholeName: '디지털/가전>소프트웨어>그래픽/멀티미디어' },
  { id: '50004311', name: '일렉기타', wholeName: '악기>기타>일렉기타' },
  { id: '50007235', name: '스피커액세서리', wholeName: '악기>음향기기>스피커액세서리' },
  // 동명 리프 충돌 고정재: '거치대' 는 악기 액세서리와 차량용기기 양쪽에 존재한다.
  { id: '50007241', name: '거치대', wholeName: '악기>음향기기>악기 거치대' },
  { id: '50002740', name: '거치대', wholeName: '디지털/가전>자동차기기>차량용 거치대' },
];

test('unique-leaf mapping above threshold and margin is confirmed', () => {
  const audit = auditCategoryMapping({
    items: [{ cgiId: 'samamusic:1769', leafCategoryId: '50007235', score: 0.84 }],
    leaves: LEAVES,
  });
  assert.equal(audit.rows[0].verdict, 'confirmed');
  assert.equal(audit.counts.confirmed, 1);
});

test('a leaf id absent from the live corpus is refused, never guessed', () => {
  const audit = auditCategoryMapping({
    items: [{ cgiId: 'samamusic:100', leafCategoryId: '99999999', score: 0.99 }],
    leaves: LEAVES,
  });
  assert.equal(audit.rows[0].verdict, 'refused');
  assert.equal(audit.rows[0].reason, 'unknown_leaf');
});

test('an identical leaf name in two categories refuses confirmation without path evidence', () => {
  // 실측 오매핑 형태: '스탠드'류 어휘가 차량용 리프에도 있어 의미가 다른 리프에 붙는다.
  const audit = auditCategoryMapping({
    items: [{ cgiId: 'samamusic:1856', leafCategoryId: '50002740', score: 0.9 }],
    leaves: LEAVES,
  });
  assert.equal(audit.rows[0].verdict, 'refused');
  assert.equal(audit.rows[0].reason, 'leaf_name_collision');
  assert.deepEqual(audit.rows[0].collisionLeafIds, ['50007241']);
});

test('path evidence that pins exactly one same-name leaf re-confirms the mapping', () => {
  const audit = auditCategoryMapping({
    items: [{ cgiId: 'samamusic:1856', leafCategoryId: '50007241', score: 0.9, evidencePath: '악기>음향기기>악기 거치대' }],
    leaves: LEAVES,
  });
  assert.equal(audit.rows[0].verdict, 'confirmed');
});

test('path evidence pointing at the other same-name leaf still refuses', () => {
  const audit = auditCategoryMapping({
    items: [{ cgiId: 'samamusic:1856', leafCategoryId: '50002740', score: 0.9, evidencePath: '악기>음향기기>악기 거치대' }],
    leaves: LEAVES,
  });
  assert.equal(audit.rows[0].verdict, 'refused');
  assert.equal(audit.rows[0].reason, 'leaf_name_collision');
});

test('a score below minScore is not confirmable no matter how unique the name is', () => {
  const audit = auditCategoryMapping({
    items: [{ cgiId: 'samamusic:300', leafCategoryId: '50004311', score: 0.49 }],
    leaves: LEAVES,
  });
  assert.equal(audit.rows[0].reason, 'below_min_score');
});

test('a runner-up within the margin is ambiguous and stays unconfirmed', () => {
  const audit = auditCategoryMapping({
    items: [{ cgiId: 'samamusic:301', leafCategoryId: '50004311', score: 0.55, runnerUpScore: 0.52 }],
    leaves: LEAVES,
  });
  assert.equal(audit.rows[0].reason, 'runner_up_within_margin');
});

test('the audit reports collision groups so operators see the ambiguous names', () => {
  const audit = auditCategoryMapping({ items: [], leaves: LEAVES });
  assert.deepEqual(audit.collisions, [{ name: '거치대', leafIds: ['50007241', '50002740'] }]);
  assert.equal(audit.counts.items, 0);
});

test('thresholds stay the measured contract values', () => {
  assert.deepEqual(CATEGORY_THRESHOLDS, { minScore: 0.5, minMargin: 0.08 });
  assert.deepEqual([...MODIFY_ALLOWED_STATUS_TYPES], ['SALE', 'SUSPENSION']);
});

test('crash recovery skips ledgered items without touching the gateway', () => {
  const plan = planCrashRecovery({
    batchItems: [{ cgiId: 'samamusic:3103', sellerManagementCode: 'samamusic:3103' }],
    ledger: [{ cgiId: 'samamusic:3103', originProductNo: 13776763000 }],
    dupChecks: [],
  });
  assert.equal(plan.decisions[0].action, 'already_ledgered');
  assert.equal(plan.ledgerEntries.length, 0);
});

test('crash recovery refuses to register an item whose remote check is missing', () => {
  const plan = planCrashRecovery({
    batchItems: [{ cgiId: 'samamusic:2146', sellerManagementCode: 'samamusic:2146' }],
    ledger: [],
    dupChecks: [],
  });
  assert.equal(plan.decisions[0].action, 'dupcheck_required');
  assert.equal(plan.ledgerEntries.length, 0);
});

test('a remotely existing item is adopted into the ledger instead of re-registered', () => {
  // 4차 배치 2146 실측 재현: 등록 직후 크래시 → 장부 미기록 → 재실행 검색 히트.
  const plan = planCrashRecovery({
    batchItems: [{ cgiId: 'samamusic:2146', sellerManagementCode: 'samamusic:2146' }],
    ledger: [],
    dupChecks: [{ sellerManagementCode: 'samamusic:2146', existing: true, originProductNo: 13776759782 }],
    now: () => '2026-10-29T06:04:33.000Z',
  });
  assert.equal(plan.decisions[0].action, 'adopt_remote');
  assert.equal(plan.decisions[0].originProductNo, 13776759782);
  assert.equal(plan.ledgerEntries.length, 1);
  assert.equal(plan.ledgerEntries[0].kind, 'cgi-ncom-crash-recovery');
  assert.equal(plan.ledgerEntries[0].originProductNo, 13776759782);
  assert.equal(plan.counts.adopt_remote, 1);
});

test('a remote hit without a product number blocks the item for manual review', () => {
  const plan = planCrashRecovery({
    batchItems: [{ cgiId: 'samamusic:1', sellerManagementCode: 'samamusic:1' }],
    ledger: [],
    dupChecks: [{ sellerManagementCode: 'samamusic:1', existing: true, originProductNo: null }],
  });
  assert.equal(plan.decisions[0].action, 'adopt_unresolved');
});

test('a clean remote check is the only path that re-allows registration', () => {
  const plan = planCrashRecovery({
    batchItems: [{ cgiId: 'samamusic:2', sellerManagementCode: 'samamusic:2' }],
    ledger: [],
    dupChecks: [{ sellerManagementCode: 'samamusic:2', existing: false, originProductNo: null }],
  });
  assert.equal(plan.decisions[0].action, 'register_allowed');
});

test('zero-stock resume starts from register with stock 1, never 0', () => {
  const plan = planZeroStockResume({ remote: null });
  assert.equal(plan.action, 'register_stock_1');
  assert.equal(plan.register.stockQuantity, 1);
  assert.equal(plan.register.channelProductDisplayStatusType, 'SUSPENSION', '품절 등록 중에는 노출 창구가 없다');
});

test('an unreadable remote stock is reported, not invented', () => {
  const plan = planZeroStockResume({ remote: { exists: true, statusType: 'SALE', stockQuantity: null, displayStatusType: 'SUSPENSION' } });
  assert.equal(plan.action, 'unreadable_remote');
});

test('stock still at 1 resumes at the modify step with statusType SALE', () => {
  const plan = planZeroStockResume({ remote: { exists: true, statusType: 'SALE', stockQuantity: 1, displayStatusType: 'SUSPENSION' } });
  assert.equal(plan.action, 'modify_stock_0');
  assert.equal(plan.modify.statusType, 'SALE');
  assert.equal(plan.modify.stockQuantity, 0);
  assert.ok(!JSON.stringify(plan.modify).includes('OUTOFSTOCK'), '수정 본문 의도에 OUTOFSTOCK 입력은 없다 — 그것은 서버 결과 상태다');
});

test('stock zero and still hidden resumes at display ON', () => {
  const plan = planZeroStockResume({ remote: { exists: true, statusType: 'SALE', stockQuantity: 0, displayStatusType: 'SUSPENSION' } });
  assert.equal(plan.action, 'display_on');
});

test('stock zero and already ON is done and verifies the saved OUTOFSTOCK state', () => {
  const done = planZeroStockResume({ remote: { exists: true, statusType: 'OUTOFSTOCK', stockQuantity: 0, displayStatusType: 'ON' } });
  assert.equal(done.action, 'done');
  assert.equal(done.outOfStockSaved, true);
  const sale = planZeroStockResume({ remote: { exists: true, statusType: 'SALE', stockQuantity: 0, displayStatusType: 'ON' } });
  assert.equal(sale.action, 'done');
  assert.equal(sale.outOfStockSaved, false, '전시 ON 이어도 원상품이 OUTOFSTOCK 저장이 아니면 품절 확정 아님');
});

test('the batch intent guard rejects the measured vendor refusals', () => {
  assert.throws(() => assertLegalBatchIntent({ kind: 'register', statusType: 'SALE', stockQuantity: 0 }), (error) => error.code === 'stock_number_min');
  assert.throws(() => assertLegalBatchIntent({ kind: 'register', statusType: 'SALE', stockQuantity: null }), (error) => error.code === 'stock_number_min');
  assert.throws(() => assertLegalBatchIntent({ kind: 'modify', statusType: 'OUTOFSTOCK', stockQuantity: 0 }), (error) => error.code === 'status_type_not_allowed');
  assert.throws(() => assertLegalBatchIntent({ kind: 'patch' }), (error) => error.code === 'batch_intent_unknown');
  assert.equal(assertLegalBatchIntent({ kind: 'register', statusType: 'SALE', stockQuantity: 1 }), true);
  assert.equal(assertLegalBatchIntent({ kind: 'modify', statusType: 'SALE', stockQuantity: 0 }), true);
});
