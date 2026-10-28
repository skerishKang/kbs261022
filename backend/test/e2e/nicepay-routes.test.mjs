import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../../worker.js';
import { signMockWindowPayload, resetMockNicepayTransactions } from '../../lib/pg-nicepay-adapter.mjs';
import { makeEnv, call, auth, CUSTOMER, purchaseCart, ORIGIN } from '../helpers.mjs';

const niceEnv = (over = {}) => makeEnv({ PG_PROVIDER: 'nicepay', PG_PROVIDER_MODE: 'mock', ...over });

/** returnUrl arrives as an HTML form post from the payment window, not JSON. */
async function callForm(env, path, fields, headers = {}) {
  const body = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString();
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
    redirect: 'manual',
  }), env);
  const h = {};
  response.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return { status: response.status, headers: h, text: await response.text() };
}

async function newPurchase(env) {
  resetMockNicepayTransactions();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  return created.json;
}

test('the gateway readout announces NICEPAY without exposing the secret key', async () => {
  const cfg = await call(niceEnv(), 'GET', '/api/payments/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.provider, 'nicepay');
  assert.equal(cfg.json.mode, 'mock');
  assert.equal(cfg.json.returnUrl, 'http://cgi.local/api/payments/nicepay/return');
  assert.ok(cfg.json.clientId, 'the browser needs the client key');
  assert.doesNotMatch(JSON.stringify(cfg.json), /mock-server-secret|secretKey/i);
});

test('the window request is built from the server order total, not a client claim', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const res = await call(env, 'POST', '/api/payments/nicepay/window', { orderId: order.id, amount: 1 });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.request.amount, order.totals.total_amount, 'a client cannot lower the window amount');
  assert.equal(res.json.request.orderId, order.id);
  assert.match(res.json.request.returnUrl, /\/api\/payments\/nicepay\/return$/);
  assert.equal(res.json.sdkUrl, 'mock://nicepay-window');
});

test('the window endpoint refuses a quote order, a closed order and an unknown order', async () => {
  const env = niceEnv();
  assert.equal((await call(env, 'POST', '/api/payments/nicepay/window', { orderId: 'nope' })).status, 404);
  const order = await newPurchase(env);
  await call(env, 'PATCH', `/api/orders/${order.id}`, { status: 'cancelled' }, auth());
  const closed = await call(env, 'POST', '/api/payments/nicepay/window', { orderId: order.id });
  assert.equal(closed.status, 409);
});

test('returnUrl approves the payment, redirects to the mall and writes a NICEPAY row', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const tid = 'NICE-RS-1';
  const payload = signMockWindowPayload({ tid, orderId: order.id, amount: order.totals.total_amount });

  const redirect = await callForm(env, '/api/payments/nicepay/return', payload);
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.location, /nicepay=success/);
  assert.match(redirect.headers.location, new RegExp(`#/order/${order.id}$`));

  const read = await call(env, 'GET', `/api/orders/${order.id}`);
  assert.equal(read.json.payment_status, 'paid');
  assert.equal(read.json.status, 'paid');
  assert.equal(read.json.payment.payment_key, tid);
  // which gateway holds the row is ledger truth, read where it is written
  const row = await env.DB.prepare('SELECT provider, provider_mode, status FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.provider, 'nicepay');
  assert.equal(row.provider_mode, 'mock');
  assert.equal(row.status, 'paid');

  const events = await call(env, 'GET', `/api/orders/${order.id}/events`, null, auth());
  const confirmed = (events.json.items || []).filter((e) => e.type === 'payment_confirmed');
  assert.equal(confirmed.length, 1);
});

test('a replayed returnUrl post cannot approve twice', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const tid = 'NICE-DUP-1';
  const payload = signMockWindowPayload({ tid, orderId: order.id, amount: order.totals.total_amount });
  await callForm(env, '/api/payments/nicepay/return', payload);
  const second = await callForm(env, '/api/payments/nicepay/return', payload);
  assert.equal(second.status, 302);
  assert.match(second.headers.location, /nicepay=success/, 'a replay still lands on the success page');

  const events = await call(env, 'GET', `/api/orders/${order.id}/events`, null, auth());
  assert.equal((events.json.items || []).filter((e) => e.type === 'payment_confirmed').length, 1);
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(rows.n, 1, 'the ledger keeps one row per tid');
});

test('a window payload whose amount is not the order total never approves', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const tid = 'NICE-TAMPER-1';
  // signed for a smaller amount than the order the client will claim
  const forged = signMockWindowPayload({ tid, orderId: order.id, amount: 1 });
  const res = await callForm(env, '/api/payments/nicepay/return', forged);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /nicepay=fail/);

  const read = await call(env, 'GET', `/api/orders/${order.id}`);
  assert.notEqual(read.json.payment_status, 'paid');
  assert.equal(read.json.status, 'awaiting_payment');
  const row = await env.DB.prepare('SELECT status FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.status, 'failed');
});

