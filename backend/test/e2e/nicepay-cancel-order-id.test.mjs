import assert from 'node:assert/strict';
import test from 'node:test';

import { auth, call, CUSTOMER, makeEnv, purchaseCart } from '../helpers.mjs';
import { windowReturnSignature } from '../../lib/pg-nicepay.mjs';

const CLIENT = 'FAKE-OPERATING-CLIENT';
const SECRET = 'fake-operating-secret-notreal';

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

function operatingGateway({ failFirstCancel = false, rejectAmountOnFullCancel = false } = {}) {
  const amounts = new Map();
  const balances = new Map();
  const used = new Set();
  const cancels = [];
  let cancelCount = 0;
  const reply = (body) => ({ ok: true, status: 200, async json() { return body; } });
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : {};
    if (/\/cancel$/.test(pathname)) {
      cancels.push(body);
      cancelCount += 1;
      if (failFirstCancel && cancelCount === 1) {
        return reply({ resultCode: 'A001', resultMsg: '일시적인 오류' });
      }
      if (used.has(body.orderId)) return reply({ resultCode: 'U112', resultMsg: '이미 사용된 OrderId 입니다.' });
      used.add(body.orderId);
      const tid = decodeURIComponent(pathname.split('/').slice(-2)[0]);
      const paid = amounts.get(tid) || 0;
      const before = balances.get(tid) ?? paid;
      if (rejectAmountOnFullCancel && before === paid && Object.prototype.hasOwnProperty.call(body, 'cancelAmt') && Number(body.cancelAmt) >= before) {
        return reply({ resultCode: '2033', resultMsg: '부분취소 불가능금액. 전체취소 이용바람.' });
      }
      const amount = Number(body.cancelAmt) || before;
      const balance = Math.max(0, before - amount);
      balances.set(tid, balance);
      return reply({
        resultCode: '0000', tid, cancelledTid: `${tid}C`,
        status: balance === 0 ? 'cancelled' : 'partialCancelled',
        amount: paid, balanceAmt: balance, payMethod: 'card',
        cancels: [{ cancelAmount: amount, cancelDate: '2026-11-20T10:00:00+09:00' }],
        card: { canPartCancel: 'true' },
      });
    }
    const tid = decodeURIComponent(pathname.split('/').pop());
    amounts.set(tid, Number(body.amount) || 0);
    return reply({
      resultCode: '0000', tid, status: 'paid', payMethod: 'card',
      amount: Number(body.amount) || 0, balanceAmt: Number(body.amount) || 0,
      card: { canPartCancel: 'true' },
    });
  };
  return { fetchImpl, cancels, used };
}

