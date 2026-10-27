// PayApp protocol layer — pure, offline, no network and no credentials.
//
// Why this file exists: issue #106 must decide whether PayApp can replace the
// Toss adapter, and the parts of that decision that are *protocol shape* can be
// pinned without a merchant account. Everything here is derived from the official
// manual (https://docs.payapp.kr/dev_center01.html, fetched 2026-10-27) and is
// testable as written:
//
//   - transport is FORM POST to https://api.payapp.kr/oapi/v2 and the response is
//     a URL-encoded key=value query string, NOT JSON (Toss is JSON + Basic auth);
//   - each request carries hash = sha256(userid + requestdate + requestkey) with
//     requestdate as yyyymmddhhmmss, accepted within ±15 minutes;
//   - the feedbackurl webhook is POSTed by PayApp and must be verified the same
//     way (hash over userid + responsedate + requestkey) plus userid / linkkey /
//     linkval / price equality, and the handler must reply "SUCCESS" or PayApp
//     retries when checkretry=y;
//   - the manual states feedbackurl "여러번 호출이 될 수 있습니다", so delivery is
//     at-least-once and the merchant owns dedup per status;
//   - there is NO server-side payment-status query command in the whole manual
//     (cmd ∈ payrequest, paycancel, paycancelreq, bill*, rebill*, cashSt*,
//      getNaverpayCashPrice, sellerRegist, subRegist, useridCheck), so status is
//     only ever what a verified webhook said. This module therefore refuses to
//     pretend otherwise: nothing here fabricates a lookup.
//
// Not implemented here, on purpose: HTTP calls, retries, storage, and any
// decision about order state. Those live in the worker and need a real account
// plus the four credential values to be verified at all.

import { createHash, timingSafeEqual } from 'node:crypto';

export const PAYAPP_PROVIDER = 'payapp';
export const PAYAPP_BASE_URL = 'https://api.payapp.kr/oapi/v2';
export const PAYAPP_ACK = 'SUCCESS';
export const MIN_AMOUNT_KRW = 1000;
export const REQUEST_DATE_MAX_SKEW_MINUTES = 15;

// Documented pay_state values. 70/71 are the partial-cancel states, which is why
// a refund that stops at the order total is not enough — the same money can be
// reported twice by two different notifications.
export const PAY_STATE = Object.freeze({
  REQUESTED: '1',
  PAID: '4',
  WAITING_DEPOSIT: '10',
  REQUEST_CANCELLED: '8',
  REQUEST_CANCELLED_ALT: '16',
  REQUEST_CANCELLED_ALT2: '31',
  APPROVAL_CANCELLED: '9',
  APPROVAL_CANCELLED_ALT: '64',
  PARTIAL_CANCELLED: '70',
  PARTIAL_CANCELLED_ALT: '71',
});

export const CANCELLED_STATES = Object.freeze([
  PAY_STATE.REQUEST_CANCELLED, PAY_STATE.REQUEST_CANCELLED_ALT, PAY_STATE.REQUEST_CANCELLED_ALT2,
  PAY_STATE.APPROVAL_CANCELLED, PAY_STATE.APPROVAL_CANCELLED_ALT,
  PAY_STATE.PARTIAL_CANCELLED, PAY_STATE.PARTIAL_CANCELLED_ALT,
]);

export const PAID_STATES = Object.freeze([PAY_STATE.PAID]);

// pay_type — only what CGI can actually receive, but the full documented map is
// kept so a method code is never silently treated as a card payment.
export const PAY_TYPE = Object.freeze({
  '1': '신용카드', '2': '휴대전화', '4': '대면결제', '6': '계좌이체', '7': '가상계좌',
  '15': '카카오페이', '16': '네이버페이', '17': '등록결제', '21': '스마일페이',
  '22': '위챗페이', '23': '애플페이', '24': '내통장결제',
});

