// Smoke test: boot the Worker against the D1 shim and walk the public path.
// Exit code 0/1 so CI can treat it as a hard gate.
//
//   node --experimental-sqlite test/smoke.mjs

import assert from 'node:assert/strict';

import worker from '../worker.js';
import { openD1 } from '../d1-shim.mjs';
import { PRICE_INDEX } from '../data/price_index.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const EVIL = 'http://evil.example.com';
const TOKEN = 'smoke-admin-token';

const env = {
  DB: openD1(),
  ADMIN_TOKEN: TOKEN,
  PG_PROVIDER_MODE: 'mock',
  ERP_LIVE_WRITE: 'NO',
  ERP_MODE: 'test',
  SHIPPING_FEE_DEFAULT: '0',
};

let passed = 0;
const checks = [];

function step(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    checks.push(`  ok - ${name}`);
  }, (e) => {
    checks.push(`  NOT OK - ${name}\n    ${e && e.message ? e.message.split('\n').slice(0, 6).join('\n    ') : e}\n    ${e && e.stack ? e.stack.split('\n')[2] || '' : ''}`);
    process.exitCode = 1;
  });
}

async function assertEqual(name, actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return actual;
}

async function request(method, path, body, headers = {}) {
  const init = { method, headers: { Origin: EVIL, ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await worker.fetch(new Request(`http://cgi.local${path}`, init), env);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  const h = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return { status: res.status, json, text, headers: h };
}

async function check(name, fn) {
  await step(name, fn);
}

const authed = { Authorization: `Bearer ${TOKEN}` };
const authedOrigin = { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN };
const priced = Object.entries(PRICE_INDEX)
  .filter(([, e]) => Number.isFinite(e.p) && e.p > 0)
  .slice(0, 2)
  .map(([id]) => id);

// 1. Schema must initialise behind admin auth and be idempotent.
await check('schema init is admin-only and idempotent', async () => {
  const denied = await request('POST', '/api/admin/schema/init', {});
  assert.equal(denied.status, 401);
  const first = await request('POST', '/api/admin/schema/init', {}, authedOrigin);
  assert.equal(first.status, 200, first.text);
  const second = await request('POST', '/api/admin/schema/init', {}, authedOrigin);
  assert.equal(second.status, 200, second.text);
});

// 2. Health reports the modes and never leaks secret material.
await check('health reports modes and leaks no secret', async () => {
  const res = await request('GET', '/api/admin/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.pg.mode, 'mock');
  assert.equal(res.json.pg.live, false);
  assert.equal(res.json.erp.live_write, false);
  assert.equal(res.text.includes(TOKEN), false);
});

// 3. CORS stays pinned to the one allowed origin.
await check('CORS is pinned for real requests', async () => {
  const res = await request('GET', '/api/orders', undefined, authed);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(res.text.includes(EVIL), false);
  const preflight = await request('OPTIONS', '/api/orders', undefined, {
    Origin: EVIL,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,authorization',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
});

// 4. Order creation is priced by the server, not the client.
let order;
await check('order creation uses the server price index', async () => {
  const tampered = await request('POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 1, unit_price: 1 }],
    company: 'smoke', name: 'smoke', phone: '010-0000-0000',
  });
  assert.equal(tampered.status, 400);
  assert.equal(tampered.json.error, 'price mismatch');

  const created = await request('POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 2 }, { product_id: priced[1], qty: 1 }],
    company: '[SMOKE] 회사', name: '[SMOKE] 담당자', phone: '010-0000-0001',
    idempotency_key: 'smoke-key-1',
  }, { Origin: ORIGIN });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.kind, 'purchase');
  assert.equal(created.json.status, 'awaiting_payment');
  assert.equal(created.json.payable, true);
  order = created.json;
});

await check('idempotency key replays the same order', async () => {
  const again = await request('POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 2 }, { product_id: priced[1], qty: 1 }],
    company: '[SMOKE] 회사', name: '[SMOKE] 담당자', phone: '010-0000-0001',
    idempotency_key: 'smoke-key-1',
  }, { Origin: ORIGIN });
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent, true);
  assert.equal(again.json.id, order.id);
});

