// Refund floor vs full refund (작업 A).
//
// The server contract, as it already exists in cancelPayment: the 1,000원 floor
// applies ONLY when the caller explicitly sends `cancelAmount`. Omitting the field
// refunds the whole remaining balance, whatever its size. The admin console broke
// that by always sending a number and pre-blocking anything under 1,000원, so a
// 340원 order could not be refunded at all. These tests pin both halves: the
// sub-floor full refund must work, and the partial minimum must stay enforced.
//
//   node --experimental-sqlite test/e2e/refund-minimum.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRICE_INDEX } from '../../data/price_index.mjs';
import { makeEnv, call, auth, CUSTOMER } from '../helpers.mjs';

/** Cheapest confirmed price — the real-world 340원 case, below the partial floor. */
function cheapestProductId() {
  const entry = Object.entries(PRICE_INDEX)
    .filter(([, v]) => Number.isFinite(v.p) && v.p > 0)
    .sort((a, b) => a[1].p - b[1].p)[0];
  return entry[0];
}

const CHEAP = cheapestProductId();
const CHEAP_PRICE = PRICE_INDEX[CHEAP].p;
assert.ok(CHEAP_PRICE < 1000, `the suite needs a sub-floor price, got ${CHEAP_PRICE}`);

async function paidCheapOrder(env) {
  const created = await call(env, 'POST', '/api/orders', { items: [{ product_id: CHEAP, qty: 1 }], ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.totals.total_amount, CHEAP_PRICE, 'no shipping, so the order total is the sub-floor price');
  const paid = await call(env, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: `pk_cheap_${CHEAP}`,
    amount: created.json.totals.total_amount,
  });
  assert.equal(paid.status, 200, paid.text);
  return { id: created.json.id, amount: created.json.totals.total_amount };
}

const cancelPath = (id, key) => `/api/orders/${id}/payments/${key}/cancel`;

test('an order below the partial floor can be fully refunded', async () => {
  const env = makeEnv();
  const { id, amount } = await paidCheapOrder(env);

  const res = await call(env, 'POST', cancelPath(id, `pk_cheap_${CHEAP}`), {
    cancelReason: '1,000원 미만 주문 전액 환불',
  }, auth());
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.refunded, true);
  assert.equal(res.json.cancel_amount, amount, 'the whole balance moved even though it is under 1,000원');
  assert.equal(res.json.refunded_amount, amount);
  assert.equal(res.json.payment_status, 'refunded');
  assert.equal(res.json.order_status, 'refunding');
});

test('sending that same sub-floor amount explicitly is still rejected', async () => {
  const env = makeEnv();
  const { id, amount } = await paidCheapOrder(env);

  const res = await call(env, 'POST', cancelPath(id, `pk_cheap_${CHEAP}`), {
    cancelAmount: amount,
    cancelReason: '잔액과 같지만 명시했으므로 부분 환불 규칙',
  }, auth());
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'invalid cancelAmount');
  assert.equal(res.json.detail.min, 1000);
  assert.equal(res.json.detail.requested, amount);

  const after = await call(env, 'GET', `/api/orders/${id}`);
  assert.equal(after.json.payment_status, 'paid', 'a rejected refund changes nothing');
});

test('the floor is a partial-refund rule, not a full-refund rule', async () => {
  const env = makeEnv();
  const { id } = await paidCheapOrder(env);
  const key = `pk_cheap_${CHEAP}`;

  const zero = await call(env, 'POST', cancelPath(id, key), { cancelAmount: 0 }, auth());
  assert.equal(zero.status, 400);
  assert.equal(zero.json.error, 'invalid cancelAmount');

  const emptyString = await call(env, 'POST', cancelPath(id, key), { cancelAmount: '', cancelReason: '빈 값은 전액' }, auth());
  assert.equal(emptyString.status, 200, 'an empty field means "refund everything"');
  assert.equal(emptyString.json.cancel_amount, CHEAP_PRICE);
});

test('the floor follows MIN_PARTIAL_REFUND exactly as the server reads it', async () => {
  const env = makeEnv({ MIN_PARTIAL_REFUND: '100' });
  const { id, amount } = await paidCheapOrder(env);

  const rejected = await call(env, 'POST', cancelPath(id, `pk_cheap_${CHEAP}`), {
    cancelAmount: 50, cancelReason: '임계 아래',
  }, auth());
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.detail.min, 100);

  const partial = await call(env, 'POST', cancelPath(id, `pk_cheap_${CHEAP}`), {
    cancelAmount: 100, cancelReason: '임계พอดี',
  }, auth());
  assert.equal(partial.status, 200, partial.text);
  assert.equal(partial.json.cancel_amount, 100);
  assert.equal(partial.json.payment_status, 'partial_refunded');
  assert.equal(partial.json.refunded_amount, 100);

  const rest = await call(env, 'POST', cancelPath(id, `pk_cheap_${CHEAP}`), { cancelReason: '나머지 전액' }, auth());
  assert.equal(rest.status, 200, rest.text);
  assert.equal(rest.json.cancel_amount, amount - 100, 'the remainder is refundable without touching the floor');
  assert.equal(rest.json.payment_status, 'refunded');
});

test('an above-floor order keeps normal partial refunds', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', {
    items: [
      { product_id: CHEAP, qty: 6 },
      { product_id: Object.entries(PRICE_INDEX).filter(([, v]) => v.p >= 1000)[0][0], qty: 1 },
    ],
    ...CUSTOMER,
  });
  assert.equal(created.status, 201, created.text);
  const total = created.json.totals.total_amount;
  assert.ok(total > 1000, `test needs an order above the floor, got ${total}`);

  const paid = await call(env, 'POST', '/api/payments/confirm', {
    orderId: created.json.id, paymentKey: 'pk_floor_mixed', amount: total,
  });
  assert.equal(paid.status, 200, paid.text);

  const first = await call(env, 'POST', cancelPath(created.json.id, 'pk_floor_mixed'), {
    cancelAmount: 1000, cancelReason: '최소 부분 환불',
  }, auth());
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.cancel_amount, 1000);
  assert.equal(first.json.refunded_amount, 1000);

  const rest = await call(env, 'POST', cancelPath(created.json.id, 'pk_floor_mixed'), { cancelReason: '잔액 전액' }, auth());
  assert.equal(rest.status, 200, rest.text);
  assert.equal(rest.json.cancel_amount, total - 1000);
  assert.equal(rest.json.payment_status, 'refunded');

  const nothing = await call(env, 'POST', cancelPath(created.json.id, 'pk_floor_mixed'), { cancelReason: '이미 전액 환불됨' }, auth());
  assert.equal(nothing.status, 409);
  assert.equal(nothing.json.error, 'nothing refundable');
});
