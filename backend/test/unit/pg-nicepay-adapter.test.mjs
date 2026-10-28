import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNicepayAdapter, NicepayApiError } from '../../lib/pg-nicepay-adapter.mjs';
import { approvePayload, transactionSignature } from '../../lib/pg-nicepay.mjs';

const CLIENT = 'nicepay-fixture-pubclient-notreal';
const SECRET = 'zzserversecret-notreal-nicepay';
const TID = 'UT0000113m01012710000000001001';
const AMOUNT = 198000;

function transport(handler = null) {
  const seen = [];
  return {
    seen,
    fetchFn: async (url, init) => {
      seen.push({ url, init });
      if (handler) return handler(url, init, seen.length - 1);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            resultCode: '0000', resultMsg: '성공', tid: TID, cancelledTid: 'UT0000113m01012710000000009999',
            orderId: 'CGI-ORDER-4711', status: 'paid', paidAt: '2026-10-27T16:00:00.000+09:00',
            failedAt: 0, cancelledAt: 0, payMethod: 'card', amount: AMOUNT, balanceAmt: AMOUNT,
            card: { cardName: '삼성', canPartCancel: 'true' },
          };
        },
      };
    },
  };
}

function adapter(over = {}) {
  const t = transport(over.handler);
  const a = createNicepayAdapter({
    clientId: CLIENT, secretKey: SECRET, mode: over.mode || 'sandbox',
    environment: over.environment || 'test', fetchFn: t.fetchFn,
    nowFn: over.nowFn || (() => new Date('2026-10-27T16:00:00+09:00')),
  });
  return { a, t };
}

/** The window payload NICE posts to returnUrl; signed with the approval digest rule. */
function windowPayload(over = {}) {
  const body = {
    resultCode: '0000', tid: TID, orderId: 'CGI-ORDER-4711', amount: AMOUNT,
    ediDate: '20261027151500', status: 'paid', payMethod: 'card', ...over,
  };
  const signed = { ...body, signature: transactionSignature({ tid: body.tid, amount: body.amount, ediDate: body.ediDate, secretKey: SECRET }) };
  // an explicit signature in `over` must survive: re-signing it would make every
  // tamper case silently valid
  return over.signature === undefined ? signed : { ...signed, signature: over.signature };
}

test('the adapter needs both halves of the credential pair and refuses to guess', () => {
  assert.throws(() => createNicepayAdapter({ clientId: CLIENT }), TypeError);
  assert.throws(() => createNicepayAdapter({ secretKey: SECRET }), TypeError);
  const { a } = adapter();
  assert.equal(a.provider, 'nicepay');
  assert.equal(a.mode, 'sandbox');
  assert.equal(a.sandbox, true);
  assert.equal(a.live, false);
  assert.equal(a.apiBaseUrl, 'https://sandbox-api.nicepay.co.kr/v1');
});

test('production mode moves the host and re-enables partial cancel', () => {
  const { a } = adapter({ mode: 'production', environment: 'operating' });
  assert.equal(a.apiBaseUrl, 'https://api.pay.nicepay.co.kr/v1');
  assert.equal(a.live, true);
  assert.equal(a.supports.partialCancel, true);
});

test('window params carry only what the browser legitimately holds', () => {
  const { a } = adapter();
  const params = a.windowParams({ orderId: 'CGI-ORDER-4711', amount: AMOUNT, goodsName: 'CGI 장비', returnUrl: 'http://localhost:8787/api/payments/nicepay/return' });
  assert.equal(params.clientId, CLIENT);
  assert.equal(params.sdkUrl, 'https://pay.nicepay.co.kr/v1/js/');
  assert.equal(params.windowHost, 'https://sandbox-pay.nicepay.co.kr');
  assert.equal(params.request.method, 'card');
  assert.equal(params.request.amount, AMOUNT);
  assert.equal(params.request.returnUrl, 'http://localhost:8787/api/payments/nicepay/return');
  assert.equal(JSON.stringify(params).includes(SECRET), false, 'the secret key leaked into window params');
  assert.equal(params.request.goodsName, 'CGI 장비');
  // goodsName is capped at 40 bytes by the manual
  assert.equal(a.windowParams({ orderId: 'A', amount: 1, goodsName: '가'.repeat(60), returnUrl: 'http://x' }).request.goodsName.length, 40);
  assert.equal(a.windowParams({ orderId: '', amount: 1, returnUrl: 'http://x' }), null);
});

