// Pure contract logic: no sockets, no clock, no credentials. Every expectation
// here is a number or a shape the vendor documents, so a change to a module
// constant must be justified by a doc page, not by a test edit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ERP_OAPI_ENDPOINTS, ERP_OAPI_STOP_CODES, MULTI_VALUE_SEPARATOR,
  oapiModeFromEnv, oapiCredentials, assertMockBaseUrlAllowed,
  parseQuotaInfo, decodeJsonField, interpretResponse, ErpOapiError,
} from '../../lib/erp-oapi.mjs';
import {
  OAPI_FIELD_LIMITS, OAPI_REQUIRED_FIELDS,
  ecountDate, bulkRows, wrapList, validateRow, productRow, custRow, slipRows,
  planSlip, planProductSync, planCustomerSync, planInventoryRead,
} from '../../lib/erp-plan.mjs';
import {
  normalizeCgiId, parseCsv, buildMappingSet, coverageOf,
  resolveErpProdCd, saleableRows, duplicateProdCds,
} from '../../lib/product-mapping.mjs';
import {
  NCOM_ENDPOINTS, NCOM_LIMITS, NCOM_GATEWAY_CODES, NCOM_UNCONFIRMED, NCOM_RESPONSIBILITY,
  ncomModeFromEnv, classifyNcomResponse, clampOrderPageSize, searchBySellerCodeBody,
  buildRegisterBody, stockFromErpBalance,
} from '../../lib/ncommerce.mjs';

// ---------------------------------------------------------------------------
// ecount: mode, credentials, endpoint table
// ---------------------------------------------------------------------------

test('ERP mode is disabled unless both guards are set; mock is allowed for tests', () => {
  assert.equal(oapiModeFromEnv({}), 'disabled');
  assert.equal(oapiModeFromEnv({ ERP_MODE: 'live' }), 'disabled', 'ERP_LIVE_WRITE is the second key');
  assert.equal(oapiModeFromEnv({ ERP_LIVE_WRITE: 'YES' }), 'disabled');
  assert.equal(oapiModeFromEnv({ ERP_MODE: 'LIVE', ERP_LIVE_WRITE: 'yes' }), 'live');
  assert.equal(oapiModeFromEnv({ ERP_MODE: 'mock' }), 'mock');
  assert.equal(oapiModeFromEnv({ ERP_MODE: 'mock', ERP_LIVE_WRITE: 'YES' }), 'mock', 'mock never becomes live');
  assert.equal(ncomModeFromEnv({}), 'disabled');
  assert.equal(ncomModeFromEnv({ NCOM_MODE: 'live' }), 'disabled');
  assert.equal(ncomModeFromEnv({ NCOM_MODE: 'live', NCOM_LIVE_WRITE: 'YES' }), 'live');
  assert.equal(ncomModeFromEnv({ NCOM_MODE: 'live', NCOM_LIVE_WRITE: 'NO' }), 'disabled');
});

test('the official credential set has no password field anywhere', () => {
  const creds = oapiCredentials({
    ECOUNT_COM_CODE: ' 80001 ', ERP_USER_ID: 'seller', ERP_API_CERT_KEY: 'CERT', ERP_TARGET: 'PROD',
  });
  assert.deepEqual(creds, {
    comCode: '80001', userId: 'seller', apiCertKey: 'CERT', lanType: 'ko-KR', target: 'prod', mockBaseUrl: '',
  });
  assert.ok(!Object.keys(creds).some((k) => /pass/i.test(k)), 'OAPILogin takes API_CERT_KEY, never a password');
  assert.equal(oapiCredentials({}).target, 'test', 'the safe default is the test host');
  assert.equal(oapiCredentials({ ERP_TARGET: 'anything' }).target, 'test');
});

test('mock base URL must be loopback, with the port preserved and trailing slash dropped', () => {
  assert.equal(assertMockBaseUrlAllowed('http://127.0.0.1:54321/'), 'http://127.0.0.1:54321');
  assert.equal(assertMockBaseUrlAllowed('http://localhost:8787'), 'http://localhost:8787');
  for (const bad of ['', 'https://sboapi.ecount.com', 'http://192.168.0.2:8787', 'https://api.commerce.naver.com/external']) {
    assert.throws(() => assertMockBaseUrlAllowed(bad), (e) => e instanceof ErpOapiError && e.code === 'mock_base_url_not_loopback');
  }
});

