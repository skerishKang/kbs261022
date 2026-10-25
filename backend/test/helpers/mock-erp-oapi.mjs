// Mock of the ecountOS Open API V2 wire contract, for tests only.
//
// It is deliberately built to the *vendor's* documented behaviour rather than
// to whatever the client would like to see, because the point of these tests is
// to catch a client that assumes the wrong contract:
//   - unknown controller path  -> 404 "No HTTP resource was found"
//   - known path, no SESSION_ID -> 500 + EXP00001 "Please login."
//   - throttled                -> 412
//   - per-row validation       -> HTTP 200, Status "200", Error null,
//                                 SuccessCnt 0 and ResultDetails as a JSON STRING
//   - login refusal            -> HTTP 200, Status "200", Error{Code:201}
// Everything binds to 127.0.0.1, matching the loopback rule in erp-oapi.mjs.

import http from 'node:http';

const KNOWN_PATHS = new Set([
  '/OAPI/V2/Zone',
  '/OAPI/V2/OAPILogin',
  '/OAPI/V2/AccountBasic/SaveBasicCust',
  '/OAPI/V2/InventoryBasic/SaveBasicProduct',
  '/OAPI/V2/InventoryBasic/ViewBasicProduct',
  '/OAPI/V2/InventoryBasic/GetBasicProductsList',
  '/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatus',
  '/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatus',
  '/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatusByLocation',
  '/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation',
  '/OAPI/V2/Quotation/SaveQuotation',
  '/OAPI/V2/SaleOrder/SaveSaleOrder',
  '/OAPI/V2/Sale/SaveSale',
]);

const LIST_KEYS = ['CustList', 'ProductList', 'QuotationList', 'SaleOrderList', 'SaleList'];

/** The vendor's own "필수 항목" tables, per path. */
const REQUIRED_BY_PATH = {
  '/OAPI/V2/AccountBasic/SaveBasicCust': ['BUSINESS_NO', 'CUST_NAME'],
  '/OAPI/V2/InventoryBasic/SaveBasicProduct': ['PROD_CD', 'PROD_DES'],
  '/OAPI/V2/SaleOrder/SaveSaleOrder': ['UPLOAD_SER_NO', 'CUST', 'WH_CD', 'PROD_CD', 'QTY'],
  '/OAPI/V2/Sale/SaveSale': ['UPLOAD_SER_NO', 'WH_CD', 'PROD_CD', 'QTY'],
  '/OAPI/V2/Quotation/SaveQuotation': ['UPLOAD_SER_NO', 'PROD_CD', 'QTY'],
};

/**
 * Only these create a 전표, so only these may carry Data.SlipNos. The vendor's
 * 품목등록 success example is literally `"SlipNos": null`, and a mock that
 * handed out a document number for a master-registration call would let a
 * client believe it had booked a slip when it had only added an item.
 */
const SLIP_PATHS = new Set(['/OAPI/V2/Quotation/SaveQuotation', '/OAPI/V2/SaleOrder/SaveSaleOrder', '/OAPI/V2/Sale/SaveSale']);

/**
 * Every server this module has opened and nobody closed yet. A test that fails
 * on an assertion throws past its own `close()`, and the leftover listening
 * socket keeps node's test runner alive until its timeout — so a 250ms file
 * reports ~120s and hides how long it actually took. Callers get one line in an
 * `after` hook instead of a close() on every exit path.
 */
const OPEN = new Set();

export async function closeAllMockOapiServers() {
  for (const mock of [...OPEN]) await mock.close();
}

function quotaText(state) {
  return `시간당 연속 오류 제한 건수: ${state.consecutiveErrors}/${state.consecutiveErrorLimit}, 1시간 허용량: ${state.hourlyUsed}/6000, 1일 허용량: ${state.dailyUsed}/10000`;
}