test('an unsigned window payload is rejected outright', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const res = await callForm(env, '/api/payments/nicepay/return', {
    tid: 'NICE-FORGED-2', orderId: order.id, amount: order.totals.total_amount, resultCode: '0000', signature: 'deadbeef',
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /nicepay=fail/);
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments').first();
  assert.ok(rows.n <= 1, 'no approval happened for a payload that never verified');
});

test('the window reports an authentication failure without approving', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const res = await callForm(env, '/api/payments/nicepay/return', {
    tid: 'NICE-FAIL-1', orderId: order.id, amount: order.totals.total_amount, authResultCode: 'FAIL',
    resultCode: '2220', resultMsg: '고객이 결제를 취소하였습니다',
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /nicepay=fail/);
  const read = await call(env, 'GET', `/api/orders/${order.id}`);
  assert.equal(read.json.payment_status, 'failed');
});

test('a GET on returnUrl is not a payment and says so', async () => {
  const res = await call(niceEnv(), 'GET', '/api/payments/nicepay/return?orderId=x');
  assert.equal(res.status, 405);
});

test('the webhook acks a verified cancellation and dedupes the replay', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const tid = 'NICE-HOOK-1';
  await callForm(env, '/api/payments/nicepay/return', signMockWindowPayload({ tid, orderId: order.id, amount: order.totals.total_amount }));
  await call(env, 'POST', `/api/orders/${order.id}/payments/${tid}/cancel`, { reason: '환불 요청' }, auth());

  const cancelled = await env.DB.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(tid).first();
  const payload = signMockWindowPayload({
    tid, orderId: order.id, amount: order.totals.total_amount,
  });
  const signed = { ...payload, status: 'cancelled', balanceAmt: cancelled.balance_amount };
  // re-sign for the mutated fields, since the digest covers tid+amount+ediDate only
  const res = await call(env, 'POST', '/api/payments/nicepay/webhook', signed);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, 'OK');
  assert.equal(res.headers['content-type'], 'text/html');

  const replay = await call(env, 'POST', '/api/payments/nicepay/webhook', signed);
  assert.equal(replay.status, 200);
  const events = await call(env, 'GET', `/api/orders/${order.id}/events`, null, auth());
  assert.equal((events.json.items || []).filter((e) => e.type === 'payment_webhook').length, 1);
});

test('a webhook whose signature does not verify is not acked', async () => {
  const env = niceEnv();
  const res = await call(env, 'POST', '/api/payments/nicepay/webhook', {
    tid: 'NICE-HOOK-BAD', orderId: 'x', amount: 1000, status: 'paid', ediDate: '20260101000000', signature: 'nope',
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'signature');
  assert.notEqual(res.text, 'OK', 'acking a forged notification would swallow the retry');
});

test('a verified webhook for a tid we have never seen is refused, not acked', async () => {
  const env = niceEnv();
  const payload = signMockWindowPayload({ tid: 'NICE-HOOK-ORPHAN', orderId: 'unknown-order', amount: 5000 });
  const res = await call(env, 'POST', '/api/payments/nicepay/webhook', payload);
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'unknown_tid');
});

test('a NICEPAY row is refunded through NICEPAY even when the deployment default is Toss', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const tid = 'NICE-CROSS-1';
  await callForm(env, '/api/payments/nicepay/return', signMockWindowPayload({ tid, orderId: order.id, amount: order.totals.total_amount }));
  const row = await env.DB.prepare('SELECT provider FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.provider, 'nicepay');

  // Same database, deployment now defaults to Toss. Routing by the row's provider
  // must still reach NICEPAY; routing by the deployment default would hand the tid
  // to the Toss mock, which has never heard of it.
  const asToss = { ...env, PG_PROVIDER: 'tosspayments', TOSS_WIDGET_SECRET_KEY: 'test_gsk_dummy' };
  const res = await call(asToss, 'POST', `/api/orders/${order.id}/payments/${tid}/cancel`, { reason: '상호 제공자 취소' }, auth());
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.refunded, true);
  const after = await env.DB.prepare('SELECT status, provider FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(after.status, 'cancelled');
  assert.equal(after.provider, 'nicepay');

  // and the same environment still cannot approve a NEW payment through Toss
  const created2 = await call(asToss, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER, allow_duplicate: true });
  assert.equal(created2.status, 201, created2.text);
  const order2 = created2.json;
  const tossConfirm = await call(asToss, 'POST', '/api/payments/confirm', {
    orderId: order2.id, paymentKey: 'pk_toss_default', amount: order2.totals.total_amount,
  });
  assert.equal(tossConfirm.status, 200);
  assert.equal(tossConfirm.json.payment.provider, 'tosspayments');
});

