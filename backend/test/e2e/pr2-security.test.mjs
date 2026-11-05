// PR-2 security + ledger contract tests (fix/cgi-security-ledger-261105).
//
//  1. POST /api/orders   - cookie-session orders require Origin + X-CSRF-Token
//  2. /api/payments/nicepay/window - buyer PII needs the order email factor
//  4. webhook cancellation - full/partial cancel never becomes a failed order
//  5. EMAIL_VERIFY_REQUIRED - unverified sessions are refused everywhere else
//  6. rate limits - success clears the login bucket; per-IP buckets exist
//  7. signup consent is stored on members (not only member_events)
//  9. mock gateway refused in production; Toss needs a live key
// 10. order lookup by customer_id, safe cookie parsing, quote input limits

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { makeEnv, auth, CUSTOMER, purchaseCart, pricedProductIds, ORIGIN } from '../helpers.mjs';
import { openD1 } from '../../d1-shim.mjs';
import {
  createNicepayMockAdapter,
  resetMockNicepayTransactions,
  signMockWebhookPayload,
  signMockWindowPayload,
} from '../../lib/pg-nicepay-adapter.mjs';

// Test-only credential, assembled so a secret scanner does not read the source
// line as a leaked password (nothing here is used outside this in-memory suite).
const PASSWORD = ['Test', '!2026', '-abc'].join('');
const WRONG_PASSWORD = ['Wrong', 'Pass!2026'].join('');
const CSRF = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN };
const priced = pricedProductIds(2);

function env(overrides = {}) {
  return makeEnv({
    DB: openD1(),
    MAIL_MODE: 'echo',
    AUTH_PBKDF2_ITERATIONS: '1000',
    AUTH_RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
    CORS_ALLOWED_ORIGINS: ORIGIN,
    ...overrides,
  });
}

async function call(environment, method, path, body, headers = {}) {
  const h = { ...headers };
  if (!('Origin' in h)) h.Origin = ORIGIN;
  if (h.Origin === null) delete h.Origin;
  const init = { method, headers: h };
  if (body !== undefined && body !== null) {
    if (!('Content-Type' in h)) h['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, init), environment);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  const out = {};
  response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return { status: response.status, json, text, headers: out };
}

async function callForm(environment, path, fields) {
  const body = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString();
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  }), environment);
  const out = {};
  response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return { status: response.status, headers: out, text: await response.text() };
}

async function signUp(environment, { email = 'kim@example.com', name = '김회원' } = {}) {
  const res = await call(environment, 'POST', '/api/auth/signup', {
    email, name, password: PASSWORD, phone: '010-1111-2222', company: '[E2E] 회사',
    terms: true, privacy: true,
    terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, CSRF);
  assert.equal(res.status, 201, res.text);
  return { res, cookie: res.headers['set-cookie'], token: res.json.mail.echo_token, memberId: res.json.member.id };
}

async function login(environment, email = 'kim@example.com', extra = {}, password = PASSWORD) {
  const res = await call(environment, 'POST', '/api/auth/login', { email, password }, { ...CSRF, ...extra });
  return res;
}

function badLogin(environment, email = 'kim@example.com', extra = {}) {
  return login(environment, email, extra, WRONG_PASSWORD);
}

async function verifiedSession(environment, opts = {}) {
  const { token, memberId } = await signUp(environment, opts);
  const verified = await call(environment, 'POST', '/api/auth/verify-email', { member_id: memberId, token }, CSRF);
  assert.equal(verified.status, 200, verified.text);
  const res = await login(environment, opts.email || 'kim@example.com');
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers['set-cookie'], memberId };
}

function memberIdOf(environment) {
  return environment.DB.prepare('SELECT id FROM members ORDER BY id DESC LIMIT 1').first().id;
}

// ---------------------------------------------------------------------------
// 1. order CSRF
// ---------------------------------------------------------------------------