test('endpoint table carries the documented per-endpoint interval and path shape', () => {
  for (const [key, endpoint] of Object.entries(ERP_OAPI_ENDPOINTS)) {
    assert.ok(endpoint.path.startsWith('/OAPI/V2/'), `${key} must be a V2 path`);
    assert.equal(typeof endpoint.minIntervalMs, 'number', `${key} needs its own interval`);
    if (/^Save/.test(endpoint.path)) assert.equal(endpoint.minIntervalMs, 10000, `${key}: 10초에 1회`);
    if (/^View|^Get[A-Z]/.test(endpoint.path.slice(endpoint.path.lastIndexOf('/')))) {
      assert.ok([1000, 600000].includes(endpoint.minIntervalMs), `${key} must be 1s or 10min`);
    }
    if (/^GetList|^Get/.test(endpoint.path.slice(endpoint.path.lastIndexOf('/')))) assert.equal(endpoint.minIntervalMs, 600000, `${key}: 10분에 1회`);
    if (/^View/.test(endpoint.path.slice(endpoint.path.lastIndexOf('/')))) assert.equal(endpoint.minIntervalMs, 1000, `${key}: 1초에 1회`);
  }
  assert.equal(ERP_OAPI_ENDPOINTS.zone.authed, false);
  assert.equal(ERP_OAPI_ENDPOINTS.login.authed, false);
  assert.equal(ERP_OAPI_ENDPOINTS.saveSale.listKey, 'SaleList');
  assert.equal(ERP_OAPI_ENDPOINTS.saveBasicProduct.listKey, 'ProductList');
  assert.ok(ERP_OAPI_STOP_CODES.has(201) && ERP_OAPI_STOP_CODES.has(99) && !ERP_OAPI_STOP_CODES.has(1));
  assert.equal(MULTI_VALUE_SEPARATOR, '∬');
});

// ---------------------------------------------------------------------------
// ecount: envelope
// ---------------------------------------------------------------------------

test('QUANTITY_INFO parses the documented wording and reports anything else as unknown', () => {
  const quota = parseQuotaInfo('시간당 연속 오류 제한 건수: 1/30, 1시간 허용량: 3/6000, 1일 허용량: 13/10000');
  assert.equal(quota.known, true);
  assert.deepEqual([quota.consecutiveErrors, quota.hourly, quota.daily], [{ used: 1, limit: 30 }, { used: 3, limit: 6000 }, { used: 13, limit: 10000 }]);
  assert.equal(parseQuotaInfo('').known, false);
  assert.deepEqual(parseQuotaInfo('문구가 바뀌었습니다'), { raw: '문구가 바뀌었습니다', known: false }, 'a reworded quota is a gap, not a zero');
  assert.equal(parseQuotaInfo('1/30, 3/6000').known, false, 'two pairs is not the documented three');
});

test('ResultDetails / SlipNos arrive as JSON-encoded strings and must be decoded', () => {
  assert.deepEqual(decodeJsonField('[{"IsSuccess":true}]', 'ResultDetails'), [{ IsSuccess: true }]);
  assert.deepEqual(decodeJsonField(['a'], 'x'), ['a']);
  assert.deepEqual(decodeJsonField('[]', 'SlipNos'), []);
  assert.deepEqual(decodeJsonField(null, 'SlipNos'), []);
  assert.deepEqual(decodeJsonField('', 'SlipNos'), []);
  assert.deepEqual(decodeJsonField('{"a":1}', 'x'), [{ a: 1 }]);
  assert.throws(() => decodeJsonField('{oops', 'ResultDetails'), (e) => e.code === 'envelope_unparseable' && e.field === 'ResultDetails');
});

const EP = { path: '/OAPI/V2/Test', minIntervalMs: 0, authed: true };
const envelope = (data, extra = {}) => ({ Status: '200', Error: null, Data: data, Timestamp: '2026-10-26', ...extra });

test('HTTP status and envelope Status are both insufficient to decide success', () => {
  const notFound = interpretResponse({ httpStatus: 404, body: { text: 'No HTTP resource was found' }, endpoint: EP });
  assert.equal(notFound.envelopeError.code, 'http_404_path_absent');
  assert.equal(notFound.ok, false);

  for (const status of [412, 302]) {
    const limited = interpretResponse({ httpStatus: status, body: null, endpoint: EP });
    assert.equal(limited.envelopeError.code, 'rate_limited');
    assert.equal(limited.envelopeError.retryAfterMs, 600000);
  }

  const deadSession = interpretResponse({ httpStatus: 500, body: { Status: '500', Error: { Code: 'EXP00001', Message: 'Please login.' } }, endpoint: EP });
  assert.equal(deadSession.envelopeError.code, 'session_invalid');

  const server = interpretResponse({
    httpStatus: 500,
    body: { Status: '500', Error: { Code: 500, Message: '서버 오류' }, Errors: [{ ProgramId: 'P', Name: 'N', Code: 432, Message: 'm', Param: '' }] },
    endpoint: EP,
  });
  assert.equal(server.envelopeError.code, 'server_error');
  assert.deepEqual(server.envelopeError.errors, [{ ProgramId: 'P', Name: 'N', Code: 432, Message: 'm', Param: '' }], 'the live 500 Errors array must survive');

  assert.equal(interpretResponse({ httpStatus: 200, body: 'not json', endpoint: EP }).envelopeError.code, 'body_unparseable');
  assert.equal(interpretResponse({ httpStatus: 200, body: { Status: '302', Error: { Code: 900, Message: 'limit' } }, endpoint: EP }).envelopeError.code, 'status_302');

  // The vendor's own login-failure example: Status 200 with Error.Code 201.
  const loginFail = interpretResponse({ httpStatus: 200, body: envelope(null, { Error: { Code: 201, Message: 'Zone 정보가 없습니다.', MessageDetail: 'd' } }), endpoint: EP });
  assert.equal(loginFail.ok, false);
  assert.equal(loginFail.envelopeError.code, 'api_error');
  assert.equal(loginFail.envelopeError.codeId, 201);
  assert.equal(loginFail.envelopeError.detail, 'd');

  assert.equal(interpretResponse({ httpStatus: 200, body: envelope({ Result: [{ OK: 1 }], TotalCnt: '1' }), endpoint: EP }).ok, true);
  assert.equal(interpretResponse({ httpStatus: 200, body: envelope(null), endpoint: EP }).ok, true, 'Status 200 with no Data is a success');
});

