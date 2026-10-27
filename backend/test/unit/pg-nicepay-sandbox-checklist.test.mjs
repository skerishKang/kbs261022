import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TX_STATUS,
  approvePayload,
  basicAuth,
  cancelAmountOf,
  cancelPayload,
  canPartialCancel,
  recoveryRequests,
  refundableAmount,
  toCgiOutcome,
  transactionSignature,
  verifyTransactionMessage,
  webhookAck,
  webhookDedupeKey,
  querySignature,
} from '../../lib/pg-nicepay.mjs';
import { SANDBOX_CAPABILITIES, resolveNicepayEnv } from '../../lib/pg-nicepay-env.mjs';

// The nine checks the work order lists for the NICEPAY sandbox, each pinned to
// the primitive that implements it and to whether it has been proven against a
// live sandbox call. `live` is a claim about evidence, not about the code:
// UNVERIFIED means the offline contract holds but no sandbox response has been
// observed yet.
const SECRET = 'nicepay-fixture-secret-not-real';
const ORDER_AMOUNT = 198000;

function signed(overrides = {}) {
  const body = {
    resultCode: '0000',
    tid: 'UT0000113m01012710000000001001',
    orderId: 'CGI-ORDER-4711',
    amount: ORDER_AMOUNT,
    ediDate: '20261027151500',
    status: TX_STATUS.PAID,
    payMethod: 'CARD',
    ...overrides,
  };
  return {
    ...body,
    signature: transactionSignature({ tid: body.tid, amount: body.amount, ediDate: body.ediDate, secretKey: SECRET }),
  };
}

const CHECKLIST = [
  { item: '결제창 호출', live: 'PARTIAL' },
  { item: '주문금액과 승인금액 일치', live: 'OFFLINE' },
  { item: '승인 결과 확인', live: 'OFFLINE' },
  { item: '주문번호·거래번호 조회', live: 'OFFLINE' },
  { item: '중복 승인 차단', live: 'OFFLINE' },
  { item: '결제 실패 처리', live: 'OFFLINE' },
  { item: '전체취소', live: 'OFFLINE' },
  { item: '결제 결과 Webhook 검증', live: 'OFFLINE' },
  { item: '부분취소 지원 범위 확인', live: 'OFFLINE' },
];

test('sandbox checklist is the nine ordered items and every one declares its evidence level', () => {
  assert.equal(CHECKLIST.length, 9);
  assert.deepEqual(CHECKLIST.map((row) => row.item), [
    '결제창 호출', '주문금액과 승인금액 일치', '승인 결과 확인', '주문번호·거래번호 조회',
    '중복 승인 차단', '결제 실패 처리', '전체취소', '결제 결과 Webhook 검증', '부분취소 지원 범위 확인',
  ]);
  for (const row of CHECKLIST) {
    assert.ok(['OFFLINE', 'PARTIAL', 'LIVE'].includes(row.live), row.item);
  }
  assert.equal(CHECKLIST.filter((row) => row.live === 'PARTIAL').length, 1);
});

test('1 결제창 호출 — the sandbox store exposes the clientId and SDK host the window needs', () => {
  const cfg = resolveNicepayEnv({
    NICEPAY_TEST_CLIENT_KEY: 'sandbox-client-id',
    NICEPAY_TEST_SECRET_KEY: SECRET,
  });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.mode, 'sandbox');
  // the window call is AUTHNICE.requestPay({ clientId, method, orderId, amount, goodsName, returnUrl })
  // — the only two values the server needs from configuration are clientId and the SDK host
  assert.equal(cfg.clientId, 'sandbox-client-id');
  assert.equal(cfg.jsSdkUrl, 'https://pay.nicepay.co.kr/v1/js/');
  assert.equal(cfg.windowHost, 'https://sandbox-pay.nicepay.co.kr');
  // The include itself is measured (200 + AUTHNICE + requestPay); what is still
  // unproven is a full window round-trip with this sandbox clientId.
  assert.equal(cfg.jsSdkUrlVerified, true);
});