// Refund is impossible for some documented methods. A UI that offers "환불" for a
// virtual-account payment will fail at the PG, so this belongs next to the codes.
export const REFUND_UNSUPPORTED_TYPES = Object.freeze({ '7': 'virtual_account' });
export const REFUND_CURRENT_MONTH_ONLY_TYPES = Object.freeze({ '2': 'mobile' });

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

const pad2 = (n) => String(n).padStart(2, '0');

/** yyyymmddhhmmss in KST (+09:00) — the format PayApp parses, not ISO. */
export function formatRequestDate(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return [
    kst.getUTCFullYear(), pad2(kst.getUTCMonth() + 1), pad2(kst.getUTCDate()),
    pad2(kst.getUTCHours()), pad2(kst.getUTCMinutes()), pad2(kst.getUTCSeconds()),
  ].join('');
}

/** hash = sha256(userid + requestdate + requestkey), the single documented formula. */
export function payappHash({ userid, date, requestkey }) {
  if (!userid || !date || !requestkey) return null;
  return sha256Hex(`${userid}${date}${requestkey}`);
}

/** requestdate must be 14 digits and within ±15 minutes of the server clock. */
export function isDateFresh(requestdate, now = new Date(), skewMinutes = REQUEST_DATE_MAX_SKEW_MINUTES) {
  if (!/^\d{14}$/.test(String(requestdate || ''))) return false;
  const then = Date.parse(
    `${requestdate.slice(0, 4)}-${requestdate.slice(4, 6)}-${requestdate.slice(6, 8)}` +
    `T${requestdate.slice(8, 10)}:${requestdate.slice(10, 12)}:${requestdate.slice(12, 14)}+09:00`
  );
  if (Number.isNaN(then)) return false;
  return Math.abs(then - now.getTime()) <= skewMinutes * 60 * 1000;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** FORM POST body. UTF-8 strings only, per the manual's parameter rules. */
export function encodeForm(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    body.set(key, String(value));
  }
  return body.toString();
}

/** PayApp answers with a URL-encoded query string, not JSON. */
export function parseResponse(text) {
  const out = {};
  for (const [key, value] of new URLSearchParams(String(text ?? ''))) out[key] = value;
  return out;
}

export const OK_CODE = '00000';

/** Success is code 00000 *and* the payload the manual names for that command. */
export function decodeResult(text) {
  const data = parseResponse(text);
  const ok = String(data.code ?? '') === OK_CODE;
  return {
    ok,
    code: String(data.code ?? ''),
    message: data.errorMessage ?? data.message ?? null,
    payurl: data.payurl ?? null,
    csturl: data.csturl ?? null,
    mulNo: data.mul_no ?? null,
    data,
  };
}

/**
 * Payment request form. `orderId` travels as var1 because that is the only
 * merchant-defined field the manual guarantees to return on the webhook, and the
 * order number is what our idempotency and refund guards key on.
 */
export function buildPayRequest({
  userid, requestkey, orderId, amount, itemName, buyerPhone,
  feedbackurl, linkkey, linkval, memo, requestdate,
}) {
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT_KRW) {
    throw new RangeError(`PayApp amount must be an integer of at least ${MIN_AMOUNT_KRW} KRW`);
  }
  if (!/^https:\/\//.test(String(feedbackurl || ''))) {
    // Error 70001 rejects non-https calls; failing here is cheaper than a rejected
    // payment and an order that never gets a webhook.
    throw new RangeError('feedbackurl must be an https:// URL');
  }
  const date = requestdate ?? formatRequestDate();
  const params = {
    cmd: 'payrequest',
    userid,
    merchantid: userid,
    gname: itemName,
    price: amount,
    buyerphone: buyerPhone,
    orderno: orderId,
    var1: orderId,
    feedbackurl,
    checkretry: 'y',
    requestdate: date,
    hash: payappHash({ userid, date, requestkey }),
  };
  if (linkkey) params.linkkey = linkkey;
  if (linkval) params.linkval = linkval;
  if (memo) params.memo = memo;
  return { form: encodeForm(params), params, requestdate: date };
}