test('a batch is only ok when every row succeeded', () => {
  const partial = interpretResponse({
    httpStatus: 200,
    endpoint: EP,
    body: envelope({
      SuccessCnt: '1', FailCnt: '1', TotalCnt: 2,
      ResultDetails: JSON.stringify([{ IsSuccess: true }, { IsSuccess: false, TotalError: '품목코드가 없습니다' }]),
      SlipNos: JSON.stringify([1234]),
      TRACE_ID: 'trace-1',
      QUANTITY_INFO: '시간당 연속 오류 제한 건수: 1/30, 1시간 허용량: 3/6000, 1일 허용량: 13/10000',
    }),
  });
  assert.equal(partial.ok, false, '1 of 2 rows failing is not success');
  assert.equal(partial.rows.length, 2);
  assert.equal(partial.envelopeError.code, 'row_failures');
  assert.match(partial.envelopeError.message, /품목코드가 없습니다/);
  assert.deepEqual(partial.slipNos, [1234]);
  assert.equal(partial.traceId, 'trace-1');
  assert.equal(partial.quota.consecutiveErrors.limit, 30);

  const clean = interpretResponse({
    httpStatus: 200, endpoint: EP,
    body: envelope({ SuccessCnt: '2', FailCnt: '0', ResultDetails: JSON.stringify([{ IsSuccess: true }, { IsSuccess: true }]) }),
  });
  assert.equal(clean.ok, true);

  const countsLie = interpretResponse({
    httpStatus: 200, endpoint: EP,
    body: envelope({ SuccessCnt: '2', FailCnt: '1', ResultDetails: JSON.stringify([{ IsSuccess: true }]) }),
  });
  assert.equal(countsLie.ok, false, 'FailCnt>0 must not be overridden by all-true rows');
});

// ---------------------------------------------------------------------------
// ecount: planning layer
// ---------------------------------------------------------------------------

test('date formatting is the vendor YYYYMMDD, in local time, and refuses garbage', () => {
  assert.equal(ecountDate(new Date(2026, 9, 26)), '20261026');
  assert.equal(ecountDate('2026-01-05T00:00:00'), '20260105');
  assert.throws(() => ecountDate('not-a-date'), /unparseable date/);
});

test('list wrapping is {<ListKey>:[{BulkDatas}]} exactly once per row', () => {
  const rows = [{ PROD_CD: 'SS-1' }, { PROD_CD: 'SS-2' }];
  assert.deepEqual(bulkRows(rows), [{ BulkDatas: rows[0] }, { BulkDatas: rows[1] }]);
  assert.deepEqual(Object.keys(wrapList('saveBasicProduct', rows)), ['ProductList']);
  assert.equal(wrapList('saveSaleOrder', rows).SaleOrderList.length, 2);
  assert.throws(() => wrapList('viewBasicProduct', rows), /no list wrapper/);
});

test('required columns and field lengths are enforced from the vendor tables', () => {
  assert.deepEqual(OAPI_REQUIRED_FIELDS.saveSaleOrder, ['UPLOAD_SER_NO', 'CUST', 'WH_CD', 'PROD_CD', 'QTY']);
  assert.deepEqual(OAPI_REQUIRED_FIELDS.saveSale, ['UPLOAD_SER_NO', 'WH_CD', 'PROD_CD', 'QTY']);
  assert.equal(OAPI_FIELD_LIMITS.PROD_CD, 20);
  assert.equal(OAPI_FIELD_LIMITS.UPLOAD_SER_NO, 4);
  assert.equal(OAPI_FIELD_LIMITS.CUST, 30);

  const missing = validateRow('saveSaleOrder', { PROD_CD: 'SS-1', QTY: '1' });
  assert.deepEqual(missing.map((p) => `${p.field}:${p.reason}`).sort(), ['CUST:required', 'UPLOAD_SER_NO:required', 'WH_CD:required']);
  assert.deepEqual(validateRow('saveBasicProduct', { PROD_CD: 'X'.repeat(21), PROD_DES: 'ok' }), [{ field: 'PROD_CD', reason: 'too_long', length: 21, limit: 20 }]);
  assert.deepEqual(validateRow('saveBasicCust', { BUSINESS_NO: '', CUST_NAME: 'x' })[0], { field: 'BUSINESS_NO', reason: 'required' });
  assert.deepEqual(validateRow('saveSale', { UPLOAD_SER_NO: '1', WH_CD: '00001', PROD_CD: 'SS-1', PROD_DES: 'x', QTY: '0' })[0].reason, 'must_be_positive');
  assert.deepEqual(validateRow('saveBasicProduct', { PROD_CD: 'SS-1', PROD_DES: 'x', PROD_TYPE: '9' })[0].reason, 'not_a_code');
  assert.equal(validateRow('saveBasicProduct', { PROD_CD: 'SS-1', PROD_DES: 'x', PROD_TYPE: '3', UNIT: 'EA' }).length, 0);
  assert.equal(validateRow('saveBasicProduct', { PROD_CD: 'SS-1', PROD_DES: 'x', UNIT: '개' }).length, 0, '2 chars inside the 6-char UNIT bound');
});

