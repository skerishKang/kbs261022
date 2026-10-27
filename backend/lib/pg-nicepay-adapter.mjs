// NICEPAY adapter — implements the same contract worker.js already consumes from
// the Toss adapter (provider/mode/sandbox/live + confirm/cancel/fetchBy*), so the
// order state machine, ledger rows and refund guards are reused instead of
// forked. Nothing here decides which provider is active; that is env policy.
//
// Request shapes follow the manual (github.com/nicepayments/nicepay-manual) and
// one live sandbox observation:
//   approve  POST /v1/payments/{tid}                body {amount, ediDate, signData}
//            signData = hex(sha256(tid + amount + ediDate + SecretKey))
//   cancel   POST /v1/payments/{tid}/cancel         body cancelPayload()
//   lookup   GET  /v1/payments/{tid}                query ediDate + signData
//   lookup   GET  /v1/payments/find/{orderId}       query orderDate + ediDate + signData
// The approval body is NOT the payment-window return payload: the window carries
// `signature`, the server-to-server approve call carries a freshly computed
// `signData`. Forwarding the window payload would be accepted by no real gateway.

import {
  NICEPAY_PROVIDER,
  approvePayload,
  basicAuth,
  cancelPayload,
  querySignature,
  toCgiOutcome,
  transactionSignature,
  verifyTransactionMessage,
  webhookAck,
  webhookDedupeKey,
} from './pg-nicepay.mjs';

const NICE_OK = '0000';

