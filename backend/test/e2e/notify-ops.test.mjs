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

// 의견 보내기(#226) 접수 → 운영 알림 inquiry_received. 알림이 실패해도 접수는 201.
function sendFeedback(e, body) {
  return call(e, 'POST', '/api/feedback', body, { Origin: 'https://skerishkang.github.io' });
}

test('an accepted feedback notifies ops once without the contact email', async () => {
  const e = notifyEnv();
  const capture = captureFetch();
  let res;
  await withFetch(capture.fetchFn, async () => {
    res = await sendFeedback(e, {
      kind: 'bug', body: '견적 목록에서 수량을 바꿔도 합계가 바로 안 바뀝니다.',
      page_url: 'https://cgishop.pages.dev/site/index.html#/quote-cart', contact_email: 'guest-notify@example.com',
    });
  });
  assert.equal(res.status, 201, res.text);
  const tg = telegramCalls(capture.calls);
  assert.equal(tg.length, 2, 'one telegram message per ops chat');
  assert.match(tg[0].body.text, /고객 의견/);
  assert.ok(tg[0].body.text.includes(res.json.id), 'the receipt number is in the alert');
  assert.match(tg[0].body.text, /불편·오류/, 'the kind is shown in Korean');
  const mails = mailCalls(capture.calls);
  assert.equal(mails.length, 2, 'one mail per ops recipient, nothing to the customer');
  assert.match(mails[0].body.subject, new RegExp(`고객 의견 ${res.json.id}`));
  for (const c of capture.calls) assert.doesNotMatch(JSON.stringify(c.body), /guest-notify@example\.com/);

  const ledger = await e.DB.prepare('SELECT id, done_at FROM ops_notify_outbox WHERE event = ? AND subject_id = ?').bind('inquiry_received', res.json.id).all();
  assert.equal(ledger.results.length, 1, 'the alert is recorded once');
  assert.ok(ledger.results[0].done_at);
});

test('feedback is still accepted when the alert channels fail', async () => {
  const e = notifyEnv();
  let res;
  await withFetch(async () => { throw new Error('network down'); }, async () => {
    res = await sendFeedback(e, { kind: 'idea', body: '설치 사례 사진이 있으면 좋겠습니다.' });
  });
  assert.equal(res.status, 201, res.text);
  const row = await e.DB.prepare('SELECT id, status FROM feedback WHERE id = ?').bind(res.json.id).first();
  assert.equal(row && row.status, 'received');
});

test('feedback is still accepted when the notifier itself throws', async () => {
  // 비밀값 바인딩 읽기가 예외를 던지는 경우: notifyOps 밖으로 예외가 나와도 접수는 유지
  const e = notifyEnv({ TELEGRAM_BOT_TOKEN: { get() { throw new Error('secret store unavailable'); } } });
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  let res;
  try {
    res = await sendFeedback(e, { kind: 'other', body: '세금계산서는 언제 발행되나요?' });
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 201, res.text);
  assert.ok(logged.some((l) => l.includes('inquiry_received failed')), 'the failure is logged');
  const row = await e.DB.prepare('SELECT id FROM feedback WHERE id = ?').bind(res.json.id).first();
  assert.ok(row);
});