test('a value the vendor column cannot hold is rejected, never silently truncated', () => {
  const order = { id: 'ORD-1', created_at: '2026-10-26T02:00:00.000Z' };
  const long = '상'.repeat(101);
  const rows = slipRows({ order, items: [{ erp_code: 'SS-1', product_name: long, qty: 1, unit_price: 1000 }], cust: '00001', whCd: '00001' });
  assert.equal(rows[0].PROD_DES.length, 101, 'slipRows must not rewrite the value');
  const plan = planSlip({ order, items: [{ erp_code: 'SS-1', product_name: long, qty: 1, unit_price: 1000 }], cust: '00001', whCd: '00001' });
  assert.equal(plan.acceptedCount, 0);
  assert.deepEqual(plan.rejected[0].problems, [{ field: 'PROD_DES', reason: 'too_long', length: 101, limit: 100 }]);
  assert.equal(plan.batches.length, 0, 'a rejected row produces no batch, so nothing can be transmitted');
});

test('slip planning groups every line of one order under a single UPLOAD_SER_NO', () => {
  const order = { id: 'ORD-9', paid_at: '2026-10-20T02:00:00.000Z', erp_cust_cd: '00035', erp_wh_cd: '00001' };
  const items = [
    { erp_code: 'SS-3836', product_name: 'SQ5+', qty: 1, unit_price: 1680000, option_label: 'A&D 케이블 포함' },
    { erp_code: 'SM-2574', product_name: 'SPX-8K', qty: 2, unit_price: 365000 },
  ];
  const plan = planSlip({ endpoint: 'saveSaleOrder', order, items, maxRowsPerCall: 50 });
  assert.equal(plan.acceptedCount, 2);
  assert.equal(plan.transmitted, false);
  const body = plan.batches[0].body.SaleOrderList.map((b) => b.BulkDatas);
  assert.deepEqual(new Set(body.map((r) => r.UPLOAD_SER_NO)), new Set(['1']), 'one document per order');
  assert.deepEqual(body.map((r) => r.PROD_CD), ['SS-3836', 'SM-2574']);
  assert.equal(body[0].REMARKS, 'A&D 케이블 포함');
  assert.equal(body[1].REMARKS, '', 'a missing option label is an empty remark, not an invented one');
  assert.equal(body[0].IO_DATE, ecountDate(order.paid_at));
  assert.equal(body[0].CUST, '00035', 'resolved from the order when the caller passes nothing');
  assert.equal(plan.batches[0].dedupeKey, 'saveSaleOrder:order:ORD-9:batch1');
  assert.equal(plan.dedupeKey, 'saveSaleOrder:order:ORD-9');

  const many = planSlip({ order, items: Array.from({ length: 5 }, (_, i) => ({ erp_code: `SS-${i}`, product_name: 'x', qty: 1, unit_price: 1 })), maxRowsPerCall: 2 });
  assert.deepEqual(many.batches.map((b) => b.rowCount), [2, 2, 1]);
  assert.deepEqual(many.batches.map((b) => b.dedupeKey), ['saveSaleOrder:order:ORD-9:batch1', 'saveSaleOrder:order:ORD-9:batch2', 'saveSaleOrder:order:ORD-9:batch3'], 'batches need distinct dedupe keys');

  // A walk-in retail order has no ERP 거래처: every line must be refused rather
  // than sent and failed row-by-row on the vendor's quota.
  const noCust = planSlip({ order: { id: 'ORD-10', created_at: '2026-10-26T02:00:00.000Z' }, items: [{ erp_code: 'SS-1', product_name: 'x', qty: 1, unit_price: 1 }] });
  assert.equal(noCust.acceptedCount, 0);
  assert.deepEqual(noCust.rejected[0].problems.map((p) => p.field).sort(), ['CUST', 'WH_CD']);
});

