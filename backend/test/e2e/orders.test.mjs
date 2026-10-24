import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PRICE_INDEX } from '../../data/price_index.mjs';
import { makeEnv, call, CUSTOMER, purchaseCart, mixedCart, pricedProductIds } from '../helpers.mjs';

const [PA, PB] = pricedProductIds(2);
const PRICE_A = PRICE_INDEX[PA].p;
const PRICE_B = PRICE_INDEX[PB].p;

test('creates a payable purchase order from a fully priced cart', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });

  assert.equal(res.status, 201, res.text);
  const order = res.json;
  assert.match(order.id, /^ORD-\d{8}-[A-Z2-9]{5}$/);
  assert.equal(order.kind, 'purchase');
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.payment_status, 'pending');
  assert.equal(order.payable, true);
  assert.equal(order.linked_quote_id, null);

  const expected = PRICE_A * 2 + PRICE_B;
  assert.equal(order.totals.item_total, expected);
  assert.equal(order.totals.total_amount, expected);
  assert.equal(order.totals.supplied_amount + order.totals.vat_amount, expected);
  assert.equal(order.totals.supplied_amount, Math.round(expected / 1.1));

  assert.equal(order.items.length, 2);
  assert.equal(order.items.reduce((sum, i) => sum + i.line_total, 0), expected);
  assert.ok(order.items.every((i) => i.unit_price > 0));
  // ERP item codes are internal accounting data: persisted server-side and
  // verified through the ERP sync payload, never returned to the customer.
  assert.ok(order.items.every((i) => i.erp_code === undefined));
  assert.equal(order.customer.phone, CUSTOMER.phone);
  assert.ok(order.created_at);
  assert.equal(order.status_label, '결제 대기');
});

test('server is authoritative on prices: client price is ignored', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/api/orders', {
    ...CUSTOMER,
    items: [{ product_id: PA, qty: 1 }],
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.totals.total_amount, PRICE_A, 'price comes from the catalog index');
});

test('rejects a client-supplied price that disagrees with the catalog', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/api/orders', {
    ...CUSTOMER,
    items: [{ product_id: PA, qty: 1, unit_price: 1 }],
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'price mismatch');
  assert.equal(res.json.detail, `server price for ${PA} is ${PRICE_A}`);
});

test('creates a quote order when any item price is unconfirmed', async () => {
  const env = makeEnv();
  const cart = mixedCart();
  const res = await call(env, 'POST', '/api/orders', { ...cart, ...CUSTOMER });

  assert.equal(res.status, 201, res.text);
  const order = res.json;
  assert.equal(order.kind, 'quote');
  assert.equal(order.status, 'pending');
  assert.equal(order.status_label, '접수 대기');
  assert.equal(order.payment_status, 'none');
  assert.equal(order.payable, false);
  assert.equal(order.totals.total_amount, PRICE_A, 'only the priced line is counted');

  assert.ok(order.items.some((i) => i.unit_price === null && i.price_state === 'inquiry'));
  assert.ok(order.linked_quote_id, 'links to the legacy quote_requests row');

  const listed = await call(env, 'GET', '/api/quotes', undefined, { Authorization: 'Bearer test-admin-token' });
  assert.equal(listed.status, 200);
  assert.ok(listed.json.items.some((q) => q.id === order.linked_quote_id), 'mirrored into quote_requests');
});

test('quote order for a cart with no priced item stays at zero', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/api/orders', {
    ...CUSTOMER,
    items: [{ product_id: 'samasound.co.kr:3836', qty: 1 }, { product_id: 'does-not-exist:1', qty: 2 }],
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.kind, 'quote');
  assert.equal(res.json.totals.total_amount, 0);
  assert.equal(res.json.payable, false);
});

test('shipping fee from the environment is added server-side', async () => {
  const env = makeEnv({ SHIPPING_FEE_DEFAULT: '6000' });
  const res = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.totals.shipping_fee, 6000);
  assert.equal(res.json.totals.total_amount, PRICE_A * 2 + PRICE_B + 6000);
});