test('2 주문금액과 승인금액 일치 — a signed message for a different amount is refused', () => {
  const good = verifyTransactionMessage(signed(), { secretKey: SECRET, expectedAmount: ORDER_AMOUNT });
  assert.equal(good.ok, true);
  assert.equal(good.amount, ORDER_AMOUNT);
  const swapped = verifyTransactionMessage(signed({ amount: 1 }), { secretKey: SECRET, expectedAmount: ORDER_AMOUNT });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.reason, 'amount');
  // A tampered amount that was re-signed with the wrong key must not pass either.
  const forged = { ...signed(), amount: 1 };
  assert.equal(verifyTransactionMessage(forged, { secretKey: SECRET, expectedAmount: ORDER_AMOUNT }).reason, 'signature');
});

test('3 승인 결과 확인 — only paid maps to DONE and the approved transaction is carried through', () => {
  const verified = verifyTransactionMessage(signed(), { secretKey: SECRET, expectedAmount: ORDER_AMOUNT });
  assert.equal(verified.tid, 'UT0000113m01012710000000001001');
  assert.equal(verified.orderId, 'CGI-ORDER-4711');
  const outcome = toCgiOutcome({ ...signed(), balanceAmt: ORDER_AMOUNT }, { orderAmount: ORDER_AMOUNT });
  assert.equal(outcome.status, 'DONE');
  assert.equal(outcome.cgiStatus, 'paid');
  assert.equal(outcome.paymentKey, verified.tid);
  assert.equal(outcome.totalAmount, ORDER_AMOUNT);
  assert.equal(outcome.balanceAmount, ORDER_AMOUNT);
  // A syntactically valid body that reports a failed approval is not DONE.
  const notPaid = toCgiOutcome(signed({ status: TX_STATUS.READY }), { orderAmount: ORDER_AMOUNT });
  assert.notEqual(notPaid.status, 'DONE');
  // and the approve call refuses a payload that was never verified
  assert.throws(() => approvePayload({}), TypeError);
});

test('4 주문번호·거래번호 조회 — a missing webhook is recovered by tid, then by orderId, in the right environment', () => {
  const tid = 'UT0000113m01012710000000001001';
  const reqs = recoveryRequests({
    orders: [{ tid }, { orderId: 'CGI-ORDER-4711' }, { tid, orderId: 'IGNORED' }],
    receivedTids: [],
    mode: 'sandbox',
  });
  assert.equal(reqs.length, 3);
  assert.equal(reqs[0].method, 'GET');
  assert.match(reqs[0].path, /^https:\/\/sandbox-api\.nicepay\.co\.kr\/v1\/payments\/UT0000113m01012710000000001001$/);
  assert.match(reqs[1].path, /\/v1\/payments\/find\/CGI-ORDER-4711$/);
  // an order that has both is probed by tid, because tid is the authoritative key
  assert.equal(reqs[2].path, reqs[0].path);
  // already-received transactions need no probe
  assert.deepEqual(recoveryRequests({ orders: [{ tid }], receivedTids: [tid], mode: 'sandbox' }), []);
  // reconciliation against the operating store must not be built from a sandbox run
  assert.match(recoveryRequests({ orders: [{ orderId: 'A' }], mode: 'production' })[0].path, /^https:\/\/api\.pay\.nicepay\.co\.kr\/v1\//);
});

test('5 중복 승인 차단 — the same (tid, status) notification collapses to one ledger event', () => {
  const key = webhookDedupeKey({ tid: 'UT0000113m01012710000000001001', status: TX_STATUS.PAID });
  assert.ok(key);
  assert.equal(webhookDedupeKey({ tid: 'UT0000113m01012710000000001001', status: TX_STATUS.PAID }), key);
  assert.notEqual(webhookDedupeKey({ tid: 'UT0000113m01012710000000001001', status: TX_STATUS.CANCELLED }), key);
  assert.equal(webhookDedupeKey({ tid: '', status: TX_STATUS.PAID }), null);
  assert.equal(webhookDedupeKey({ tid: 'UT0000113m01012710000000001001' }), null);
});

test('6 결제 실패 처리 — a failed transaction settles nothing and refunds nothing', () => {
  const failed = toCgiOutcome({ status: TX_STATUS.FAILED, amount: ORDER_AMOUNT, balanceAmt: 0 }, { orderAmount: ORDER_AMOUNT });
  assert.equal(failed.cgiStatus, 'failed');
  assert.notEqual(failed.status, 'DONE');
  assert.equal(refundableAmount({ status: TX_STATUS.FAILED, amount: ORDER_AMOUNT, balanceAmt: 0 }), 0);
  const expired = toCgiOutcome({ status: TX_STATUS.EXPIRED, amount: ORDER_AMOUNT }, { orderAmount: ORDER_AMOUNT });
  assert.equal(expired.cgiStatus, 'pending');
});

test('7 전체취소 — a full cancel carries no cancelAmt and clears the whole balance', () => {
  const body = cancelPayload({ orderId: 'CGI-ORDER-4711', cancelReason: '고객 변심' });
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'cancelAmt'), false);
  assert.equal(body.orderId, 'CGI-ORDER-4711');
  const cancelled = toCgiOutcome({
    status: TX_STATUS.CANCELLED, amount: ORDER_AMOUNT, balanceAmt: 0,
    cancelledTid: 'UT0000113m01012710000000009999',
    cancels: [{ cancelAmount: ORDER_AMOUNT, cancelDate: '2026-10-27 16:00:00' }],
  }, { orderAmount: ORDER_AMOUNT });
  assert.equal(cancelled.cgiStatus, 'cancelled');
  assert.equal(cancelled.cancelledTid, 'UT0000113m01012710000000009999');
  assert.equal(cancelAmountOf({ cancels: [{ cancelAmount: ORDER_AMOUNT, cancelDate: '2026-10-27 16:00:00' }] }), ORDER_AMOUNT);
});