test('slipRows refuses to build anything without an order id', () => {
  assert.throws(() => slipRows({ items: [] }), /order.id is required/);
  assert.throws(() => planSlip({ endpoint: 'nope', order: { id: 'X' } }), /unknown endpoint/);
});

test('product and customer planning classifies rows before any batch is built', () => {
  const productPlan = planProductSync([
    { productId: 'SS-3836', productName: 'SQ5+', outPrice: 1680000, barCode: '8801234567890' },
    { productId: '', productName: '이름만 있음' },
    { productId: 'X'.repeat(25), productName: '코드 너무 김' },
    { productId: 'SM-1', productName: '' },
  ]);
  assert.equal(productPlan.acceptedCount, 1);
  assert.equal(productPlan.batches[0].body.ProductList[0].BulkDatas.PROD_CD, 'SS-3836');
  assert.equal(productPlan.batches[0].body.ProductList[0].BulkDatas.OUT_PRICE_VAT, '1');
  assert.equal(productPlan.batches[0].body.ProductList[0].BulkDatas.TAX, '10');
  // A record with no id must NOT be sent as a fabricated "XX-" code: that would
  // create a junk row in the ERP master, which is worse than refusing locally.
  assert.deepEqual(productPlan.rejected.map((r) => r.PROD_CD), ['', 'X'.repeat(25), 'SM-1']);
  assert.deepEqual(productPlan.rejected[0].problems, [{ field: 'PROD_CD', reason: 'required' }]);
  assert.deepEqual(productPlan.rejected[1].problems[0].reason, 'too_long');
  assert.deepEqual(productPlan.rejected[2].problems, [{ field: 'PROD_DES', reason: 'required' }]);
  assert.deepEqual(productRow({ productName: '이름만 있음' }).PROD_CD, '');

  const custPlan = planCustomerSync([
    { businessNo: '123-45-67890', name: '합성거래처', addr: '광주광역시 테스트로 1' },
    { businessNo: '', name: '번호 없음' },
  ]);
  assert.equal(custPlan.acceptedCount, 1);
  assert.equal(custPlan.batches[0].body.CustList.length, 1);
  assert.equal(custPlan.rejected[0].problems[0].field, 'BUSINESS_NO');
  assert.deepEqual(Object.keys(productRow({ productId: 'SS-1', productName: 'x' })).sort(), ['BAL_FLAG', 'PROD_CD', 'PROD_DES', 'PROD_TYPE', 'SIZE_DES', 'TAX', 'UNIT'].sort());
  assert.equal(custRow({}).G_GUBUN, '01');
});

test('inventory read picks the endpoint the code count requires and chunks with the vendor separator', () => {
  const single = planInventoryRead({ baseDate: '20261026', prodCds: ['SS-3836'] });
  assert.equal(single.endpoint, 'viewInventoryBalance');
  assert.equal(single.minIntervalMs, 1000);
  assert.equal(single.chunks[0].body.PROD_CD, 'SS-3836');

  const many = planInventoryRead({ prodCds: ['A', 'B', 'C'], chunkSize: 2, whCd: '00035', flags: { BAL_FLAG: 'Y' } });
  assert.equal(many.endpoint, 'listInventoryBalance');
  assert.equal(many.minIntervalMs, 600000);
  assert.match(many.note, /10 minutes/);
  assert.deepEqual(many.chunks.map((c) => c.body.PROD_CD), [`A∬B`, 'C']);
  assert.equal(many.chunks[0].body.BAL_FLAG, 'Y');
  assert.equal(many.chunks[0].body.WH_CD, '00035');

  assert.equal(planInventoryRead({ prodCds: [] }).endpoint, 'listInventoryBalance', 'a full sweep is a list read');
  assert.equal(planInventoryRead({ prodCds: ['A'], byLocation: true }).endpoint, 'viewInventoryBalanceByLocation');
  assert.equal(planInventoryRead({ prodCds: ['A', 'B'], byLocation: true }).endpoint, 'listInventoryBalanceByLocation');
  assert.equal(planInventoryRead({ prodCds: ['A', '', '  ', 'B'] }).chunks[0].prodCds.length, 2, 'blank codes are dropped, not sent');
});

// ---------------------------------------------------------------------------
// mapping material already in this repository
// ---------------------------------------------------------------------------

test('CSV reader survives BOM, CRLF, quotes, embedded commas, newlines and ""', () => {
  const csv = '﻿ 상품명,품목코드,규격\r\n"SQ5+, 블랙",SS-3836,"2"\r\n"He said ""hi""",SM-2574,\r\n"line1\nline2",ZZ-1,x\r\n,,,,\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3, 'an all-blank line is dropped');
  assert.equal(rows[0].prodDes, 'SQ5+, 블랙', 'comma inside quotes stays in the field');
  assert.equal(rows[0].erpProdCd, 'SS-3836', 'Korean header aliased to the ASCII key');
  assert.equal(rows[0].상품명, 'SQ5+, 블랙', 'the original header is kept too');
  assert.equal(rows[1].prodDes, 'He said "hi"');
  assert.equal(rows[2].prodDes, 'line1\nline2', 'newline inside quotes is data');
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
});

