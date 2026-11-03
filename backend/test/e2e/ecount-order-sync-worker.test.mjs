import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { prepareEcountSaleOrder, transmitEcountSaleOrder } from '../../lib/ecount-order-adapter.mjs';
import { pricedProductIds, makeTossEnv, makeEnv, call, auth, CUSTOMER, purchaseCart } from '../helpers.mjs';
import { signMockWindowPayload } from '../../lib/pg-nicepay-adapter.mjs';
import { closeAllMockOapiServers, startMockOapiServer } from '../helpers/mock-erp-oapi.mjs';

after(closeAllMockOapiServers);

const [PRODUCT_A, PRODUCT_B] = pricedProductIds(2);

function configuredEnv(mock, overrides = {}) {
  return makeTossEnv({
    ECOUNT_ORDER_SYNC_ENABLED: 'YES',
    ECOUNT_TARGET: 'test',
    ERP_MODE: 'mock',
    ERP_MOCK_BASE_URL: mock.baseUrl,
    ECOUNT_COM_CODE: 'MOCK-COM',
    ECOUNT_USER_ID: 'MOCK-USER',
    ECOUNT_API_CERT_KEY: 'FAKE-CERTIFICATE-ONLY',
    ECOUNT_DEFAULT_CUST_CODE: 'ONLINE-CUSTOMER',
    ECOUNT_DEFAULT_WH_CD: 'MAIN',
    ECOUNT_ITEM_CODE_MAP_JSON: JSON.stringify({ [PRODUCT_A]: 'EC-ITEM-A', [PRODUCT_B]: 'EC-ITEM-B' }),
    ...overrides,
  });
}

async function createAndPay(env, paymentKey = 'pk_ecount_test') {
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  const paid = await call(env, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey,
    amount: created.json.totals.total_amount,
  });
  assert.equal(paid.status, 200, paid.text);
  return { orderId: created.json.id, created: created.json, paid };
}

async function erpRow(env, orderId) {
  return env.DB.prepare('SELECT * FROM erp_sync WHERE order_id = ?').bind(orderId).first();
}

test('paid order uses Zone, login and SaleOrder once; duplicate payment and retry reuse its receipt', async () => {
  const mock = await startMockOapiServer();
  const env = configuredEnv(mock);
  const { orderId, paid } = await createAndPay(env);

  assert.equal(paid.json.erp_sync.status, 'sent');
  assert.deepEqual(mock.pathsSeen(), [
    '/OAPI/V2/Zone', '/OAPI/V2/OAPILogin', '/OAPI/V2/SaleOrder/SaveSaleOrder',
  ]);
  const sale = mock.calls.find((entry) => entry.path.endsWith('/SaveSaleOrder'));
  assert.equal(sale.query.SESSION_ID, 'MOCK_SESSION_ID');
  assert.equal(sale.body.SaleOrderList.length, 2);
  assert.deepEqual(sale.body.SaleOrderList.map((row) => row.BulkDatas.PROD_CD), ['EC-ITEM-A', 'EC-ITEM-B']);

  const row = await erpRow(env, orderId);
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 1);
  assert.equal(row.adapter, 'ecount-oapi-v2');
  const persisted = JSON.stringify(JSON.parse(row.payload));
  for (const sensitive of [CUSTOMER.email, CUSTOMER.phone, CUSTOMER.addr, 'FAKE-CERTIFICATE-ONLY']) {
    assert.equal(persisted.includes(sensitive), false, 'ERP receipt stores no customer contact/address or credential');
  }

  const duplicatePayment = await call(env, 'POST', '/api/payments/confirm', {
    orderId, paymentKey: 'pk_ecount_test', amount: paid.json.order.totals.total_amount,
  });
  assert.equal(duplicatePayment.status, 200);
  const retry = await call(env, 'POST', `/api/orders/${orderId}/erp/retry`, {}, auth());
  assert.equal(retry.status, 200);
  assert.equal(retry.json.status, 'sent');
  assert.equal(mock.state.saleOrderCreatedCount, 1);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM erp_sync WHERE order_id = ?').bind(orderId).first()).count, 1);
  await mock.close();
});

