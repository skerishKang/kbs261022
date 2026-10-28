// Contract tests for the PayApp protocol layer — no network, no credentials.
//
// These pin the documented shapes from https://docs.payapp.kr/dev_center01.html.
// They deliberately re-derive the hash with node:crypto instead of trusting the
// library's own helper twice, so a change to the formula cannot pass by
// mirroring itself. What is NOT covered here, and cannot be without an account:
// whether PayApp accepts these exact values in production, and how it behaves on
// a lost webhook (the manual documents no status-query command at all).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  PAYAPP_ACK, PAYAPP_BASE_URL, MIN_AMOUNT_KRW, PAY_STATE, PAY_TYPE,
  REFUND_UNSUPPORTED_TYPES,
  encodeForm, parseResponse, decodeResult, payappHash, formatRequestDate, isDateFresh,
  buildPayRequest, buildCancelRequest, verifyFeedback, feedbackDedupeKey,
  isCancellationNotification, isPaidNotification, ackBody, unreconciledOrders,
} from '../../lib/pg-payapp.mjs';

const USERID = 'cgiunitshop';
const LINKKEY = 'unit-link-key-0001';
const LINKVAL = 'unit-link-val-0002';
const REQUESTKEY = 'unit-request-key-0003';
const ORDER_ID = 'CGI-20261027-0001';
const NOW = new Date('2026-10-27T10:30:00+09:00');

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Build a correctly signed webhook body the way PayApp says it sends one.
 * A test that tampers with price or hash passes its own replacement value and
 * does NOT get re-signed, which is the point: an attacker edits one field.
 */
function feedbackBody(overrides = {}) {
  const responsedate = formatRequestDate(NOW);
  return {
    userid: USERID,
    linkkey: LINKKEY,
    linkval: LINKVAL,
    responsedate,
    hash: sha256(`${USERID}${responsedate}${REQUESTKEY}`),
    goodname: '음향 장비',
    price: '1500000',
    orderno: ORDER_ID,
    var1: ORDER_ID,
    mul_no: '90000001',
    pay_state: PAY_STATE.PAID,
    pay_type: '1',
    pay_date: responsedate,
    ...overrides,
  };
}

test('the base URL is the documented v2 endpoint over https', () => {
  assert.equal(PAYAPP_BASE_URL, 'https://api.payapp.kr/oapi/v2');
});

test('requestdate is yyyymmddhhmmss in KST, not ISO', () => {
  const stamp = formatRequestDate(new Date('2026-10-27T01:30:00Z'));
  assert.match(stamp, /^\d{14}$/);
  assert.equal(stamp, '20261027103000');
  // a date built from a UTC clock would be 9 hours off and rejected by the vendor
  assert.notEqual(formatRequestDate(new Date('2026-10-27T01:30:00Z')), '20261027013000');
});

test('hash is exactly sha256(userid + requestdate + requestkey)', () => {
  const date = '20261027103000';
  assert.equal(payappHash({ userid: USERID, date, requestkey: REQUESTKEY }), sha256(`${USERID}${date}${REQUESTKEY}`));
  assert.equal(payappHash({ userid: '', date, requestkey: REQUESTKEY }), null);
  assert.equal(payappHash({ userid: USERID, date, requestkey: '' }), null);
  // a reordered formula must not match
  assert.notEqual(payappHash({ userid: USERID, date, requestkey: REQUESTKEY }), sha256(`${date}${USERID}${REQUESTKEY}`));
});

test('requestdate freshness accepts ±15 minutes and rejects malformed stamps', () => {
  const base = new Date('2026-10-27T10:30:00+09:00');
  assert.equal(isDateFresh(formatRequestDate(new Date(base.getTime() - 14 * 60 * 1000)), base), true);
  assert.equal(isDateFresh(formatRequestDate(new Date(base.getTime() + 14 * 60 * 1000)), base), true);
  assert.equal(isDateFresh(formatRequestDate(new Date(base.getTime() - 16 * 60 * 1000)), base), false);
  assert.equal(isDateFresh(formatRequestDate(new Date(base.getTime() + 16 * 60 * 1000)), base), false);
  for (const bad of ['', '2026102710', '2026-10-27T10:30:00', 'abcdefghijklmn', '20261332103000']) {
    assert.equal(isDateFresh(bad, base), false, bad);
  }
});

