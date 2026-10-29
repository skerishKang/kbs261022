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
  classifySellerCodeHits,
  planCrashRecovery,
  planZeroStockResume,
  resolveOriginArea,
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

test('origin resolution: single-country text maps to the verified detailed code', () => {
  const r = resolveOriginArea({ originText: '유럽 독일', resolveCode: () => '0201005' });
  assert.equal(r.ok, true);
  assert.equal(r.originAreaCode, '0201005');
  assert.equal(r.content, null);
  assert.equal(r.mode, 'verified_code');
});

test('origin resolution: a multi-candidate supplier text uses 04 + the verbatim text, never one guessed country', () => {
  // 배치5 실측: '아시아 중국 또는 멕시코'(SHURE 마이크) — 문서상 04(기타-직접 입력)+content 경로.
  const r = resolveOriginArea({ originText: '아시아 중국 또는 멕시코', resolveCode: () => '0200037' });
  assert.equal(r.ok, true);
  assert.equal(r.originAreaCode, '04');
  assert.equal(r.content, '아시아 중국 또는 멕시코');
  assert.equal(r.plural, false, 'plural 의 문서 의미는 옵션 묶음 원산지 혼재이므로 단일 상품 불확정 원산지에 쓰지 않는다');
  assert.equal(r.mode, 'direct_input_content');
});

test('origin resolution: unreadable or unmatched text is reported, not invented', () => {
  assert.equal(resolveOriginArea({ originText: '' }).ok, false);
  assert.equal(resolveOriginArea({ originText: '미확인', resolveCode: () => null }).reason, 'origin_code_unresolved');
  assert.equal(resolveOriginArea({ originText: '유럽 독일' }).ok, false, 'resolveCode 없이는 코드를 만들지 않는다');
});

test('seller-code hits: prefix-only matches are not duplicates and must not block registration', () => {
  // 배치6 실측(E23): 'samamusic:27' 검색이 2792·2788 등 접두어 히트 6건을 돌려주고,
  // 응답에는 판매자코드가 없다 — 원상품 GET으로 검증한 코드 목록만 근거다.
  const r = classifySellerCodeHits({ hitCodes: ['samamusic:2798', 'samamusic:2722', 'samamusic:2786'], sellerManagementCode: 'samamusic:27' });
  assert.equal(r.adoptable, false);
  assert.equal(r.prefixOnly, true);
  assert.equal(r.prefixCount, 3);
});

test('seller-code hits: an exact match is the only adoptable duplicate evidence', () => {
  const r = classifySellerCodeHits({ hitCodes: ['samamusic:2792', 'samamusic:27'], sellerManagementCode: 'samamusic:27' });
  assert.equal(r.adoptable, true);
  assert.equal(r.exactCount, 1);
  const none = classifySellerCodeHits({ hitCodes: [], sellerManagementCode: 'samamusic:27' });
  assert.equal(none.adoptable, false);
  assert.equal(none.prefixOnly, false);
});

test('origin resolution: trailing punctuation and the country-less 해외 mark are handled per E24', () => {
  const dot = resolveOriginArea({ originText: '아시아 중국 .', resolveCode: () => '0200037' });
  assert.equal(dot.ok, true);
  assert.equal(dot.originAreaCode, '0200037', '표기 꼬리 마침표는 제거하고 상세 코드로 매칭한다');
  const overseas = resolveOriginArea({ originText: '해외', resolveCode: () => '02' });
  assert.equal(overseas.ok, false);
  assert.equal(overseas.reason, 'origin_country_unspecified', '국가 미표기 원산지는 02 단독 선언(거부 실측) 대신 제외 대상이다');
  const comma = resolveOriginArea({ originText: '아메리카 멕시코 , 중국', resolveCode: () => '0200037' });
  assert.equal(comma.ok, true);
  assert.equal(comma.originAreaCode, '04');
  assert.equal(comma.content, '아메리카 멕시코 , 중국', '쉼표 나열도 복수 표기다 — 한쪽 국가만 선언하지 않는다');
});

