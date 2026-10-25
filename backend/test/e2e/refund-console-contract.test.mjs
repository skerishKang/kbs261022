// Console ↔ server refund contract (작업 A, the seam that actually broke).
//
// The unit tests for cgi-refund.js could pass while disagreeing with the Worker,
// and the Worker's own tests could pass while the console never produced a body it
// would accept. This file loads the real frontend helper and posts the bodies it
// builds to the real Worker, so the two halves are only green together.
//
//   node --experimental-sqlite test/e2e/refund-console-contract.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRICE_INDEX } from '../../data/price_index.mjs';
import { makeEnv, call, auth, CUSTOMER } from '../helpers.mjs';

const SITE_HELPER = new URL('../../../site/assets/js/cgi-refund.js', import.meta.url);
await import(SITE_HELPER.href);
const build = globalThis.CGI_REFUND.buildRefundRequest;
const FLOOR = globalThis.CGI_REFUND.MIN_PARTIAL_REFUND;

const CHEAP = Object.entries(PRICE_INDEX)
  .filter(([, v]) => Number.isFinite(v.p) && v.p > 0)
  .sort((a, b) => a[1].p - b[1].p)[0][0];
const CHEAP_PRICE = PRICE_INDEX[CHEAP].p;

let seq = 0;

/** A paid order whose refundable balance is `price * qty`. */
async function paidOrder(env, qty) {
  seq += 1;
  const created = await call(env, 'POST', '/api/orders', {
    items: [{ product_id: CHEAP, qty }], allow_duplicate: true, ...CUSTOMER,
  });
  assert.equal(created.status, 201, created.text);
  const total = created.json.totals.total_amount;
  const key = `pk_console_${seq}`;
  const paid = await call(env, 'POST', '/api/payments/confirm', { orderId: created.json.id, paymentKey: key, amount: total });
  assert.equal(paid.status, 200, paid.text);
  return { id: created.json.id, key, balance: total };
}

const cancel = (env, order, body) =>
  call(env, 'POST', `/api/orders/${order.id}/payments/${order.key}/cancel`, body, auth());

test('the console can refund every order in full, including one below the floor', async () => {
  const env = makeEnv();
  assert.ok(CHEAP_PRICE < FLOOR, `needs a sub-floor product, cheapest is ${CHEAP_PRICE}`);

  for (const qty of [1, 2, 15]) {
    const order = await paidOrder(env, qty);
    const fromUi = build('', order.balance, '전액 환불');
    assert.equal(fromUi.ok, true, `qty ${qty}: the console must always allow a full refund`);
    assert.equal(fromUi.mode, 'full');

    const res = await cancel(env, order, fromUi.body);
    assert.equal(res.status, 200, `qty ${qty}: ${res.text}`);
    assert.equal(res.json.cancel_amount, order.balance);
    assert.equal(res.json.payment_status, 'refunded');
  }
});

test('every body the console accepts, the server accepts too', async () => {
  const env = makeEnv();
  const balance = CHEAP_PRICE * 15;
  assert.ok(balance > FLOOR, 'this tier needs an order above the floor');
  const inputs = ['', '   ', '1000', '2500', String(balance)];

  for (const raw of inputs) {
    const order = await paidOrder(env, 15);
    assert.equal(order.balance, balance);
    const fromUi = build(raw, order.balance, `UI 입력 ${JSON.stringify(raw)}`);
    assert.equal(fromUi.ok, true, `${JSON.stringify(raw)} must not be blocked by the console`);

    const res = await cancel(env, order, fromUi.body);
    assert.notEqual(res.json.error, 'invalid cancelAmount',
      `the console offered ${JSON.stringify(raw)} but the server rejected it: ${res.text}`);
    assert.equal(res.status, 200, res.text);

    if (fromUi.mode === 'full') {
      assert.equal(res.json.cancel_amount, order.balance);
      assert.equal(res.json.payment_status, 'refunded');
    } else {
      assert.equal(res.json.cancel_amount, Number(raw));
      assert.equal(res.json.payment_status, 'partial_refunded');
    }
  }
});

test('every partial the console blocks below the floor, the server blocks as well', async () => {
  const env = makeEnv();
  const order = await paidOrder(env, 15);
  const balance = order.balance;

  for (const raw of ['1', '500', String(FLOOR - 1)]) {
    const fromUi = build(raw, balance, '부분 환불 시도');
    assert.equal(fromUi.ok, false, `${raw} is below the floor, so the console must block it`);
    assert.equal(fromUi.min, FLOOR);

    // Same value sent explicitly, as the buggy console used to do.
    const res = await cancel(env, order, { cancelAmount: Number(raw), cancelReason: `서버 확인 ${raw}` });
    assert.equal(res.status, 400, `the server must reject ${raw} too: ${res.text}`);
    assert.equal(res.json.error, 'invalid cancelAmount');
    assert.equal(res.json.detail.min, FLOOR);
  }

  const untouched = await call(env, 'GET', `/api/orders/${order.id}`);
  assert.equal(untouched.json.payment_status, 'paid', 'blocked refunds left no trace');
});

test('an amount equal to the balance never reaches the floor rule', async () => {
  const env = makeEnv();
  const order = await paidOrder(env, 1);
  assert.ok(order.balance < FLOOR);

  const fromUi = build(String(order.balance), order.balance, '잔액과 같은 금액');
  assert.equal(fromUi.mode, 'full');
  assert.equal('cancelAmount' in fromUi.body, false, 'sending it explicitly is what used to fail');

  const res = await cancel(env, order, fromUi.body);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.refunded_amount, order.balance);
});

test('a console partial leaves a balance the console can finish in full', async () => {
  const env = makeEnv();
  const order = await paidOrder(env, 15);

  const first = build('1000', order.balance, '최소 부분 환불');
  assert.equal(first.ok, true);
  const res1 = await cancel(env, order, first.body);
  assert.equal(res1.status, 200, res1.text);
  assert.equal(res1.json.payment_status, 'partial_refunded');
  assert.equal(res1.json.refunded_amount, 1000);

  const remaining = order.balance - 1000;
  const second = build('', remaining, '남은 전액');
  assert.equal(second.ok, true);
  assert.equal(second.mode, 'full');

  const res2 = await cancel(env, order, second.body);
  assert.equal(res2.status, 200, res2.text);
  assert.equal(res2.json.cancel_amount, remaining);
  assert.equal(res2.json.payment_status, 'refunded');
  assert.equal(res2.json.refunded_amount, order.balance);
  assert.equal(res2.json.order_status, 'refunding');

  const final = await call(env, 'GET', `/api/orders/${order.id}`);
  assert.equal(final.json.totals.refunded_amount, order.balance, 'no earlier refund counted twice');
  assert.equal(final.json.payment_status, 'refunded');
  assert.equal(final.json.status, 'refunding');
});

test('a partial refund does not count the same money twice in the ledger', async () => {
  const env = makeEnv();
  const order = await paidOrder(env, 15);

  for (const n of [1, 2, 3]) {
    const res = await cancel(env, order, { cancelAmount: 1000, cancelReason: `누적 확인 ${n}` });
    assert.equal(res.status, 200, res.text);
  }
  const after = await call(env, 'GET', `/api/orders/${order.id}`);
  assert.equal(after.json.totals.refunded_amount, 3000, 'three 1,000원 refunds are 3,000원, not 6,000원');
  assert.equal(after.json.payment_status, 'partial_refunded');
  assert.equal(after.json.status, 'paid', 'still a balance left, so the order is not closing');
});
