import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PRICE_INDEX } from '../../data/price_index.mjs';
import { makeEnv, call, auth, CUSTOMER, purchaseCart, mixedCart, pricedProductIds, inquiryProductId } from '../helpers.mjs';

const [PA, PB] = pricedProductIds(2);
const PRICE_A = PRICE_INDEX[PA].p;
const PRICE_B = PRICE_INDEX[PB].p;
const TOTAL = PRICE_A * 2 + PRICE_B;

async function paidPurchase(env) {
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  const confirmed = await call(env, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: 'pk_approved_1',
    amount: created.json.totals.total_amount,
    paymentMethod: '카드',
  });
  assert.equal(confirmed.status, 200, confirmed.text);
  return { id: created.json.id, created: created.json, confirmed: confirmed.json };
}

test('confirms a payment and marks the order paid', async () => {
  const env = makeEnv();
  const { confirmed } = await paidPurchase(env);

  assert.equal(confirmed.approved, true);
  assert.equal(confirmed.payment.payment_key, 'pk_approved_1');
  assert.equal(confirmed.payment.provider, 'tosspayments');
  assert.equal(confirmed.payment.provider_mode, 'mock');
  assert.equal(confirmed.payment.method, '카드');

  const order = confirmed.order;
  assert.equal(order.status, 'paid');
  assert.equal(order.status_label, '결제 완료');
  assert.equal(order.payment_status, 'paid');
  assert.equal(order.payment.payment_key, 'pk_approved_1');
  assert.ok(order.payment.paid_at);
  assert.equal(order.payable, false, 'a paid order is no longer awaiting payment');
  assert.equal(order.delivery_status, 'processing');
});

test('rejects a payment amount that does not match the order total', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201);

  const tampered = await call(env, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: 'pk_tampered',
    amount: created.json.totals.total_amount - 1,
  });
  assert.equal(tampered.status, 400);
  assert.equal(tampered.json.error, 'amount mismatch');
  assert.equal(tampered.json.detail.expected, TOTAL);
  assert.equal(tampered.json.detail.received, TOTAL - 1);

  const stillWaiting = await call(env, 'GET', `/api/orders/${created.json.id}`);
  assert.equal(stillWaiting.json.status, 'awaiting_payment');
  assert.equal(stillWaiting.json.payment_status, 'pending');
  assert.equal(stillWaiting.json.payment.payment_key, null);
});

test('rejects invalid confirm payloads', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/api/payments/confirm', {})).json.error, 'orderId and paymentKey required');
  assert.equal((await call(env, 'POST', '/api/payments/confirm', { orderId: 'ORD-19990101-ABCDE', paymentKey: 'pk' })).status, 404);
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal((await call(env, 'POST', '/api/payments/confirm', { orderId: created.json.id, paymentKey: 'pk', amount: 0 })).json.error, 'invalid amount');
  assert.equal((await call(env, 'POST', '/api/payments/confirm', { orderId: created.json.id, paymentKey: 'pk', amount: -1 })).status, 400);
});

test('a quote order can never be paid', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...mixedCart(), ...CUSTOMER });
  assert.equal(created.status, 201);
  assert.equal(created.json.kind, 'quote');

  const confirm = await call(env, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: 'pk_quote_try',
    amount: created.json.totals.total_amount,
  });
  assert.equal(confirm.status, 409);
  assert.equal(confirm.json.error, 'quote_order_not_payable');

  const unchanged = await call(env, 'GET', `/api/orders/${created.json.id}`);
  assert.equal(unchanged.json.status, 'pending');
  assert.equal(unchanged.json.payment_status, 'none');
});

test('the same paymentKey is idempotent and never double approves', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  const body = { orderId: created.json.id, paymentKey: 'pk_once', amount: TOTAL };

  const first = await call(env, 'POST', '/api/payments/confirm', body);
  assert.equal(first.status, 200);
  assert.equal(first.json.approved, true);

  const second = await call(env, 'POST', '/api/payments/confirm', body);
  assert.equal(second.status, 200);
  assert.equal(second.json.idempotent, true);

  const events = await call(env, 'GET', `/api/orders/${created.json.id}/events`, undefined, auth());
  const approvals = events.json.items.filter((e) => e.type === 'payment_confirmed');
  assert.equal(approvals.length, 1, 'exactly one approval is recorded');
});