test('8 결제 결과 Webhook 검증 — signature, amount and the literal OK answer', () => {
  const ok = verifyTransactionMessage(signed(), { secretKey: SECRET, expectedAmount: ORDER_AMOUNT });
  assert.equal(ok.ok, true);
  const tampered = { ...signed(), signature: 'deadbeef' };
  assert.equal(verifyTransactionMessage(tampered, { secretKey: SECRET }).reason, 'signature');
  assert.equal(verifyTransactionMessage(signed({ resultCode: '1111' }), { secretKey: SECRET }).reason, 'result_code');
  assert.equal(verifyTransactionMessage(signed({ tid: '' }), { secretKey: SECRET }).reason, 'missing_tid');
  assert.equal(verifyTransactionMessage(signed({ ediDate: '' }), { secretKey: SECRET }).reason, 'missing_edi_date');
  assert.equal(verifyTransactionMessage(signed(), { secretKey: '' }).reason, 'missing_secret_key');
  const ack = webhookAck();
  assert.equal(ack.status, 200);
  assert.equal(ack.body, 'OK');
  assert.equal(ack.headers['Content-Type'], 'text/html');
});

test('9 부분취소 지원 범위 확인 — NICE decides per transaction and the sandbox never allows it', () => {
  assert.equal(SANDBOX_CAPABILITIES.partialCancel, false);
  assert.equal(canPartialCancel({ canPartCancel: 'true' }), true);
  assert.equal(canPartialCancel({ canPartCancel: 'false' }), false);
  assert.equal(canPartialCancel({}), false);
  const tx = { amount: ORDER_AMOUNT, balanceAmt: 60000, canPartCancel: 'true' };
  assert.equal(refundableAmount(tx), 60000);
  const partial = cancelPayload({ orderId: 'CGI-ORDER-4711', cancelReason: '일부 반품', cancelAmount: 20000 });
  assert.equal(partial.cancelAmt, 20000);
  assert.throws(() => cancelPayload({ orderId: 'CGI-ORDER-4711', cancelReason: 'x', cancelAmount: -1 }), RangeError);
  assert.throws(() => cancelPayload({ orderId: 'CGI-ORDER-4711', cancelReason: 'x', cancelAmount: 1500.5 }), RangeError);
  // cumulative history is read newest-first by date, not by array position
  assert.equal(cancelAmountOf({ cancels: [
    { cancelAmount: 10000, cancelDate: '2026-10-20 10:00:00' },
    { cancelAmount: 30000, cancelDate: '2026-10-27 10:00:00' },
  ] }), 30000);
  assert.equal(cancelAmountOf({ cancels: [
    { cancelAmount: 30000, cancelDate: '2026-10-27 10:00:00' },
    { cancelAmount: 10000, cancelDate: '2026-10-20 10:00:00' },
  ] }), 30000);
});