async function withGateway(gw, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = gw.fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function paidOrder(e, gw, tid) {
  const created = await call(e, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  const amount = created.json.totals.total_amount;
  const authToken = `mock-window-${tid}`;
  const signatureData = {
    authResultCode: '0000', authResultMsg: '인증 성공', tid,
    orderId: created.json.id, clientId: CLIENT, amount, authToken,
    signature: windowReturnSignature({ authToken, clientId: CLIENT, amount, secretKey: SECRET }),
  };
  await withGateway(gw, async () => {
    const confirmed = await call(e, 'POST', '/api/payments/confirm', {
      orderId: created.json.id, paymentKey: tid, amount, signatureData,
    });
    assert.equal(confirmed.status, 200, confirmed.text);
  });
  return { id: created.json.id, amount };
}

async function cancel(e, gw, order, tid, body) {
  return withGateway(gw, () => call(e, 'POST', `/api/orders/${order.id}/payments/${tid}/cancel`, body, auth()));
}

test('a full cancel sends a fresh orderId instead of the one the approval consumed', async () => {
  const e = env();
  const gw = operatingGateway();
  const order = await paidOrder(e, gw, 'NICE-U112-FULL');
  const res = await cancel(e, gw, order, 'NICE-U112-FULL', { reason: '전액 취소' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.refunded, true);
  assert.equal(gw.cancels.length, 1);
  const sent = gw.cancels[0].orderId;
  assert.notEqual(sent, order.id);
  assert.match(sent, /^[A-Za-z0-9-]{1,64}$/);
  const row = await e.DB.prepare('SELECT status, balance_amount, cancel_amount FROM payments WHERE payment_key = ?').bind('NICE-U112-FULL').first();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.balance_amount, 0);
  assert.equal(row.cancel_amount, order.amount);
});

test('a partial cancel and the remaining full cancel never reuse an orderId', async () => {
  const e = env();
  const gw = operatingGateway();
  const tid = 'NICE-U112-PART';
  const order = await paidOrder(e, gw, tid);
  const part = Math.floor(order.amount / 2);
  const first = await cancel(e, gw, order, tid, { cancelAmount: part, reason: '일부 반품' });
  assert.equal(first.status, 200, first.text);
  const rest = await cancel(e, gw, order, tid, { reason: '나머지 취소' });
  assert.equal(rest.status, 200, rest.text);
  assert.equal(gw.cancels.length, 2);
  assert.notEqual(gw.cancels[0].orderId, gw.cancels[1].orderId);
  const row = await e.DB.prepare('SELECT status, balance_amount FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.balance_amount, 0);
});

test('a failed cancel and its retry reuse the stored cancel orderId', async () => {
  const e = env();
  const gw = operatingGateway({ failFirstCancel: true });
  const tid = 'NICE-U112-RETRY';
  const order = await paidOrder(e, gw, tid);
  const failed = await cancel(e, gw, order, tid, { reason: '재시도 취소' });
  assert.equal(failed.status, 502, failed.text);
  assert.equal(failed.json.error, 'refund_failed');
  const retry = await cancel(e, gw, order, tid, { reason: '재시도 취소' });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(gw.cancels.length, 2);
  assert.equal(gw.cancels[0].orderId, gw.cancels[1].orderId);
  const events = await e.DB.prepare("SELECT meta FROM order_events WHERE order_id = ? AND type = 'payment_cancelled'").bind(order.id).all();
  const meta = JSON.parse(events.results[0].meta);
  assert.equal(meta.cancel_order_id, gw.cancels[1].orderId);
});

test('a first full cancel omits cancelAmt so NICE does not answer 2033', async () => {
  const e = env();
  const gw = operatingGateway({ rejectAmountOnFullCancel: true });
  const tid = 'NICE-FULL-AMOUNT';
  const order = await paidOrder(e, gw, tid);
  const res = await cancel(e, gw, order, tid, { reason: '전체취소' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.cancel_amount, order.amount);
  assert.equal(gw.cancels.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(gw.cancels[0], 'cancelAmt'), false);
  const row = await e.DB.prepare('SELECT status, cancel_amount FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancel_amount, order.amount);
  const events = await e.DB.prepare("SELECT meta FROM order_events WHERE order_id = ? AND type = 'payment_cancelled'").bind(order.id).all();
  const meta = JSON.parse(events.results[0].meta);
  assert.equal(meta.cancel_amount, order.amount);
});

test('a partial cancel and the remaining cancel still send cancelAmt', async () => {
  const e = env();
  const gw = operatingGateway({ rejectAmountOnFullCancel: true });
  const tid = 'NICE-PART-AMOUNT';
  const order = await paidOrder(e, gw, tid);
  const part = Math.floor(order.amount / 2);
  const first = await cancel(e, gw, order, tid, { cancelAmount: part, reason: '일부 반품' });
  assert.equal(first.status, 200, first.text);
  const rest = await cancel(e, gw, order, tid, { reason: '나머지 취소' });
  assert.equal(rest.status, 200, rest.text);
  assert.equal(gw.cancels.length, 2);
  assert.equal(gw.cancels[0].cancelAmt, part);
  assert.equal(gw.cancels[1].cancelAmt, order.amount - part);
  const row = await e.DB.prepare('SELECT status, balance_amount FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.balance_amount, 0);
});