test('공급처원본ID normalises to the CGI product id', () => {
  assert.equal(normalizeCgiId('samasound:3836'), 'samasound.co.kr:3836');
  assert.equal(normalizeCgiId(' samamusic:2574 '), 'samamusic.co.kr:2574');
  assert.equal(normalizeCgiId('samasound.co.kr:3836'), 'samasound.co.kr:3836');
  assert.equal(normalizeCgiId('unknownsite:1'), 'unknownsite:1', 'an unknown alias is kept, never guessed at');
  assert.equal(normalizeCgiId(''), '');
});

test('buildMappingSet labels where each 품목코드 came from, and only an ERP match is verified', () => {
  // Rows come from parseCsv, the same path the committed prep files use, so the
  // Korean-header alias layer is exercised rather than assumed.
  const extendedRows = parseCsv([
    '공급처원본ID,품목코드,상품명,바코드,공개판매가',
    'samasound:3836,SS-3836,"SQ5+, 블랙",8801,"1,680,000"',
    'samamusic:2574,SM-2574,SPX-8K,,',
    'yamaha:77,YM-77,U1,,0',
  ].join('\n'));
  const records = buildMappingSet({
    extendedRows,
    uploadRows: parseCsv('품목코드,상품명,단위,출고단가\nSS-3836,SQ5+,EA,1680000'),
    smartstoreRows: parseCsv('공급처원본ID,네이버상품ID,가격확인필요,판매자코드\nsamasound:3836,,예,samasound.co.kr:3836'),
    erpMasterRows: [{ PROD_CD: 'SM-2574', BAR_CODE: '' }, { PROD_CD: 'OTHER', BAR_CODE: '8801' }],
  });
  assert.equal(records.length, 3);
  const byId = new Map(records.map((r) => [r.cgiId, r]));
  const ss = byId.get('samasound.co.kr:3836');
  assert.equal(ss.erpProdCdSource, 'erp_barcode', 'the ERP master holds this barcode, so the real code is OTHER');
  assert.equal(ss.erpProdCd, 'OTHER');
  assert.equal(ss.erpProdCdVerified, true);
  assert.equal(ss.erpProdCdProposed, 'SS-3836');
  assert.equal(ss.prodDes, 'SQ5+, 블랙', 'the comma inside the quoted name survived the join');
  assert.deepEqual(ss.price, { value: 1680000, text: '1,680,000', state: 'public' });
  assert.equal(ss.outPrice, 1680000);
  assert.equal(ss.naverItemId, null, 'the prep file reserves 네이버상품ID empty for every row');
  assert.equal(ss.sellerManagementCode, 'samasound.co.kr:3836');
  assert.deepEqual(ss.joins, { extended: true, upload: true, smartstore: true });

  const ym = byId.get('yamaha.co.kr:77');
  assert.equal(ym.erpProdCdSource, 'cgi_synthetic');
  assert.equal(ym.erpProdCdVerified, false);
  assert.equal(ym.erpProdCd, 'YM-77', 'the proposal is still carried, flagged as unverified');
  assert.deepEqual(ym.price, { value: 0, text: '0', state: 'public' }, 'a zero price is measured, not treated as missing');

  const spx = byId.get('samamusic.co.kr:2574');
  assert.equal(spx.erpProdCdSource, 'erp_code_exact');
  assert.equal(spx.price.state, 'unknown', 'no price and no inquiry flag is "unknown", never 0');
  for (const record of records) {
    assert.equal(typeof record.erpProdCdVerified, 'boolean', `${record.cgiId}: the verified flag must not be a short-circuit value`);
    assert.ok(['erp_code_exact', 'erp_barcode', 'cgi_synthetic'].includes(record.erpProdCdSource));
  }

  const coverage = coverageOf(records);
  assert.equal(coverage.total, 3);
  assert.equal(coverage.erpProdCdVerified, 2);
  assert.equal(coverage.erpProdCdSynthetic, 1);
  assert.equal(coverage.naverItemId, 0);
  assert.equal(coverage.pricePublic, 2, 'the empty price is not public');
  assert.equal(coverage.priceUnknown, 1);
  assert.equal(coverage.fullyJoinedAllThree, 1);
  assert.equal(coverage.rates.naverItemId, 0);

  assert.deepEqual(resolveErpProdCd('samasound.co.kr:3836', records).status, 'verified');
  assert.equal(resolveErpProdCd('yamaha.co.kr:77', records).status, 'register_first');
  assert.deepEqual(resolveErpProdCd('nope:1', records), { status: 'unmapped', prodCd: null, reason: 'no mapping row for nope:1' });
  assert.deepEqual(saleableRows(records).map((r) => r.cgiId).sort(), ['samasound.co.kr:3836', 'yamaha.co.kr:77']);
  assert.deepEqual(duplicateProdCds(records), []);
  assert.deepEqual(duplicateProdCds([...records, { erpProdCdProposed: 'YM-77' }]), [{ code: 'YM-77', count: 2 }]);
});