test('a second paymentKey on a paid order is reported as already paid', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  await call(env, 'POST', '/api/payments/confirm', { orderId: created.json.id, paymentKey: 'pk_one', amount: TOTAL });
  const second = await call(env, 'POST', '/api/payments/confirm', { orderId: created.json.id, paymentKey: 'pk_two', amount: TOTAL });
  assert.equal(second.status, 200);
  assert.equal(second.json.already_paid, true);
  assert.equal(second.json.order.payment.payment_key, 'pk_one', 'the original payment key is kept');
});

test('a rejected card leaves the order payable again', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201);

  const failed = await call(env, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: 'pk_fail_card_declined',
    amount: TOTAL,
  });
  assert.equal(failed.status, 402);
  assert.equal(failed.json.approved, false);
  assert.equal(failed.json.error, 'REJECT_CARD_COMPANY');
  assert.equal(failed.json.order_status, 'awaiting_payment');
  assert.equal(failed.json.payment_status, 'failed');

  const after = await call(env, 'GET', `/api/orders/${created.json.id}`);
  assert.equal(after.json.status, 'awaiting_payment');
  assert.equal(after.json.payment_status, 'failed');
  assert.equal(after.json.payable, false, 'payment_status is failed, so the UI must offer a retry');

  const retry = await call(env, 'POST', '/api/payments/confirm', { orderId: created.json.id, paymentKey: 'pk_retry_ok', amount: TOTAL });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.order.status, 'paid');
});

test('a client-reported auth failure is recorded without calling the PG', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });

  const failed = await call(env, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: 'pk_customer_cancelled',
    amount: TOTAL,
    failure: true,
    failure_code: 'PAY_PROCESS_CANCELED',
  });
  assert.equal(failed.status, 402);
  assert.equal(failed.json.error, 'payment_auth_failed');
  assert.equal(failed.json.code, 'PAY_PROCESS_CANCELED');

  const events = await call(env, 'GET', `/api/orders/${created.json.id}/events`, undefined, auth());
  assert.ok(events.json.items.some((e) => e.type === 'payment_failed'));
});

test('a payment cannot confirm a closed order', async () => {
  const env = makeEnv();
  const { id } = await paidPurchase(env);

  const shipped = await call(env, 'PATCH', `/api/orders/${id}`, { status: 'processing' }, auth());
  assert.equal(shipped.status, 200);
  await call(env, 'PATCH', `/api/orders/${id}`, { status: 'shipped' }, auth());
  await call(env, 'PATCH', `/api/orders/${id}`, { status: 'delivered' }, auth());

  const confirm = await call(env, 'POST', '/api/payments/confirm', { orderId: id, paymentKey: 'pk_late', amount: TOTAL });
  assert.equal(confirm.status, 409);
  assert.equal(confirm.json.error, 'order_closed');
});

test('full refund records the amount and moves the order to refunding', async () => {
  const env = makeEnv();
  const { id } = await paidPurchase(env);

  const result = await call(env, 'POST', `/api/orders/${id}/payments/pk_approved_1/cancel`, {
    cancelReason: 'E2E 환불 테스트',
  }, auth());
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.refunded, true);
  assert.equal(result.json.cancel_amount, TOTAL);
  assert.equal(result.json.refunded_amount, TOTAL);
  assert.equal(result.json.payment_status, 'refunded');
  assert.equal(result.json.order_status, 'refunding');
  assert.equal(result.json.provider_mode, 'mock');

  const events = await call(env, 'GET', `/api/orders/${id}/events`, undefined, auth());
  const cancellations = events.json.items.filter((e) => e.type === 'payment_cancelled');
  assert.equal(cancellations.length, 1);
  assert.ok(cancellations[0].meta.includes('E2E 환불 테스트'));
});

test('refunds are idempotent and cannot over-refund', async () => {
  const env = makeEnv();
  const { id } = await paidPurchase(env);
  const path = `/api/orders/${id}/payments/pk_approved_1/cancel`;
  const body = { cancelReason: '중복 환불 방지' };

  assert.equal((await call(env, 'POST', path, body, auth())).status, 200);
  const again = await call(env, 'POST', path, body, auth());
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent, true);

  const exhausted = await call(env, 'POST', path, { cancelReason: '잔액 없음' }, auth());
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.json.error, 'nothing refundable');
});