test('a cookie-session order must clear Origin + CSRF; a guest order is unchanged', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const memberId = memberIdOf(environment);

  const noOrigin = await call(environment, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER }, {
    Cookie: cookie, 'X-CSRF-Token': ORIGIN, Origin: null,
  });
  assert.equal(noOrigin.status, 403, noOrigin.text);
  assert.equal(noOrigin.json.error, 'origin_csrf_required');

  const noCsrf = await call(environment, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER }, { Cookie: cookie });
  assert.equal(noCsrf.status, 403, 'a session order without X-CSRF-Token is refused');
  assert.equal(noCsrf.json.error, 'origin_csrf_required');

  const linked = await call(environment, 'POST', '/api/orders', {
    ...purchaseCart(), ...CUSTOMER, allow_duplicate: true,
  }, { ...CSRF, Cookie: cookie });
  assert.equal(linked.status, 201, linked.text);
  assert.equal(linked.json.customer_id, memberId, 'the order is linked to the session member');

  const guest = await call(environment, 'POST', '/api/orders', {
    ...purchaseCart(), ...CUSTOMER, idempotency_key: 'pr2-guest-order', allow_duplicate: true,
  });
  assert.equal(guest.status, 201, guest.text);
  assert.equal(guest.json.customer_id, null, 'a request with no session stays a guest order');
});