/** Full cancel is partcancel 0; partial needs partcancel 1 plus cancelprice. */
export function buildCancelRequest({
  userid, requestkey, mulNo, orderId, cancelReason,
  cancelAmount = 0, totalAmount, requestdate,
}) {
  if (!cancelReason) throw new RangeError('cancelReason is required');
  const partial = Number.isInteger(cancelAmount) && cancelAmount > 0;
  if (partial) {
    if (!Number.isInteger(totalAmount)) throw new RangeError('totalAmount is required for a partial cancel');
    if (cancelAmount > totalAmount) {
      // The caller's over-refund clamp must hold here too: two notifications for
      // the same money are exactly how a partial refund becomes an over-refund.
      throw new RangeError('cancelAmount exceeds the original payment');
    }
  }
  const date = requestdate ?? formatRequestDate();
  const params = {
    cmd: 'paycancel',
    userid,
    mul_no: mulNo,
    orderno: orderId,
    partcancel: partial ? '1' : '0',
    cancelreason: cancelReason,
    requestdate: date,
    hash: payappHash({ userid, date, requestkey }),
  };
  if (partial) params.cancelprice = cancelAmount;
  return { form: encodeForm(params), params, partial };
}

/**
 * Verify a feedbackurl POST the way the manual's own sample does: identity,
 * linkage, the hash over userid + responsedate + 결제KEY, the amount, and the
 * replay window. Returns a reason and never the secret material.
 */
export function verifyFeedback(form, { userid, linkkey, linkval, requestkey, expectedAmount, now }) {
  const body = form && typeof form === 'object' ? form : {};
  if (!body.userid || !userid || !safeEqual(body.userid, userid)) return { ok: false, reason: 'userid' };
  if (!linkkey || !safeEqual(body.linkkey, linkkey)) return { ok: false, reason: 'linkkey' };
  if (!linkval || !safeEqual(body.linkval, linkval)) return { ok: false, reason: 'linkval' };
  if (!isDateFresh(body.responsedate, now ?? new Date())) return { ok: false, reason: 'stale_or_malformed_date' };
  const expected = payappHash({ userid, date: body.responsedate, requestkey });
  if (!expected || !safeEqual(String(body.hash || '').toLowerCase(), expected)) {
    return { ok: false, reason: 'hash' };
  }
  if (expectedAmount !== undefined && Number(body.price) !== Number(expectedAmount)) {
    return { ok: false, reason: 'amount' };
  }
  if (!body.mul_no) return { ok: false, reason: 'missing_mul_no' };
  return { ok: true, reason: '', orderId: body.var1 ?? body.orderno ?? null, mulNo: body.mul_no, state: body.pay_state, price: Number(body.price), payType: body.pay_type, payDate: body.pay_date ?? null };
}

/**
 * At-least-once delivery means one (mul_no, pay_state) pair can arrive twice.
 * The existing order_events audit already keys on an idempotent insert, so this
 * returns the exact key the worker should reuse rather than inventing a store.
 */
export function feedbackDedupeKey({ mulNo, state }) {
  if (!mulNo || !state) return null;
  return `payapp:feedback:${mulNo}:${state}`;
}

export function isCancellationNotification(state) {
  return CANCELLED_STATES.includes(String(state));
}

export function isPaidNotification(state) {
  return PAID_STATES.includes(String(state));
}

export function ackBody() {
  return PAYAPP_ACK;
}

/**
 * A webhook can be lost. With no status-query command in the manual, the only
 * reconciliation left is the seller-admin transaction list, which the vendor
 * documents as a screen rather than an API. This function names the gap instead
 * of hiding it: it reports what we can prove locally from our own audit trail.
 */
export function unreconciledOrders({ orders, receivedMulNos }) {
  const seen = new Set(receivedMulNos ?? []);
  return (orders ?? []).filter((order) => order && !seen.has(order.mul_no) && order.payment_status !== 'paid');
}