test('approve body is {amount, ediDate, signData}, not the window payload', () => {
  const body = approvePayload({ tid: TID, amount: AMOUNT, ediDate: '2026-10-27T16:00:00+09:00', secretKey: SECRET });
  assert.deepEqual(Object.keys(body).sort(), ['amount', 'ediDate', 'signData']);
  assert.match(body.signData, /^[0-9a-f]{64}$/);
  assert.equal(body.amount, AMOUNT);
  // the digest rule is the approval one (includes amount)
  assert.equal(body.signData, transactionSignature({ tid: TID, amount: AMOUNT, ediDate: body.ediDate, secretKey: SECRET }));
  assert.throws(() => approvePayload({ amount: 1, ediDate: 'x', secretKey: SECRET }), TypeError);
  assert.throws(() => approvePayload({ tid: TID, amount: '198000.5', ediDate: 'x', secretKey: SECRET }), RangeError);
  assert.throws(() => approvePayload({ tid: TID, amount: 0, ediDate: 'x', secretKey: SECRET }), RangeError);
});

test('confirm verifies the window payload before it approves anything', async () => {
  const { a, t } = adapter();
  await assert.rejects(() => a.confirm({ paymentKey: TID, orderId: 'CGI-ORDER-4711', amount: AMOUNT }), TypeError);
  await assert.rejects(
    () => a.confirm({ paymentKey: TID, orderId: 'X', amount: AMOUNT, signatureData: windowPayload({ signature: 'deadbeef' }) }),
    (e) => e instanceof NicepayApiError && e.code === 'window_signature' && t.seen.length === 0,
  );
  await assert.rejects(
    () => a.confirm({ paymentKey: TID, orderId: 'X', amount: 1, signatureData: windowPayload() }),
    (e) => e.code === 'window_amount' && t.seen.length === 0,
  );
  await assert.rejects(
    () => a.confirm({ paymentKey: TID, orderId: 'X', amount: AMOUNT, signatureData: windowPayload({ resultCode: '1111' }) }),
    (e) => e.code === 'window_result_code' && t.seen.length === 0,
  );
});

test('confirm posts the tid in the path with Basic auth and maps a DONE outcome', async () => {
  const { a, t } = adapter();
  const outcome = await a.confirm({ paymentKey: TID, orderId: 'CGI-ORDER-4711', amount: AMOUNT, signatureData: windowPayload(), idempotencyKey: 'cgi:confirm:1' });
  assert.equal(t.seen.length, 1);
  const { url, init } = t.seen[0];
  assert.equal(url, `https://sandbox-api.nicepay.co.kr/v1/payments/${TID}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${CLIENT}:${SECRET}`, 'utf8').toString('base64')}`);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['amount', 'ediDate', 'signData']);
  assert.equal(outcome.status, 'DONE');
  assert.equal(outcome.totalAmount, AMOUNT);
  assert.equal(outcome.balanceAmount, AMOUNT);
  assert.equal(outcome.paymentKey, TID);
  assert.equal(outcome.method, 'card');
  assert.equal(outcome.approvedAt, '2026-10-27T16:00:00.000+09:00');
  assert.equal(outcome.isPartialCancelable, true);
  assert.equal(init.headers['X-Request-Idempotency-Key'], 'cgi:confirm:1');
});

test('cancel omits cancelAmt for a full refund and sends it for a partial one', async () => {
  const full = adapter();
  await full.a.cancel({ paymentKey: TID, orderId: 'CGI-ORDER-4711', cancelReason: '환불 요청' });
  assert.equal(full.t.seen[0].url, `https://sandbox-api.nicepay.co.kr/v1/payments/${TID}/cancel`);
  const body = JSON.parse(full.t.seen[0].init.body);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'cancelAmt'), false);
  assert.equal(body.orderId, 'CGI-ORDER-4711');
  assert.equal(body.reason, '환불 요청');

  const partial = adapter();
  await partial.a.cancel({ paymentKey: TID, orderId: 'CGI-ORDER-4711', cancelAmount: 20000, cancelReason: '일부 반품' });
  assert.equal(JSON.parse(partial.t.seen[0].init.body).cancelAmt, 20000);
});