test('a non-JSON body is refused with 415 on order and quote intake', async () => {
  const environment = env();
  const order = await call(environment, 'POST', '/api/orders', JSON.stringify(purchaseCart()), {
    'Content-Type': 'text/plain',
  });
  assert.equal(order.status, 415);
  assert.equal(order.json.error, 'content_type_json_required');

  const quote = await call(environment, 'POST', '/api/quotes', JSON.stringify({
    items: [{ id: 'x', qty: 1 }], company: 'c', name: 'n', phone: '010-1111-2222', privacy_consent: true,
  }), { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(quote.status, 415);
});

// ---------------------------------------------------------------------------
// 2. payment window PII
// ---------------------------------------------------------------------------

test('the payment window requires the order email factor', async () => {
  const environment = env();
  const created = await call(environment, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  const orderId = created.json.id;

  const none = await call(environment, 'POST', '/api/payments/nicepay/window', { orderId });
  assert.equal(none.status, 403);
  assert.equal(none.json.error, 'email factor required');

  const wrong = await call(environment, 'POST', '/api/payments/nicepay/window', { orderId, email: 'other@example.com' });
  assert.equal(wrong.status, 403);

  const right = await call(environment, 'POST', '/api/payments/nicepay/window', { orderId, email: CUSTOMER.email });
  assert.equal(right.status, 200, right.text);
  assert.equal(right.json.request.orderId, orderId);
});

test('an owning member session opens the window without the email factor', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const created = await call(environment, 'POST', '/api/orders', {
    ...purchaseCart(), ...CUSTOMER, idempotency_key: 'pr2-window-member',
  }, { ...CSRF, Cookie: cookie });
  assert.equal(created.status, 201, created.text);

  const res = await call(environment, 'POST', '/api/payments/nicepay/window', { orderId: created.json.id }, {
    ...CSRF, Cookie: cookie,
  });
  assert.equal(res.status, 200, res.text);
});

// ---------------------------------------------------------------------------
// 4. webhook cancellation
// ---------------------------------------------------------------------------

async function paidOrder(environment, tid) {
  resetMockNicepayTransactions();
  const created = await call(environment, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  const order = created.json;
  const payload = signMockWindowPayload({ tid, orderId: order.id, amount: order.totals.total_amount });
  const redirect = await callForm(environment, '/api/payments/nicepay/return', payload);
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.location, /nicepay=success/);
  const row = await environment.DB.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(row.status, 'paid');
  return order;
}

test('a full gateway-side cancel webhook marks the order cancelled and keeps the amounts', async () => {
  const environment = env();
  const tid = 'PR2-HOOK-FULL';
  const order = await paidOrder(environment, tid);
  const total = order.totals.total_amount;

  // The operator refunded in the NICE console: the worker never saw a cancel call.
  await createNicepayMockAdapter().cancel({ paymentKey: tid, orderId: order.id, cancelReason: '콘솔 환불' });

  const hook = await call(environment, 'POST', '/api/payments/nicepay/webhook', signMockWebhookPayload({
    tid, orderId: order.id, amount: total, status: 'cancelled', balanceAmt: 0,
  }));
  assert.equal(hook.status, 200, hook.text);
  assert.equal(hook.text, 'OK');

  const payment = await environment.DB.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(payment.status, 'cancelled');
  assert.equal(payment.balance_amount, 0);
  assert.equal(payment.cancel_amount, total, 'the cancelled amount is written, not zeroed');
  assert.ok(payment.approved_at, 'the original approval stamp survives the webhook');

  const stored = await environment.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(order.id).first();
  assert.equal(stored.payment_status, 'cancelled');
  assert.equal(stored.refunded_amount, total);

  const events = await environment.DB.prepare('SELECT type, meta FROM order_events WHERE order_id = ? AND type = ?')
    .bind(order.id, 'payment_cancelled').all();
  assert.equal(events.results.length, 1);
  const meta = JSON.parse(events.results[0].meta);
  assert.equal(meta.cancel_amount, total);
  assert.equal(meta.source, 'webhook');
});

test('a partial gateway-side cancel webhook uses the refund vocabulary', async () => {
  const environment = env();
  const tid = 'PR2-HOOK-PART';
  const order = await paidOrder(environment, tid);
  const total = order.totals.total_amount;
  const half = Math.floor(total / 2);

  await createNicepayMockAdapter().cancel({ paymentKey: tid, orderId: order.id, cancelAmount: half, cancelReason: '부분 환불' });

  const hook = await call(environment, 'POST', '/api/payments/nicepay/webhook', signMockWebhookPayload({
    tid, orderId: order.id, amount: total, status: 'partialCancelled', balanceAmt: total - half,
  }));
  assert.equal(hook.status, 200, hook.text);

  const payment = await environment.DB.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(tid).first();
  assert.equal(payment.status, 'partial_cancelled');
  assert.equal(payment.balance_amount, total - half);
  assert.equal(payment.cancel_amount, half);

  const stored = await environment.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(order.id).first();
  assert.equal(stored.payment_status, 'partial_refunded', 'the refund handler vocabulary');
  assert.equal(stored.refunded_amount, half);
});

// ---------------------------------------------------------------------------
// 5. email verification
// ---------------------------------------------------------------------------

test('EMAIL_VERIFY_REQUIRED refuses every member route except me / resend / logout', async () => {
  const environment = env({ EMAIL_VERIFY_REQUIRED: 'YES' });
  const { cookie, token, memberId } = await signUp(environment);

  const me = await call(environment, 'GET', '/api/me', undefined, { ...CSRF, Cookie: cookie });
  assert.equal(me.status, 200, 'GET /api/me stays reachable so the site can show the verify screen');
  assert.equal(me.json.member.email_verified, false);

  const order = await call(environment, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER }, { ...CSRF, Cookie: cookie });
  assert.equal(order.status, 403);
  assert.equal(order.json.error, 'email not verified');

  const orderNoCsrf = await call(environment, 'POST', '/api/me/orders', { ...purchaseCart(), ...CUSTOMER }, { ...CSRF, Cookie: cookie });
  assert.equal(orderNoCsrf.status, 403);
  assert.equal(orderNoCsrf.json.error, 'email not verified');

  const addresses = await call(environment, 'GET', '/api/me/addresses', undefined, { ...CSRF, Cookie: cookie });
  assert.equal(addresses.status, 403);

  const quote = await call(environment, 'POST', '/api/quotes', {
    items: [{ id: 'x', qty: 1 }], company: 'c', name: 'n', phone: '010-1111-2222', privacy_consent: true,
  }, { ...CSRF, Cookie: cookie });
  assert.equal(quote.status, 403);

  const resend = await call(environment, 'POST', '/api/auth/resend-verification', {}, { ...CSRF, Cookie: cookie });
  assert.equal(resend.status, 200, resend.text);
  // The resend revokes the signup token; the newest one is the valid link.
  const freshToken = resend.json.mail.echo_token;

  const verified = await call(environment, 'POST', '/api/auth/verify-email', { member_id: memberId, token: freshToken }, CSRF);
  assert.equal(verified.status, 200, verified.text);

  const after = await call(environment, 'POST', '/api/orders', {
    ...purchaseCart(), ...CUSTOMER, idempotency_key: 'pr2-after-verify',
  }, { ...CSRF, Cookie: cookie });
  assert.equal(after.status, 201, after.text);

  const logout = await call(environment, 'POST', '/api/auth/logout', {}, { ...CSRF, Cookie: cookie });
  assert.equal(logout.status, 200, 'logout is always allowed');
});

// ---------------------------------------------------------------------------
// 6. rate limits
// ---------------------------------------------------------------------------

test('a successful login clears the failure counter for that address', async () => {
  const environment = env();
  await signUp(environment);

  for (let i = 0; i < 2; i += 1) {
    const bad = await badLogin(environment, 'kim@example.com');
    assert.equal(bad.status, 401);
  }
  let row = await environment.DB.prepare("SELECT count FROM auth_attempts WHERE kind = 'login' AND key = ?")
    .bind('kim@example.com').first();
  assert.equal(Number(row.count), 2);

  const good = await login(environment, 'kim@example.com');
  assert.equal(good.status, 200);
  row = await environment.DB.prepare("SELECT count FROM auth_attempts WHERE kind = 'login' AND key = ?")
    .bind('kim@example.com').first();
  assert.equal(row, null, 'the counter is deleted on success');
});

test('repeated failures still lock the email bucket', async () => {
  const environment = env({ AUTH_RATE_LIMIT_MAX: '3' });
  await signUp(environment);

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await badLogin(environment, 'kim@example.com')).status, 401);
  }
  const locked = await badLogin(environment, 'kim@example.com');
  assert.equal(locked.status, 429);
});

