// Re-paying an existing unpaid order (작업 B).
//
// The defect: an order that reached `awaiting_payment` but was never approved had
// no way back into the PG widget — every "다시 시도" link pointed at #/checkout,
// which mints a NEW order and leaves the old one stranded. These tests pin the
// server-side contract the repay button now relies on: the server (not the
// browser) decides payability, ownership and amount, and no second order exists.
//
//   node --experimental-sqlite test/e2e/repay.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeEnv, call, auth, ORIGIN, CUSTOMER, purchaseCart,
  pricedProductIds, inquiryProductId,
} from '../helpers.mjs';

const PASSWORD = 'Test!2026-abc';
const CSRF = { 'X-CSRF-Token': ORIGIN };
const [PA] = pricedProductIds(1);

async function signUp(env, email) {
  const res = await call(env, 'POST', '/api/auth/signup', {
    email, name: '[E2E] 재결제 회원', password: PASSWORD,
    phone: '010-1234-5678', company: '[E2E] 테스트 회사',
  }, CSRF);
  assert.equal(res.status, 201, res.text);
  const verified = await call(env, 'POST', '/api/auth/verify-email', {
    member_id: res.json.member.id, token: res.json.mail.echo_token,
  }, CSRF);
  assert.equal(verified.status, 200, verified.text);
  const login = await call(env, 'POST', '/api/auth/login', { email, password: PASSWORD }, CSRF);
  assert.equal(login.status, 200, login.text);
  return login.headers['set-cookie'];
}

function memberEnv() {
  return makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000', AUTH_RATE_LIMIT_MAX: '100000' });
}

/** Order created under a member session, so customer_id is bound server-side. */
async function memberOrder(env, cookie, cart = purchaseCart()) {
  const created = await call(env, 'POST', '/api/orders', { ...cart, ...CUSTOMER }, { ...CSRF, Cookie: cookie });
  assert.equal(created.status, 201, created.text);
  return created.json;
}

async function myOrderCount(env, cookie) {
  const res = await call(env, 'GET', '/api/me/orders', undefined, { ...CSRF, Cookie: cookie });
  assert.equal(res.status, 200, res.text);
  return res.json.items.length;
}

const repay = (env, cookie, id) => call(env, 'POST', `/api/me/orders/${id}/repay`, {}, { ...CSRF, Cookie: cookie });

test('an unpaid order can be re-opened for payment at the server-declared amount', async () => {
  const env = memberEnv();
  const cookie = await signUp(env, 'repay-ok@example.com');
  const order = await memberOrder(env, cookie);

  const res = await repay(env, cookie, order.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.payable, true);
  assert.equal(res.json.payment.order_id, order.id, 'the SAME order number is handed back to the widget');
  assert.equal(res.json.payment.amount, order.totals.total_amount, 'the amount comes from the server row');
  assert.equal(res.json.payment.status, 'awaiting_payment');
  assert.equal(res.json.payment.payment_status, 'pending');

  const events = await call(env, 'GET', `/api/me/orders/${order.id}`, undefined, { ...CSRF, Cookie: cookie });
  assert.equal(events.json.order.status, 'awaiting_payment', 'repay must not mutate the order');

  assert.equal(await myOrderCount(env, cookie), 1, 'repay never creates a second order');
});

test('the repaid order then confirms normally and is paid exactly once', async () => {
  const env = memberEnv();
  const cookie = await signUp(env, 'repay-confirm@example.com');
  const order = await memberOrder(env, cookie);
  const opened = await repay(env, cookie, order.id);

  const paid = await call(env, 'POST', '/api/payments/confirm', {
    orderId: opened.json.payment.order_id,
    paymentKey: 'pk_repay_ok',
    amount: opened.json.payment.amount,
    paymentMethod: '카드',
  });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.json.order.status, 'paid');

  assert.equal(await myOrderCount(env, cookie), 1, 'a completed re-payment still adds no order');

  const late = await repay(env, cookie, order.id);
  assert.equal(late.status, 409);
  assert.equal(late.json.error, 'already_paid', 'double payment on a paid order is blocked');
});