// ---------------------------------------------------------------------------
// naver 커머스: pure contract logic
// ---------------------------------------------------------------------------

test('the 커머스API limits are the documented numbers and nothing else', () => {
  assert.equal(NCOM_LIMITS.salePriceMax, 999999990);
  assert.equal(NCOM_LIMITS.stockQuantityMax, 99999999);
  assert.equal(NCOM_LIMITS.standardOptionStockWhenUnmanaged, 9999);
  assert.equal(NCOM_LIMITS.imagesPerUploadCall, 10);
  assert.equal(NCOM_LIMITS.searchSizeMax, 500);
  assert.equal(NCOM_LIMITS.orderPageSizeMax, 300);
  assert.ok(NCOM_UNCONFIRMED.length >= 6);
  for (const gap of NCOM_UNCONFIRMED) assert.equal(typeof gap, 'string');
  assert.ok(NCOM_ENDPOINTS.imageUpload.multipart, 'image upload is multipart, not JSON');
  assert.equal(NCOM_ENDPOINTS.token.authed, false);
  assert.ok(NCOM_RESPONSIBILITY.rule.includes('read-only'));
  assert.ok(NCOM_RESPONSIBILITY.ecountNative.length && NCOM_RESPONSIBILITY.thisAdapter.length);
});

test('gateway classification drives the retry decision, not the HTTP status alone', () => {
  const headers = { 'GNCP-GW-RateLimit-Limit': '100', 'GNCP-GW-RateLimit-Remaining': '0', 'content-type': 'application/json' };
  const rate = classifyNcomResponse({ httpStatus: 429, body: { code: 'GW.RATE_LIMIT', message: 'm', traceId: 't' }, headers });
  assert.equal(rate.ok, false);
  assert.equal(rate.family, 'gateway');
  assert.equal(rate.retryable, true);
  assert.equal(rate.rateLimited, true);
  assert.deepEqual(Object.keys(rate.rateHeaders).sort(), ['gncp-gw-ratelimit-limit', 'gncp-gw-ratelimit-remaining'], 'only the rate headers are kept');

  assert.equal(classifyNcomResponse({ httpStatus: 403, body: { code: 'GW.IP_NOT_ALLOWED' }, headers: {} }).stopped, true);
  assert.equal(classifyNcomResponse({ httpStatus: 403, body: { code: 'GW.IP_NOT_ALLOWED' }, headers: {} }).retryable, false);
  assert.equal(classifyNcomResponse({ httpStatus: 404, body: { code: 'GW.NOT_FOUND' }, headers: {} }).pathNotRegistered, true);
  assert.equal(classifyNcomResponse({ httpStatus: 404, body: { code: 'GW.NOT_FOUND' }, headers: {} }).retryable, false);
  assert.equal(classifyNcomResponse({ httpStatus: 401, body: { code: 'GW.AUTHN' }, headers: {} }).reauth, true);
  assert.equal(classifyNcomResponse({ httpStatus: 503, body: { code: 'GW.BLOCK.01' }, headers: {} }).retryable, true);

  const domain = classifyNcomResponse({ httpStatus: 400, body: { code: 'DUPLICATE', message: '중복', traceId: 'd' }, headers: {} });
  assert.equal(domain.family, 'domain');
  assert.equal(domain.retryable, false);
  assert.deepEqual(domain.raw, { code: 'DUPLICATE', message: '중복', traceId: 'd' }, 'the undocumented domain shape is passed through untouched');

  assert.equal(classifyNcomResponse({ httpStatus: 200, body: { code: null, data: {} }, headers: {} }).ok, true);
  assert.equal(classifyNcomResponse({ httpStatus: 200, body: { code: 'GW.AUTHN' }, headers: {} }).ok, true, 'a 200 is a 200: the code table is about failures');
});

test('search body uses the documented keyword type and never exceeds size 500', () => {
  assert.deepEqual(searchBySellerCodeBody('code'), { searchKeywordType: 'SELLER_CODE', sellerManagementCode: 'code', page: 1, size: 500 });
  assert.equal(searchBySellerCodeBody('code', { size: 5000 }).size, 500);
  assert.deepEqual(searchBySellerCodeBody('code', { productStatusTypes: ['SALE'] }).productStatusTypes, ['SALE']);
  assert.equal('searchKeyword' in searchBySellerCodeBody('code'), false, 'SELLER_CODE lookups carry the code field only');
  assert.deepEqual(clampOrderPageSize(301), { pageSize: 300, clamped: true, reason: 'pageSize must be 1..300' });
  assert.deepEqual(clampOrderPageSize(0), { pageSize: 300, clamped: true, reason: 'unset defaults to the documented maximum' });
  assert.equal(clampOrderPageSize(1).pageSize, 1);
});

