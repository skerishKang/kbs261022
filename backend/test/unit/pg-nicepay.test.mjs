// Contract tests for the NICEPAY protocol layer — no network, no credentials.
//
// Everything asserted here is transcribed from the published manual at
// github.com/nicepayments/nicepay-manual (fetched 2026-10-27). No NICEPAY
// account exists for CGI, so nothing about live behaviour is claimed: these
// tests pin the documented message shapes, the signature rule, the refund
// guards and the mapping onto the object worker.js already consumes from Toss.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  NICEPAY_PROVIDER, NICEPAY_PROD_API, NICEPAY_SANDBOX_API, NICEPAY_WEBHOOK_ACK,
  TX_STATUS, niceApiBase, basicAuth, bearerAuth, transactionSignature,
  verifyTransactionMessage, cancelPayload, refundableAmount, canPartialCancel,
  latestCancel, cancelAmountOf, toCgiOutcome, webhookDedupeKey, webhookAck,
  recoveryRequests,
} from '../../lib/pg-nicepay.mjs';

const SHOP = 'cgiunitshop';
const SECRET = 'unit-secret-key-0001';
const TID = 'UT0000113m01012110051656331001';
const ORDER_ID = 'CGI-20261027-0002';
const EDI = '2026-10-27T13:00:00+09:00';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function message(overrides = {}) {
  const body = {
    resultCode: '0000',
    tid: TID,
    orderId: ORDER_ID,
    payMethod: '카드',
    amount: 1_500_000,
    balanceAmt: 1_500_000,
    status: TX_STATUS.PAID,
    ediDate: EDI,
    canPartCancel: 'true',
    cancels: [],
    ...overrides,
  };
  return { ...body, signature: sha256(`${body.tid}${body.amount}${body.ediDate}${SECRET}`) };
}

test('provider name and the two API hosts are separated, unknown mode fails', () => {
  assert.equal(NICEPAY_PROVIDER, 'nicepay');
  assert.equal(niceApiBase('production'), `${NICEPAY_PROD_API}/v1`);
  assert.equal(niceApiBase('sandbox'), `${NICEPAY_SANDBOX_API}/v1`);
  assert.throws(() => niceApiBase('staging'), RangeError);
  // the sandbox host is a different machine, so a wrong constant cannot
  // quietly send test traffic at production or vice versa
  assert.notEqual(NICEPAY_PROD_API, NICEPAY_SANDBOX_API);
});

test('auth headers follow the documented Basic/Bearer split', () => {
  assert.equal(basicAuth({ shopId: SHOP, secretKey: SECRET }),
    'Basic ' + Buffer.from(`${SHOP}:${SECRET}`, 'utf8').toString('base64'));
  assert.equal(basicAuth({ shopId: SHOP, secretKey: '' }), null);
  assert.equal(bearerAuth('tok-123'), 'Bearer tok-123');
  assert.equal(bearerAuth(''), null);
});

test('signature is hex(sha256(tid + amount + ediDate + SecretKey)) in that order', () => {
  assert.equal(transactionSignature({ tid: TID, amount: 1_500_000, ediDate: EDI, secretKey: SECRET }),
    sha256(`${TID}1500000${EDI}${SECRET}`));
  assert.notEqual(transactionSignature({ tid: TID, amount: 1_500_000, ediDate: EDI, secretKey: SECRET }),
    sha256(`${TID}${EDI}1500000${SECRET}`));
  assert.equal(transactionSignature({ tid: '', amount: 1, ediDate: EDI, secretKey: SECRET }), null);
  // amount 0 is a value, not a missing field
  assert.ok(transactionSignature({ tid: TID, amount: 0, ediDate: EDI, secretKey: SECRET }));
});

test('a valid approval message verifies and reports the transaction', () => {
  const verdict = verifyTransactionMessage(message(), { secretKey: SECRET, expectedAmount: 1_500_000 });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.tid, TID);
  assert.equal(verdict.orderId, ORDER_ID);
  assert.equal(verdict.status, TX_STATUS.PAID);
  assert.equal(verdict.method, '카드');
});

test('tampering with any single field is rejected with its own reason', () => {
  const cases = [
    // the amount is left alone here so the ONLY thing wrong is the signature
    ['signature', { ...message(), signature: 'deadbeef' }],
    ['amount', message({ amount: 900_000 })],
    ['result_code', message({ resultCode: '0004' })],
    ['missing_tid', { ...message(), tid: '' }],
    ['missing_edi_date', { ...message(), ediDate: '' }],
    ['missing_secret_key', message()],
  ];
  for (const [expected, body] of cases) {
    const verdict = verifyTransactionMessage(body, {
      secretKey: expected === 'missing_secret_key' ? '' : SECRET,
      expectedAmount: 1_500_000,
    });
    assert.equal(verdict.ok, false, `${expected} must be rejected`);
    assert.equal(verdict.reason, expected);
    assert.ok(!JSON.stringify(verdict).includes(SECRET), 'a rejection must not echo the secret key');
  }
});

test('a full cancel omits cancelAmt, because omission is what means full', () => {
  const full = cancelPayload({ orderId: ORDER_ID, reason: '재고 소진' });
  assert.ok(!('cancelAmt' in full), JSON.stringify(full));
  assert.equal(full.orderId, ORDER_ID);

  const part = cancelPayload({ orderId: ORDER_ID, reason: '일부 반품', cancelAmount: 300_000 });
  assert.equal(part.cancelAmt, 300_000);
  assert.throws(() => cancelPayload({ orderId: ORDER_ID, reason: '' }), RangeError);
  assert.throws(() => cancelPayload({ orderId: ORDER_ID, reason: 'x', cancelAmount: -1 }), RangeError);
  assert.throws(() => cancelPayload({ orderId: ORDER_ID, reason: 'x', cancelAmount: '300000' }), RangeError);
});

