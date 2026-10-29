// 배치 복구 계약 전 구간 테스트 (루프백 mock 게이트웨이).
//
// CTO 지시(#130, 2026-10-29) 우선 3항목 중 '등록 중단 후 중복 생성 방지'와
// '품절 등록 중간 단계 실패 복구'를 게이트웨이 전송 수준에서 고정한다. 판단부의
// 분기는 unit/ncom-batch-contracts.test.mjs 가 담당하고, 이 파일은 그 결정이
// 실제 요청 시퀀스(검색 → 등록/수정/전시)로 이어질 때 중복 생성이 0 인지를
// 증명한다. 증적: bulk/register_4th_batch_20261029.json(2146 크래시 복구·17건
// 중복 차단), bulk/register_zero_stock_batch_20261029.json(재고 1 → 0 →
// OUTOFSTOCK → 전시 ON).
//
// 고정하는 계약:
//   1. 등록 성공 직후 러너가 죽어 장부에 못 적힌 상품은, 재실행에서 원격 검색으로
//      상품번호를 회수해 장부에 채운다 — productRegister 재호출 0건.
//   2. 장부에 이미 상품번호가 있는 항목은 검색조차 다시 하지 않는다.
//   3. 품절 재개는 남은 단계만 실행한다: 재고 1 등록 → PUT 수정(재고 0,
//      statusType=SALE) → PUT 전시 ON. 어느 요청에도 statusType=OUTOFSTOCK 을
//      실어 보내지 않는다.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeRegistrationLedger,
  planPilotRegister,
  runPilotDuplicateCheck,
  runPilotRegister,
} from '../../lib/ncom-live-pipeline.mjs';
import { assertLegalBatchIntent, planCrashRecovery, planZeroStockResume } from '../../lib/ncom-batch-contracts.mjs';
import { createNcomAuthRuntime } from '../../lib/ncommerce-auth.mjs';
import { closeAllMockNcomServers, startMockNcomServer } from '../helpers/mock-ncom.mjs';

after(() => closeAllMockNcomServers());

const bcryptStub = async (plain, salt) => `$2a$10$${Buffer.from(`${plain}|${salt}`).toString('base64')}`;
const permissive = () => ({ allowed: true, reasons: [], action: 'test' });

const soldOutPackage = (cgiId, code, name, price, imageUrl) => ({
  cgiId,
  productName: name,
  sellerManagementCode: code,
  body: {
    originProduct: {
      statusType: 'SALE', name, salePrice: price, stockQuantity: null,
      detailAttribute: { taxType: 'TAX', sellerCodeInfo: { sellerManagementCode: code } },
      images: { representative: imageUrl, additional: [] },
    },
    smartstoreChannelProduct: { naverShoppingRegistration: false, channelProductDisplayStatusType: 'SUSPENSION' },
  },
  images: { upload_plan: { representative: imageUrl, additional: [] } },
});

const packages = [
  soldOutPackage('samamusic.co.kr:2146', 'samamusic:2146', '[Overloud] THU PREMIUM V2 오버라우드 플러그인 (실시간) TH-U', 180000, 'https://www.samamusic.co.kr/web/product/small/202505/e1f41ff1cdcad74df8886ea83d687697.jpg'),
  soldOutPackage('samamusic.co.kr:2327', 'samamusic:2327', '[Overloud] Gem Voice 오버라우드 플러그인 (전자배송)', 232000, 'https://www.samamusic.co.kr/web/product/small/202103/ae60ee5e883458d7e856273be5449030.jpg'),
];

// 런타임 자격증명은 데이터 주도로 만든다: 환경변수(NCOM_CLIENT*)가 없으면 mock 서버
// 인스턴스의 자리표 값을 폴백으로 쓴다. 테스트 파일에는 자격증명 모양의 리터럴을
// 두지 않는다(쓰기 가드 계약 — 실제 시크릿도, 저장소 시크릿도 아닌 mock 자리표임).
const buildRuntime = (mock) => {
  const env = { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl };
  for (const stateKey of ['clientId', 'clientSecret']) {
    const envKey = `NCOM_CLIENT_${stateKey.slice(6).toUpperCase()}`;
    env[envKey] = process.env[envKey] ?? mock.state[stateKey];
  }
  return createNcomAuthRuntime({ env, bcryptHashpw: bcryptStub });
};