test('the wire format is FORM POST, and Korean survives UTF-8', () => {
  const form = encodeForm({ cmd: 'payrequest', gname: '음향 장비', price: 1500000, empty: null });
  assert.ok(form.startsWith('cmd=payrequest'));
  assert.ok(!form.includes('empty'), 'null values must not be sent as the string "null"');
  // URLSearchParams writes a space as "+" (a FORM POST, not a JSON document), so
  // the round trip through the parser is the property that matters.
  assert.equal(parseResponse(form).gname, '음향 장비');
  assert.throws(() => JSON.parse(form));
});

test('responses are parsed as a URL-encoded query string, not JSON', () => {
  const raw = 'code=00000&mul_no=90000001&payurl=https%3A%2F%2Fapi.payapp.kr%2Fpay%2Fstart%3Fno%3D90000001';
  const parsed = parseResponse(raw);
  assert.equal(parsed.code, '00000');
  assert.equal(parsed.mul_no, '90000001');
  assert.equal(parsed.payurl, 'https://api.payapp.kr/pay/start?no=90000001');
  const result = decodeResult(raw);
  assert.equal(result.ok, true);
  assert.equal(result.mulNo, '90000001');
  assert.match(result.payurl, /^https:/);
});

test('a failed command keeps the vendor code instead of pretending success', () => {
  const rejected = decodeResult('code=30052&errorMessage=%EA%B1%B0%EC%A0%88');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, '30052');
  assert.equal(rejected.message, '거절');
  assert.equal(decodeResult('').ok, false);
});

test('a payment request carries the order id in var1 and a matching hash', () => {
  const { params, form, requestdate } = buildPayRequest({
    userid: USERID, requestkey: REQUESTKEY, linkkey: LINKKEY, linkval: LINKVAL,
    orderId: ORDER_ID, amount: 1_500_000, itemName: 'PAZ-937',
    buyerPhone: '01012341234', feedbackurl: 'https://shop.example/api/payments/payapp/feedback',
    requestdate: formatRequestDate(NOW),
  });
  assert.equal(params.cmd, 'payrequest');
  assert.equal(params.var1, ORDER_ID, 'var1 is the only merchant field the webhook guarantees back');
  assert.equal(params.price, 1_500_000);
  assert.equal(params.checkretry, 'y', 'without it a lost notification is never retried');
  assert.equal(params.hash, sha256(`${USERID}${requestdate}${REQUESTKEY}`));
  assert.ok(form.includes('feedbackurl=https%3A%2F%2Fshop.example'));
});

test('a payment request below the minimum, or over plain http, is refused locally', () => {
  const base = {
    userid: USERID, requestkey: REQUESTKEY, orderId: ORDER_ID, itemName: 'PAZ-937',
    buyerPhone: '01012341234', feedbackurl: 'https://shop.example/fb',
  };
  assert.throws(() => buildPayRequest({ ...base, amount: 500 }), RangeError);
  assert.throws(() => buildPayRequest({ ...base, amount: '1500000' }), RangeError);
  assert.throws(() => buildPayRequest({ ...base, amount: 1000, feedbackurl: 'http://shop.example/fb' }), /https/);
  assert.equal(MIN_AMOUNT_KRW, 1000);
});

test('full cancel is partcancel 0, partial is partcancel 1 with cancelprice', () => {
  const common = {
    userid: USERID, requestkey: REQUESTKEY, mulNo: '90000001', orderId: ORDER_ID,
    cancelReason: '고객 변심', totalAmount: 1_500_000, requestdate: formatRequestDate(NOW),
  };
  const full = buildCancelRequest(common);
  assert.equal(full.params.partcancel, '0');
  assert.ok(!('cancelprice' in full.params), 'a full cancel must not send a partial amount');
  assert.equal(full.partial, false);

  const part = buildCancelRequest({ ...common, cancelAmount: 300_000 });
  assert.equal(part.params.partcancel, '1');
  assert.equal(part.params.cancelprice, 300_000);
  assert.equal(part.partial, true);
});

test('a partial cancel that exceeds the payment cannot be built', () => {
  const common = {
    userid: USERID, requestkey: REQUESTKEY, mulNo: '90000001', orderId: ORDER_ID,
    cancelReason: '하자품', totalAmount: 1_500_000, requestdate: formatRequestDate(NOW),
  };
  assert.throws(() => buildCancelRequest({ ...common, cancelAmount: 1_500_001 }), RangeError);
  assert.throws(() => buildCancelRequest({ ...common, cancelAmount: 10_000, totalAmount: undefined }), RangeError);
  assert.throws(() => buildCancelRequest({ ...common, cancelReason: '' }), RangeError);
});

