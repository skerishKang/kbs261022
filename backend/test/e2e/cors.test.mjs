import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';
import { ORIGIN, EVIL_ORIGIN, ADMIN_TOKEN, call } from '../helpers.mjs';

const ALLOWED = 'https://skerishkang.github.io';

async function raw(method, path, headers = {}) {
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, { method, headers }), { DB: openD1() });
  const text = await response.text();
  const out = {};
  response.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return { status: response.status, text, headers: out };
}

test('preflight for an allowed origin is accepted', async () => {
  const res = await raw('OPTIONS', '/api/quotes', {
    Origin: ALLOWED,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,authorization,idempotency-key',
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], ALLOWED);
  assert.match(res.headers['access-control-allow-methods'], /PATCH/);
  assert.match(res.headers['access-control-allow-headers'], /authorization/i);
  assert.match(res.headers['access-control-allow-headers'], /idempotency-key/i);
});

test('preflight for a disallowed origin is never echoed', async () => {
  const res = await raw('OPTIONS', '/api/quotes', { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'POST' });
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], ALLOWED, 'ACAO is pinned to the allowlist');
  assert.notEqual(res.headers['access-control-allow-origin'], EVIL_ORIGIN);
  assert.notEqual(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['vary'], /origin/i);
});

test('ACAO is pinned for real requests from a disallowed origin', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/quotes', undefined],
    ['GET', '/api/orders', undefined],
    ['GET', '/api/orders/ORD-19990101-ABCDE', undefined],
    ['POST', '/api/orders', JSON.stringify({ items: [] })],
    ['PATCH', '/api/quotes/Q-ping', JSON.stringify({ status: 'in_progress' })],
    ['POST', '/api/payments/confirm', JSON.stringify({ orderId: 'x', paymentKey: 'y', amount: 1 })],
  ]) {
    const headers = { Origin: EVIL_ORIGIN };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await raw(method, path, headers);
    assert.equal(res.headers['access-control-allow-origin'], ALLOWED, `${method} ${path}: ACAO pinned`);
    assert.notEqual(res.headers['access-control-allow-origin'], EVIL_ORIGIN, `${method} ${path}: not echoed`);
    assert.match(res.headers['vary'], /origin/i, `${method} ${path}: Vary: Origin`);
  }
});

test('existing quote route CORS and status behaviour is unchanged', async () => {
  const env = { DB: openD1(), ADMIN_TOKEN };
  const r = (method, path, body, headers = { Origin: ALLOWED }) => call(env, method, path, body, headers);

  assert.equal((await r('POST', '/api/quotes', { items: [] })).status, 400);
  assert.equal((await r('POST', '/api/quotes', { items: [{ id: 'x' }] })).json.error, 'company, name, phone required');
  assert.equal((await r('GET', '/api/quotes')).status, 401);
  assert.equal((await r('PATCH', '/api/quotes/Q-ping', { status: 'in_progress' })).status, 401);

  const created = await r('POST', '/api/quotes', {
    company: '[E2E] CORS 회사',
    name: '이름',
    phone: '010-0000-0000',
    items: [{ id: 'samasound.co.kr:3836', qty: 1 }],
  });
  assert.equal(created.status, 201);
  assert.ok(created.json.id.startsWith('Q-'));
  assert.equal(created.json.status, 'received');

  const patched = await r('PATCH', `/api/quotes/${created.json.id}`, { status: 'in_progress' }, {
    Origin: ALLOWED,
    Authorization: `Bearer ${ADMIN_TOKEN}`,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.status, 'in_progress');
});

test('a disallowed origin gets no useful response for protected routes', async () => {
  const env = { DB: openD1(), ADMIN_TOKEN };
  const evil = (method, path, body) =>
    call(env, method, path, body, { Origin: EVIL_ORIGIN, Authorization: `Bearer ${ADMIN_TOKEN}` });

  // the token is valid, so the data comes back, but the browser blocks the read
  const list = await evil('GET', '/api/orders');
  assert.equal(list.status, 200);
  assert.equal(list.headers['access-control-allow-origin'], ALLOWED, 'ACAO is not the evil origin');
  assert.equal(list.headers['access-control-allow-credentials'], undefined, 'no credentials are granted');
});

test('OPTIONS is 204 with an empty body on every route', async () => {
  for (const path of ['/api/quotes', '/api/orders', '/api/orders/ORD-1', '/api/payments/confirm', '/api/admin/health']) {
    const res = await raw('OPTIONS', path, { Origin: ALLOWED });
    assert.equal(res.status, 204, path);
    assert.equal(res.text, '');
  }
});
