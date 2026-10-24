import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPgAdapter, resolvePgMode, basicAuth, pgEnvFromKey, createMockPgAdapter, resetMockPayments, PgError } from '../../lib/pg.mjs';

test('resolvePgMode picks mock without a secret key', () => {
  assert.equal(resolvePgMode(undefined, 'auto'), 'mock');
  assert.equal(resolvePgMode('', 'auto'), 'mock');
  assert.equal(resolvePgMode('test_gsk_docs_x', 'auto'), 'test');
  assert.equal(resolvePgMode('live_gsk_x', 'auto'), 'live');
  assert.equal(resolvePgMode('live_gsk_x', 'mock'), 'mock');
  assert.equal(resolvePgMode(undefined, 'mock'), 'mock');
});

test('pgEnvFromKey distinguishes test and live keys', () => {
  assert.equal(pgEnvFromKey('test_sk_abc'), 'test');
  assert.equal(pgEnvFromKey('live_sk_abc'), 'live');
  assert.equal(pgEnvFromKey(''), 'test');
});

test('basicAuth appends the required colon and base64 encodes', () => {
  const key = 'test_sk_x';
  assert.equal(basicAuth(key), 'Basic ' + Buffer.from('test_sk_x:').toString('base64'));
  assert.equal(basicAuth(''), null);
  assert.equal(basicAuth(undefined), null);
  // the trailing colon is what separates the secret from an empty password
  assert.ok(Buffer.from(basicAuth(key).replace('Basic ', ''), 'base64').toString().endsWith(':'));
});

test('mock adapter approves a normal payment', async () => {
  resetMockPayments();
  const pg = createMockPgAdapter();
  const payment = await pg.confirm({ paymentKey: 'pk_ok_1', orderId: 'ORD-20261025-ABCDE', amount: 11000, orderName: 'CGI 주문' });

  assert.equal(payment.status, 'DONE');
  assert.equal(payment.totalAmount, 11000);
  assert.equal(payment.balanceAmount, 11000);
  assert.equal(payment.suppliedAmount, 10000);
  assert.equal(payment.vat, 1000);
  assert.equal(payment.orderId, 'ORD-20261025-ABCDE');
  assert.ok(payment.card, 'card detail present');
  assert.equal(pg.mode, 'mock');
  assert.equal(pg.sandbox, true);
  assert.equal(pg.live, false);
});

test('mock adapter rejects a failing paymentKey deterministically', async () => {
  resetMockPayments();
  const pg = createMockPgAdapter();
  await assert.rejects(
    () => pg.confirm({ paymentKey: 'pk_fail_card', orderId: 'ORD-20261025-ABCDE', amount: 1000 }),
    (error) => error instanceof PgError && error.code === 'REJECT_CARD_COMPANY' && error.status === 402
  );
});

test('mock adapter validates arguments', async () => {
  const pg = createMockPgAdapter();
  await assert.rejects(() => pg.confirm({ paymentKey: '', orderId: 'ORD-20261025-ABCDE', amount: 1000 }), PgError);
  await assert.rejects(() => pg.confirm({ paymentKey: 'pk', orderId: '', amount: 1000 }), PgError);
  await assert.rejects(() => pg.confirm({ paymentKey: 'pk', orderId: 'ORD-20261025-ABCDE', amount: 0 }), PgError);
  await assert.rejects(() => pg.confirm({ paymentKey: 'pk', orderId: 'ORD-20261025-ABCDE', amount: -5 }), PgError);
});

