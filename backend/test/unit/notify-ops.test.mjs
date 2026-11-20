import assert from 'node:assert/strict';
import test from 'node:test';

import { openD1 } from '../../d1-shim.mjs';
import { notifyOps, retryPendingNotifications, OPS_EVENTS } from '../../lib/notify.mjs';

function env(over = {}) {
  return {
    DB: openD1(),
    SITE_BASE_URL: 'https://site.example/store',
    ORDER_NOTIFY_TO: 'ops1@example.com, ops2@example.com',
    ORDER_NOTIFY_TELEGRAM_CHAT_IDS: '111,222',
    TELEGRAM_BOT_TOKEN: 'fake-token-not-real',
    ...over,
  };
}

function mailer({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async deliver(message) {
      calls.push(message);
      if (fail) throw new Error('mail down');
      return { delivered: true, channel: 'resend' };
    },
  };
}

function telegram({ fail = false } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, ...JSON.parse(init.body) });
    if (fail) throw new Error('telegram down');
    return { ok: true, status: 200 };
  };
  return { calls, fetchFn };
}

const paidPayload = {
  orderId: 'ORD-1', amount: 1000,
  items: [{ product_name: '상품A', qty: 2, unit_price: 500 }],
  company: '회사A', name: '홍길동', phone: '010-1111-2222', email: 'buyer@example.com',
};

test('a paid order reaches two mail recipients, two Telegram chats and the customer', async () => {
  const e = env();
  const mail = mailer();
  const tg = telegram();
  const result = await notifyOps(OPS_EVENTS.ORDER_PAID, { env: e, mailAdapter: mail, fetchFn: tg.fetchFn, ...paidPayload });
  assert.equal(mail.calls.length, 3);
  assert.deepEqual(mail.calls.slice(0, 2).map((m) => m.to), ['ops1@example.com', 'ops2@example.com']);
  assert.equal(mail.calls[2].to, 'buyer@example.com');
  assert.match(mail.calls[0].subject, /ORD-1 1,000원/);
  assert.match(mail.calls[0].text, /상품A 2개 500원/);
  assert.match(mail.calls[0].text, /orders\.html\?order=ORD-1/);
  assert.match(mail.calls[2].text, /\/#\/order\/ORD-1/);
  assert.equal(tg.calls.length, 2);
  assert.deepEqual(tg.calls.map((c) => c.chat_id), ['111', '222']);
  assert.match(tg.calls[0].text, /ORD-1 1,000원/);
  assert.equal(tg.calls[0].text.includes('010-1111-2222'), false);
  assert.equal(tg.calls[0].text.includes('buyer@example.com'), false);
  assert.equal(result.customer.delivered, true);
});

test('a repeated event is not sent again', async () => {
  const e = env();
  const mail = mailer();
  const tg = telegram();
  const first = await notifyOps(OPS_EVENTS.ORDER_PAID, { env: e, mailAdapter: mail, fetchFn: tg.fetchFn, ...paidPayload });
  const second = await notifyOps(OPS_EVENTS.ORDER_PAID, { env: e, mailAdapter: mail, fetchFn: tg.fetchFn, ...paidPayload });
  assert.equal(first.event, 'order_paid');
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'duplicate');
  assert.equal(mail.calls.length, 3);
  assert.equal(tg.calls.length, 2);
});

test('a disabled event and an empty configuration are skipped silently', async () => {
  const mail = mailer();
  const tg = telegram();
  const filtered = await notifyOps(OPS_EVENTS.QUOTE_RECEIVED, {
    env: env({ ORDER_NOTIFY_EVENTS: 'order_paid' }), mailAdapter: mail, fetchFn: tg.fetchFn, quoteId: 'Q-1',
  });
  assert.equal(filtered.reason, 'event_disabled');
  const bare = await notifyOps(OPS_EVENTS.QUOTE_RECEIVED, {
    env: env({ ORDER_NOTIFY_TO: '', ORDER_NOTIFY_TELEGRAM_CHAT_IDS: '', TELEGRAM_BOT_TOKEN: '' }),
    mailAdapter: mail, fetchFn: tg.fetchFn, quoteId: 'Q-1',
  });
  assert.notEqual(bare.skipped, true);
  assert.equal(mail.calls.length, 0);
  assert.equal(tg.calls.length, 0);
});