test('rejects orders without items or without a customer', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/api/orders', {})).status, 400);
  assert.equal((await call(env, 'POST', '/api/orders', { ...CUSTOMER, items: [] })).status, 400);
  assert.equal((await call(env, 'POST', '/api/orders', { items: [{ product_id: PA, qty: 1 }] })).json.error, 'company, name, phone required');
  assert.equal((await call(env, 'POST', '/api/orders', { company: 'x', items: [{ product_id: PA, qty: 1 }] })).status, 400);
  assert.equal((await call(env, 'POST', '/api/orders', { name: 'x', phone: 'x', items: [{ product_id: PA, qty: 1 }] })).status, 400);
});

test('rejects malformed and oversized orders', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/api/orders', { ...CUSTOMER, items: 'nope' })).json.error, 'items required');
  assert.equal((await call(env, 'POST', '/api/orders', { ...CUSTOMER, items: [{}] })).json.error, 'invalid item');
  assert.equal((await call(env, 'POST', '/api/orders', { ...CUSTOMER, items: [{ product_id: PA, qty: 0 }] })).status, 201, 'qty 0 is clamped to 1');
  assert.equal((await call(env, 'POST', '/api/orders', { ...CUSTOMER, items: [{ product_id: PA, qty: 999999 }] })).json.error, 'invalid item');
  const huge = Array.from({ length: 101 }, () => ({ product_id: PA, qty: 1 }));
  assert.equal((await call(env, 'POST', '/api/orders', { ...CUSTOMER, items: huge })).json.error, 'too many items');
});

test('idempotency key returns the same order on retry', async () => {
  const env = makeEnv();
  const headers = { 'Idempotency-Key': 'idem-test-1' };
  const first = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER }, headers);
  assert.equal(first.status, 201, first.text);
  assert.equal(first.json.idempotent, undefined);

  const second = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER }, headers);
  assert.equal(second.status, 200);
  assert.equal(second.json.idempotent, true);
  assert.equal(second.json.id, first.json.id);
  assert.equal(second.json.totals.total_amount, first.json.totals.total_amount);
});

test('same idempotency key with a different cart still returns the first order', async () => {
  const env = makeEnv();
  const headers = { 'Idempotency-Key': 'idem-test-2' };
  const first = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER }, headers);
  const second = await call(env, 'POST', '/api/orders', { ...purchaseCart({ items: [{ product_id: PB, qty: 9 }] }), ...CUSTOMER }, headers);
  assert.equal(second.status, 200);
  assert.equal(second.json.id, first.json.id, 'the key binds to the first order, never a new one');
});

test('blocks a duplicate cart within the duplicate window', async () => {
  const env = makeEnv();
  const first = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(first.status, 201, first.text);

  const duplicate = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, 'duplicate_order');
  assert.equal(duplicate.json.existing_id, first.json.id);

  const allowed = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER, allow_duplicate: true });
  assert.equal(allowed.status, 201, allowed.text);
  assert.notEqual(allowed.json.id, first.json.id);

  const otherCustomer = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER, phone: '010-9999-9999' });
  assert.equal(otherCustomer.status, 201, 'a different customer can order the same cart');
});

test('customer can look up their order and 404 on unknown ids', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201);

  const lookedUp = await call(env, 'GET', `/api/orders/${created.json.id}`);
  assert.equal(lookedUp.status, 200);
  assert.equal(lookedUp.json.id, created.json.id);
  assert.equal(lookedUp.json.items.length, 2);

  const missing = await call(env, 'GET', '/api/orders/ORD-19990101-ABCDE');
  assert.equal(missing.status, 404);
});

test('unknown routes return 404', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/api/definitely-not-real')).status, 404);
  assert.equal((await call(env, 'DELETE', '/api/orders')).status, 404);
});