// 5. Payment is confirmed by the mock PG in deterministic test mode.
let paymentKey;
await check('payment confirm marks the order paid', async () => {
  const res = await request('POST', '/api/payments/confirm', {
    orderId: order.id,
    paymentKey: 'smoke_pkey_1',
    amount: order.totals.total_amount,
    paymentMethod: '카드',
  }, { Origin: ORIGIN });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.approved, true);
  assert.equal(res.json.payment.provider_mode, 'mock');
  assert.equal(res.json.order.status, 'paid');
  assert.equal(res.json.order.payment_status, 'paid');
  paymentKey = res.json.payment.payment_key;
});

await check('amount tampering is rejected', async () => {
  const created = await request('POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 1 }],
    company: '[SMOKE] 회사', name: '[SMOKE] 담당자', phone: '010-0000-0002',
    idempotency_key: 'smoke-key-2',
  }, { Origin: ORIGIN });
  assert.equal(created.status, 201);
  const bad = await request('POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: 'smoke_pkey_2',
    amount: created.json.totals.total_amount - 1,
  }, { Origin: ORIGIN });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'amount mismatch');
});

// 6. Refunds are bounded by the paid amount.
await check('refund honours the paid balance', async () => {
  const res = await request('POST', `/api/orders/${order.id}/payments/${paymentKey}/cancel`, {
    cancelAmount: 1000,
    cancelReason: 'smoke partial refund',
  }, authedOrigin);
  assertEqual('partial refund status', res.status, 200);
  if (res.status !== 200) throw new Error(`body: ${JSON.stringify(res.json)}`);
  assertEqual('partial refund amount', res.json.cancel_amount, 1000);
  assertEqual('partial refund payment status', res.json.payment_status, 'partial_refunded');

  const again = await request('POST', `/api/orders/${order.id}/payments/${paymentKey}/cancel`, {
    cancelAmount: 1000,
    cancelReason: 'smoke partial refund',
  }, authedOrigin);
  assertEqual('refund replay status', again.status, 200);
  assertEqual('refund replay idempotent', again.json.idempotent, true);

  const dust = await request('POST', `/api/orders/${order.id}/payments/${paymentKey}/cancel`, {
    cancelAmount: 100,
    cancelReason: 'smoke dust',
  }, authedOrigin);
  assertEqual('dust refund status', dust.status, 400);
  assertEqual('dust refund error', dust.json.error, 'invalid cancelAmount');
});

// 7. Unpriced carts become quote orders and cannot be paid.
await check('unpriced cart becomes an unpaid quote order', async () => {
  const created = await request('POST', '/api/orders', {
    items: [{ product_id: '__no_price__', qty: 1 }],
    company: '[SMOKE] 회사', name: '[SMOKE] 담당자', phone: '010-0000-0003',
  }, { Origin: ORIGIN });
  assert.equal(created.status, 201);
  assert.equal(created.json.kind, 'quote');
  assert.equal(created.json.payable, false);

  const pay = await request('POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: 'smoke_pkey_3',
    amount: created.json.totals.total_amount,
  }, { Origin: ORIGIN });
  assert.equal(pay.status, 409);
});

// 8. ERP payloads are built but never transmitted in test mode.
await check('ERP sync is built, never transmitted', async () => {
  const res = await request('POST', `/api/orders/${order.id}/erp`, {}, authedOrigin);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.delivered, false);
  assert.equal(res.json.mode, 'test');
  assert.ok(res.json.payload_lines > 0);
});

console.log(`# smoke: ${passed}/${checks.length}`);
checks.forEach((line) => console.log(line));
console.log(process.exitCode ? '# smoke: FAIL' : '# smoke: PASS');