test('mail and Telegram failures are isolated and never thrown', async () => {
  const brokenMail = mailer({ fail: true });
  const okTg = telegram();
  const a = await notifyOps(OPS_EVENTS.REFUND_COMPLETED, {
    env: env(), mailAdapter: brokenMail, fetchFn: okTg.fetchFn,
    orderId: 'ORD-2', cancelAmount: 500, remainingAmount: 500,
  });
  assert.equal(a.telegram.length, 2);
  assert.equal(a.telegram[0].delivered, true);
  assert.equal(a.mail[0].delivered, false);

  const okMail = mailer();
  const brokenTg = telegram({ fail: true });
  const b = await notifyOps(OPS_EVENTS.REFUND_COMPLETED, {
    env: env(), mailAdapter: okMail, fetchFn: brokenTg.fetchFn,
    orderId: 'ORD-3', cancelAmount: 1000, remainingAmount: 0,
  });
  assert.equal(b.mail.length, 2);
  assert.equal(b.mail[0].delivered, true);
  assert.equal(b.telegram[0].delivered, false);
});

test('signup keeps the email in mail only', async () => {
  const mail = mailer();
  const tg = telegram();
  await notifyOps(OPS_EVENTS.SIGNUP, {
    env: env(), mailAdapter: mail, fetchFn: tg.fetchFn,
    memberId: 7, joinedAt: '2026-11-20T10:00:00.000Z', company: '회사B', name: '김철수',
    email: 'member@example.com', source: 'google',
  });
  assert.match(mail.calls[0].text, /member@example.com/);
  assert.match(mail.calls[0].text, /가입 경로: google/);
  assert.equal(tg.calls[0].text.includes('member@example.com'), false);
});

test('an inquiry notification clips the body and links the ops center', async () => {
  const mail = mailer();
  const tg = telegram();
  await notifyOps(OPS_EVENTS.INQUIRY_RECEIVED, {
    env: env(), mailAdapter: mail, fetchFn: tg.fetchFn,
    receiptId: 'INQ-1', kind: '의견', body: '가'.repeat(260),
  });
  assert.match(mail.calls[0].text, /INQ-1/);
  assert.match(mail.calls[0].text, /staff\.html/);
  assert.equal(mail.calls[0].text.includes('가'.repeat(201)), false);
  assert.match(tg.calls[0].text, /INQ-1/);
});

test('a user closing the payment window is never reported', async () => {
  const mail = mailer();
  const tg = telegram();
  const result = await notifyOps(OPS_EVENTS.PAYMENT_FAILED, {
    env: env(), mailAdapter: mail, fetchFn: tg.fetchFn, orderId: 'ORD-4',
    failureCode: 'PAY_PROCESS_CANCELED', reason: 'closed',
  });
  assert.equal(result.reason, 'user_cancel');
  assert.equal(mail.calls.length, 0);
  assert.equal(tg.calls.length, 0);
});

test('a successful dispatch records one delivery per channel and closes the outbox', async () => {
  const e = env();
  const mail = mailer();
  const tg = telegram();
  const result = await notifyOps(OPS_EVENTS.ORDER_PAID, { env: e, mailAdapter: mail, fetchFn: tg.fetchFn, ...paidPayload });
  assert.ok(result.outboxId > 0);
  assert.equal(result.done, true);
  const rows = await e.DB.prepare('SELECT channel FROM ops_notify_delivery WHERE outbox_id = ? ORDER BY channel').bind(result.outboxId).all();
  assert.deepEqual(rows.results.map((r) => r.channel), [
    'customer_mail:buyer@example.com',
    'mail:ops1@example.com',
    'mail:ops2@example.com',
    'telegram:111',
    'telegram:222',
  ]);
  const row = await e.DB.prepare('SELECT done_at FROM ops_notify_outbox WHERE id = ?').bind(result.outboxId).first();
  assert.ok(row.done_at);
});

