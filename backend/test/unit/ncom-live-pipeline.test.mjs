// L1 — 라이브 실행 경로 게이트·재고·조립·장부 단위 테스트 (네트워크 0건).
//
// 고정하는 계약:
//   1. 게이트 — 읽기는 live+자격증명, 쓰기는 +LIVE_WRITE+execute, 등록은
//      +i-confirm-register. 하나라도 부족하면 전송 전 거부(사유는 운영자용 문구).
//   2. 재고 — 공급처 표시 수량은 use_stock=true 이고 1 이상일 때만, 소수 내림,
//      0·음수·미관리·경과 초과는 거부(사유 보존).
//   3. 조립 — ledger 이미지 URL 만 본문에 들어가고, 없는 값은 pending 으로
//      주체와 함께 남는다. pending 이 남으면 registerable=false.
//   4. 판매노출 ON 은 sell-ack 없이는 조립 단계에서부터 금지.
//   5. 장부 — 동일 cgiId 는 최근 기록을 남기고 registered/duplicate_blocked 모두 기록.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateLiveGates, ledgerEntriesFromRegisterRun, mapSupplierStock, mergeRegistrationLedger, planPilotRegister,
} from '../../lib/ncom-live-pipeline.mjs';
import { buildRegisterBody } from '../../lib/ncommerce.mjs';

const LIVE_ENV = { NCOM_MODE: 'live', NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC' };
const WRITE_ENV = { ...LIVE_ENV, NCOM_LIVE_WRITE: 'YES' };

// --- 1. 게이트 ---------------------------------------------------------------

test('read gate needs live mode and credentials', () => {
  assert.equal(evaluateLiveGates({ env: {}, action: 'read' }).allowed, false);
  assert.equal(evaluateLiveGates({ env: { NCOM_MODE: 'mock', NCOM_CLIENT_ID: 'C', NCOM_CLIENT_SECRET: 'S' }, action: 'read' }).allowed, false, 'mock 은 이 레인에서 거부된다');
  assert.equal(evaluateLiveGates({ env: LIVE_ENV, action: 'read' }).allowed, true);
  const disabled = evaluateLiveGates({ env: {}, action: 'read' });
  assert.ok(disabled.reasons.some((r) => r.includes('NCOM_MODE=live')));
  assert.ok(disabled.reasons.some((r) => r.includes('NCOM_CLIENT_ID')));
});

test('write gates escalate for upload and register', () => {
  assert.ok(evaluateLiveGates({ env: LIVE_ENV, action: 'upload', acks: {} }).reasons.join(' ').includes('NCOM_LIVE_WRITE=YES'));
  assert.ok(evaluateLiveGates({ env: WRITE_ENV, action: 'upload', acks: {} }).reasons.join(' ').includes('--execute'));
  assert.equal(evaluateLiveGates({ env: WRITE_ENV, action: 'upload', acks: { execute: true } }).allowed, true);
  assert.ok(evaluateLiveGates({ env: WRITE_ENV, action: 'register', acks: { execute: true } }).reasons.join(' ').includes('--i-confirm-register'));
  assert.equal(evaluateLiveGates({ env: WRITE_ENV, action: 'register', acks: { execute: true, confirmRegister: true } }).allowed, true);
  assert.equal(evaluateLiveGates({ env: {}, action: 'nope' }).allowed, false, '모르는 동작은 전부 거부');
});

// --- 2. 공급처 표시 재고 -------------------------------------------------------

test('mapSupplierStock accepts the three pilot availability payloads', () => {
  const pilots = [
    { cgiId: 'samamusic.co.kr:1769', availability: '{"stock_number_displayed": "8", "use_stock": true, "use_soldout": "F", "is_reserve_stat": "N"}' },
    { cgiId: 'samamusic.co.kr:3417', availability: '{"stock_number_displayed": "9", "use_stock": true, "use_soldout": "F", "is_reserve_stat": "N"}' },
    { cgiId: 'samamusic.co.kr:3418', availability: '{"stock_number_displayed": "29", "use_stock": true, "use_soldout": "F", "is_reserve_stat": "N"}' },
  ];
  for (const pilot of pilots) {
    const stock = mapSupplierStock({ availability: pilot.availability, collectedAt: '2026-10-22T05:16:51Z', nowMs: Date.parse('2026-10-28T00:00:00Z') });
    assert.equal(stock.ok, true, pilot.cgiId);
    assert.equal(Number.isInteger(stock.stockQuantity), true, pilot.cgiId);
    assert.equal(stock.source, 'supplier_displayed');
    assert.equal(stock.stale, false, '336시간(14일) 이내 측정은 신선하다');
  }
  assert.equal(mapSupplierStock({ availability: '{"stock_number_displayed": "7.9", "use_stock": true}', collectedAt: '2026-10-28T00:00:00Z' }).stockQuantity, 7, '소수는 내림 — 올림 금지');
});

test('mapSupplierStock refuses unusable states with preserved reasons', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  const cases = [
    { availability: null, reason: 'availability_json_unreadable' },
    { availability: 'not-json', reason: 'availability_json_unreadable' },
    { availability: '{"stock_number_displayed": "5", "use_stock": false}', reason: 'use_stock_false' },
    { availability: '{"stock_number_displayed": null, "use_stock": true}', reason: 'stock_number_unreadable' },
    { availability: '{"stock_number_displayed": "-1", "use_stock": true}', reason: 'negative_displayed_stock' },
    { availability: '{"stock_number_displayed": "0", "use_stock": true}', reason: 'zero_displayed_stock' },
  ];
  for (const c of cases) {
    const stock = mapSupplierStock({ availability: c.availability, nowMs: now });
    assert.equal(stock.ok, false, c.reason);
    assert.equal(stock.reason, c.reason);
  }
  const stale = mapSupplierStock({ availability: '{"stock_number_displayed": "8", "use_stock": true}', collectedAt: '2026-09-01T00:00:00Z', nowMs: now, maxAgeHours: 336 });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_measurement');
  assert.equal(stale.stockQuantity, 8, '거부 사유가 있어도 측정값 자체는 보존된다(운영자 판단 자료)');
  assert.equal(mapSupplierStock({ availability: '{"stock_number_displayed": "8", "use_stock": true}', collectedAt: '2026-09-01T00:00:00Z', nowMs: now, maxAgeHours: 336, allowStale: true }).ok, true, '운영자가 명시적으로 받아들이면 경과 측정도 사용된다');
});