test('cancel carries the merchant orderId the gateway requires', async () => {
  const { a, t } = adapter();
  await a.cancel({ paymentKey: TID, orderId: 'CGI-ORDER-4711', cancelReason: '환불' });
  const body = JSON.parse(t.seen[0].init.body);
  assert.equal(body.orderId, 'CGI-ORDER-4711', 'NICE rejects the call without orderId');
  assert.equal(body.reason, '환불');
  assert.match(body.signData, /^[0-9a-f]{64}$/, 'cancel must carry the 조회-rule digest');
  assert.match(body.ediDate, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.reason, '환불');
});

test('lookups sign with the 조회 rule and keep the secret out of the URL', async () => {
  const { a, t } = adapter();
  await a.fetchByPaymentKey(TID);
  const url = new URL(t.seen[0].url);
  assert.equal(url.pathname, `/v1/payments/${TID}`);
  const sign = url.searchParams.get('signData');
  assert.match(sign, /^[0-9a-f]{64}$/);
  assert.equal(url.search.includes(SECRET), false);
  // not the approval digest
  assert.notEqual(sign, transactionSignature({ tid: TID, amount: AMOUNT, ediDate: url.searchParams.get('ediDate'), secretKey: SECRET }));

  await a.fetchByOrderId('CGI-ORDER-4711');
  const second = new URL(t.seen[1].url);
  assert.equal(second.pathname, '/v1/payments/find/CGI-ORDER-4711');
  assert.match(second.searchParams.get('orderDate'), /^\d{8}$/);
});

test('a failed gateway response throws without echoing the secret', async () => {
  const { a } = adapter({
    handler: async () => ({
      ok: false, status: 401,
      async json() { return { resultCode: 'U304', resultMsg: `인가 실패 key=${SECRET}` }; },
    }),
  });
  await assert.rejects(
    () => a.fetchByPaymentKey(TID),
    (e) => {
      assert.ok(e instanceof NicepayApiError);
      assert.equal(e.code, 'U304');
      assert.equal(e.status, 401);
      assert.equal(e.message.includes(SECRET), false, 'the error message echoed the secret');
      assert.equal(String(e).includes(SECRET), false);
      assert.match(e.message, /«redacted»/);
      return true;
    },
  );
});

test('a non-0000 code on an HTTP 200 is still a failure', async () => {
  const { a } = adapter({
    handler: async () => ({ ok: true, status: 200, async json() { return { resultCode: '3011', resultMsg: '카드번호 오류' }; } }),
  });
  await a.fetchByPaymentKey(TID).then(() => { throw new Error('should have thrown'); }, (e) => {
    assert.equal(e.code, '3011');
  });
});

test('a body that is not JSON surfaces as an HTTP failure, not a crash', async () => {
  const { a } = adapter({ handler: async () => ({ ok: false, status: 502, async json() { throw new Error('not json'); } }) });
  await assert.rejects(() => a.fetchByPaymentKey(TID), (e) => e.status === 502 && e.code === null);
});

test('webhook helpers are reachable from the adapter the worker holds', async () => {
  const { a } = adapter();
  const ack = a.webhook.ack();
  assert.equal(ack.status, 200);
  assert.equal(ack.body, 'OK');
  assert.equal(ack.headers['Content-Type'], 'text/html');
  assert.equal(a.webhook.dedupeKey({ tid: TID, status: 'paid' }), a.webhook.dedupeKey({ tid: TID, status: 'paid' }));
  assert.equal(a.webhook.verify(windowPayload(), { expectedAmount: AMOUNT }).ok, true);
  assert.equal(a.webhook.verify({ ...windowPayload(), signature: 'x' }, { expectedAmount: AMOUNT }).ok, false);
});
