import assert from 'node:assert/strict';
import test from 'node:test';

import { call, CUSTOMER, makeTossEnv } from '../helpers.mjs';

const PAYTEST_ID = 'cgi:paytest-1000';

function env() {
  return makeTossEnv({ SHIPPING_FEE_DEFAULT: '0' });
}

function cart(qty, extra = {}) {
  return { items: [{ product_id: PAYTEST_ID, qty, ...extra }], ...CUSTOMER };
}

test('hidden paytest product creates a payable 1,000 KRW order and confirms payment', async () => {
  const e = env();
  const created = await call(e, 'POST', '/api/orders', cart(1));
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.kind, 'purchase');
  assert.equal(created.json.totals.item_total, 1000);
  assert.equal(created.json.totals.shipping_fee, 0);
  assert.equal(created.json.totals.total_amount, 1000);
  assert.equal(created.json.items[0].price_state, 'public');
  assert.equal(created.json.items[0].unit_price, 1000);

  const paid = await call(e, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: 'pk_paytest_open',
    amount: 1000,
  });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.json.approved, true);
  assert.equal(paid.json.order.status, 'paid');
});

test('paytest product rejects a quantity above one and a tampered price', async () => {
  const e = env();
  const tooMany = await call(e, 'POST', '/api/orders', cart(2));
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.error, 'paytest_quantity_limit');

  const three = await call(e, 'POST', '/api/orders', cart(3));
  assert.equal(three.status, 400);
  assert.equal(three.json.error, 'paytest_quantity_limit');

  const tampered = await call(e, 'POST', '/api/orders', cart(1, { unit_price: 999 }));
  assert.equal(tampered.status, 400);
  assert.equal(tampered.json.error, 'price mismatch');
});

test('a paytest order with a wrong amount is refused at confirmation', async () => {
  const e = env();
  const created = await call(e, 'POST', '/api/orders', cart(1));
  assert.equal(created.status, 201, created.text);
  const paid = await call(e, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: 'pk_paytest_wrong_amount',
    amount: 2000,
  });
  assert.equal(paid.status, 400);
  assert.equal(paid.json.error, 'amount mismatch');
});
