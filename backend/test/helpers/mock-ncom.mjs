// Mock of the Naver Commerce API gateway + domain behaviour for tests only.
// Loopback-bound, like the ecount mock. Error payloads are copied from the
// documented gateway table so the classifier is tested against the vendor's
// real shape, including the GW.NOT_FOUND case that proves a path is invented.

import http from 'node:http';

const ROUTES = new Set([
  '/external/v1/oauth2/token',
  '/external/v2/products',
  '/external/v1/products/search',
  '/external/v1/pay-order/seller/product-orders',
  '/external/v1/product-images/upload',
]);

function originRoute(pathname) {
  const origin = pathname.match(/^\/external\/v2\/products\/origin-products\/([^/]+)$/);
  const option = pathname.match(/^\/external\/v1\/products\/origin-products\/([^/]+)\/option-stock$/);
  const channel = pathname.match(/^\/external\/v2\/products\/channel-products\/([^/]+)$/);
  if (origin) return { kind: 'origin', id: origin[1] };
  if (option) return { kind: 'optionStock', id: option[1] };
  if (channel) return { kind: 'channel', id: channel[1] };
  return null;
}

/**
 * Servers opened and not yet closed. A failing assertion throws past a test's
 * own `close()`, and the leftover listening socket keeps node's test runner
 * alive until its timeout, so one `after` hook covers every exit path.
 */
const OPEN = new Set();

export async function closeAllMockNcomServers() {
  for (const mock of [...OPEN]) await mock.close();
}

export async function startMockNcomServer(overrides = {}) {
  const state = {
    clientId: 'MOCK_CLIENT_ID',
    clientSecret: '$2a$10$MOCKSALTMOCKSALTMOCKSALT',
    accessToken: 'MOCK_ACCESS_TOKEN',
    expiresIn: 3600,
    tokenError: null,          // {http, code, message}
    failRequest: null,         // one-shot {http, code, message}
    sellerCodeIndex: new Set(),
    originProductNo: 500001,
    orderPageSizeSeen: null,
    calls: [],
    ...overrides,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), headers: { ...req.headers }, raw, body: null };
      try { record.body = raw.includes('=') && !raw.startsWith('{') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw); } catch (e) { record.body = { raw }; }
      state.calls.push(record);

      const reply = (httpStatus, payload) => {
        if (state.failRequest && !record.path.endsWith('/oauth2/token')) {
          const forced = state.failRequest;
          if (forced.consume !== false) state.failRequest = null;
          res.writeHead(forced.http, { 'Content-Type': 'application/json', 'GNCP-GW-RateLimit-Limit': '100', 'GNCP-GW-RateLimit-Remaining': '0' });
          res.end(JSON.stringify({ code: forced.code, message: forced.message, timestamp: '2026-10-26T07:57:11.369+09:00', traceId: 'mock-trace' }));
          return;
        }
        res.writeHead(httpStatus, { 'Content-Type': 'application/json', 'GNCP-GW-RateLimit-Limit': '100', 'GNCP-GW-RateLimit-Remaining': '99' });
        res.end(JSON.stringify(payload));
      };

      if (record.path === '/external/v1/oauth2/token') {
        if (state.tokenError) {
          reply(state.tokenError.http, { code: state.tokenError.code, message: state.tokenError.message, timestamp: '2026-10-26T07:00:00.000+09:00', traceId: 'mock-trace-token' });
          return;
        }
        reply(200, { access_token: state.accessToken, token_type: 'bearer', expires_in: state.expiresIn });
        return;
      }

      if (record.headers.authorization !== `Bearer ${state.accessToken}`) {
        reply(401, { code: 'GW.AUTHN', message: '요청을 보낼 권한이 없습니다.', timestamp: '2026-10-26T07:00:00.000+09:00', traceId: 'mock-trace-authn' });
        return;
      }

      if (record.path === '/external/v1/products/search') {
        const hit = state.sellerCodeIndex.has(String(record.body?.sellerManagementCode || ''));
        reply(200, {
          code: null,
          message: null,
          traceId: 'mock-trace-search',
          data: {
            contents: hit ? [{ originProductNo: 500001, statusType: 'SALE', sellerManagementCode: record.body.sellerManagementCode }] : [],
            page: record.body?.page ?? 1,
            size: record.body?.size ?? 500,
            totalElements: hit ? 1 : 0,
            hasNext: false,
          },
        });
        return;
      }

      if (record.path === '/external/v2/products' && req.method === 'POST') {
        if (state.sellerCodeIndex.has(String(record.body?.originProduct?.detailAttribute?.sellerCodeInfo?.sellerManagementCode || ''))) {
          reply(400, { code: 'DUPLICATE_SELLER_MANAGEMENT_CODE', message: '중복된 판매자 관리 코드입니다.', traceId: 'mock-trace-dup' });
          return;
        }
        const detail = record.body?.originProduct?.detailAttribute || {};
        const bad = [];
        if (record.body?.originProduct?.salePrice > 999999990) bad.push('salePrice');
        if (record.body?.originProduct?.stockQuantity > 99999999) bad.push('stockQuantity');
        if (!detail.sellerCodeInfo?.sellerManagementCode) bad.push('sellerManagementCode');
        if (bad.length) {
          reply(400, { code: 'INVALID_PARAMETER', message: `검증 실패: ${bad.join(', ')}`, traceId: 'mock-trace-invalid' });
          return;
        }
        reply(200, {
          traceId: 'mock-trace-register',
          data: {
            originProductNo: state.originProductNo,
            smartstoreChannelProductNo: state.originProductNo + 1000,
            originProduct: record.body.originProduct,
            smartstoreChannelProduct: record.body.smartstoreChannelProduct,
          },
        });
        return;
      }

      const routed = originRoute(record.path);
      if (routed) {
        reply(200, {
          traceId: `mock-trace-${routed.kind}`,
          data: {
            originProductNo: Number(routed.id),
            smartstoreChannelProductNo: Number(routed.id) + 1000,
            receivedKind: routed.kind,
            receivedMethod: req.method,
            echo: record.body,
          },
        });
        return;
      }

      if (record.path === '/external/v1/pay-order/seller/product-orders') {
        state.orderPageSizeSeen = url.searchParams.get('pageSize');
        reply(200, {
          traceId: 'mock-trace-orders',
          data: {
            contents: [{
              orderId: 'MOCKORDER000',
              productOrderId: 'MOCKPRODUCTORDER001',
              productId: '500001',
              originalProductId: '500001',
              groupProductId: '500001',
              productOrderStatus: 'PAY_CONFIRMED',
              items: [{ optionCode: '500001|option1', optionManageCode: 'MOCKOPT1', sellerProductCode: 'samamusic:2574', count: { remainQuantity: 2 } }],
            }],
          },
        });
        return;
      }

      reply(404, { code: 'GW.NOT_FOUND', message: '요청하신 리소스를 찾을 수 없습니다.', timestamp: '2026-10-26T07:00:00.000+09:00', traceId: 'mock-trace-404' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const mock = {
    baseUrl: `http://127.0.0.1:${port}/external`,
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
