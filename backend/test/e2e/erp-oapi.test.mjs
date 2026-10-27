// Contract tests against a mock of the vendor's documented behaviour.
// These live under test/e2e/ on purpose: package.json's test globs collect
// test/unit and test/e2e only, so a directory called test/integration/ would
// be committed, green locally and never run by CI.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createErpOapiClient, ErpOapiError, ERP_OAPI_ENDPOINTS } from '../../lib/erp-oapi.mjs';
import { planInventoryRead, planProductSync, planSlip, validateRow, ecountDate, wrapList, OAPI_FIELD_LIMITS } from '../../lib/erp-plan.mjs';
import { closeAllMockOapiServers, startMockOapiServer } from '../helpers/mock-erp-oapi.mjs';

// A failing assertion throws past the `mock.close()` at the end of a test and
// leaves a listening server; the helper registry reclaims those.
after(closeAllMockOapiServers);

function fakeClock() {
  const waits = [];
  let t = 1_700_000_000_000;
  return {
    waits,
    now: () => t,
    sleep: async (ms) => { waits.push(ms); t += ms; },
  };
}

async function withClient(overrides = {}, extraEnv = {}) {
  const mock = await startMockOapiServer(overrides);
  const clock = fakeClock();
  const client = createErpOapiClient({
    env: { ERP_MODE: 'mock', ERP_MOCK_BASE_URL: mock.baseUrl, ECOUNT_COM_CODE: '80001', ECOUNT_USER_ID: 'cgi_api', ECOUNT_LAN_TYPE: 'ko-KR', ...extraEnv },
    now: clock.now,
    sleep: clock.sleep,
  });
  return { mock, client, clock };
}

test('disabled by default: nothing is transmitted when env is silent', async () => {
  const mock = await startMockOapiServer();
  const client = createErpOapiClient({ env: {}, fetchFn: () => { throw new Error('fetch must not be called'); } });
  assert.equal(client.mode, 'disabled');
  await assert.rejects(client.call('saveBasicProduct', {}, { rows: [{ PROD_CD: 'SS-1', PROD_DES: 'x' }] }), (e) => e.code === 'disabled');
  assert.equal(mock.calls.length, 0);
  await mock.close();
});