test('register body enforces every documented bound locally', () => {
  const base = { prodDes: 'SQ5+', price: { value: 1680000 }, stockQuantity: 12, sellerManagementCode: 'samasound.co.kr:3836' };
  const okImages = { representative: 'https://prd-phinf.pstatic.net/x.png', additional: [], uploadedViaImageApi: true };
  const good = buildRegisterBody(base, { leafCategoryId: '50005556', images: okImages, detailContent: '상세' });
  assert.deepEqual(good.problems, []);
  assert.equal(good.body.originProduct.statusType, 'SALE');
  assert.equal(good.body.smartstoreChannelProduct.naverShoppingRegistration, false, 'off unless the operator opts in');
  assert.equal(good.body.smartstoreChannelProduct.channelProductDisplayStatusType, 'ON');
  assert.equal(good.body.originProduct.leafCategoryId, '50005556');

  const reasons = (record, opts) => buildRegisterBody(record, opts).problems.map((p) => `${p.field}:${p.reason}`);
  assert.deepEqual(reasons({ ...base, stockQuantity: null }, { leafCategoryId: '1', images: okImages, detailContent: 'x' }), ['stockQuantity:required_at_register']);
  assert.ok(reasons({ ...base, price: { value: null } }, { leafCategoryId: '1', images: okImages, detailContent: 'x' }).includes('salePrice:no_public_price'));
  assert.ok(reasons({ ...base, price: { value: NCOM_LIMITS.salePriceMax + 10 } }, { leafCategoryId: '1', images: okImages, detailContent: 'x' }).some((r) => r.startsWith('salePrice:out_of_bounds')));
  assert.ok(reasons({ ...base, prodDes: '  ' }, { leafCategoryId: '1', images: okImages, detailContent: 'x' }).includes('name:required'));
  assert.ok(reasons(base, { leafCategoryId: '', images: okImages, detailContent: '' }).includes('leafCategoryId:required_at_register'));
  assert.ok(reasons(base, { leafCategoryId: '1', images: { representative: null }, detailContent: 'x' }).includes('images.representative:required'));
  assert.ok(reasons(base, { leafCategoryId: '1', images: {}, detailContent: 'x' }).includes('images.representative:required'));
  // The consequential one: a direct link to our own host is a real URL, so it is
  // present but not usable — the vendor only accepts upload-API URLs.
  assert.ok(reasons(base, { leafCategoryId: '1', images: { representative: 'https://www.samasound.co.kr/web/product/small/x.png' }, detailContent: 'x' }).includes('images.representative:not_from_image_upload_api'));
  assert.equal(buildRegisterBody(base, { leafCategoryId: '1', images: { ...okImages, additional: Array.from({ length: 30 }, (_, i) => `u${i}`) }, detailContent: 'x' }).body.originProduct.images.additional.length, NCOM_LIMITS.extraImagesMax);
  assert.equal(buildRegisterBody(base, { leafCategoryId: '1', images: okImages, detailContent: 'x', channel: { channelProductDisplayStatusType: 'SUSPENSION' } }).body.smartstoreChannelProduct.channelProductDisplayStatusType, 'SUSPENSION');
  assert.equal(buildRegisterBody(base, { leafCategoryId: '1', images: okImages, detailContent: 'x', optionInfo: { optionSimple: [] } }).body.originProduct.detailAttribute.optionInfo.optionSimple.length, 0);
});

test('ERP balance to Naver stock keeps reasons distinct and floors the quantity', () => {
  const map = new Map([
    ['A', { naverItemId: 1 }],
    ['B', { naverItemId: 2, optionManaged: true }],
    ['C', {}],
    ['D', { naverItemId: 4 }],
  ]);
  const out = stockFromErpBalance({
    erpRows: [
      { PROD_CD: 'A', BAL_QTY: '7.9' },
      { PROD_CD: 'B', BAL_QTY: '0.0000000000' },
      { PROD_CD: 'C', BAL_QTY: '3' },
      { PROD_CD: 'D', BAL_QTY: '-5' },
      { PROD_CD: 'E', BAL_QTY: '1' },
      { PROD_CD: 'D', BAL_QTY: 'N/A' },
      { PROD_CD: '', BAL_QTY: '5' },
    ],
    mappingByProdCd: map,
  });
  assert.deepEqual(out.updates.map((u) => [u.prodCd, u.endpointKey, u.stockQuantity]), [['A', 'productModifyOrigin', 7], ['B', 'optionStock', 0]]);
  assert.deepEqual(out.rejected.map((r) => r.reason), ['no_naver_channel_product', 'negative_balance', 'unmapped_prod_cd', 'unreadable_BAL_QTY', 'unreadable_BAL_QTY']);
  assert.equal(out.updates[0].dedupeKey, 'ncom:stock:1:7.9', 'the dedupe key uses the measured value, not the floored one');
  assert.equal(out.counts.updates, 2);
  assert.deepEqual(Object.keys(out), ['updates', 'rejected', 'counts']);
});