test('origin resolution: the supplier 국내 declaration is the code-table 국산 (E30)', () => {
  // 2026-10-30 라이브 실측: GET /v1/product-origin-areas 535코드 중 '00'의 이름이 정확히
  // '국산'이고 이름이 '국내'인 코드는 없다 — 배치9~11의 '국내 코드 부재' 제외는 어휘 불일치였다.
  // 정규화는 정확 일치에만 적용한다('국내산' 같은 다른 표기는 리졸버가 판단한다).
  const domestic = resolveOriginArea({ originText: '국내', resolveCode: (t) => (String(t).endsWith('국산') ? '00' : null) });
  assert.equal(domestic.ok, true);
  assert.equal(domestic.originAreaCode, '00');
  assert.equal(domestic.mode, 'verified_code');
  assert.equal(domestic.content, null, '검증 코드 경로는 04+content와 달리 content를 만들지 않는다');
  const guksan = resolveOriginArea({ originText: '국산', resolveCode: (t) => (String(t).endsWith('국산') ? '00' : null) });
  assert.equal(guksan.ok, true);
  assert.equal(guksan.originAreaCode, '00', '공급처가 직접 국산으로 표기해도 같은 코드다');
  const unmatched = resolveOriginArea({ originText: '국내', resolveCode: () => null });
  assert.equal(unmatched.ok, false, '리졸버가 코드를 못 찾으면 국내라도 값을 만들지 않는다');
});

test('origin resolution: country tokens behind qualifiers and the vague 외 suffix (E31)', () => {
  // 배치13 실측: '아메리카 미국 애리조나'(3013)·'아시아 중국 OEM'(2893) — 국가 뒤 한정사.
  // 뒤에서 안쪽으로 걸어 국가 토큰을 찾는다(선언 국가는 변하지 않는다).
  const arizona = resolveOriginArea({ originText: '아메리카 미국 애리조나', resolveCode: (t) => (String(t).endsWith('미국') ? '0204000' : null) });
  assert.equal(arizona.ok, true);
  assert.equal(arizona.originAreaCode, '0204000');
  assert.equal(arizona.mode, 'verified_code');
  const oem = resolveOriginArea({ originText: '아시아 중국 OEM', resolveCode: (t) => (String(t).endsWith('중국') ? '0200037' : null) });
  assert.equal(oem.ok, true);
  assert.equal(oem.originAreaCode, '0200037', 'OEM은 생산 방식 한정사 — 국가 선언(중국)은 그대로다');
  // '… 외'는 미열거 복수 후보 신호 — 04+공급처 표기 원문(C18 경로).
  const vague = resolveOriginArea({ originText: '아메리카 미국 외', resolveCode: (t) => (String(t).endsWith('미국') ? '0204000' : null) });
  assert.equal(vague.ok, true);
  assert.equal(vague.originAreaCode, '04');
  assert.equal(vague.content, '아메리카 미국 외', '미열거 복수 표기는 한 국가로 단정하지 않는다');
  assert.equal(vague.mode, 'direct_input_content');
  const unresolved = resolveOriginArea({ originText: '아시아 미지국가', resolveCode: () => null });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.reason, 'origin_code_unresolved');
});

test('the batch intent guard rejects the measured vendor refusals', () => {
  assert.throws(() => assertLegalBatchIntent({ kind: 'register', statusType: 'SALE', stockQuantity: 0 }), (error) => error.code === 'stock_number_min');
  assert.throws(() => assertLegalBatchIntent({ kind: 'register', statusType: 'SALE', stockQuantity: null }), (error) => error.code === 'stock_number_min');
  assert.throws(() => assertLegalBatchIntent({ kind: 'modify', statusType: 'OUTOFSTOCK', stockQuantity: 0 }), (error) => error.code === 'status_type_not_allowed');
  assert.throws(() => assertLegalBatchIntent({ kind: 'patch' }), (error) => error.code === 'batch_intent_unknown');
  assert.equal(assertLegalBatchIntent({ kind: 'register', statusType: 'SALE', stockQuantity: 1 }), true);
  assert.equal(assertLegalBatchIntent({ kind: 'modify', statusType: 'SALE', stockQuantity: 0 }), true);
});