test('4b 조회 서명은 승인 서명과 다른 규칙으로 계산된다', () => {
  const tid = 'UT0000113m01012710000000001001';
  const ediDate = '2026-10-27T15:15:00+09:00';
  const query = querySignature({ tid, ediDate, secretKey: SECRET });
  const approve = transactionSignature({ tid, amount: ORDER_AMOUNT, ediDate, secretKey: SECRET });
  assert.match(query, /^[0-9a-f]{64}$/);
  assert.notEqual(query, approve);
  assert.equal(query, querySignature({ tid, ediDate, secretKey: SECRET }));
  assert.equal(querySignature({ tid: '', ediDate, secretKey: SECRET }), null);
  assert.equal(querySignature({ tid, ediDate: '', secretKey: SECRET }), null);
  assert.equal(querySignature({ tid, ediDate, secretKey: '' }), null);
});

test('9b 부분취소 플래그는 card 객체 안에서 읽는다 — 실제 응답 형태', () => {
  // the manual puts canPartCancel under 카드, so a top-level-only read answers
  // "no" for every real card transaction
  const tx = {
    resultCode: '0000', status: TX_STATUS.PAID, payMethod: 'card',
    tid: 'UT0000113m01012710000000001001', orderId: 'CGI-ORDER-4711',
    amount: ORDER_AMOUNT, balanceAmt: ORDER_AMOUNT - 20000,
    paidAt: '2026-10-27T16:00:00.000+09:00', failedAt: 0, cancelledAt: 0,
    ediDate: '2026-10-27T16:00:01.000+09:00',
    card: { cardCode: '01', cardName: '삼성', canPartCancel: 'true' },
  };
  assert.equal(canPartialCancel(tx), true);
  assert.equal(toCgiOutcome(tx, { orderAmount: ORDER_AMOUNT }).isPartialCancelable, true);
  assert.equal(canPartialCancel({ card: { canPartCancel: 'false' } }), false);
  assert.equal(canPartialCancel({ card: {} }), false);
  assert.equal(canPartialCancel({ canPartCancel: 'false', card: { canPartCancel: 'true' } }), false);
});

test('3b lifecycle stamps come from paidAt / failedAt / cancelledAt, and 0 means not-yet', () => {
  const paid = toCgiOutcome({
    status: TX_STATUS.PAID, amount: ORDER_AMOUNT, paidAt: '2026-10-27T16:00:00.000+09:00',
    failedAt: 0, cancelledAt: 0, ediDate: '2026-10-27T16:00:01.000+09:00',
  }, { orderAmount: ORDER_AMOUNT });
  assert.equal(paid.approvedAt, '2026-10-27T16:00:00.000+09:00');
  assert.equal(paid.failedAt, null);
  assert.equal(paid.cancelledAt, null);
  assert.equal(paid.requestedAt, null);
  assert.equal(paid.respondedAt, '2026-10-27T16:00:01.000+09:00');

  const pending = toCgiOutcome({ status: TX_STATUS.READY, amount: ORDER_AMOUNT, paidAt: 0 }, { orderAmount: ORDER_AMOUNT });
  assert.equal(pending.approvedAt, null);

  const cancelled = toCgiOutcome({
    status: TX_STATUS.CANCELLED, amount: ORDER_AMOUNT, paidAt: '2026-10-27T16:00:00.000+09:00',
    cancelledAt: '2026-10-27T18:30:00.000+09:00',
  }, { orderAmount: ORDER_AMOUNT });
  assert.equal(cancelled.cancelledAt, '2026-10-27T18:30:00.000+09:00');
});

test('the sandbox store authenticates with Basic over its own key pair', () => {
  const header = basicAuth({ shopId: 'sandbox-client-id', secretKey: SECRET });
  assert.match(header, /^Basic /);
  assert.equal(Buffer.from(header.slice(6), 'base64').toString('utf8'), `sandbox-client-id:${SECRET}`);
  assert.equal(basicAuth({ shopId: '', secretKey: SECRET }), null);
});