// --- 3. 등록 패키지 조립 -------------------------------------------------------

const makePackage = (overrides = {}) => ({
  cgiId: 'samamusic.co.kr:1769',
  productName: 'K&M 19797 케이앤엠 태블릿 PC 스탠드',
  sellerManagementCode: 'samamusic:1769',
  body: {
    originProduct: {
      statusType: 'SALE', name: 'K&M 19797 케이앤엠 태블릿 PC 스탠드', salePrice: 116000, stockQuantity: null,
      detailAttribute: { taxType: 'TAX', sellerCodeInfo: { sellerManagementCode: 'samamusic:1769' } },
      images: { representative: 'https://www.samamusic.co.kr/web/product/small/20200624/a3a892a3c531bd7522d5eeaf32a09cdd.jpg', additional: [] },
    },
    smartstoreChannelProduct: { naverShoppingRegistration: false, channelProductDisplayStatusType: 'ON' },
  },
  images: { upload_plan: { representative: 'https://www.samamusic.co.kr/web/product/small/20200624/a3a892a3c531bd7522d5eeaf32a09cdd.jpg', additional: [] } },
  ...overrides,
});

const completeInputs = () => ({
  imagesByCgiId: new Map([['samamusic.co.kr:1769', { representative: 'https://ncom-image.example/uploaded-1.png', additional: [], uploadedViaImageApi: true }]]),
  leafByCgiId: new Map([['samamusic.co.kr:1769', '50007811']]),
  detailByCgiId: new Map([['samamusic.co.kr:1769', '<p>운영자 승인 상세본문</p>']]),
  stockByCgiId: new Map([['samamusic.co.kr:1769', { ok: true, stockQuantity: 8, source: 'supplier_displayed', measuredAt: '2026-10-22T05:16:51Z', ageHours: 100, stale: false, reason: null }]]),
  deliveryByCgiId: new Map([['samamusic.co.kr:1769', { deliveryMethod: 'DELIVERY', deliveryFee: 3000 }]]),
});

test('planPilotRegister: every unconfirmed value stays pending and blocks registerability', () => {
  const plan = planPilotRegister({ packages: [makePackage()] });
  assert.equal(plan.counts.registerable, 0);
  const row = plan.rows[0];
  const fields = row.pending.map((p) => p.field);
  assert.deepEqual(fields.sort(), ['deliveryInfo', 'detailContent', 'images.representative', 'leafCategoryId', 'stockQuantity'].sort());
  assert.equal(row.body.originProduct.stockQuantity, null, '미확정 값은 본문에 들어가지 않는다');
  assert.equal(row.body.originProduct.detailContent, undefined);
  assert.equal(row.body.originProduct.leafCategoryId, undefined);
});

test('planPilotRegister: complete inputs assemble a registerable body with SUSPENSION default', () => {
  const plan = planPilotRegister({ packages: [makePackage()], ...completeInputs() });
  assert.equal(plan.counts.registerable, 1);
  const row = plan.rows[0];
  assert.equal(row.pending.length, 0);
  assert.equal(row.displayStatus, 'SUSPENSION', '기본값은 비노출 등록 — 등록과 판매개시를 분리한다');
  assert.equal(row.body.smartstoreChannelProduct.channelProductDisplayStatusType, 'SUSPENSION');
  assert.equal(row.body.originProduct.stockQuantity, 8);
  assert.equal(row.body.originProduct.leafCategoryId, '50007811');
  assert.equal(row.body.originProduct.detailContent, '<p>운영자 승인 상세본문</p>');
  assert.equal(row.body.originProduct.images.representative, 'https://ncom-image.example/uploaded-1.png', '본문 이미지는 업로드 API 반환 URL 만');
  assert.equal(row.body.originProduct.deliveryInfo.deliveryFee, 3000, '고객 정책 파일이 준 배송 정보만 반영된다');
  assert.equal(row.body.smartstoreChannelProduct.naverShoppingRegistration, false);
});