test('a correctly signed notification verifies and reports state', () => {
  const verdict = verifyFeedback(feedbackBody(), {
    userid: USERID, linkkey: LINKKEY, linkval: LINKVAL, requestkey: REQUESTKEY,
    expectedAmount: 1_500_000, now: NOW,
  });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.orderId, ORDER_ID);
  assert.equal(verdict.mulNo, '90000001');
  assert.equal(verdict.state, PAY_STATE.PAID);
  assert.equal(isPaidNotification(verdict.state), true);
});

test('identity, linkage, amount, hash and freshness each fail closed on their own', () => {
  const secrets = { userid: USERID, linkkey: LINKKEY, linkval: LINKVAL, requestkey: REQUESTKEY, expectedAmount: 1_500_000, now: NOW };
  const cases = [
    ['userid', feedbackBody({ userid: 'someone-else' })],
    ['linkkey', feedbackBody({ linkkey: 'wrong' })],
    ['linkval', feedbackBody({ linkval: 'wrong' })],
    ['amount', feedbackBody({ price: '1500001' })],
    ['hash', feedbackBody({ price: '1500000', hash: 'deadbeef' })],
    ['stale_or_malformed_date', feedbackBody({ responsedate: formatRequestDate(new Date('2026-10-27T06:00:00+09:00')) })],
    ['missing_mul_no', feedbackBody({ mul_no: '' })],
  ];
  for (const [expected, body] of cases) {
    const verdict = verifyFeedback(body, secrets);
    assert.equal(verdict.ok, false, `${expected} must be rejected`);
    assert.equal(verdict.reason, expected, `expected ${expected}, got ${verdict.reason}`);
    assert.ok(!JSON.stringify(verdict).includes(REQUESTKEY), 'a rejection must not echo the secret');
  }
});

test('the hash comparison is case-insensitive, as the manual states', () => {
  const body = feedbackBody({ hash: feedbackBody().hash.toUpperCase() });
  assert.equal(verifyFeedback(body, {
    userid: USERID, linkkey: LINKKEY, linkval: LINKVAL, requestkey: REQUESTKEY,
    expectedAmount: 1_500_000, now: NOW,
  }).ok, true);
});

test('delivery is at-least-once: same status dedupes, a different status does not', () => {
  const paid = feedbackDedupeKey({ mulNo: '90000001', state: PAY_STATE.PAID });
  const partial = feedbackDedupeKey({ mulNo: '90000001', state: PAY_STATE.PARTIAL_CANCELLED });
  assert.equal(paid, 'payapp:feedback:90000001:4');
  assert.notEqual(paid, partial, 'a later partial cancel must not be swallowed as a duplicate');
  assert.equal(paid, feedbackDedupeKey({ mulNo: '90000001', state: PAY_STATE.PAID }));
  assert.equal(feedbackDedupeKey({ mulNo: '', state: '4' }), null);
});

test('partial-cancel states are cancellations, and the ack is the literal word', () => {
  for (const state of [PAY_STATE.APPROVAL_CANCELLED, PAY_STATE.PARTIAL_CANCELLED, PAY_STATE.PARTIAL_CANCELLED_ALT]) {
    assert.equal(isCancellationNotification(state), true, state);
  }
  assert.equal(isCancellationNotification(PAY_STATE.WAITING_DEPOSIT), false);
  assert.equal(ackBody(), PAYAPP_ACK);
  assert.equal(PAYAPP_ACK, 'SUCCESS');
});

test('refund impossible by method is visible before the UI offers a button', () => {
  assert.equal(PAY_TYPE['7'], '가상계좌');
  assert.equal(REFUND_UNSUPPORTED_TYPES['7'], 'virtual_account');
  assert.equal(PAY_TYPE['23'], '애플페이');
});

test('reconciliation reports orders with no verified notification at all', () => {
  const orders = [
    { id: 'A', mul_no: '1', payment_status: 'paid' },
    { id: 'B', mul_no: undefined, payment_status: 'awaiting_payment' },
    { id: 'C', mul_no: '3', payment_status: 'awaiting_payment' },
  ];
  const stuck = unreconciledOrders({ orders, receivedMulNos: ['1', '3'] });
  assert.deepEqual(stuck.map((o) => o.id), ['B'], 'C got its notification; A is already paid');
});