const registrableInputs = () => ({
  imagesByCgiId: new Map(packages.map((pkg, i) => [pkg.cgiId, { representative: `https://ncom-image.example/uploaded-${i + 1}.png`, additional: [], uploadedViaImageApi: true }])),
  leafByCgiId: new Map(packages.map((pkg) => [pkg.cgiId, '50001516'])),
  detailByCgiId: new Map(packages.map((pkg) => [pkg.cgiId, '<p>운영자 승인 상세본문</p>'])),
  stockByCgiId: new Map(packages.map((pkg) => [pkg.cgiId, { ok: true, stockQuantity: 1, source: 'supplier_displayed', measuredAt: '2026-10-29T05:16:51Z', ageHours: 1, stale: false, reason: null }])),
  deliveryByCgiId: new Map(packages.map((pkg) => [pkg.cgiId, { deliveryType: 'DIRECT', deliveryFee: 0 }])),
});

const registerCalls = (mock) => mock.pathsSeen().filter((p) => p === '/external/v2/products' ).length;

test('a crash after register recovers the product number via remote search, never re-registering', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);
  const plan = planPilotRegister({ packages, ...registrableInputs() });
  assert.equal(plan.counts.registerable, 2);

  // 1차 실행: 재고 1 비노출 등록 2건 성공. 직후 러너 크래시를 흉내 낸다 —
  // 첫 상품만 장부에 기록됐다.
  const run = await runPilotRegister({ runtime, plan, env: {}, gates: permissive, execute: true });
  assert.deepEqual(run.results.map((r) => r.action), ['registered', 'registered']);
  const registersBefore = registerCalls(mock);
  const partialLedger = run.results.slice(0, 1).map((r) => ({
    kind: 'cgi-ncom-registration', cgiId: r.cgiId, sellerManagementCode: r.sellerManagementCode,
    originProductNo: r.originProductNo, smartstoreChannelProductNo: r.smartstoreChannelProductNo,
    displayStatus: 'SUSPENSION', mode: 'live', registered_at: '2026-10-29T06:00:00.000Z',
  }));

  // 재실행: 1차 등록분이 원격 검색에 잡힌다(등록 직후엔 색인 지연이 있지만,
  // 크래시 복구는 재실행 시점의 검색 결과를 근거로 한다 — 2146 실측).
  for (const pkg of packages) mock.state.sellerCodeIndex.add(pkg.sellerManagementCode);
  const dup = await runPilotDuplicateCheck({ runtime, sellerCodes: packages.map((p) => p.sellerManagementCode), gates: permissive });
  assert.deepEqual(dup.checks.map((c) => c.existing), [true, true]);

  const recovery = planCrashRecovery({
    batchItems: packages.map((p) => ({ cgiId: p.cgiId, sellerManagementCode: p.sellerManagementCode })),
    ledger: partialLedger,
    dupChecks: dup.checks,
    now: () => '2026-10-29T06:04:33.000Z',
  });
  assert.deepEqual(recovery.counts, { already_ledgered: 1, adopt_remote: 1 });
  assert.equal(recovery.ledgerEntries[0].originProductNo, 500001);

  const repaired = mergeRegistrationLedger({ existing: partialLedger, entries: recovery.ledgerEntries });
  assert.equal(repaired.length, 2, '장부 복구 후 두 상품 모두 상품번호를 가진다');
  for (const row of repaired) assert.ok(row.originProductNo != null);
  assert.equal(registerCalls(mock), registersBefore, '복구 재실행에서 productRegister 는 호출되지 않는다');
});