test('a failed channel is retried alone and closes the outbox', async () => {
  const e = env({ MAIL_MODE: 'resend', B66_ALERT_RESEND_API_KEY: 're_fake_key_for_tests' });
  const tg = telegram();
  const first = await notifyOps(OPS_EVENTS.REFUND_COMPLETED, {
    env: e, mailAdapter: mailer({ fail: true }), fetchFn: tg.fetchFn,
    orderId: 'ORD-RETRY', cancelAmount: 500, remainingAmount: 500,
  });
  assert.equal(first.done, false);
  const failedTgCount = tg.calls.length;
  const delivered = await e.DB.prepare('SELECT channel FROM ops_notify_delivery WHERE outbox_id = ?').bind(first.outboxId).all();
  assert.deepEqual(delivered.results.map((r) => r.channel), ['telegram:111', 'telegram:222']);

  const goodMail = mailer();
  const retryFetch = telegram();
  const summary = await retryPendingNotifications(e, { mailAdapter: goodMail, fetchFn: retryFetch.fetchFn });
  assert.equal(summary.processed, 1);
  assert.equal(summary.sent, 2);
  assert.equal(goodMail.calls.length, 2);
  assert.equal(retryFetch.calls.length, 0, 'delivered Telegram channels are not sent again');
  assert.equal(tg.calls.length, failedTgCount);
  const closed = await e.DB.prepare('SELECT done_at FROM ops_notify_outbox WHERE id = ?').bind(first.outboxId).first();
  assert.ok(closed.done_at);
  const again = await retryPendingNotifications(e, { mailAdapter: mailer(), fetchFn: telegram().fetchFn });
  assert.equal(again.processed, 0);
});

test('retry ignores outbox rows older than 24 hours', async () => {
  const e = env();
  const mail = mailer();
  const tg = telegram();
  const first = await notifyOps(OPS_EVENTS.QUOTE_RECEIVED, {
    env: e, mailAdapter: mailer({ fail: true }), fetchFn: tg.fetchFn, quoteId: 'Q-OLD',
    now: () => new Date('2026-11-01T00:00:00Z'),
  });
  assert.equal(first.done, false);
  await e.DB.prepare('UPDATE ops_notify_outbox SET done_at = NULL WHERE id = ?').bind(first.outboxId).run();
  await e.DB.prepare('UPDATE ops_notify_outbox SET created_at = ? WHERE id = ?').bind('2026-11-01T00:00:00Z', first.outboxId).run();
  const summary = await retryPendingNotifications(e, {
    now: new Date('2026-11-20T10:00:00Z'), mailAdapter: mailer(), fetchFn: telegram().fetchFn,
  });
  assert.equal(summary.processed, 0);
});

test('a secondary Telegram token name is used when the primary is missing', async () => {
  const e = env({ TELEGRAM_BOT_TOKEN: '', B66_ALERT_TELEGRAM_BOT_TOKEN: 'fallback-token-not-real' });
  const tg = telegram();
  const result = await notifyOps(OPS_EVENTS.SIGNUP, {
    env: e, mailAdapter: mailer(), fetchFn: tg.fetchFn,
    memberId: 9, joinedAt: '2026-11-20T10:00:00Z', name: '이름', source: 'email',
  });
  assert.equal(result.telegram.length, 2);
  assert.equal(result.telegram[0].delivered, true);
  assert.match(tg.calls[0].url, /fallback-token-not-real/);
});

test('an approval failure is grouped per order within 30 minutes', async () => {
  const e = env();
  const mail = mailer();
  const tg = telegram();
  const base = { env: e, mailAdapter: mail, fetchFn: tg.fetchFn, orderId: 'ORD-5', failureCode: 'A001', reason: '금액 불일치' };
  const first = await notifyOps(OPS_EVENTS.PAYMENT_FAILED, { ...base, now: () => new Date('2026-11-20T10:00:00Z') });
  const second = await notifyOps(OPS_EVENTS.PAYMENT_FAILED, { ...base, now: () => new Date('2026-11-20T10:20:00Z') });
  const later = await notifyOps(OPS_EVENTS.PAYMENT_FAILED, { ...base, now: () => new Date('2026-11-20T10:31:00Z') });
  assert.equal(first.skipped, undefined);
  assert.equal(second.reason, 'within_window');
  assert.equal(later.skipped, undefined);
  assert.equal(mail.calls.length, 4);
  assert.equal(tg.calls.length, 4);
  assert.match(mail.calls[0].subject, /A001/);
  assert.match(mail.calls[0].text, /#\/order\/ORD-5/);
});
