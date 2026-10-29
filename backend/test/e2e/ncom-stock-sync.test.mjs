// 재고 동기화 전송 수준 테스트 (루프백 mock 게이트웨이) — 8단계 지시 §6.
//
// 고정하는 계약:
//   1. 재입고 전환: 원상품 전체 클론 + 재고·상태 변경 후 PUT(statusType=SALE) —
//      부분 발송으로 다른 필드를 잃지 않는다(C13 전체 리소스 교체 계약).
//   2. 품절 전환: 재고 0 수정(statusType=SALE) — 요청 어디에도 OUTOFSTOCK 입력이 없다.
//   3. no-op: 변경 없는 상품은 게이트웨이 요청 0건(쓰기 생략).
//   4. 채택 조인은 판매자코드 정확 일치만(C20).
//
// 실제 재입고 라이브 사례가 없으면 라이브 E2E는 NOT_VERIFIED로 보고하고, 이 mock 테스트가
// 전환 계약의 증거가 된다(8단계 지시 §6).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { planStockSync, STOCK_SYNC_ACTIONS } from '../../lib/ncom-stock-sync.mjs';
import { createNcomAuthRuntime } from '../../lib/ncommerce-auth.mjs';
import { closeAllMockNcomServers, startMockNcomServer } from '../helpers/mock-ncom.mjs';

after(() => closeAllMockNcomServers());

const bcryptStub = async (plain, salt) => `$2a$10$${Buffer.from(`${plain}|${salt}`).toString('base64')}`;
const SUPPLIER_CODE = 'samamusic:1048';
const ORIGIN_NO = 13777136100;

const remoteOriginProduct = (overrides = {}) => ({
  statusType: 'SALE',
  name: 'SHURE SE215SPE 슈어 이어폰',
  salePrice: 189000,
  stockQuantity: 3,
  leafCategoryId: '50024419',
  detailAttribute: { taxType: 'TAX', sellerCodeInfo: { sellerManagementCode: SUPPLIER_CODE }, originAreaInfo: { originAreaCode: '0204000', plural: false, importer: '삼아사운드 유한회사' } },
  images: { representativeImage: { url: 'https://shop-phinf.pstatic.net/x.jpg' }, optionalImages: [] },
  deliveryInfo: { deliveryType: 'DELIVERY', deliveryAttributeType: 'NORMAL', deliveryCompany: 'KGB', deliveryFee: { deliveryFeeType: 'FREE', baseFee: 0, deliveryFeePayType: 'PREPAID' }, claimDeliveryInfo: { returnDeliveryFee: 3000, exchangeDeliveryFee: 3000 } },
  detailContent: '<p>운영자 승인 상세본문</p>',
  ...overrides,
});

const buildRuntime = (mock) => {
  const env = { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl };
  for (const stateKey of ['clientId', 'clientSecret']) {
    const envKey = `NCOM_CLIENT_${stateKey.slice(6).toUpperCase()}`;
    env[envKey] = process.env[envKey] ?? mock.state[stateKey];
  }
  return createNcomAuthRuntime({ env, bcryptHashpw: bcryptStub });
};

const putBodies = (mock) => mock.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/external/v2/products/origin-products/')).map((c) => c.body);

test('restock transition sends the full origin product with synced quantity and SALE', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);
  const op = remoteOriginProduct({ statusType: 'OUTOFSTOCK', stockQuantity: 0 });
  const plan = planStockSync({ sellerManagementCode: SUPPLIER_CODE, supplier: { observedAt: '2026-10-29T11:00:00Z', onSale: true, stockQuantity: 5 }, remote: { exists: true, originProductNo: ORIGIN_NO, statusType: 'OUTOFSTOCK', stockQuantity: 0 } });
  assert.equal(plan.action, STOCK_SYNC_ACTIONS.restock);

  // 실행 주체: 전체 클론에 의도를 적용해 PUT(C13 전체 리소스 교체)
  const full = JSON.parse(JSON.stringify(op));
  full.statusType = plan.modify.statusType;
  full.stockQuantity = plan.modify.stockQuantity;
  await runtime.call('productModifyOrigin', { pathParams: { originProductNo: ORIGIN_NO }, body: { originProduct: full } });

  const bodies = putBodies(mock);
  assert.equal(bodies.length, 1);
  const sent = bodies[0].originProduct;
  assert.equal(sent.statusType, 'SALE');
  assert.equal(sent.stockQuantity, 5);
  assert.equal(sent.name, op.name, '전체 교체 계약 — 기존 필드가 보존된다');
  assert.equal(sent.detailAttribute.sellerCodeInfo.sellerManagementCode, SUPPLIER_CODE);
});

test('sold-out transition sends stock 0 with statusType SALE and never the OUTOFSTOCK input', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);
  const op = remoteOriginProduct({ stockQuantity: 3 });
  const plan = planStockSync({ sellerManagementCode: SUPPLIER_CODE, supplier: { observedAt: '2026-10-29T11:00:00Z', onSale: false, stockQuantity: 0 }, remote: { exists: true, originProductNo: ORIGIN_NO, statusType: 'SALE', stockQuantity: 3 } });
  assert.equal(plan.action, STOCK_SYNC_ACTIONS.sold_out_transition);

  const full = JSON.parse(JSON.stringify(op));
  full.statusType = plan.modify.statusType;
  full.stockQuantity = plan.modify.stockQuantity;
  await runtime.call('productModifyOrigin', { pathParams: { originProductNo: ORIGIN_NO }, body: { originProduct: full } });

  const bodies = putBodies(mock);
  assert.equal(bodies.length, 1);
  const sent = bodies[0].originProduct;
  assert.equal(sent.stockQuantity, 0);
  assert.equal(sent.statusType, 'SALE');
  assert.equal(JSON.stringify(bodies[0]).includes('OUTOFSTOCK'), false, 'OUTOFSTOCK은 입력 statusType이 아니다(C12)');
});

test('a no-op plan sends nothing to the gateway', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);
  const plan = planStockSync({ sellerManagementCode: SUPPLIER_CODE, supplier: { observedAt: '2026-10-29T11:00:00Z', onSale: true, stockQuantity: 3 }, remote: { exists: true, originProductNo: ORIGIN_NO, statusType: 'SALE', stockQuantity: 3 } });
  assert.equal(plan.action, STOCK_SYNC_ACTIONS.noop);
  assert.equal(plan.modify, null);
  const puts = putBodies(mock);
  assert.equal(puts.length, 0, '동일 수량·상태는 쓰기를 생략한다');
});
