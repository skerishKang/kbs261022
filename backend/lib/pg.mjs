// PG adapter for Toss Payments.
//
// Live mode  : calls https://api.tosspayments.com with a secret key
//              (POST /v1/payments/confirm, POST /v1/payments/{key}/cancel,
//               GET  /v1/payments/{key}, GET /v1/payments/orders/{orderId})
// Mock mode  : deterministic local simulator with the exact same interface,
//              used when no secret key is configured so the whole
//              order -> payment -> refund -> ERP pipeline stays E2E-testable
//              without any external dependency.
//
// The secret key is NEVER read from or written to this repository. It comes
// from a Worker secret (TOSS_WIDGET_SECRET_KEY) at runtime.

export const PG_PROVIDER = 'tosspayments';
export const TOSS_PUBLIC_BASE_URL = 'https://api.tosspayments.com';

/** Toss Basic auth: base64("<secret>:") — the trailing colon is required. */
export function basicAuth(secretKey) {
  const key = String(secretKey || '').trim();
  if (!key) return null;
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

/** Toss keys start with live_ / test_. Anything else is treated as test. */
export function pgEnvFromKey(secretKey) {
  return typeof secretKey === 'string' && secretKey.startsWith('live_') ? 'live' : 'test';
}

/** Decide which adapter mode to run in. */
export function resolvePgMode(secretKey, requested = 'auto') {
  const mode = String(requested || 'auto').toLowerCase();
  if (mode === 'mock') return 'mock';
  if (mode === 'test' || mode === 'live') return pgEnvFromKey(secretKey);
  return secretKey && String(secretKey).trim() ? pgEnvFromKey(secretKey) : 'mock';
}

export class PgError extends Error {
  constructor(status, code, message, detail = {}) {
    super(message || code || 'pg error');
    this.name = 'PgError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function readJson(response) {
  let body = null;
  try {
    body = await response.json();
  } catch (e) {
    try {
      body = { message: (await response.text()).slice(0, 500) };
    } catch (e2) {
      body = {};
    }
  }
  return body;
}

/** Adapter for the real Toss Payments API. */
export function createLivePgAdapter({ secretKey, baseUrl = TOSS_PUBLIC_BASE_URL, fetchFn = fetch } = {}) {
  const auth = basicAuth(secretKey);
  const mode = pgEnvFromKey(secretKey);
  const headers = (extra = {}) => ({ 'Content-Type': 'application/json', ...extra });

  async function post(path, payload, idempotencyKey) {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method: 'POST',
      headers: headers({ Authorization: auth, 'Idempotency-Key': idempotencyKey }),
      body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    if (!response.ok) throw new PgError(response.status, body && body.code, body && body.message, body);
    return body;
  }

  async function get(path) {
    const response = await fetchFn(`${baseUrl}${path}`, { method: 'GET', headers: headers({ Authorization: auth }) });
    const body = await readJson(response);
    if (!response.ok) throw new PgError(response.status, body && body.code, body && body.message, body);
    return body;
  }

  return {
    provider: PG_PROVIDER,
    mode,
    sandbox: mode === 'test',
    live: mode === 'live',

    async confirm({ paymentKey, orderId, amount, idempotencyKey }) {
      if (!paymentKey || !orderId || !Number.isInteger(amount) || amount <= 0) {
        throw new PgError(400, 'INVALID_ARGUMENT', 'paymentKey, orderId, amount(>0) are required.');
      }
      return post(
        '/v1/payments/confirm',
        { paymentKey, orderId, amount },
        idempotencyKey || `cgi:confirm:${orderId}:${paymentKey}`
      );
    },

    async cancel({ paymentKey, cancelAmount, cancelReason, idempotencyKey, refundReceiveAccount }) {
      if (!paymentKey || !cancelReason) throw new PgError(400, 'INVALID_ARGUMENT', 'paymentKey and cancelReason are required.');
      const payload = { cancelReason };
      if (Number.isInteger(cancelAmount) && cancelAmount > 0) payload.cancelAmount = cancelAmount;
      if (refundReceiveAccount) payload.refundReceiveAccount = refundReceiveAccount;
      return post(
        `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`,
        payload,
        idempotencyKey || `cgi:cancel:${paymentKey}:${cancelReason}`
      );
    },

    fetchByPaymentKey(paymentKey) {
      if (!paymentKey) return Promise.reject(new PgError(400, 'INVALID_ARGUMENT', 'paymentKey is required.'));
      return get(`/v1/payments/${encodeURIComponent(paymentKey)}`);
    },

    fetchByOrderId(orderId) {
      if (!orderId) return Promise.reject(new PgError(400, 'INVALID_ARGUMENT', 'orderId is required.'));
      return get(`/v1/payments/orders/${encodeURIComponent(orderId)}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock adapter — test-mode only, deterministic, no network.
// paymentKey containing "fail" simulates a card-company rejection.
// ---------------------------------------------------------------------------

const MOCK_PAYMENTS = new Map();

export function resetMockPayments() {
  MOCK_PAYMENTS.clear();
}

export function getMockPayments() {
  return new Map(MOCK_PAYMENTS);
}

const MOCK_METHODS = ['카드', '간편결제', '휴대폰'];

export function createMockPgAdapter() {
  const nowIso = () => new Date().toISOString();

  function buildPayment({ paymentKey, orderId, amount, orderName, method }) {
    const supplied = Math.round(amount / 1.1);
    const vat = amount - supplied;
    return {
      version: '2022-06-08',
      paymentKey,
      type: 'NORMAL',
      orderId,
      orderName: orderName || 'CGI 주문',
      mId: 'MOCK0000000000',
      currency: 'KRW',
      // The handler the buyer actually used wins; the key-derived value keeps
      // tests deterministic when the client did not send one.
      method: (method && String(method).trim()) || MOCK_METHODS[paymentKey.length % MOCK_METHODS.length],
      totalAmount: amount,
      balanceAmount: amount,
      status: 'DONE',
      requestedAt: nowIso(),
      approvedAt: nowIso(),
      useEscrow: false,
      lastTransactionKey: 'mock-tx-0001',
      suppliedAmount: supplied,
      vat,
      cultureExpense: false,
      taxFreeAmount: 0,
      taxExemptionAmount: 0,
      cancels: [],
      isPartialCancelable: true,
      card: {
        amount,
        issuerCode: '01',
        acquirerCode: null,
        number: '411111******1111',
        installmentPlanMonths: 0,
        approveNo: '00000001',
        useCardPoint: false,
        cardType: '신용',
        ownerType: '개인',
        acquireStatus: 'REQUESTED',
        isInterestFree: false,
        interestPayer: null,
      },
      country: 'KR',
    };
  }

  return {
    provider: PG_PROVIDER,
    mode: 'mock',
    sandbox: true,
    live: false,

    async confirm({ paymentKey, orderId, amount, orderName, method }) {
      if (!paymentKey || !orderId || !Number.isInteger(amount) || amount <= 0) {
        throw new PgError(400, 'INVALID_ARGUMENT', 'paymentKey, orderId, amount(>0) are required.');
      }
      if (/fail/i.test(paymentKey)) {
        throw new PgError(402, 'REJECT_CARD_COMPANY', '카드사에서 결제를 거절했습니다 (mock).');
      }
      const payment = buildPayment({ paymentKey, orderId, amount, orderName, method });
      MOCK_PAYMENTS.set(paymentKey, payment);
      return payment;
    },

    async cancel({ paymentKey, cancelAmount, cancelReason }) {
      if (!paymentKey || !cancelReason) throw new PgError(400, 'INVALID_ARGUMENT', 'paymentKey and cancelReason are required.');
      const payment = MOCK_PAYMENTS.get(paymentKey);
      if (!payment) throw new PgError(404, 'NOT_FOUND_PAYMENT_KEY', '결제 정보를 찾을 수 없습니다 (mock).');
      if (payment.status === 'CANCELED' && !cancelAmount) return payment;

      const amount = cancelAmount && cancelAmount > 0 ? Math.min(cancelAmount, payment.balanceAmount) : payment.balanceAmount;
      payment.cancels = payment.cancels || [];
      payment.cancels.push({
        cancelAmount: amount,
        cancelReason,
        taxFreeAmount: 0,
        taxExemptionAmount: 0,
        refundableAmount: payment.balanceAmount - amount,
        cardDiscountAmount: 0,
        transferDiscountAmount: 0,
        easyPayDiscountAmount: 0,
        canceledAt: nowIso(),
        transactionKey: `mock-tx-${String(payment.cancels.length + 2).padStart(4, '0')}`,
        receiptKey: null,
        cancelStatus: 'DONE',
        cancelRequestId: null,
      });
      payment.balanceAmount -= amount;
      payment.cancel_amount = (payment.cancel_amount || 0) + amount;
      payment.lastTransactionKey = payment.cancels[payment.cancels.length - 1].transactionKey;
      payment.status = payment.balanceAmount <= 0 ? 'CANCELED' : 'PARTIAL_CANCELED';
      return payment;
    },

    async fetchByPaymentKey(paymentKey) {
      const payment = MOCK_PAYMENTS.get(paymentKey);
      if (!payment) throw new PgError(404, 'NOT_FOUND_PAYMENT_KEY', '결제 정보를 찾을 수 없습니다 (mock).');
      return payment;
    },

    async fetchByOrderId(orderId) {
      for (const payment of MOCK_PAYMENTS.values()) {
        if (payment.orderId === orderId) return payment;
      }
      throw new PgError(404, 'NOT_FOUND_PAYMENT_KEY', '결제 정보를 찾을 수 없습니다 (mock).');
    },
  };
}

/** Pick the right adapter from runtime config. */
export function createPgAdapter({ secretKey, mode = 'auto', baseUrl = TOSS_PUBLIC_BASE_URL, fetchFn } = {}) {
  const providerMode = resolvePgMode(secretKey, mode);
  if (providerMode === 'mock') return createMockPgAdapter();
  return createLivePgAdapter({ secretKey, baseUrl, fetchFn });
}