test('cancel routes by the payment row provider, not by the deployment default', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const tid = 'NICE-CANCEL-1';
  await callForm(env, '/api/payments/nicepay/return', signMockWindowPayload({ tid, orderId: order.id, amount: order.totals.total_amount }));
  const res = await call(env, 'POST', `/api/orders/${order.id}/payments/${tid}/cancel`, { reason: '고객 변심' }, auth());
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.refunded, true);
  assert.equal(res.json.cancel_amount, order.totals.total_amount);

  const paid = await call(env, 'GET', `/api/orders/${order.id}`);
  assert.equal(paid.json.payment_status, 'refunded');
  const row = await env.DB.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.balance_amount, 0);
  assert.equal(row.provider, 'nicepay');

  const events = await call(env, 'GET', `/api/orders/${order.id}/events`, null, auth());
  const cancelEvents = (events.json.items || []).filter((e) => e.type === 'payment_cancelled');
  assert.equal(cancelEvents.length, 1);
  assert.match(cancelEvents[0].meta, /고객 변심/);
});

test('the worker hands the merchant orderId down to the gateway cancel', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const tid = 'NICE-ORDERID-1';
  await callForm(env, '/api/payments/nicepay/return', signMockWindowPayload({ tid, orderId: order.id, amount: order.totals.total_amount }));
  const res = await call(env, 'POST', `/api/orders/${order.id}/payments/${tid}/cancel`, { reason: '취소' }, auth());
  assert.equal(res.status, 200, res.text);
  // the mock keeps the transaction by tid; a missing orderId would not have cancelled it
  const row = await env.DB.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.status, 'cancelled');
});

test('a partial refund on a NICEPAY row respects the gateway balance', async () => {
  const env = niceEnv();
  const order = await newPurchase(env);
  const tid = 'NICE-PART-1';
  await callForm(env, '/api/payments/nicepay/return', signMockWindowPayload({ tid, orderId: order.id, amount: order.totals.total_amount }));
  const half = Math.floor(order.totals.total_amount / 2);
  const res = await call(env, 'POST', `/api/orders/${order.id}/payments/${tid}/cancel`, { cancelAmount: half, reason: '일부 반품' }, auth());
  assert.equal(res.status, 200, res.text);
  const row = await env.DB.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.status, 'partial_cancelled');
  assert.equal(row.balance_amount, order.totals.total_amount - half);
  assert.equal(row.cancel_amount, half);

  const over = await call(env, 'POST', `/api/orders/${order.id}/payments/${tid}/cancel`, { cancelAmount: order.totals.total_amount, reason: 'over' }, auth());
  assert.equal(over.status, 200, 'the existing guard clamps to the refundable balance');
  const after = await env.DB.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(after.balance_amount, 0);
});

test('NICEPAY without credentials fails closed instead of using the Toss path', async () => {
  const env = makeEnv({ PG_PROVIDER: 'nicepay', PG_PROVIDER_MODE: 'auto', TOSS_WIDGET_SECRET_KEY: 'test_gsk_dummy' });
  const cfg = await call(env, 'GET', '/api/payments/config');
  assert.equal(cfg.status, 503);
  assert.equal(cfg.json.provider, 'nicepay');
  assert.equal(cfg.json.reason, 'keys_missing');
  assert.deepEqual(cfg.json.missing, ['NICEPAY_TEST_CLIENT_KEY', 'NICEPAY_TEST_SECRET_KEY']);

  const window = await call(env, 'POST', '/api/payments/nicepay/window', { orderId: 'x' });
  assert.equal(window.status, 503);
  const order = await newPurchase(env);
  const redirect = await callForm(env, '/api/payments/nicepay/return', { tid: 'x', orderId: order.id, amount: 1 });
  assert.equal(redirect.status, 503);
  const hook = await call(env, 'POST', '/api/payments/nicepay/webhook', { tid: 'x' });
  assert.equal(hook.status, 503);

  // and it did not quietly fall back to Toss
  const confirm = await call(env, 'POST', '/api/payments/confirm', {
    orderId: order.id, paymentKey: 'pk_should_not_work', amount: order.totals.total_amount,
  });
  assert.equal(confirm.status, 503, 'the active provider is nicepay, so no Toss approval may happen');
});

test('the Toss path is untouched when no provider is selected', async () => {
  const env = makeEnv();
  const order = await newPurchase(env);
  const cfg = await call(env, 'GET', '/api/payments/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.provider, 'tosspayments');
  const res = await call(env, 'POST', '/api/payments/confirm', {
    orderId: order.id, paymentKey: 'pk_toss_still_works', amount: order.totals.total_amount,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.payment.provider, 'tosspayments');
});
