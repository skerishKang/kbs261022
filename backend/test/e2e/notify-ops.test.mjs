import assert from 'node:assert/strict';
import test from 'node:test';

import { auth, call, CUSTOMER, makeEnv, purchaseCart } from '../helpers.mjs';

function notifyEnv(over = {}) {
  return makeEnv({
    PG_PROVIDER: 'tosspayments',
    MAIL_MODE: 'resend',
    B66_ALERT_RESEND_API_KEY: 're_fake_key_for_tests',
    ORDER_NOTIFY_TO: 'ops1@example.com,ops2@example.com',
    ORDER_NOTIFY_TELEGRAM_CHAT_IDS: '111,222',
    TELEGRAM_BOT_TOKEN: 'fake-token-for-tests',
    ...over,
  });
}

function captureFetch() {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
    return {
      ok: true,
      status: 200,
      async text() { return '{}'; },
      async json() { return {}; },
    };
  };
  return { calls, fetchFn };
}

async function withFetch(fetchFn, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function telegramCalls(calls) {
  return calls.filter((c) => c.url.startsWith('https://api.telegram.org/'));
}

function mailCalls(calls) {
  return calls.filter((c) => c.url.includes('api.resend.com'));
}

test('a paid order notifies ops and sends the customer confirmation', async () => {
  const e = notifyEnv();
  const capture = captureFetch();
  const created = await call(e, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  await withFetch(capture.fetchFn, async () => {
    const paid = await call(e, 'POST', '/api/payments/confirm', {
      orderId: created.json.id, paymentKey: 'pk_notify_paid', amount: created.json.totals.total_amount,
    });
    assert.equal(paid.status, 200, paid.text);
  });
  assert.equal(telegramCalls(capture.calls).length, 2);
  assert.match(telegramCalls(capture.calls)[0].body.text, /새 주문/);
  const mails = mailCalls(capture.calls);
  assert.equal(mails.length, 3);
  assert.equal(mails[2].body.to[0], CUSTOMER.email);
  assert.match(mails[2].body.subject, /주문이 완료되었습니다/);
});

test('a completed refund notifies ops exactly once', async () => {
  const e = notifyEnv();
  const capture = captureFetch();
  const created = await call(e, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  await withFetch(capture.fetchFn, async () => {
    const paid = await call(e, 'POST', '/api/payments/confirm', {
      orderId: created.json.id, paymentKey: 'pk_notify_refund', amount: created.json.totals.total_amount,
    });
    assert.equal(paid.status, 200, paid.text);
    const before = telegramCalls(capture.calls).length;
    const refunded = await call(e, 'POST', `/api/orders/${created.json.id}/payments/pk_notify_refund/cancel`, { reason: '취소' }, auth());
    assert.equal(refunded.status, 200, refunded.text);
    assert.equal(telegramCalls(capture.calls).length - before, 2);
    assert.match(telegramCalls(capture.calls).at(-1).body.text, /환불·취소/);
    const replay = await call(e, 'POST', `/api/orders/${created.json.id}/payments/pk_notify_refund/cancel`, { reason: '취소' }, auth());
    assert.equal(replay.json.idempotent, true);
    assert.equal(telegramCalls(capture.calls).length - before, 2);
  });
});

test('an accepted quote request notifies ops', async () => {
  const e = notifyEnv();
  const capture = captureFetch();
  await withFetch(capture.fetchFn, async () => {
    const quote = await call(e, 'POST', '/api/quotes', {
      items: [{ id: 'samasound.co.kr:3836', qty: 1 }],
      privacy_consent: true,
      company: '[E2E] 알림 회사', name: '[E2E] 담당자', phone: '010-1111-2222',
    });
    assert.equal(quote.status, 201, quote.text);
  });
  assert.equal(telegramCalls(capture.calls).length, 2);
  assert.match(telegramCalls(capture.calls)[0].body.text, /견적 요청/);
  assert.equal(mailCalls(capture.calls).length, 2);
});