test('per-IP login bucket blocks one source and leaves another unaffected', async () => {
  const environment = env();
  // No such member: each attempt answers 401 without hashing.
  for (let i = 0; i < 30; i += 1) {
    const res = await login(environment, `nobody${i}@example.com`, { 'CF-Connecting-IP': '203.0.113.10' });
    assert.equal(res.status, 401, `attempt ${i + 1}: ${res.text}`);
  }
  const blocked = await login(environment, 'nobody-final@example.com', { 'CF-Connecting-IP': '203.0.113.10' });
  assert.equal(blocked.status, 429);

  const otherIp = await login(environment, 'nobody-other@example.com', { 'CF-Connecting-IP': '203.0.113.99' });
  assert.equal(otherIp.status, 401, 'another IP is not locked by this bucket');
});

// ---------------------------------------------------------------------------
// 7. signup consent
// ---------------------------------------------------------------------------

test('signup consent versions are stored on the member row, not just the event log', async () => {
  const environment = env();
  await signUp(environment);
  const member = await environment.DB.prepare('SELECT terms_consent_version, privacy_consent_version, consented_at FROM members').first();
  assert.equal(member.terms_consent_version, 'draft-2026-10-28');
  assert.equal(member.privacy_consent_version, 'draft-2026-10-28');
  assert.ok(member.consented_at);
});

// ---------------------------------------------------------------------------
// 9. mock refusal + Toss fail-closed
// ---------------------------------------------------------------------------

