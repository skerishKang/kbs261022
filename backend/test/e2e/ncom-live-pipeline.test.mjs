// L1 — 라이브 실행 경로 전 구간 테스트 (루프백 mock 게이트웨이).
//
// 게이트 자체는 단위 테스트가 고정한다. 이 파일은 '게이트를 통과한 실행'이 게이트웨이
// 에서 정확히 어떤 요청을 보내고 어떤 장부를 남기는지를 고정한다 — 라이브에서 같은
// 코드가 실행된다. 게이트는 주입(evaluateLiveGates 대체)으로 열고, 대상 게이트웨이는
// mock 이다. 실제 라이브에서는 CLI 가 엄격한 기본 게이트를 쓴다.
//
// 고정하는 계약:
//   1. 업로드 — 배치 10장, 응답 URL 수 불일치 배치는 부분 채택 금지, ledger 반환 URL 만.
//   2. 등록 — 등록 직전 sellerManagementCode 검색(중복조회) → 없을 때만 POST /v2/products.
//   3. 기존 상품 발견 → duplicate_blocked, PUT(전체 덮어쓰기) 요청 0건.
//   4. 사전조건 미충족 행은 검색조차 하지 않는다(전송 0).
//   5. 기본 게이트는 mock 환경에서 등록을 거부한다(테스트 주입이 아니면 못 연다).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  ledgerEntriesFromRegisterRun, mapSupplierStock, planPilotRegister, runPilotDuplicateCheck, runPilotImageUpload, runPilotRegister,
} from '../../lib/ncom-live-pipeline.mjs';
import { createNcomAuthRuntime } from '../../lib/ncommerce-auth.mjs';
import { closeAllMockNcomServers, startMockNcomServer } from '../helpers/mock-ncom.mjs';

after(() => closeAllMockNcomServers());

const bcryptStub = async (plain, salt) => `$2a$10$${Buffer.from(`${plain}|${salt}`).toString('base64')}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const permissive = () => ({ allowed: true, reasons: [], action: 'test' });

const pilotPackage = (cgiId, code, name, price, imageUrl) => ({
  cgiId,
  productName: name,
  sellerManagementCode: code,
  body: {
    originProduct: {
      statusType: 'SALE', name, salePrice: price, stockQuantity: null,
      detailAttribute: { taxType: 'TAX', sellerCodeInfo: { sellerManagementCode: code } },
      images: { representative: imageUrl, additional: [] },
    },
    smartstoreChannelProduct: { naverShoppingRegistration: false, channelProductDisplayStatusType: 'ON' },
  },
  images: { upload_plan: { representative: imageUrl, additional: [] } },
});

const packages = [
  pilotPackage('samamusic.co.kr:1769', 'samamusic:1769', 'K&M 19797 케이앤엠 태블릿 PC 스탠드', 116000, 'https://www.samamusic.co.kr/web/product/small/20200624/a3a892a3c531bd7522d5eeaf32a09cdd.jpg'),
  pilotPackage('samamusic.co.kr:3417', 'samamusic:3417', 'iZOTOPE RX 12 Standard 아이조톱 오디오 리페어 표준 플러그인', 518000, 'https://www.samamusic.co.kr/web/product/small/202606/61734205dcb870404e61c666626eae4c.png'),
  pilotPackage('samamusic.co.kr:3418', 'samamusic:3418', 'iZOTOPE RX 12 Advanced 아이조톱 오디오 리페어 프로 플러그인', 1818000, 'https://www.samamusic.co.kr/web/product/small/202606/61734205dcb870404e61c666626eae4d.png'),
];

const fetchBytes = async () => ({ status: 200, bytes: PNG });

const completeInputs = () => ({
  imagesByCgiId: new Map(packages.map((pkg, i) => [pkg.cgiId, { representative: `https://ncom-image.example/uploaded-${i + 1}.png`, additional: [], uploadedViaImageApi: true }])),
  leafByCgiId: new Map(packages.map((pkg, i) => [pkg.cgiId, `5000781${i + 1}`])),
  detailByCgiId: new Map(packages.map((pkg) => [pkg.cgiId, '<p>운영자 승인 상세본문</p>'])),
  stockByCgiId: new Map(packages.map((pkg, i) => [pkg.cgiId, { ok: true, stockQuantity: [8, 9, 29][i], source: 'supplier_displayed', measuredAt: '2026-10-22T05:16:51Z', ageHours: 100, stale: false, reason: null }])),
  deliveryByCgiId: new Map(packages.map((pkg) => [pkg.cgiId, { deliveryMethod: 'DELIVERY', deliveryFee: 3000 }])),
});

const buildRuntime = (mock) => createNcomAuthRuntime({
  env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC' },
  bcryptHashpw: bcryptStub,
});

test('default gate refuses the whole register run in a non-live environment', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);
  const plan = planPilotRegister({ packages, ...completeInputs() });
  const run = await runPilotRegister({ runtime, plan, env: { NCOM_MODE: 'mock' } });
  assert.equal(run.refused, true);
  assert.equal(run.naver_requests, 0);
  assert.equal(mock.pathsSeen().length, 0, '게이트 거부는 토큰 발급도 하지 않는다');
});

