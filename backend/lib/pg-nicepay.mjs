// NICEPAY protocol layer — pure, offline, no network and no credentials.
//
// Why this exists next to pg-payapp.mjs: PayApp turned out to have no
// server-side status query, which is the one thing CGI's order/refund model
// cannot work without. NICEPAY does have it, plus an official sandbox and a
// JSON REST shape close enough to the existing Toss adapter to map field for
// field. This file pins that claim in code instead of prose, using only the
// published manual (github.com/nicepayments/nicepay-manual, fetched 2026-10-27)
// — no account, no keys, no calls.
//
// Documented facts encoded here:
//   * transport: JSON body, `Authorization: Basic or Bearer`,
//     `Content-Type: application/json` (common/api.md)
//   * hosts: production api.pay.nicepay.co.kr / sandbox sandbox-api.nicepay.co.kr,
//     JS SDK https://pay.nicepay.co.kr/v1/js/ (common/test.md, common/api.md)
//   * endpoints: POST /v1/access-token, POST /v1/payments/{tid} (승인),
//     POST /v1/payments/{tid}/cancel, GET /v1/payments/{tid},
//     GET /v1/payments/find/{orderId}, POST /v1/check-amount/{tid} (common/api.md)
//   * cancel: `cancelAmt` omitted means full cancel; a cancelled transaction
//     answers `cancelledTid` different from `tid`, `balanceAmt` is what remains
//     refundable, `canPartCancel` gates a second partial, and `orderId` may not
//     be reused for a repeat partial call (api/cancel.md)
//   * status values: paid | ready | failed | cancelled | partialCancelled |
//     expired (api/cancel.md)
//   * signature: hex(sha256(tid + amount + ediDate + SecretKey)) — the manual
//     says the merchant MUST check it and the amount before trusting a message
//     (api/hook.md, api/payment-window-server.md)
//   * webhook answer: HTTP 200 with the literal "OK" in the body and
//     `Content-Type: text/html`; anything else counts as a failure and is
//     replayed via the admin resend function (api/hook.md)
//   * sandbox: created from the seller console after signup, keys differ from
//     production, card answers are pinned to 삼성, and **partial cancel is not
//     available in the sandbox** (common/test.md)

import { createHash, timingSafeEqual } from 'node:crypto';

export const NICEPAY_PROVIDER = 'nicepay';
export const NICEPAY_PROD_API = 'https://api.pay.nicepay.co.kr';
export const NICEPAY_SANDBOX_API = 'https://sandbox-api.nicepay.co.kr';
export const NICEPAY_JS_SDK_PROD = 'https://pay.nicepay.co.kr/v1/js/';
export const NICEPAY_WEBHOOK_ACK = 'OK';
export const OK_CODE = '0000';

const HOSTS = Object.freeze({ production: NICEPAY_PROD_API, sandbox: NICEPAY_SANDBOX_API });

export const TX_STATUS = Object.freeze({
  PAID: 'paid', READY: 'ready', FAILED: 'failed',
  CANCELLED: 'cancelled', PARTIAL_CANCELLED: 'partialCancelled', EXPIRED: 'expired',
});

export function niceApiBase(mode = 'production') {
  const base = HOSTS[mode];
  if (!base) throw new RangeError(`unknown NICEPAY mode: ${mode}`);
  return `${base}/v1`;
}

/** Basic uses 가맹점ID/시크릿키; Bearer needs the access-token call first. */
export function basicAuth({ shopId, secretKey }) {
  if (!shopId || !secretKey) return null;
  return 'Basic ' + Buffer.from(`${shopId}:${secretKey}`, 'utf8').toString('base64');
}