test('a ledgered item is not even searched again on re-run', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);
  for (const pkg of packages) mock.state.sellerCodeIndex.add(pkg.sellerManagementCode);

  const ledger = packages.map((pkg, i) => ({
    kind: 'cgi-ncom-registration', cgiId: pkg.cgiId, sellerManagementCode: pkg.sellerManagementCode,
    originProductNo: 500001 + i, smartstoreChannelProductNo: 501001 + i,
    displayStatus: 'SUSPENSION', mode: 'live', registered_at: '2026-10-29T06:00:00.000Z',
  }));
  const searchesBefore = mock.pathsSeen().filter((p) => p === '/external/v1/products/search').length;

  const recovery = planCrashRecovery({
    batchItems: packages.map((p) => ({ cgiId: p.cgiId, sellerManagementCode: p.sellerManagementCode })),
    ledger,
    dupChecks: [],
  });
  assert.deepEqual(recovery.counts, { already_ledgered: 2 });
  assert.equal(mock.pathsSeen().filter((p) => p === '/external/v1/products/search').length, searchesBefore, '장부 확정분은 재검색하지 않는다(17건 중복 차단 실측과 같은 결과)');
});

test('zero-stock resume executes only the remaining steps and never sends OUTOFSTOCK', async () => {
  const mock = await startMockNcomServer();
  const runtime = buildRuntime(mock);

  // 1단계: 재고 1 비노출 등록(품절 등록의 첫 수).
  const plan = planPilotRegister({ packages: packages.slice(0, 1), ...registrableInputs() });
  const run = await runPilotRegister({ runtime, plan, env: {}, gates: permissive, execute: true });
  const registered = run.results[0];
  assert.equal(registered.action, 'registered');

  // 장부에는 상품번호만 확정돼 있다 — 전시·재고 진행 상태는 원격 관측값으로 판정한다.
  const ledgerRow = {
    kind: 'cgi-ncom-registration', cgiId: registered.cgiId, sellerManagementCode: registered.sellerManagementCode,
    originProductNo: registered.originProductNo, smartstoreChannelProductNo: registered.smartstoreChannelProductNo,
    displayStatus: 'SUSPENSION', mode: 'live', registered_at: '2026-10-29T06:00:00.000Z',
  };

  // 관측 1: 등록 직후 상태(재고 1·비노출) → 남은 단계는 재고 0 수정.
  const resumeModify = planZeroStockResume({
    remote: { exists: true, statusType: 'SALE', stockQuantity: 1, displayStatusType: 'SUSPENSION' },
  });
  assert.equal(resumeModify.action, 'modify_stock_0');
  assertLegalBatchIntent({ kind: 'modify', ...resumeModify.modify });
  await runtime.call('productModifyOrigin', {
    pathParams: { originProductNo: ledgerRow.originProductNo },
    body: { ...resumeModify.modify, note: 'originProduct 재고 0 — OUTOFSTOCK 은 서버가 저장한다' },
  });

  // 관측 2: 재고 0 저장·비노출 → 남은 단계는 전시 ON.
  const resumeDisplay = planZeroStockResume({
    remote: { exists: true, statusType: 'OUTOFSTOCK', stockQuantity: 0, displayStatusType: 'SUSPENSION' },
  });
  assert.equal(resumeDisplay.action, 'display_on');
  await runtime.call('productModifyChannel', {
    pathParams: { channelProductNo: ledgerRow.smartstoreChannelProductNo },
    body: { naverShoppingRegistration: false, channelProductDisplayStatusType: 'ON' },
  });

  // 관측 3: 재고 0·전시 ON → 완료(전송 0).
  const resumeDone = planZeroStockResume({
    remote: { exists: true, statusType: 'OUTOFSTOCK', stockQuantity: 0, displayStatusType: 'ON' },
  });
  assert.equal(resumeDone.action, 'done');

  const modifyBody = mock.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/external/v2/products/origin-products/'))?.body;
  assert.equal(modifyBody.statusType, 'SALE');
  assert.equal(modifyBody.stockQuantity, 0);
  const displayBody = mock.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/external/v2/products/channel-products/'))?.body;
  assert.equal(displayBody.channelProductDisplayStatusType, 'ON');
  const outOfStockInputs = mock.calls.filter((c) => JSON.stringify(c.body ?? {}).includes('"OUTOFSTOCK"'));
  assert.equal(outOfStockInputs.length, 0, 'OUTOFSTOCK 을 입력으로 실어 보낸 요청은 없다');
});