export async function startMockOapiServer(overrides = {}) {
  const state = {
    sessionId: 'MOCK_SESSION_ID',
    zone: 'AA',
    loginError: null,          // {Code, Message} returned inside Status 200
    requireSession: true,
    rateLimitNext: false,
    consecutiveErrors: 0,
    consecutiveErrorLimit: 30,
    hourlyUsed: 3,
    dailyUsed: 13,
    failProdCds: new Set(),
    unknownPathStatus: 404,
    slipNo: '20261026-1',
    inventory: [{ PROD_CD: 'SS-3836', BAL_QTY: '3.0000000000' }],
    knownPaths: new Set(KNOWN_PATHS),
    calls: [],
    ...overrides,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = { __invalid: raw.slice(0, 200) }; }
      const record = {
        method: req.method,
        path,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: { ...req.headers },
        body,
        raw,
      };
      state.calls.push(record);

      const respond = (status, payload) => {
        if (state.rateLimitNext) {
          state.rateLimitNext = false;
          res.writeHead(412, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Forbidden: request limit exceeded' }));
          return;
        }
        if (!state.knownPaths.has(path)) {
          res.writeHead(state.unknownPathStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            Message: `No HTTP resource was found that matches the request URI 'https://sboapi.ecount.com${path}'.`,
          }));
          return;
        }
        const authed = path !== '/OAPI/V2/Zone' && path !== '/OAPI/V2/OAPILogin';
        if (authed && state.requireSession && url.searchParams.get('SESSION_ID') !== state.sessionId) {
          state.consecutiveErrors += 1;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            Status: '500',
            Error: { Code: 'EXP00001', Message: 'Please login.', MessageDetail: '' },
            Errors: [{ ProgramId: 'MOCK', Name: 'session', Code: 'EXP00001', Message: 'Please login.', Param: '' }],
            Data: null,
            Timestamp: null,
          }));
          return;
        }
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (path === '/OAPI/V2/Zone') {
        const com = String(body.COM_CODE || '');
        if (!com) {
          respond(500, { Status: '500', Error: { Code: 100, Message: 'Zone 정보가 없습니다.', MessageDetail: '' }, Data: null, Timestamp: null });
          return;
        }
        respond(200, { Status: '200', Error: null, Data: { ZONE: state.zone, DOMAIN: '.ecount.com', EXPIRE_DATE: '' }, Timestamp: '2026년 10월 26일 오전 5:00:00' });
        return;
      }

      if (path === '/OAPI/V2/OAPILogin') {
        if (state.loginError) {
          respond(200, { Status: '200', Error: { Code: state.loginError.Code, Message: state.loginError.Message, MessageDetail: '' }, Data: null, Timestamp: null });
          return;
        }
        respond(200, {
          Status: '200',
          Error: null,
          Data: { Code: '00', Datas: { COM_CODE: body.COM_CODE, USER_ID: body.USER_ID, SESSION_ID: state.sessionId }, NOTICE: '', EXPIRE_DATE: '', RedirectUrl: '', Message: '' },
          Timestamp: '2026년 10월 26일 오전 5:00:00',
        });
        return;
      }

      if (path.includes('InventoryBalance') || path === '/OAPI/V2/InventoryBasic/ViewBasicProduct' || path === '/OAPI/V2/InventoryBasic/GetBasicProductsList') {
        const result = path.includes('InventoryBalance') ? state.inventory : [{ PROD_CD: 'SS-3836', PROD_DES: 'SQ5+', UNIT: 'EA', PROD_TYPE: '3', OUT_PRICE: '1200000.0000000000' }];
        respond(200, {
          Status: '200',
          Error: null,
          Data: { IsSuccess: true, EXPIRE_DATE: '', QUANTITY_INFO: quotaText(state), TRACE_ID: 'mock-trace-read', TotalCnt: result.length, Result: result },
          Timestamp: '2026년 10월 26일 오전 5:00:00',
        });
        return;
      }

      const listKey = LIST_KEYS.find((key) => Array.isArray(body[key]));
      const rows = listKey ? body[listKey] : null;
      if (!rows) {
        respond(200, {
          Status: '200',
          Error: null,
          Data: { SuccessCnt: 0, FailCnt: 0, ResultDetails: '[]', SlipNos: null, EXPIRE_DATE: '', QUANTITY_INFO: quotaText(state), TRACE_ID: 'mock-trace-empty' },
          Timestamp: null,
        });
        return;
      }

      const details = rows.map((entry, index) => {
        const data = entry.BulkDatas || {};
        const prodCd = String(data.PROD_CD || '');
        const required = REQUIRED_BY_PATH[path] || [];
        const missing = required.filter((field) => data[field] === undefined || String(data[field]).trim() === '');
        if (missing.length) {
          return { IsSuccess: false, TotalError: `[${index}]${missing[0]} (필수)`, Errors: missing.map((ColCd) => ({ ColCd, Message: `${ColCd} (필수)` })), Code: null };
        }
        if (state.failProdCds.has(prodCd)) {
          return { IsSuccess: false, TotalError: `[전표묶음 ${index}] 품목코드 (존재하지 않는 품목)`, Errors: [{ ColCd: 'PROD_CD', Message: '존재하지 않는 품목' }], Code: null };
        }
        return { IsSuccess: true, TotalError: `[전표묶음 ${index}] OK`, Errors: [], Code: null };
      });
      const failed = details.filter((d) => !d.IsSuccess);
      if (failed.length) state.consecutiveErrors += 1;
      else state.consecutiveErrors = 0;
      state.hourlyUsed += 1;
      state.dailyUsed += 1;

      respond(200, {
        Status: '200',
        Error: null,
        Data: {
          EXPIRE_DATE: '',
          QUANTITY_INFO: quotaText(state),
          TRACE_ID: `mock-trace-${state.calls.length}`,
          SuccessCnt: details.length - failed.length,
          FailCnt: failed.length,
          // The vendor sends this as a JSON-encoded string, so the mock must too.
          ResultDetails: JSON.stringify(details),
          SlipNos: SLIP_PATHS.has(path) && failed.length === 0 ? JSON.stringify([state.slipNo]) : null,
        },
        Timestamp: '2026년 10월 26일 오전 5:00:00',
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const mock = {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    calls: state.calls,
    pathsSeen: () => state.calls.map((c) => c.path),
    closed: false,
    close() {
      if (mock.closed) return Promise.resolve();
      mock.closed = true;
      OPEN.delete(mock);
      // undici keeps its pooled socket alive, so server.close() alone would sit
      // on an open connection until the test runner's timeout fired.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
  OPEN.add(mock);
  return mock;
}