test('upload run posts multipart batches and records returned URLs only', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);
  const run = await runPilotImageUpload({ runtime, packages, env: {}, gates: permissive, execute: true, fetchBytes });
  assert.equal(run.refused, false);
  assert.equal(run.transmitted, true);
  assert.equal(run.ledger.length, 3, '상품별 대표 1장씩 3건');
  for (const entry of run.ledger) {
    assert.match(entry.uploaded, /^https:\/\/mock-image\.example\/upload-\d+\.png$/, '본문에 쓸 URL 은 업로드 API 반환값 뿐이다');
    assert.match(entry.source, /^https:\/\/www\.samamusic\.co\.kr\//, 'ledger 는 공급처 원본 URL 과 반환 URL 을 함께 남긴다');
  }
  const uploads = mock.pathsSeen().filter((p) => p === '/external/v1/product-images/upload');
  assert.equal(uploads.length, 3);
});

test('register run searches before every register and records product numbers', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);
  const plan = planPilotRegister({ packages, ...completeInputs() });
  assert.equal(plan.counts.registerable, 3);
  const run = await runPilotRegister({ runtime, plan, env: {}, gates: permissive, execute: true });
  assert.equal(run.refused, false);
  assert.deepEqual(run.results.map((r) => r.action), ['registered', 'registered', 'registered']);
  for (const result of run.results) {
    assert.equal(result.originProductNo, 500001, 'mock 은 고정 번호를 돌려준다 — 계약 대상은 응답 처리다');
    assert.equal(result.displayStatus, 'SUSPENSION');
  }
  const searches = mock.pathsSeen().filter((p) => p === '/external/v1/products/search');
  assert.equal(searches.length, 3, '등록 직전 검색이 상품마다 1회씩 실행된다');
  const registers = mock.pathsSeen().filter((p) => p === '/external/v2/products');
  assert.equal(registers.length, 3);
  const registerBody = mock.calls.find((c) => c.path === '/external/v2/products').body;
  assert.equal(registerBody.smartstoreChannelProduct.channelProductDisplayStatusType, 'SUSPENSION', '본문은 비노출 등록으로 전송된다');
  assert.equal(typeof registerBody.originProduct.detailContent, 'string');

  const entries = ledgerEntriesFromRegisterRun({ run, mode: 'live' });
  assert.equal(entries.length, 3);
  for (const entry of entries) assert.equal(entry.kind, 'cgi-ncom-registration');
});

test('existing seller code is duplicate_blocked and never modified', async () => {
  const mock = await startMockNcomServer({ sellerCodeIndex: new Set(['samamusic:1769']) });
  const runtime = buildRuntime(mock);
  const plan = planPilotRegister({ packages, ...completeInputs() });
  const run = await runPilotRegister({ runtime, plan, env: {}, gates: permissive, execute: true });
  const blocked = run.results.find((r) => r.cgiId === 'samamusic.co.kr:1769');
  assert.equal(blocked.action, 'duplicate_blocked');
  assert.equal(blocked.existingOriginProductNo, 500001);
  assert.equal(blocked.transmitted, false);
  const puts = mock.pathsSeen().filter((p) => p.startsWith('/external/v2/products/origin-products/'));
  assert.equal(puts.length, 0, '파일럿 레인은 PUT(전체 덮어쓰기)을 절대 실행하지 않는다');
  const entries = ledgerEntriesFromRegisterRun({ run, mode: 'live' });
  assert.equal(entries.find((e) => e.kind === 'cgi-ncom-duplicate-blocked').sellerManagementCode, 'samamusic:1769');
});

test('precondition-blocked rows never reach the gateway', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);
  const plan = planPilotRegister({ packages });
  assert.equal(plan.counts.registerable, 0);
  const run = await runPilotRegister({ runtime, plan, env: {}, gates: permissive, execute: true });
  assert.deepEqual(run.results.map((r) => r.action), ['blocked_preconditions', 'blocked_preconditions', 'blocked_preconditions']);
  const traffic = mock.pathsSeen().filter((p) => p !== '/external/v1/oauth2/token');
  assert.equal(traffic.length, 0, '미충족 행은 검색도 등록도 하지 않는다');
  for (const result of run.results) assert.ok(result.pending.length >= 5);
});

test('duplicate check step reports existing products without writing', async () => {
  const mock = await startMockNcomServer({ sellerCodeIndex: new Set(['samamusic:3417']) });
  const runtime = buildRuntime(mock);
  const run = await runPilotDuplicateCheck({ runtime, sellerCodes: packages.map((p) => p.sellerManagementCode), gates: permissive });
  assert.equal(run.refused, false);
  assert.deepEqual(run.checks.map((c) => c.existing), [false, true, false]);
  assert.equal(run.checks[1].originProductNo, 500001);
  assert.equal(mock.pathsSeen().filter((p) => p === '/external/v2/products').length, 0, '조회 단계는 쓰기 요청이 없다');
});

test('stock for the three pilots maps from committed availability measurements', () => {
  const samples = [
    ['{"stock_number_displayed": "8", "use_stock": true, "use_soldout": "F", "is_reserve_stat": "N"}', 8],
    ['{"stock_number_displayed": "9", "use_stock": true, "use_soldout": "F", "is_reserve_stat": "N"}', 9],
    ['{"stock_number_displayed": "29", "use_stock": true, "use_soldout": "F", "is_reserve_stat": "N"}', 29],
  ];
  for (const [availability, expected] of samples) {
    const stock = mapSupplierStock({ availability, collectedAt: '2026-10-22T05:16:51Z', nowMs: Date.parse('2026-10-28T00:00:00Z') });
    assert.equal(stock.stockQuantity, expected);
  }
});
