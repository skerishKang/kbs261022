import assert from 'node:assert/strict';
import test from 'node:test';

import { call, CUSTOMER, makeEnv, pricedProductIds } from '../helpers.mjs';
import { windowReturnSignature } from '../../lib/pg-nicepay.mjs';

const CLIENT = 'FAKE-CLIENT-DIAGNOSTIC';
const SECRET = 'FAKE-SECRET-DIAGNOSTIC';

function env() {
  return makeEnv({
    PG_PROVIDER: 'nicepay',
    PG_PROVIDER_MODE: 'live',
    PG_NICEPAY_ENV: 'operating',
    NICEPAY_OPERATING_CLIENT_KEY: CLIENT,
    NICEPAY_OPERATING_SECRET_KEY: SECRET,
    ECOUNT_ORDER_SYNC_ENABLED: 'NO',
  });
}

async function paidAttempt(e, fetchImpl) {
  const created = await call(e, 'POST', '/api/orders', {
    items: [{ product_id: pricedProductIds(1)[0], qty: 1 }], ...CUSTOMER,
  });
  assert.equal(created.status, 201, created.text);
  const amount = created.json.totals.total_amount;
  const tid = 'UT-FAKE-DIAGNOSTIC-1';
  const authToken = 'FAKE-TOKEN-DIAGNOSTIC';
  const signatureData = {
    authResultCode: '0000',
    authResultMsg: '인증 성공',
    tid,
    orderId: created.json.id,
    clientId: CLIENT,
    amount,
    authToken,
    signature: windowReturnSignature({ authToken, clientId: CLIENT, amount, secretKey: SECRET }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await call(e, 'POST', '/api/payments/confirm', {
      orderId: created.json.id, paymentKey: tid, amount, signatureData,
    });
    assert.equal(result.status, 402, result.text);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const row = await e.DB.prepare('SELECT status, failure_code, failure_message, raw FROM payments WHERE order_id = ?')
    .bind(created.json.id).first();
  const order = await e.DB.prepare('SELECT payment_status FROM orders WHERE id = ?').bind(created.json.id).first();
  return { row, order };
}

test('a network failure records fetch_failed and the host, never the credentials', async () => {
  const { row, order } = await paidAttempt(env(), async () => { throw new TypeError('fetch failed'); });
  assert.equal(row.failure_code, 'fetch_failed');
  assert.match(row.failure_message, /api\.nicepay\.co\.kr/);
  const raw = JSON.parse(row.raw);
  assert.equal(raw.resultCode, 'fetch_failed');
  assert.match(raw.message || raw.resultMsg, /api\.nicepay\.co\.kr/);
  assert.match(raw.endpoint, /\/v1\/payments/);
  const stored = JSON.stringify(row);
  assert.equal(stored.includes(SECRET), false);
  assert.equal(stored.includes(CLIENT), false);
  assert.equal(order.payment_status, 'pending', 'a failed approval must not mark the order paid');
});

test('a NICEPAY resultCode and resultMsg are kept in failure_code and raw', async () => {
  const { row } = await paidAttempt(env(), async () => new Response(JSON.stringify({
    resultCode: 'A001', resultMsg: '금액이 일치하지 않습니다.',
  }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
  assert.equal(row.failure_code, 'A001');
  assert.match(row.failure_message, /금액이 일치하지 않습니다/);
  const raw = JSON.parse(row.raw);
  assert.equal(raw.resultCode, 'A001');
  assert.match(raw.resultMsg, /금액이 일치하지 않습니다/);
  assert.equal(JSON.stringify(row).includes(SECRET), false);
});