test('partial refunds accumulate and stop at the order total', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  await call(env, 'POST', '/api/payments/confirm', { orderId: created.json.id, paymentKey: 'pk_partial', amount: TOTAL });

  const first = await call(env, 'POST', `/api/orders/${created.json.id}/payments/pk_partial/cancel`, {
    cancelAmount: 1000,
    cancelReason: '일부 환불',
  }, auth());
  assert.equal(first.status, 200);
  assert.equal(first.json.cancel_amount, 1000);
  assert.equal(first.json.refunded_amount, 1000);
  assert.equal(first.json.payment_status, 'partial_refunded');

  const over = await call(env, 'POST', `/api/orders/${created.json.id}/payments/pk_partial/cancel`, {
    cancelAmount: TOTAL * 5,
    cancelReason: '과액 요청은 잔액으로 제한',
  }, auth());
  assert.equal(over.status, 200);
  assert.equal(over.json.cancel_amount, TOTAL - 1000, 'capped at the refundable balance');
  assert.equal(over.json.payment_status, 'refunded');
});

test('requires authentication for refunds and rejects bad amounts', async () => {
  const env = makeEnv();
  const { id } = await paidPurchase(env);
  const path = `/api/orders/${id}/payments/pk_approved_1/cancel`;
  assert.equal((await call(env, 'POST', path, { cancelReason: 'x' })).status, 401);
  assert.equal((await call(env, 'POST', `/api/orders/${id}/payments/pk_unknown/cancel`, { cancelReason: 'x' }, auth())).status, 404);
  assert.equal((await call(env, 'POST', path, { cancelReason: 'x', cancelAmount: 0 }, auth())).json.error, 'invalid cancelAmount');
  assert.equal((await call(env, 'POST', path, { cancelAmount: 100 }, auth())).json.error, 'invalid cancelAmount');
});

test('staff can confirm prices on a quote order and convert it to a payable purchase', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', {
    ...CUSTOMER,
    items: [{ product_id: PA, qty: 1 }, { product_id: inquiryProductId(), qty: 2 }],
  });
  assert.equal(created.status, 201);
  const orderId = created.json.id;
  assert.equal(created.json.kind, 'quote');

  const adminPrices = { [PA]: PRICE_A, [inquiryProductId()]: 5000 };

  const quoted = await call(env, 'POST', `/api/orders/${orderId}/quote/prices`, { admin_prices: adminPrices }, auth());
  assert.equal(quoted.status, 200, quoted.text);
  assert.equal(quoted.json.converted, false);
  assert.equal(quoted.json.order.status, 'quoted');
  assert.equal(quoted.json.order.status_label, '견적 고지');
  assert.equal(quoted.json.order.kind, 'quote', 'the kind is unchanged until conversion');
  assert.equal(quoted.json.order.totals.total_amount, PRICE_A + 10000);
  assert.ok(quoted.json.order.items.every((i) => i.unit_price !== null));

  const converted = await call(env, 'POST', `/api/orders/${orderId}/quote/prices`, { admin_prices: adminPrices, convert: true }, auth());
  assert.equal(converted.status, 200);
  assert.equal(converted.json.converted, true);
  assert.equal(converted.json.order.kind, 'purchase');
  assert.equal(converted.json.order.status, 'awaiting_payment');
  assert.equal(converted.json.order.payment_status, 'pending');

  const paid = await call(env, 'POST', '/api/payments/confirm', {
    orderId,
    paymentKey: 'pk_converted_ok',
    amount: converted.json.order.totals.total_amount,
  });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.json.order.status, 'paid');
});

test('price confirmation requires every item price and admin auth', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', {
    ...CUSTOMER,
    items: [{ product_id: PA, qty: 1 }, { product_id: inquiryProductId(), qty: 1 }],
  });
  const orderId = created.json.id;

  assert.equal((await call(env, 'POST', `/api/orders/${orderId}/quote/prices`, {})).status, 401);
  const missing = await call(env, 'POST', `/api/orders/${orderId}/quote/prices`, { admin_prices: { [PA]: PRICE_A } }, auth());
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'price missing');
  const zero = await call(env, 'POST', `/api/orders/${orderId}/quote/prices`, {
    admin_prices: { [PA]: 0, [inquiryProductId()]: 100 },
  }, auth());
  assert.equal(zero.status, 400);
});

test('price confirmation is rejected for a purchase order', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  const res = await call(env, 'POST', `/api/orders/${created.json.id}/quote/prices`, { admin_prices: { [PA]: 100 } }, auth());
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'not_a_quote_order');
});