function toNonNegLocal(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/** Carries only what is safe to log: code, message, HTTP status, endpoint. */
export class NicepayApiError extends Error {
  constructor({ code, message, status, endpoint }) {
    super(message || `nicepay request failed (${endpoint})`);
    this.name = 'NicepayApiError';
    this.code = code || null;
    this.status = status || null;
    this.endpoint = endpoint || null;
  }
}

function isoNow(now) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T`
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function ymd(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

const MOCK_SECRET = 'mock-server-secret-not-a-real-key';
const MOCK_CLIENT = 'mock-client-id-not-a-real-key';
const MOCK_TX = new Map();

/**
 * The mock speaks the same contract as the live adapter, including the rule that
 * matters for security: an approval without a verified window payload is refused.
 * Tests therefore exercise the real guard instead of a weaker stand-in.
 */
export function signMockWindowPayload({ tid, orderId, amount, ediDate = '20260101000000', resultCode = '0000' }) {
  return {
    resultCode, tid, orderId, amount, ediDate, status: 'paid', payMethod: 'card',
    signature: transactionSignature({ tid, amount, ediDate, secretKey: MOCK_SECRET }),
  };
}

export function resetMockNicepayTransactions() {
  MOCK_TX.clear();
}

export function seedMockNicepayTransaction({ tid, orderId, amount }) {
  const payload = signMockWindowPayload({ tid, orderId, amount });
  MOCK_TX.set(tid, {
    tid, orderId, amount, balanceAmt: amount, status: 'paid', payMethod: 'card',
    paidAt: new Date().toISOString(), cancels: [], canPartCancel: 'true', _payload: payload,
  });
  return payload;
}

export function createNicepayMockAdapter() {
  function tx(tid) {
    const row = MOCK_TX.get(tid);
    if (!row) throw new NicepayApiError({ code: 'mock_unknown_tid', message: 'no such mock transaction', endpoint: 'mock' });
    return row;
  }
  return {
    provider: NICEPAY_PROVIDER,
    mode: 'mock',
    environment: 'mock',
    sandbox: true,
    live: false,
    clientId: MOCK_CLIENT,
    sdkUrl: 'mock://nicepay-window',
    supports: { partialCancel: true, statusQuery: true, orderByOrderId: true },
    windowParams({ orderId, amount, goodsName, returnUrl, method = 'card' }) {
      if (!orderId || !amount || !returnUrl) return null;
      return {
        sdkUrl: 'mock://nicepay-window',
        windowHost: 'mock://nicepay-window',
        clientId: MOCK_CLIENT,
        request: { clientId: MOCK_CLIENT, method, orderId, amount: Number(amount), goodsName: goodsName || 'CGI 주문', returnUrl },
      };
    },
    verifyWindowPayload(payload, { expectedAmount } = {}) {
      return verifyTransactionMessage(payload, { secretKey: MOCK_SECRET, expectedAmount });
    },
    async confirm({ paymentKey, orderId, amount, signatureData }) {
      if (!signatureData || typeof signatureData !== 'object') throw new TypeError('confirm needs the payment window payload to verify');
      const verified = verifyTransactionMessage(signatureData, { secretKey: MOCK_SECRET, expectedAmount: amount });
      if (!verified.ok) throw new NicepayApiError({ code: `window_${verified.reason}`, message: 'mock window payload did not verify', endpoint: 'mock' });
      const row = seedIfMissing({ tid: paymentKey, orderId, amount, signatureData });
      return toCgiOutcome(row, { orderAmount: amount });
    },
    async cancel({ paymentKey, orderId, cancelAmount, cancelReason }) {
      // the live endpoint rejects the call without the merchant orderId (measured:
      // U100 on a missing required field), so the mock refuses it too — otherwise a
      // worker that forgets to pass orderId would look correct offline
      if (!orderId) throw new NicepayApiError({ code: 'mock_missing_orderId', message: 'orderId is required by the cancel endpoint', endpoint: 'mock' });
      const row = tx(paymentKey);
      const amount = cancelAmount && cancelAmount > 0 ? cancelAmount : row.balanceAmt;
      if (amount > row.balanceAmt) throw new NicepayApiError({ code: 'mock_over_refund', message: 'cancel exceeds balance', endpoint: 'mock' });
      row.balanceAmt -= amount;
      row.cancels.push({ cancelAmount: amount, cancelReason: cancelReason || '', cancelDate: new Date().toISOString() });
      row.status = row.balanceAmt === 0 ? 'cancelled' : 'partialCancelled';
      row.cancelledTid = row.status === 'cancelled' ? `${paymentKey}C` : paymentKey;
      const outcome = toCgiOutcome(row, { orderAmount: amount });
      outcome.status = row.balanceAmt === 0 ? 'CANCELED' : 'PARTIAL_CANCELED';
      return outcome;
    },
    async fetchByPaymentKey(paymentKey) { return { ...tx(paymentKey) }; },
    async fetchByOrderId(orderId) {
      for (const row of MOCK_TX.values()) if (row.orderId === orderId) return { ...row };
      throw new NicepayApiError({ code: 'mock_unknown_order', message: 'no such mock order', endpoint: 'mock' });
    },
    webhook: {
      dedupeKey: webhookDedupeKey,
      ack: webhookAck,
      verify: (payload, { expectedAmount } = {}) => verifyTransactionMessage(payload, { secretKey: MOCK_SECRET, expectedAmount }),
    },
  };
}

function seedIfMissing({ tid, orderId, amount }) {
  if (!MOCK_TX.has(tid)) {
    MOCK_TX.set(tid, {
      tid, orderId, amount, balanceAmt: amount, status: 'paid', payMethod: 'card',
      paidAt: new Date().toISOString(), cancels: [], canPartCancel: 'true',
    });
  }
  const row = MOCK_TX.get(tid);
  row.orderId = row.orderId || orderId;
  return { ...row, amount };
}

export function createNicepayAdapter({
  clientId,
  secretKey,
  mode = 'sandbox',
  environment = 'test',
  apiBaseUrl,
  windowHost,
  fetchFn = fetch,
  nowFn = () => new Date(),
} = {}) {
  if (!clientId || !secretKey) {
    throw new TypeError('nicepay adapter needs clientId and secretKey');
  }
  const base = String(apiBaseUrl || (mode === 'sandbox'
    ? 'https://sandbox-api.nicepay.co.kr/v1'
    : 'https://api.pay.nicepay.co.kr/v1')).replace(/\/$/, '');
  const auth = basicAuth({ shopId: clientId, secretKey });

  // Whatever a gateway (or a proxy in front of one) puts in resultMsg ends up in
  // an Error message, which means logs. Credentials are removed at the source
  // rather than trusted to the upstream not echoing them back.
  function sanitize(text) {
    let out = String(text ?? '');
    for (const secret of [secretKey, clientId, auth]) {
      if (secret) out = out.split(secret).join('«redacted»');
    }
    return out.slice(0, 120);
  }

  async function call(method, path, { query, body, idempotencyKey } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const headers = {
      Authorization: auth,
      'Content-Type': 'application/json;charset=utf-8',
      Accept: 'application/json',
    };
    // NICE does not define an idempotency header; the key is kept for the caller's
    // own ledger and to make a duplicate attempt visible in diagnostics.
    if (idempotencyKey) headers['X-Request-Idempotency-Key'] = String(idempotencyKey).slice(0, 120);
    const response = await fetchFn(url.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    const code = payload ? String(payload.resultCode ?? payload.code ?? '') : '';
    if (!response.ok || (code && code !== NICE_OK)) {
      throw new NicepayApiError({
        code: code || null,
        message: payload ? sanitize(payload.resultMsg) : null,
        status: response.status,
        endpoint: `${method} ${url.pathname}`,
      });
    }
    return payload || {};
  }

  return {
    provider: NICEPAY_PROVIDER,
    mode,
    environment,
    sandbox: mode === 'sandbox',
    live: mode === 'production',
    apiBaseUrl: base,
    // The client key is what the browser holds in the window call, so exposing it
    // through the config route is the documented design, not a leak. The secret
    // key stays closed over and is never on this object.
    clientId,
    sdkUrl: 'https://pay.nicepay.co.kr/v1/js/',
    supports: { partialCancel: mode === 'production', statusQuery: true, orderByOrderId: true },

    /** What the browser needs to open the NICEPAY window. clientId is public by design. */
    windowParams({ orderId, amount, goodsName, returnUrl, method = 'card', mallUserId = null, buyerName = null, buyerTel = null, buyerEmail = null }) {
      if (!orderId || !amount || !returnUrl) return null;
      // buyerTel is not decoration: the card window asks for the cash-receipt
      // phone number when it is absent, which blocks a headless test run.
      return {
        sdkUrl: 'https://pay.nicepay.co.kr/v1/js/',
        windowHost: windowHost || (mode === 'sandbox' ? 'https://sandbox-pay.nicepay.co.kr' : 'https://pay.nicepay.co.kr'),
        clientId,
        request: {
          clientId,
          method,
          orderId: String(orderId).slice(0, 64),
          amount: Number(amount),
          goodsName: String(goodsName || 'CGI 주문').slice(0, 40),
          returnUrl,
          ...(mallUserId ? { mallUserId: String(mallUserId).slice(0, 20) } : {}),
          ...(buyerName ? { buyerName: String(buyerName).slice(0, 30) } : {}),
          ...(buyerTel ? { buyerTel: String(buyerTel).replace(/[^0-9]/g, '').slice(0, 11) } : {}),
          ...(buyerEmail ? { buyerEmail: String(buyerEmail).slice(0, 60) } : {}),
        },
      };
    },

    /** The window's own signature, verified before the approve call is allowed. */
    verifyWindowPayload(payload, { expectedAmount } = {}) {
      return verifyTransactionMessage(payload, { secretKey, expectedAmount });
    },

    async confirm({ paymentKey, orderId, amount, signatureData, idempotencyKey }) {
      if (!paymentKey) throw new TypeError('confirm needs the tid from the payment window');
      // A return payload that was never verified must not reach the approve call,
      // and an approval without any window payload at all is not a thing the
      // Server-승인 model supports — failing open here would let a caller approve
      // a tid it merely guessed.
      if (!signatureData || typeof signatureData !== 'object') {
        throw new TypeError('confirm needs the payment window payload to verify');
      }
      const windowVerified = verifyTransactionMessage(signatureData, { secretKey, expectedAmount: amount });
      if (!windowVerified.ok) {
        throw new NicepayApiError({
          code: `window_${windowVerified.reason}`,
          message: 'the payment window payload did not verify; no approval was requested',
          endpoint: 'verify',
        });
      }
      const body = approvePayload({ tid: paymentKey, amount, ediDate: isoNow(nowFn()), secretKey });
      const tx = await call('POST', `/payments/${encodeURIComponent(paymentKey)}`, { body, idempotencyKey });
      return toCgiOutcome({ ...tx, tid: tx.tid || paymentKey, orderId: tx.orderId || orderId }, { orderAmount: amount });
    },

    async cancel({ paymentKey, orderId, cancelAmount, cancelReason, refundReceiveAccount, idempotencyKey }) {
      const ediDate = isoNow(nowFn());
      const body = cancelPayload({
        orderId,
        // the worker speaks Toss's field name; the endpoint's is `reason`
        reason: cancelReason || '고객 요청에 의한 취소',
        ...(cancelAmount ? { cancelAmount } : {}),
        ...(refundReceiveAccount ? { refundAccount: refundReceiveAccount } : {}),
      });
      // cancel is signed the way a lookup is: hex(sha256(tid + ediDate + SecretKey))
      body.ediDate = ediDate;
      body.signData = querySignature({ tid: paymentKey, ediDate, secretKey });
      const tx = await call('POST', `/payments/${encodeURIComponent(paymentKey)}/cancel`, { body, idempotencyKey });
      const outcome = toCgiOutcome({ ...tx, tid: paymentKey }, { orderAmount: cancelAmount || 0 });
      // cancelPayment decides between a full and a partial refund on this
      // vocabulary; NICE's own lowercase status would read as partial forever.
      outcome.status = toNonNegLocal(outcome.balanceAmount) <= 0 ? 'CANCELED' : 'PARTIAL_CANCELED';
      return outcome;
    },

    async fetchByPaymentKey(paymentKey) {
      const ediDate = isoNow(nowFn());
      return call('GET', `/payments/${encodeURIComponent(paymentKey)}`, {
        query: { ediDate, signData: querySignature({ tid: paymentKey, ediDate, secretKey }) },
      });
    },

    async fetchByOrderId(orderId, { orderDate } = {}) {
      const ediDate = isoNow(nowFn());
      return call('GET', `/payments/find/${encodeURIComponent(orderId)}`, {
        query: { orderDate: orderDate || ymd(nowFn()), ediDate, signData: querySignature({ tid: orderId, ediDate, secretKey }) },
      });
    },

    webhook: {
      dedupeKey: webhookDedupeKey,
      ack: webhookAck,
      verify: (payload, { expectedAmount } = {}) => verifyTransactionMessage(payload, { secretKey, expectedAmount }),
    },
  };
}