test('NICEPAY payment return also sends one SaleOrder and its replay is idempotent', async () => {
  const mock = await startMockOapiServer();
  const env = makeEnv({
    PG_PROVIDER: 'nicepay', PG_PROVIDER_MODE: 'mock',
    ECOUNT_ORDER_SYNC_ENABLED: 'YES', ECOUNT_TARGET: 'test', ERP_MODE: 'mock', ERP_MOCK_BASE_URL: mock.baseUrl,
    ECOUNT_COM_CODE: 'MOCK-COM', ECOUNT_USER_ID: 'MOCK-USER', ECOUNT_API_CERT_KEY: 'FAKE-CERTIFICATE-ONLY',
    ECOUNT_DEFAULT_CUST_CODE: 'ONLINE-CUSTOMER', ECOUNT_DEFAULT_WH_CD: 'MAIN',
    ECOUNT_ITEM_CODE_MAP_JSON: JSON.stringify({ [PRODUCT_A]: 'EC-ITEM-A', [PRODUCT_B]: 'EC-ITEM-B' }),
  });
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  const payload = signMockWindowPayload({ tid: 'NICE-ERP-PAID', orderId: created.json.id, amount: created.json.totals.total_amount });
  const returned = await call(env, 'POST', '/api/payments/nicepay/return', payload);
  assert.equal(returned.status, 302);
  const row = await erpRow(env, created.json.id);
  assert.equal(row.status, 'sent');
  assert.equal(mock.state.saleOrderCreatedCount, 1);

  await call(env, 'POST', '/api/payments/nicepay/return', payload);
  assert.equal(mock.state.saleOrderCreatedCount, 1, 'return URL replay does not create a second ECOUNT document');
  await mock.close();
});

test('login failure is recorded without changing the paid order or sending a sale order', async () => {
  const mock = await startMockOapiServer({ loginError: { Code: 201, Message: 'invalid mock login' } });
  const env = configuredEnv(mock);
  const { orderId, paid } = await createAndPay(env, 'pk_ecount_login_201');

  assert.equal(paid.json.order.status, 'paid');
  assert.equal((await erpRow(env, orderId)).status, 'failed');
  assert.deepEqual(mock.pathsSeen(), ['/OAPI/V2/Zone', '/OAPI/V2/OAPILogin']);
  assert.equal(mock.state.saleOrderCreatedCount, 0);
  await mock.close();
});

test('network failure before sale registration is retryable through the same order receipt', async () => {
  const mock = await startMockOapiServer({ networkFailNextPath: '/OAPI/V2/OAPILogin' });
  const env = configuredEnv(mock);
  const { orderId, paid } = await createAndPay(env, 'pk_ecount_network_retry');
  assert.equal(paid.json.order.status, 'paid');
  assert.equal((await erpRow(env, orderId)).status, 'failed');
  assert.equal((await erpRow(env, orderId)).attempts, 1);

  const retried = await call(env, 'POST', `/api/orders/${orderId}/erp/retry`, {}, auth());
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.status, 'sent');
  assert.equal(retried.json.attempts, 2);
  assert.equal(mock.state.saleOrderCreatedCount, 1);
  await mock.close();
});

test('lost response after ECOUNT registered the sale order is unknown and cannot be blindly retried', async () => {
  const mock = await startMockOapiServer({ dropSaleOrderResponseAfterWrite: true });
  const env = configuredEnv(mock);
  const { orderId, paid } = await createAndPay(env, 'pk_ecount_ambiguous');
  assert.equal(paid.json.order.status, 'paid');
  assert.equal((await erpRow(env, orderId)).status, 'unknown');
  assert.equal(mock.state.saleOrderCreatedCount, 1);

  const retry = await call(env, 'POST', `/api/orders/${orderId}/erp/retry`, {}, auth());
  assert.equal(retry.json.status, 'unknown');
  assert.equal(retry.json.attempts, 1);
  assert.equal(mock.state.saleOrderCreatedCount, 1, 'ambiguous registration is never sent twice');
  await mock.close();
});