test('mock adapter supports full and partial cancellation', async () => {
  resetMockPayments();
  const pg = createMockPgAdapter();
  const key = 'pk_full_cancel';
  await pg.confirm({ paymentKey: key, orderId: 'ORD-20261025-ABCDE', amount: 10000 });

  const cancelled = await pg.cancel({ paymentKey: key, cancelReason: '테스트 환불' });
  assert.equal(cancelled.status, 'CANCELED');
  assert.equal(cancelled.balanceAmount, 0);
  assert.equal(cancelled.cancels.length, 1);
  assert.equal(cancelled.cancels[0].cancelAmount, 10000);

  // partial refund
  resetMockPayments();
  const partial = 'pk_partial_cancel';
  await pg.confirm({ paymentKey: partial, orderId: 'ORD-20261025-ABCDE', amount: 10000 });
  const part = await pg.cancel({ paymentKey: partial, cancelAmount: 4000, cancelReason: '부분 환불' });
  assert.equal(part.status, 'PARTIAL_CANCELED');
  assert.equal(part.balanceAmount, 6000);
  assert.equal(part.cancels[0].cancelAmount, 4000);

  const rest = await pg.cancel({ paymentKey: partial, cancelReason: '잔액 환불' });
  assert.equal(rest.status, 'CANCELED');
  assert.equal(rest.balanceAmount, 0);
  assert.equal(rest.cancels.length, 2);
});

test('mock adapter rejects cancelling an unknown paymentKey', async () => {
  resetMockPayments();
  const pg = createMockPgAdapter();
  await assert.rejects(
    () => pg.cancel({ paymentKey: 'pk_never_existed', cancelReason: 'x' }),
    (error) => error instanceof PgError && error.code === 'NOT_FOUND_PAYMENT_KEY'
  );
});

test('mock adapter lookup by paymentKey and orderId', async () => {
  resetMockPayments();
  const pg = createMockPgAdapter();
  await pg.confirm({ paymentKey: 'pk_lookup', orderId: 'ORD-20261025-ABCDE', amount: 2500 });
  assert.equal((await pg.fetchByPaymentKey('pk_lookup')).totalAmount, 2500);
  assert.equal((await pg.fetchByOrderId('ORD-20261025-ABCDE')).paymentKey, 'pk_lookup');
  await assert.rejects(() => pg.fetchByPaymentKey('nope'), PgError);
  await assert.rejects(() => pg.fetchByOrderId('ORD-00000000-XXXXX'), PgError);
});

test('createPgAdapter returns a mock when no key is configured', () => {
  const pg = createPgAdapter({ secretKey: undefined, mode: 'auto' });
  assert.equal(pg.mode, 'mock');
  assert.equal(pg.live, false);
});

test('live adapter is built with auth and injectable fetch', async () => {
  const calls = [];
  const pg = createPgAdapter({
    secretKey: 'test_sk_x',
    mode: 'auto',
    baseUrl: 'https://api.example.test',
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ status: 'DONE', totalAmount: 100 }) };
    },
  });
  assert.equal(pg.mode, 'test');
  const result = await pg.confirm({ paymentKey: 'pk', orderId: 'ORD-20261025-ABCDE', amount: 100, idempotencyKey: 'k1' });
  assert.equal(result.totalAmount, 100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/payments/confirm');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.headers.Authorization.startsWith('Basic '));
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'k1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { paymentKey: 'pk', orderId: 'ORD-20261025-ABCDE', amount: 100 });
});

test('live adapter surfaces PG errors as PgError', async () => {
  const pg = createPgAdapter({
    secretKey: 'test_sk_x',
    baseUrl: 'https://api.example.test',
    fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ code: 'UNAUTHORIZED_KEY', message: '잘못된 키' }) }),
  });
  await assert.rejects(
    () => pg.confirm({ paymentKey: 'pk', orderId: 'ORD-20261025-ABCDE', amount: 100 }),
    (error) => error instanceof PgError && error.code === 'UNAUTHORIZED_KEY' && error.status === 403
  );
});

test('live adapter cancel endpoint passes amount and reason', async () => {
  let captured = null;
  const pg = createPgAdapter({
    secretKey: 'test_sk_x',
    baseUrl: 'https://api.example.test',
    fetchFn: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ status: 'PARTIAL_CANCELED' }) };
    },
  });
  await pg.cancel({ paymentKey: 'pk_abc', cancelAmount: 500, cancelReason: '고객 취소', idempotencyKey: 'id1' });
  assert.equal(captured.url, 'https://api.example.test/v1/payments/pk_abc/cancel');
  assert.deepEqual(captured.body, { cancelReason: '고객 취소', cancelAmount: 500 });
});