export function bearerAuth(accessToken) {
  return accessToken ? `Bearer ${accessToken}` : null;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** hex(sha256(tid + amount + ediDate + SecretKey)) — the documented order, exactly. */
export function transactionSignature({ tid, amount, ediDate, secretKey }) {
  if (!tid || amount === undefined || amount === null || !ediDate || !secretKey) return null;
  return sha256Hex(`${tid}${amount}${ediDate}${secretKey}`);
}

/**
 * Verify an approval message (returnUrl POST or webhook) before anything is
 * written. resultCode and the amount are checked as well as the signature,
 * because the manual warns that a syntactically valid body can still describe a
 * failed transaction.
 */
export function verifyTransactionMessage(body, { secretKey, expectedAmount } = {}) {
  const tx = body && typeof body === 'object' ? body : {};
  if (String(tx.resultCode ?? OK_CODE) !== OK_CODE) {
    return { ok: false, reason: 'result_code', code: String(tx.resultCode ?? '') };
  }
  if (!tx.tid) return { ok: false, reason: 'missing_tid' };
  if (!tx.ediDate) return { ok: false, reason: 'missing_edi_date' };
  if (!secretKey) return { ok: false, reason: 'missing_secret_key' };
  const expected = transactionSignature({
    tid: tx.tid, amount: tx.amount, ediDate: tx.ediDate, secretKey,
  });
  if (!safeEqual(String(tx.signature ?? '').toLowerCase(), expected ?? '')) {
    return { ok: false, reason: 'signature' };
  }
  if (expectedAmount !== undefined && Number(tx.amount) !== Number(expectedAmount)) {
    return { ok: false, reason: 'amount' };
  }
  return {
    ok: true, reason: '', tid: tx.tid, orderId: tx.orderId ?? null,
    amount: Number(tx.amount), status: tx.status, method: tx.payMethod ?? null,
  };
}

/**
 * 조회(signData) and 승인(signature) do not use the same digest: the manual
 * defines hex(sha256(tid + ediDate + SecretKey)) for 거래조회 and
 * hex(sha256(tid + amount + ediDate + SecretKey)) for the approval message, so
 * reusing one helper for both would sign the wrong thing and be rejected only
 * at runtime against a real transaction.
 */
export function querySignature({ tid, ediDate, secretKey }) {
  if (!tid || !ediDate || !secretKey) return null;
  return sha256Hex(`${tid}${ediDate}${secretKey}`);
}

/** Request bodies. JSON, not FORM POST — the same transport family as Toss. */
export function approvePayload({ signatureData }) {
  if (!signatureData || typeof signatureData !== 'object') {
    throw new TypeError('the approve call forwards the verified returnUrl payload');
  }
  return { ...signatureData };
}

/**
 * Cancel body. `cancelAmt` is intentionally absent for a full cancel: the
 * manual defines "값이 누락이면 전액취소", and sending the total instead would
 * turn a full cancel into a partial one with a different cancelledTid.
 */
export function cancelPayload({ orderId, cancelReason, cancelAmount, refundAccount }) {
  if (!orderId || !cancelReason) throw new RangeError('orderId and cancelReason are required');
  const body = { orderId, cancelReason };
  if (cancelAmount === undefined || cancelAmount === null || cancelAmount === 0) {
    body.cancelMethod = 'RESTRICT';
  } else {
    if (!Number.isInteger(cancelAmount) || cancelAmount < 0) {
      throw new RangeError('cancelAmount must be a non-negative integer');
    }
    body.cancelAmt = cancelAmount;
    body.cancelMethod = 'RESTRICT';
  }
  if (refundAccount) {
    body.refundBankCode = refundAccount.bankCode ?? undefined;
    body.refundAccount = refundAccount.accountNumber ?? undefined;
  }
  return body;
}

/**
 * The refund guard the worker already enforces (Math.min(requested, refundable))
 * is expressed here against NICE's own fields so a partial cancel cannot exceed
 * what NICE still considers refundable, and cannot be attempted at all when
 * canPartCancel says no.
 */
export function refundableAmount(tx) {
  const balance = Number(tx && tx.balanceAmt);
  if (Number.isFinite(balance) && balance >= 0) return Math.trunc(balance);
  const amount = Number(tx && tx.amount);
  return Number.isFinite(amount) && amount > 0 ? Math.trunc(amount) : 0;
}

/**
 * NICE answers `canPartCancel` inside the `card` object of the transaction, not
 * at its top level (api/status-transaction.md 응답 명세 → 카드). Reading only the
 * top level silently answers "no" for every real card transaction, which would
 * lock CGI out of partial refunds on a payment that is fully refundable.
 */
export function canPartialCancel(tx) {
  const value = tx?.canPartCancel ?? tx?.card?.canPartCancel;
  return String(value ?? '').toLowerCase() === 'true';
}

/**
 * NICE reports cumulative cancel history in `cancels[]`. CGI's ledger stores the
 * newest transaction only (adding the running total again would double-count),
 * so the newest entry is picked by its own date rather than by array position.
 */
export function latestCancel(tx) {
  const rows = Array.isArray(tx?.cancels) ? tx.cancels.filter((row) => row && typeof row === 'object') : [];
  if (!rows.length) return null;
  return rows.reduce((newest, row) => {
    const a = Date.parse(newest.cancelDate ?? newest.cancelReqDate ?? 0) || 0;
    const b = Date.parse(row.cancelDate ?? row.cancelReqDate ?? 0) || 0;
    return b > a ? row : newest;
  }, rows[0]);
}

export function cancelAmountOf(tx, fallback = 0) {
  const last = latestCancel(tx);
  const value = Number(last?.cancelAmount ?? last?.cancelAmt);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : Math.trunc(Number(fallback) || 0);
}

/**
 * Map a NICE transaction onto the object worker.js already consumes from Toss
 * (status/DONE, totalAmount, balanceAmount, suppliedAmount, vat, method,
 * requestedAt, approvedAt, cancels). Two fields have no NICE counterpart:
 * suppliedAmount and vat — NICE answers only `taxFreeAmt`. The worker's own
 * order totals stay authoritative for the tax split, so these are left as the
 * order's values passed in rather than invented from the payment amount.
 */
export function toCgiOutcome(tx, { orderAmount, suppliedAmount = 0, vat = 0 } = {}) {
  const status = String(tx?.status ?? '');
  const done = status === TX_STATUS.PAID;
  return {
    status: done ? 'DONE' : status || 'pending',
    cgiStatus: done ? 'paid' : status === TX_STATUS.CANCELLED || status === TX_STATUS.PARTIAL_CANCELLED
      ? 'cancelled' : status === TX_STATUS.FAILED ? 'failed' : 'pending',
    totalAmount: numberOr(tx?.amount, orderAmount),
    balanceAmount: numberOr(tx?.balanceAmt, orderAmount),
    suppliedAmount: Number.isFinite(suppliedAmount) ? suppliedAmount : 0,
    vat: Number.isFinite(vat) ? vat : 0,
    taxFreeAmount: numberOr(tx?.taxFreeAmt, 0),
    method: tx?.payMethod ?? null,
    requestedAt: tx?.reqDate ?? null,
    // paidAt carries 0 (not null) while a transaction is unpaid, and the
    // lifecycle stamps are paidAt / failedAt / cancelledAt in NICE's own names.
    approvedAt: stamp(tx?.paidAt ?? tx?.approveDate),
    failedAt: stamp(tx?.failedAt),
    cancelledAt: stamp(tx?.cancelledAt),
    respondedAt: tx?.ediDate ?? null,
    cancels: Array.isArray(tx?.cancels) ? tx.cancels : [],
    isPartialCancelable: canPartialCancel(tx),
    paymentKey: tx?.tid ?? null,
    cancelledTid: tx?.cancelledTid ?? null,
    orderId: tx?.orderId ?? null,
    raw: tx ?? null,
  };
}

/** NICE uses the literal 0 for "this stage has not happened". */
function stamp(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text === '' || /^0+$/.test(text)) return null;
  return text;
}

function numberOr(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n)) return Math.trunc(n);
  const f = Number(fallback);
  return Number.isFinite(f) ? Math.trunc(f) : 0;
}

/** Status is at-least-once too; (tid, status) is the natural dedupe key. */
export function webhookDedupeKey({ tid, status }) {
  if (!tid || !status) return null;
  return `nicepay:webhook:${tid}:${status}`;
}

export function webhookAck() {
  return { status: 200, headers: { 'Content-Type': 'text/html' }, body: NICEPAY_WEBHOOK_ACK };
}

/**
 * Reconciliation: unlike PayApp, a lost webhook is recoverable here because the
 * transaction can be re-read by tid or by the merchant's own orderId.
 */
export function recoveryRequests({ orders, receivedTids, mode = 'production' }) {
  const base = niceApiBase(mode);
  const seen = new Set(receivedTids ?? []);
  const out = [];
  for (const order of orders ?? []) {
    if (!order || seen.has(order.tid)) continue;
    if (order.tid) out.push({ method: 'GET', path: `${base}/payments/${encodeURIComponent(order.tid)}` });
    else if (order.orderId) out.push({ method: 'GET', path: `${base}/payments/find/${encodeURIComponent(order.orderId)}` });
  }
  return out;
}