test('expired session triggers a fresh Zone and login before one successful retry', async () => {
  const mock = await startMockOapiServer({ expireSessionOnWrite: true });
  const env = {
    ECOUNT_ORDER_SYNC_ENABLED: 'YES', ERP_MODE: 'mock', ERP_MOCK_BASE_URL: mock.baseUrl,
    ECOUNT_COM_CODE: 'MOCK-COM', ECOUNT_USER_ID: 'MOCK-USER', ECOUNT_API_CERT_KEY: 'FAKE-CERTIFICATE-ONLY',
    ECOUNT_TARGET: 'test', ECOUNT_DEFAULT_CUST_CODE: 'ONLINE-CUSTOMER', ECOUNT_DEFAULT_WH_CD: 'MAIN',
    ECOUNT_ITEM_CODE_MAP_JSON: JSON.stringify({ [PRODUCT_A]: 'EC-ITEM-A' }),
  };
  const order = { id: 'ORDER-SESSION-1', status: 'paid', payment_status: 'paid', shipping_fee: 0, created_at: '2026-11-03T00:00:00.000Z' };
  const items = [{ product_id: PRODUCT_A, product_name: 'Mock item', qty: 1, unit_price: 100, line_total: 100, option_label: '' }];
  const prepared = prepareEcountSaleOrder({ env, order, items });
  assert.equal(prepared.ready, true);
  let time = 1_700_000_000_000;
  const sent = await transmitEcountSaleOrder(prepared, { env, now: () => time, sleep: async (ms) => { time += ms; } });

  assert.equal(sent.status, 'sent');
  assert.deepEqual(mock.pathsSeen(), [
    '/OAPI/V2/Zone', '/OAPI/V2/OAPILogin', '/OAPI/V2/SaleOrder/SaveSaleOrder',
    '/OAPI/V2/Zone', '/OAPI/V2/OAPILogin', '/OAPI/V2/SaleOrder/SaveSaleOrder',
  ]);
  assert.equal(mock.state.saleOrderCreatedCount, 1, 'expired-session request was rejected before creating a slip');
  await mock.close();
});

test('switch off, missing API secret and missing approved item mapping make no request and record not configured', async () => {
  const offMock = await startMockOapiServer();
  const offEnv = configuredEnv(offMock, { ECOUNT_ORDER_SYNC_ENABLED: 'NO' });
  const off = await createAndPay(offEnv, 'pk_ecount_off');
  assert.equal((await erpRow(offEnv, off.orderId)).status, 'not_configured');
  assert.equal((await erpRow(offEnv, off.orderId)).attempts, 0);
  assert.deepEqual(offMock.pathsSeen(), []);
  await offMock.close();

  const secretMock = await startMockOapiServer();
  const missingSecretEnv = configuredEnv(secretMock, { ECOUNT_API_CERT_KEY: '' });
  const missingSecret = await createAndPay(missingSecretEnv, 'pk_ecount_missing_secret');
  const missingSecretRow = await erpRow(missingSecretEnv, missingSecret.orderId);
  assert.equal(missingSecretRow.status, 'not_configured');
  assert.match(missingSecretRow.last_error, /ECOUNT_API_CERT_KEY/);
  assert.deepEqual(secretMock.pathsSeen(), []);
  await secretMock.close();

  const mapMock = await startMockOapiServer();
  const missingMapEnv = configuredEnv(mapMock, { ECOUNT_ITEM_CODE_MAP_JSON: '{}' });
  const missingMap = await createAndPay(missingMapEnv, 'pk_ecount_missing_map');
  assert.match((await erpRow(missingMapEnv, missingMap.orderId)).last_error, /item_mapping_missing|product_mapping_missing/);
  assert.deepEqual(mapMock.pathsSeen(), []);
  await mapMock.close();
});

test('unpaid orders cannot create an ECOUNT receipt or send a request', async () => {
  const mock = await startMockOapiServer();
  const env = configuredEnv(mock);
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  const result = await call(env, 'POST', `/api/orders/${created.json.id}/erp`, {}, auth());
  assert.equal(result.json.status, 'not_configured');
  assert.equal(result.json.note, 'payment_not_complete');
  assert.equal(await erpRow(env, created.json.id), null);
  assert.deepEqual(mock.pathsSeen(), []);
  await mock.close();
});