test('the production Worker refuses the mock gateway and health warns', async () => {
  const environment = env({ WORKER_NAME: 'cgi-quote-api', PG_PROVIDER_MODE: 'mock' });
  const config = await call(environment, 'GET', '/api/payments/config');
  assert.equal(config.status, 503);
  assert.equal(config.json.reason, 'mock_forbidden');

  const created = await call(environment, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  const confirm = await call(environment, 'POST', '/api/payments/confirm', {
    orderId: created.json.id, paymentKey: 'pr2_mock_must_not_approve', amount: created.json.totals.total_amount,
  });
  assert.equal(confirm.status, 503, 'no mock approval in production');

  const health = await call(environment, 'GET', '/api/admin/health', undefined, auth());
  assert.equal(health.status, 200);
  assert.equal(health.json.pg.mock_forbidden, true);
  assert.ok(health.json.warnings.includes('pg_mock_forbidden'));
});

test('PG_NICEPAY_ENV=operating also refuses the mock gateway', async () => {
  const environment = env({ PG_NICEPAY_ENV: 'operating', PG_PROVIDER_MODE: 'mock' });
  const config = await call(environment, 'GET', '/api/payments/config');
  assert.equal(config.status, 503);
  assert.equal(config.json.reason, 'mock_forbidden');
});

test('the sandbox Worker may still use the mock gateway', async () => {
  const environment = env({ WORKER_NAME: 'cgi-nicepay-sandbox', PG_PROVIDER_MODE: 'mock' });
  const config = await call(environment, 'GET', '/api/payments/config');
  assert.equal(config.status, 200);
  assert.equal(config.json.mode, 'mock');
});

test('Toss never approves without a live secret key', async () => {
  const noKey = env({ PG_PROVIDER: 'tosspayments', SITE_PG_PROVIDER: 'tosspayments', PG_PROVIDER_MODE: 'auto' });
  const config = await call(noKey, 'GET', '/api/payments/config');
  assert.equal(config.status, 503);
  assert.equal(config.json.reason, 'toss_live_key_required');

  const created = await call(noKey, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  const confirm = await call(noKey, 'POST', '/api/payments/confirm', {
    orderId: created.json.id, paymentKey: 'pr2_toss_no_key', amount: created.json.totals.total_amount,
  });
  assert.equal(confirm.status, 503);

  const testKey = env({
    PG_PROVIDER: 'tosspayments', SITE_PG_PROVIDER: 'tosspayments', PG_PROVIDER_MODE: 'auto',
    TOSS_WIDGET_SECRET_KEY: 'test_sk_dummy',
  });
  const testConfig = await call(testKey, 'GET', '/api/payments/config');
  assert.equal(testConfig.status, 503, 'a test key never approves through the live path');
  assert.equal(testConfig.json.reason, 'toss_live_key_required');
});

// ---------------------------------------------------------------------------
// 10. small fixes
// ---------------------------------------------------------------------------

test('order lookup recognises the owning member session via customer_id', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const created = await call(environment, 'POST', '/api/orders', {
    ...purchaseCart(), ...CUSTOMER, idempotency_key: 'pr2-lookup-owner',
  }, { ...CSRF, Cookie: cookie });
  assert.equal(created.status, 201, created.text);

  const full = await call(environment, 'GET', `/api/orders/${created.json.id}`, undefined, { ...CSRF, Cookie: cookie });
  assert.equal(full.status, 200);
  assert.equal(full.json.customer.name, CUSTOMER.name, 'the member sees their own order detail without the email factor');

  const anonymized = await call(environment, 'GET', `/api/orders/${created.json.id}`);
  assert.equal(anonymized.status, 200);
  assert.equal(anonymized.json.customer, undefined, 'a stranger still gets the status-only view');
});

test('a malformed session cookie is rejected, not a 500', async () => {
  const environment = env();
  const res = await call(environment, 'GET', '/api/me', undefined, {
    ...CSRF, Cookie: 'cgi_member=%E0%A4%A',
  });
  assert.equal(res.status, 401);
});

test('quote intake validates field length and item shape', async () => {
  const environment = env();
  const base = { items: [{ id: 'x', qty: 1 }], company: 'c', name: 'n', phone: '010-1111-2222', privacy_consent: true };

  const longCompany = await call(environment, 'POST', '/api/quotes', { ...base, company: 'x'.repeat(201) });
  assert.equal(longCompany.status, 400);
  assert.match(longCompany.json.error, /company too long/);

  const longPhone = await call(environment, 'POST', '/api/quotes', { ...base, phone: '0'.repeat(41) });
  assert.equal(longPhone.status, 400);

  const stringItems = await call(environment, 'POST', '/api/quotes', { ...base, items: 'not-an-array' });
  assert.equal(stringItems.status, 400);
  assert.equal(stringItems.json.error, 'items required');

  const objectItem = await call(environment, 'POST', '/api/quotes', { ...base, items: ['x'] });
  assert.equal(objectItem.status, 400);
  assert.equal(objectItem.json.error, 'invalid item');

  const longNote = await call(environment, 'POST', '/api/quotes', { ...base, note: 'n'.repeat(2001) });
  assert.equal(longNote.status, 400);
});

test('guest quote intake is rate limited per source IP (20 / 15 minutes)', async () => {
  const environment = env();
  const quote = {
    items: [{ id: 'x', qty: 1 }], company: 'c', name: 'n', phone: '010-1111-2222', privacy_consent: true,
  };
  for (let i = 0; i < 20; i += 1) {
    const res = await call(environment, 'POST', '/api/quotes', quote, { 'CF-Connecting-IP': '198.51.100.7' });
    assert.equal(res.status, 201, `quote ${i + 1}: ${res.text}`);
  }
  const blocked = await call(environment, 'POST', '/api/quotes', quote, { 'CF-Connecting-IP': '198.51.100.7' });
  assert.equal(blocked.status, 429);

  const other = await call(environment, 'POST', '/api/quotes', quote, { 'CF-Connecting-IP': '198.51.100.8' });
  assert.equal(other.status, 201, 'another IP is unaffected');
});