test('a repay request is recorded as an order event', async () => {
  const env = memberEnv();
  const cookie = await signUp(env, 'repay-events@example.com');
  const order = await memberOrder(env, cookie);
  await repay(env, cookie, order.id);
  await repay(env, cookie, order.id);

  const events = await call(env, 'GET', `/api/orders/${order.id}/events`, undefined, auth());
  assert.equal(events.status, 200, events.text);
  const retries = events.json.items.filter((e) => e.type === 'payment_retry_requested');
  assert.equal(retries.length, 2, 'each retry attempt is auditable');
  assert.equal(retries[0].actor, 'customer');
  assert.ok(retries[0].meta.includes(String(order.totals.total_amount)));
});

test('repay requires a member session', async () => {
  const env = memberEnv();
  const order = await memberOrder(env, await signUp(env, 'repay-auth@example.com'));

  const anonymous = await call(env, 'POST', `/api/me/orders/${order.id}/repay`, {}, CSRF);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error, 'unauthorized');
});

test("someone else's order cannot be re-opened", async () => {
  const env = memberEnv();
  const owner = await signUp(env, 'repay-owner@example.com');
  const thief = await signUp(env, 'repay-thief@example.com');
  const order = await memberOrder(env, owner);

  const res = await repay(env, thief, order.id);
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'order not found', 'ownership is checked on the server, not in the browser');
});

test('a guest order has no owner and therefore cannot be re-paid through the member API', async () => {
  const env = memberEnv();
  const stranger = await signUp(env, 'repay-guest@example.com');
  const guest = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(guest.status, 201, guest.text);

  const res = await repay(env, stranger, guest.json.id);
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'order not found');
});

test('a quote order is never payable', async () => {
  const env = memberEnv();
  const cookie = await signUp(env, 'repay-quote@example.com');
  const order = await memberOrder(env, cookie, {
    items: [{ product_id: PA, qty: 1 }, { product_id: inquiryProductId(), qty: 1 }],
  });
  assert.equal(order.kind, 'quote');

  const res = await repay(env, cookie, order.id);
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'not payable');
  assert.equal(res.json.detail.reason, 'quote_order_not_payable');
});

test('an order that is no longer awaiting payment cannot be re-paid', async () => {
  const env = memberEnv();
  const cookie = await signUp(env, 'repay-cancelled@example.com');
  const order = await memberOrder(env, cookie);

  const cancelled = await call(env, 'POST', `/api/me/orders/${order.id}/cancel`, {}, { ...CSRF, Cookie: cookie });
  assert.equal(cancelled.status, 200, cancelled.text);

  const res = await repay(env, cookie, order.id);
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'not payable');
  assert.equal(res.json.detail.status, 'cancelled');
});

test('an unknown order id is a 404 for its own owner too', async () => {
  const env = memberEnv();
  const cookie = await signUp(env, 'repay-missing@example.com');
  const res = await repay(env, cookie, 'ORD-19990101-ABCDE');
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'order not found');
});

test('a failed payment stays repayable with the original amount', async () => {
  const env = memberEnv();
  const cookie = await signUp(env, 'repay-failed@example.com');
  const order = await memberOrder(env, cookie);

  const failed = await call(env, 'POST', '/api/payments/confirm', {
    orderId: order.id, paymentKey: 'pk_fail_card_declined', amount: order.totals.total_amount,
  });
  assert.equal(failed.status, 402);
  assert.equal(failed.json.payment_status, 'failed');

  const res = await repay(env, cookie, order.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.payment.payment_status, 'failed');
  assert.equal(res.json.payment.amount, order.totals.total_amount);

  const retry = await call(env, 'POST', '/api/payments/confirm', {
    orderId: order.id, paymentKey: 'pk_repay_approved', amount: res.json.payment.amount,
  });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.order.status, 'paid');
  assert.equal(await myOrderCount(env, cookie), 1);
});

test('a client-sent amount in the repay body is ignored', async () => {
  const env = memberEnv();
  const cookie = await signUp(env, 'repay-tamper@example.com');
  const order = await memberOrder(env, cookie);

  const res = await call(env, 'POST', `/api/me/orders/${order.id}/repay`, { amount: 1 }, { ...CSRF, Cookie: cookie });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.payment.amount, order.totals.total_amount, 'the amount is read from the order row');

  const cheap = await call(env, 'POST', '/api/payments/confirm', {
    orderId: order.id, paymentKey: 'pk_repay_cheap', amount: 1,
  });
  assert.equal(cheap.status, 400);
  assert.equal(cheap.json.error, 'amount mismatch');
});