test('planPilotRegister: display ON without sell-ack is refused at assembly', () => {
  assert.throws(() => planPilotRegister({ packages: [makePackage()], displayStatus: 'ON' }), (error) => error.code === 'sell_ack_missing');
  const plan = planPilotRegister({ packages: [makePackage()], ...completeInputs(), displayStatus: 'ON', sellAck: true });
  assert.equal(plan.rows[0].body.smartstoreChannelProduct.channelProductDisplayStatusType, 'ON');
});

test('planPilotRegister: supplier-displayed stock never bypasses its own gate', () => {
  const inputs = completeInputs();
  inputs.stockByCgiId = new Map([['samamusic.co.kr:1769', { ok: false, stockQuantity: null, reason: 'stale_measurement', note: '측정 후 900시간 경과' }]]);
  const plan = planPilotRegister({ packages: [makePackage()], ...inputs });
  assert.equal(plan.counts.registerable, 0);
  const pending = plan.rows[0].pending.find((p) => p.field === 'stockQuantity');
  assert.equal(pending.owner, 'stale_measurement', '거부 사유가 pending 주체로 남는다');
});

test('planPilotRegister: buildRegisterBody contract is the only body authority', () => {
  const inputs = completeInputs();
  const plan = planPilotRegister({ packages: [makePackage()], ...inputs });
  const record = {
    prodDes: 'K&M 19797 케이앤엠 태블릿 PC 스탠드',
    price: { value: 116000 },
    sellerManagementCode: 'samamusic:1769',
    stockQuantity: 8,
  };
  const direct = buildRegisterBody(record, {
    leafCategoryId: '50007811',
    detailContent: '<p>운영자 승인 상세본문</p>',
    images: { representative: 'https://ncom-image.example/uploaded-1.png', additional: [], uploadedViaImageApi: true },
    channel: { naverShoppingRegistration: false, channelProductDisplayStatusType: 'SUSPENSION', deliveryInfo: { deliveryMethod: 'DELIVERY', deliveryFee: 3000 } },
  });
  assert.deepEqual(plan.rows[0].body, direct.body, '라이브 조립은 buildRegisterBody 와 정확히 같은 본문을 만든다');
  assert.deepEqual(plan.rows[0].problems, direct.problems);
});

// --- 4. 실행 장부 ---------------------------------------------------------------

test('mergeRegistrationLedger keeps the newest row per cgiId', () => {
  const existing = [
    { kind: 'cgi-ncom-registration', cgiId: 'samamusic.co.kr:1769', originProductNo: 111, registered_at: '2026-10-28T09:00:00Z' },
    { kind: 'cgi-ncom-registration', cgiId: 'samamusic.co.kr:3417', originProductNo: 222, registered_at: '2026-10-28T09:01:00Z' },
  ];
  const entries = [
    { kind: 'cgi-ncom-registration', cgiId: 'samamusic.co.kr:1769', originProductNo: 333, registered_at: '2026-10-28T10:00:00Z' },
    { kind: 'cgi-ncom-registration', cgiId: 'samamusic.co.kr:3418', originProductNo: 444, registered_at: '2026-10-28T10:01:00Z' },
  ];
  const merged = mergeRegistrationLedger({ existing, entries });
  assert.equal(merged.length, 3);
  assert.equal(merged.find((r) => r.cgiId === 'samamusic.co.kr:1769').originProductNo, 333, '최근 기록을 남긴다');
  assert.equal(merged.find((r) => r.cgiId === 'samamusic.co.kr:3417').originProductNo, 222);
  assert.equal(merged.find((r) => r.cgiId === 'samamusic.co.kr:3418').originProductNo, 444);
});

test('ledgerEntriesFromRegisterRun records both registered and duplicate_blocked facts', () => {
  const run = {
    results: [
      { cgiId: 'samamusic.co.kr:1769', sellerManagementCode: 'samamusic:1769', action: 'registered', originProductNo: 777, smartstoreChannelProductNo: 1777, traceId: 't1' },
      { cgiId: 'samamusic.co.kr:3417', sellerManagementCode: 'samamusic:3417', action: 'duplicate_blocked', existingOriginProductNo: 888 },
      { cgiId: 'samamusic.co.kr:3418', sellerManagementCode: 'samamusic:3418', action: 'blocked_preconditions', pending: [{ field: 'detailContent' }] },
    ],
  };
  const entries = ledgerEntriesFromRegisterRun({ run, mode: 'live', now: () => '2026-10-28T11:00:00Z' });
  assert.equal(entries.length, 2, '차단(사전조건) 건은 장부에 쓰지 않는다');
  assert.equal(entries[0].kind, 'cgi-ncom-registration');
  assert.equal(entries[0].displayStatus, 'SUSPENSION');
  assert.equal(entries[1].kind, 'cgi-ncom-duplicate-blocked');
  assert.equal(entries[1].existingOriginProductNo, 888);
});