test('refund account maps only the documented bank code and account fields', () => {
  const body = cancelPayload({
    orderId: ORDER_ID, reason: '반품', cancelAmount: 100_000,
    refundAccount: { bankCode: '03', accountNumber: '123-456-789' },
  });
  assert.equal(body.refundBankCode, '03');
  assert.equal(body.refundAccount, '123-456-789');
  assert.ok(!('secretKey' in body));
});

test('refundable amount prefers balanceAmt and falls back to the paid amount', () => {
  assert.equal(refundableAmount({ balanceAmt: 700_000, amount: 1_500_000 }), 700_000);
  assert.equal(refundableAmount({ amount: 1_500_000 }), 1_500_000);
  assert.equal(refundableAmount({ balanceAmt: 0, amount: 1_500_000 }), 0);
  assert.equal(refundableAmount({}), 0);
  assert.equal(refundableAmount({ balanceAmt: '250000' }), 250_000);
});

test('partial cancel is refused unless NICE says the transaction allows it', () => {
  assert.equal(canPartialCancel({ canPartCancel: 'true' }), true);
  for (const value of ['false', undefined, 'TRUE-ish', '']) {
    assert.equal(canPartialCancel({ canPartCancel: value }), false, String(value));
  }
});

test('the newest cancel is found by date, not by array position', () => {
  // deliberately not sorted, and the newest entry is NOT first: a reader that
  // trusts array order would pick 200,000 here and double-count the wrong money
  const tx = {
    cancels: [
      { cancelAmount: 200_000, cancelDate: '2026-10-20T12:00:00+09:00' },
      { cancelAmount: 90_000, cancelDate: '2026-10-26T12:00:00+09:00' },
      { cancelAmount: 300_000, cancelDate: '2026-10-27T12:00:00+09:00' },
    ],
  };
  assert.equal(latestCancel(tx).cancelAmount, 300_000);
  assert.equal(cancelAmountOf(tx, 0), 300_000);
  // the reverse order must give the same answer
  const reversed = { cancels: [...tx.cancels].reverse() };
  assert.equal(cancelAmountOf(reversed, 0), 300_000);
  assert.equal(cancelAmountOf({ cancels: [] }, 300_000), 300_000, 'no history falls back to the request');
  assert.equal(cancelAmountOf(undefined, 0), 0);
});

test('a NICE transaction maps onto the shape worker.js already consumes', () => {
  const outcome = toCgiOutcome(message({ balanceAmt: 1_200_000, cancels: [{ cancelAmount: 300_000 }] }), {
    orderAmount: 1_500_000, suppliedAmount: 1_363_637, vat: 136_363,
  });
  assert.equal(outcome.status, 'DONE');
  assert.equal(outcome.cgiStatus, 'paid');
  assert.equal(outcome.totalAmount, 1_500_000);
  assert.equal(outcome.balanceAmount, 1_200_000);
  assert.equal(outcome.paymentKey, TID);
  assert.equal(outcome.method, '카드');
  assert.equal(outcome.isPartialCancelable, true);
  // NICE has no supplied/vat field: the order's own split is carried, not
  // recomputed from the payment amount, which would silently drift from pricing
  assert.equal(outcome.suppliedAmount, 1_363_637);
  assert.equal(outcome.vat, 136_363);
});

test('cancelled and failed statuses map to the ledger states the worker expects', () => {
  for (const [status, expected] of [
    [TX_STATUS.CANCELLED, 'cancelled'], [TX_STATUS.PARTIAL_CANCELLED, 'cancelled'],
    [TX_STATUS.FAILED, 'failed'], [TX_STATUS.READY, 'pending'], [TX_STATUS.EXPIRED, 'pending'],
  ]) {
    assert.equal(toCgiOutcome({ status }).cgiStatus, expected, status);
  }
  assert.equal(toCgiOutcome({ status: TX_STATUS.CANCELLED }).status, TX_STATUS.CANCELLED,
    'the raw status is preserved so cancelPayment can tell full from partial');
});

test('webhook ack is 200 + text/html + the literal OK', () => {
  const ack = webhookAck();
  assert.equal(ack.status, 200);
  assert.equal(ack.headers['Content-Type'], 'text/html');
  assert.equal(ack.body, NICEPAY_WEBHOOK_ACK);
  assert.equal(NICEPAY_WEBHOOK_ACK, 'OK');
});

test('delivery is replayed: same transaction different status is not a duplicate', () => {
  const paid = webhookDedupeKey({ tid: TID, status: TX_STATUS.PAID });
  const partial = webhookDedupeKey({ tid: TID, status: TX_STATUS.PARTIAL_CANCELLED });
  assert.equal(paid, `nicepay:webhook:${TID}:paid`);
  assert.notEqual(paid, partial);
  assert.equal(webhookDedupeKey({ tid: '', status: 'paid' }), null);
});

test('a lost webhook is recoverable by tid, falling back to the order id', () => {
  const orders = [
    { tid: 'seen-tid', orderId: 'A' },
    { tid: 'missing-tid', orderId: 'B' },
    { tid: null, orderId: ORDER_ID },
    { tid: null, orderId: null },
  ];
  const calls = recoveryRequests({ orders, receivedTids: ['seen-tid'] });
  assert.deepEqual(calls.map((c) => c.path), [
    `${NICEPAY_PROD_API}/v1/payments/missing-tid`,
    `${NICEPAY_PROD_API}/v1/payments/find/${encodeURIComponent(ORDER_ID)}`,
  ], 'this is the capability PayApp does not document at all');
  assert.ok(calls.every((c) => c.method === 'GET'));
});