test('ERP_LIVE_WRITE gate: live needs YES *and* ERP_MODE=live', async () => {
  assert.equal(createErpOapiClient({ env: { ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES', ECOUNT_COM_CODE: '1', ECOUNT_USER_ID: 'u', ECOUNT_API_CERT_KEY: 'k' } }).mode, 'live');
  assert.equal(createErpOapiClient({ env: { ERP_MODE: 'live', ECOUNT_COM_CODE: '1', ECOUNT_USER_ID: 'u', ECOUNT_API_CERT_KEY: 'k' } }).mode, 'disabled');
});

test('mock mode refuses a non-loopback base URL', () => {
  assert.throws(
    () => createErpOapiClient({ env: { ERP_MODE: 'mock', ERP_MOCK_BASE_URL: 'https://sboapiAA.ecount.com', ECOUNT_COM_CODE: '1', ECOUNT_USER_ID: 'u' } }),
    (e) => e instanceof ErpOapiError && e.code === 'mock_base_url_not_loopback',
  );
});

test('bootstrap uses Zone then OAPILogin and passes SESSION_ID as a query parameter, not a header', async () => {
  const { mock, client, clock } = await withClient();
  const session = await client.bootstrap();
  assert.equal(session.zone, 'AA');
  assert.equal(session.sessionId, 'MOCK_SESSION_ID');
  assert.deepEqual(mock.pathsSeen(), ['/OAPI/V2/Zone', '/OAPI/V2/OAPILogin']);

  const login = mock.calls[1];
  assert.deepEqual(Object.keys(login.body).sort(), ['API_CERT_KEY', 'COM_CODE', 'LAN_TYPE', 'USER_ID', 'ZONE']);
  assert.equal(login.body.API_CERT_KEY, '', 'API_CERT_KEY is read from env and is absent here on purpose — no credential may be echoed into a test log');

  const result = await client.call('saveBasicProduct', null, { rows: [{ PROD_CD: 'SS-3836', PROD_DES: 'SQ5+', UNIT: 'EA', PROD_TYPE: '3' }] });
  const call = mock.calls[2];
  assert.equal(call.path, '/OAPI/V2/InventoryBasic/SaveBasicProduct');
  assert.equal(call.query.SESSION_ID, 'MOCK_SESSION_ID');
  assert.equal(call.headers.authorization, undefined, 'ecount OAPI has no Authorization header');
  assert.deepEqual(Object.keys(call.body), ['ProductList']);
  assert.deepEqual(Object.keys(call.body.ProductList[0]), ['BulkDatas']);
  assert.equal(call.body.ProductList[0].BulkDatas.PROD_CD, 'SS-3836');
  assert.equal(result.ok, true);
  assert.deepEqual(result.slipNos, []);
  assert.equal(result.quota.consecutiveErrors.limit, 30);

  // The documented interval is between successive calls to the SAME endpoint,
  // so a fresh client must not stall before its first one and must spend the
  // full 10s on the second — an interval enforced only by luck of the batch
  // size is how an account-wide 412 starts.
  const waitsBeforeSecond = clock.waits.length;
  await client.call('saveBasicProduct', null, { rows: [{ PROD_CD: 'SS-3837', PROD_DES: 'SQ5' }] });
  assert.equal(clock.waits.length, waitsBeforeSecond + 1, 'the first call to an endpoint spends no interval');
  assert.equal(clock.waits[waitsBeforeSecond], 10000, 'SaveBasicProduct is documented at 1 call / 10s');
  assert.equal(ERP_OAPI_ENDPOINTS.saveBasicProduct.minIntervalMs, 10000);
  await mock.close();
});

test('a per-row rejection inside HTTP 200 is a failure, not a success', async () => {
  const { mock, client } = await withClient({ failProdCds: new Set(['SS-DEAD']) });
  await client.bootstrap();
  await assert.rejects(
    client.call('saveBasicProduct', null, { rows: [
      { PROD_CD: 'SS-3836', PROD_DES: 'SQ5+' },
      { PROD_CD: 'SS-DEAD', PROD_DES: '없는 품목' },
    ] }),
    (e) => {
      assert.equal(e.code, 'row_failures');
      assert.equal(e.retryable, false);
      assert.equal(e.rows.length, 2);
      assert.equal(e.rows[1].IsSuccess, false);
      assert.match(e.message, /존재하지 않는 품목/);
      return true;
    },
  );
  const call = mock.calls[mock.calls.length - 1];
  assert.equal(call.body.ProductList.length, 2, 'the batch was sent as one call, so the client must read SuccessCnt/FailCnt');
  await mock.close();
});

test('login refusal code 201 stops the client instead of retrying', async () => {
  const { mock, client } = await withClient({ loginError: { Code: 201, Message: 'API_CERT_KEY가 유효하지 않습니다.' } });
  await assert.rejects(client.bootstrap(), (e) => e.code === 'login_failed' && /201/.test(e.message));
  assert.equal(client.stopped, true);
  await assert.rejects(client.call('saveBasicProduct', null, { rows: [{ PROD_CD: 'SS-1', PROD_DES: 'x' }] }), (e) => e.code === 'stopped');
  assert.equal(mock.pathsSeen().filter((p) => p === '/OAPI/V2/OAPILogin').length, 1, 'no retry storm against a locked or unissued key');
  await mock.close();
});

test('a dead session is detected from EXP00001 and re-bootstrapped once', async () => {
  const { mock, client } = await withClient();
  await client.bootstrap();
  await client.call('saveBasicProduct', null, { rows: [{ PROD_CD: 'SS-3836', PROD_DES: 'SQ5+' }] });
  mock.state.sessionId = 'EXPIRED_SESSION';
  await assert.rejects(
    client.call('viewBasicProduct', { PROD_CD: 'SS-3836' }),
    (e) => e.code === 'session_invalid' && e.retryable === true,
  );
  assert.equal(client.sessionId, null);
  const result = await client.call('viewBasicProduct', { PROD_CD: 'SS-3836' });
  assert.equal(result.ok, true);
  assert.equal(mock.pathsSeen().filter((p) => p === '/OAPI/V2/Zone').length, 2, 're-login happened exactly once');
  assert.equal(result.result[0].PROD_CD, 'SS-3836');
  await mock.close();
});

test('HTTP 412 is a retryable rate-limit, and a path the vendor does not have is reported as path-absent', async () => {
  const { mock, client } = await withClient();
  await client.bootstrap();
  mock.state.rateLimitNext = true;
  await assert.rejects(client.call('saveBasicProduct', null, { rows: [{ PROD_CD: 'SS-3836', PROD_DES: 'SQ5+' }] }),
    (e) => e.code === 'rate_limited' && e.retryable === true && e.retryAfterMs === 600000);
  assert.equal(client.sessionId, 'MOCK_SESSION_ID', 'a throttle is not a session loss');

  // This is how an invented endpoint (PR #83 called them /api/item and friends)
  // has to present: 404 + path-absent, distinguishable from "session invalid".
  mock.state.knownPaths.delete('/OAPI/V2/Sale/SaveSale');
  await assert.rejects(
    client.call('saveSale', null, { rows: [{ UPLOAD_SER_NO: '1', WH_CD: '00001', PROD_CD: 'SS-3836', PROD_DES: 'SQ5+', QTY: '1' }] }),
    (e) => e.code === 'http_404_path_absent' && e.retryable === false && e.httpStatus === 404,
  );
  mock.state.knownPaths.add('/OAPI/V2/Sale/SaveSale');
  await mock.close();
});

test('consecutive-error quota reached marks the client stopped', async () => {
  const { mock, client } = await withClient({ failProdCds: new Set(['SS-3836']), consecutiveErrors: 29 });
  await client.bootstrap();
  await assert.rejects(client.call('saveBasicProduct', null, { rows: [{ PROD_CD: 'SS-3836', PROD_DES: 'SQ5+' }] }), (e) => e.code === 'row_failures');
  assert.equal(client.stopped, true);
  assert.match(client.stopReason, /consecutive-error quota/);
  await mock.close();
});

test('duplicate transmission is refused by the dedupe claim and released only on a provably unprocessed batch', async () => {
  const { mock, client } = await withClient();
  const held = new Set();
  const claimDedupe = async (key, opts = {}) => {
    if (opts.release) { held.delete(key); return true; }
    if (held.has(key)) return false;
    held.add(key);
    return true;
  };
  const withClaim = createErpOapiClient({
    env: { ERP_MODE: 'mock', ERP_MOCK_BASE_URL: mock.baseUrl, ECOUNT_COM_CODE: '80001', ECOUNT_USER_ID: 'cgi_api' },
    now: client.lastQuota ? Date.now : () => Date.now(),
    sleep: async () => {},
    claimDedupe,
  });
  await withClaim.bootstrap();
  const rows = [{ UPLOAD_SER_NO: '1', CUST: '00001', WH_CD: '00001', PROD_CD: 'SS-3836', PROD_DES: 'SQ5+', QTY: '1', PRICE: '1000' }];
  await withClaim.call('saveSaleOrder', null, { rows, dedupeKey: 'order:ORD-1' });
  await assert.rejects(withClaim.call('saveSaleOrder', null, { rows, dedupeKey: 'order:ORD-1' }), (e) => e.code === 'dedupe_claimed');
  assert.equal(mock.calls.filter((c) => c.path.endsWith('SaveSaleOrder')).length, 1);

  // A row failure keeps the claim held: the document may exist server-side.
  mock.state.failProdCds = new Set(['SS-9999']);
  await assert.rejects(withClaim.call('saveSaleOrder', null, { rows: [{ ...rows[0], PROD_CD: 'SS-9999' }], dedupeKey: 'order:ORD-2' }), (e) => e.code === 'row_failures');
  assert.equal(held.has('order:ORD-2'), true, 'a partially processed batch must not be re-sendable');
  await mock.close();
});

test('stock read uses the list endpoint only when it must, because it costs 10 minutes', async () => {
  const single = planInventoryRead({ prodCds: ['SS-3836'], baseDate: '20261026' });
  assert.equal(single.endpoint, 'viewInventoryBalance');
  assert.equal(single.chunks[0].body.PROD_CD, 'SS-3836');
  assert.equal(single.minIntervalMs, 1000);

  const many = planInventoryRead({ prodCds: Array.from({ length: 41 }, (_, i) => `SS-${i}`), baseDate: '20261026' });
  assert.equal(many.endpoint, 'listInventoryBalance');
  assert.equal(many.chunks.length, 3);
  assert.equal(many.minIntervalMs, 600000);
  assert.match(many.note, /10 minutes/);

  const joined = planInventoryRead({ prodCds: ['A', 'B'], baseDate: '20261026', chunkSize: 5 });
  assert.equal(joined.chunks[0].body.PROD_CD, 'A∬B');

  const { mock, client } = await withClient();
  await client.bootstrap();
  const read = await client.call('viewInventoryBalance', { BASE_DATE: '20261026', PROD_CD: 'SS-3836', WH_CD: '' });
  assert.equal(read.totalCnt, 1);
  assert.equal(read.result[0].BAL_QTY, '3.0000000000');
  await mock.close();
});

test('plan-time validation blocks the boundaries the vendor would reject anyway', () => {
  assert.equal(OAPI_FIELD_LIMITS.PROD_CD, 20);
  assert.deepEqual(validateRow('saveBasicProduct', { PROD_CD: 'X'.repeat(21), PROD_DES: 'ok' }).map((p) => p.field), ['PROD_CD']);
  assert.deepEqual(validateRow('saveBasicProduct', { PROD_CD: 'SS-1', PROD_DES: '상'.repeat(101) })[0].reason, 'too_long');
  assert.deepEqual(validateRow('saveSaleOrder', { UPLOAD_SER_NO: '1', CUST: '', WH_CD: '', PROD_CD: 'SS-1', QTY: '0' }).map((p) => p.reason).sort(), ['must_be_positive', 'required', 'required']);
  assert.deepEqual(validateRow('saveSaleOrder', { UPLOAD_SER_NO: '1', CUST: '00001', WH_CD: '00001', PROD_CD: 'SS-1', PROD_DES: 'x', QTY: '2', IO_DATE: '2026-10-26' })[0].reason, 'not_YYYYMMDD');
  assert.equal(validateRow('saveSale', { UPLOAD_SER_NO: '1', WH_CD: '00001', PROD_CD: 'SS-1', PROD_DES: 'x', QTY: '2' }).length, 0);
  assert.equal(ecountDate(new Date(2026, 9, 26)), '20261026');
  assert.deepEqual(Object.keys(wrapList('saveBasicCust', [{ BUSINESS_NO: '1', CUST_NAME: 'n' }])), ['CustList']);
});

test('an order with no resolved ERP 거래처 produces a plan with zero transmittable rows', () => {
  const plan = planSlip({
    order: { id: 'ORD-20261026-TEST', paid_at: '2026-10-26T02:00:00Z' },
    items: [{ product_id: 'samamusic.co.kr:2574', product_name: 'SPX-8K', qty: 2, unit_price: 365000, option_label: '기본' }],
    cust: '',
    whCd: '',
  });
  assert.equal(plan.acceptedCount, 0);
  assert.equal(plan.batches.length, 0);
  assert.equal(plan.transmitted, false);
  assert.deepEqual(plan.rejected[0].problems.map((p) => p.field), ['CUST', 'WH_CD']);
  assert.match(plan.rejected[0].PROD_CD, /^SM-2574$/);
});

test('a resolved slip plan becomes the documented SaleOrderList body', async () => {
  const { mock, client } = await withClient();
  await client.bootstrap();
  const plan = planSlip({
    order: { id: 'ORD-20261026-OK', paid_at: '2026-10-26T02:00:00Z' },
    items: [
      { product_id: 'samamusic.co.kr:2574', product_name: 'SPX-8K', qty: 2, unit_price: 365000 },
      { erp_code: 'SS-3836', product_name: 'SQ5+', qty: 1, unit_price: 1680000, option_label: 'A&D 케이블 포함' },
    ],
    cust: '00001',
    custDes: '(주)삼아사운드',
    whCd: '00001',
  });
  assert.equal(plan.acceptedCount, 2);
  const sent = await client.call('saveSaleOrder', null, { rows: plan.batches.length ? plan.batches[0].body.SaleOrderList.map((r) => r.BulkDatas) : [], dedupeKey: plan.dedupeKey });
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.slipNos, ['20261026-1'], 'ERP 전표번호 must be captured, not discarded');
  const body = mock.calls.at(-1).body.SaleOrderList.map((r) => r.BulkDatas);
  assert.equal(body[0].UPLOAD_SER_NO, body[1].UPLOAD_SER_NO, 'both lines share one 전표 grouping key');
  assert.equal(body[0].PROD_CD, 'SM-2574');
  assert.equal(body[1].REMARKS, 'A&D 케이블 포함');
  await mock.close();
});

test('product plan separates transmittable rows from local rejections without dropping either', () => {
  const plan = planProductSync([
    { productId: 'SS-3836', productName: 'SQ5+', outPrice: 1680000, barCode: 'P0000FRO000A' },
    { productId: 'SS-' + 'Y'.repeat(30), productName: '코드 초과', outPrice: 1000 },
    { productId: 'SS-EMPTY', productName: '' },
  ], { maxRowsPerCall: 50, generatedAt: new Date('2026-10-26T00:00:00Z') });
  assert.equal(plan.acceptedCount, 1);
  assert.equal(plan.rejected.length, 2);
  assert.deepEqual(plan.rejected.map((r) => r.problems[0].reason), ['too_long', 'required']);
  assert.equal(plan.transmitted, false);
});
