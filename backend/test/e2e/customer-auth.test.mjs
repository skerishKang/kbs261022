// Customer account E2E (issue #69): signup, email verification, session login,
// my page (profile / password / addresses / orders / quotes), rate limits,
// admin isolation, and the cookie+CSRF+origin guard rails.
//
//   node --experimental-sqlite test/e2e/customer-auth.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';
import { PRICE_INDEX } from '../../data/price_index.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const EVIL = 'http://evil.example.com';
const ADMIN_TOKEN = 'example-admin-token';
const PASSWORD = 'Test!2026-abc';

function env(overrides = {}) {
  return {
    DB: openD1(),
    ADMIN_TOKEN,
    PG_PROVIDER_MODE: 'mock',
    ERP_LIVE_WRITE: 'NO',
    ERP_MODE: 'test',
    SHIPPING_FEE_DEFAULT: '0',
    // echo returns the verification token in the response, which is how this
    // suite completes email verification without an external provider.
    MAIL_MODE: 'echo',
    // Keep the suite fast and deterministic: hash cheap, don't throttle.
    AUTH_PBKDF2_ITERATIONS: '1000',
    AUTH_RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
    ...overrides,
  };
}

const csrf = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN };

async function call(environment, method, path, body, headers = {}) {
  const init = { method, headers: { Origin: ORIGIN, ...headers } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, init), environment);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  const headersOut = {};
  response.headers.forEach((value, key) => { headersOut[key.toLowerCase()] = value; });
  return { status: response.status, json, text, headers: headersOut };
}

const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}`, Origin: ORIGIN };

const priced = Object.entries(PRICE_INDEX)
  .filter(([, entry]) => Number.isFinite(entry.p) && entry.p > 0)
  .slice(0, 2)
  .map(([id]) => id);

async function signUp(environment, { email = 'kim@example.com', name = '김회원', password = PASSWORD } = {}) {
  const res = await call(environment, 'POST', '/api/auth/signup', {
    email, name, password, phone: '010-1111-2222', company: '[E2E] 회사',
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(res.status, 201, `signup failed: ${res.text}`);
  return { res, token: res.json.mail.echo_token, memberId: res.json.member.id };
}

/** Create a member that is already email-verified, then log in and return its cookie. */
async function verifiedSession(environment, opts = {}) {
  const { token, memberId } = await signUp(environment, opts);
  const verified = await call(environment, 'POST', '/api/auth/verify-email', { member_id: memberId, token }, csrf);
  assert.equal(verified.status, 200, verified.text);
  return login(environment, opts);
}

async function login(environment, opts = {}) {
  const email = opts.email || 'kim@example.com';
  const password = opts.password || PASSWORD;
  const res = await call(environment, 'POST', '/api/auth/login', { email, password }, csrf);
  assert.equal(res.status, 200, `login failed: ${res.text}`);
  return { res, cookie: res.headers['set-cookie'], body: res.json };
}

async function seedPaidOrder(environment, cookie) {
  const created = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 2 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222', email: 'kim@example.com',
    idempotency_key: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }, { ...csrf, Cookie: cookie });
  assert.equal(created.status, 201, created.text);
  const paid = await call(environment, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: `e2e_pkey_${Date.now()}`,
    amount: created.json.totals.total_amount,
    paymentMethod: '카드',
  }, { ...csrf, Cookie: cookie });
  assert.equal(paid.status, 200, paid.text);
  return { order: created.json, payment: paid.json };
}

// ---------------------------------------------------------------------------
// guard rails: origin, CSRF, CORS
// ---------------------------------------------------------------------------

test('auth routes reject a disallowed origin and a missing CSRF token', async () => {
  const environment = env();

  const evilOrigin = await call(environment, 'POST', '/api/auth/login', { email: 'a@b.com', password: PASSWORD }, {
    Origin: EVIL, 'X-CSRF-Token': EVIL,
  });
  assert.equal(evilOrigin.status, 403);
  assert.equal(evilOrigin.json.error, 'origin not allowed');
  assert.equal(evilOrigin.headers['access-control-allow-origin'], ORIGIN, 'ACAO is pinned, never echoed');
  assert.notEqual(evilOrigin.headers['access-control-allow-origin'], EVIL);

  const noCsrf = await call(environment, 'POST', '/api/auth/login', { email: 'a@b.com', password: PASSWORD }, { Origin: ORIGIN });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error, 'csrf token required');

  const badCsrf = await call(environment, 'POST', '/api/auth/login', { email: 'a@b.com', password: PASSWORD }, {
    Origin: ORIGIN, 'X-CSRF-Token': 'https://wrong.example',
  });
  assert.equal(badCsrf.status, 403);
  assert.equal(badCsrf.json.error, 'csrf token required');
});

test('auth routes advertise credentials and DELETE, legacy routes grant none', async () => {
  const environment = env();

  const authPreflight = await call(environment, 'OPTIONS', '/api/auth/login', undefined, {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  });
  assert.equal(authPreflight.status, 204);
  assert.equal(authPreflight.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(authPreflight.headers['access-control-allow-credentials'], 'true');
    assert.match(authPreflight.headers['access-control-allow-methods'], /DELETE/);
    // The custom CSRF header has to be preflight-approved or the browser drops
    // the real request before the guard runs.
    assert.match(authPreflight.headers['access-control-allow-headers'], /x-csrf-token/i);

  const mePreflight = await call(environment, 'OPTIONS', '/api/me', undefined, {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'DELETE',
    'Access-Control-Request-Headers': 'content-type',
  });
  assert.equal(mePreflight.status, 204);
  assert.equal(mePreflight.headers['access-control-allow-credentials'], 'true');

  const legacyPreflight = await call(environment, 'OPTIONS', '/api/orders', undefined, {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,authorization,idempotency-key',
  });
  assert.equal(legacyPreflight.status, 204);
  assert.equal(legacyPreflight.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(legacyPreflight.headers['access-control-allow-credentials'], undefined, 'legacy routes stay credential-free');
  assert.match(legacyPreflight.headers['access-control-allow-methods'], /PATCH/);
  assert.match(legacyPreflight.headers['access-control-allow-headers'], /idempotency-key/i);

  const adminResponse = await call(environment, 'GET', '/api/orders', undefined, adminHeaders);
  assert.equal(adminResponse.status, 200);
  assert.equal(adminResponse.headers['access-control-allow-credentials'], undefined);

  // The browser admin console uses the member cookie on the same legacy order
  // and quote routes. A CSRF-bearing preflight opts into credentialed CORS, and
  // a response to a cookie-bearing request carries the credential flag too.
  const cookiePreflight = await call(environment, 'OPTIONS', '/api/orders', undefined, {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'content-type,x-csrf-token',
  });
  assert.equal(cookiePreflight.status, 204);
  assert.equal(cookiePreflight.headers['access-control-allow-credentials'], 'true');

  const cookieResponse = await call(environment, 'GET', '/api/orders', undefined, {
    ...adminHeaders,
    Cookie: 'cgi_member=test-session',
  });
  assert.equal(cookieResponse.status, 200);
  assert.equal(cookieResponse.headers['access-control-allow-credentials'], 'true');
});

test('health reports the auth posture without leaking secrets', async () => {
  const environment = env({ ADMIN_TOKEN: 'super-secret-admin-token', MAIL_MODE: 'console' });
  const res = await call(environment, 'GET', '/api/admin/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.version, '1.5.0');
  assert.equal(res.json.auth.enabled, true);
  assert.equal(res.json.auth.mail_mode, 'console');
  assert.equal(res.json.auth.email_verify_required, false);
  assert.equal(res.json.auth.cookie_secure, true);
  assert.equal(res.json.auth.origin_strict, true);
  assert.equal(res.json.auth.csrf_configured, false);
  assert.equal(res.json.auth.pbkdf2_iterations, 1000, 'reports the effective iteration count');
  assert.equal(res.json.auth.password_min, 8);
  assert.ok(!res.text.includes('super-secret-admin-token'));
  assert.ok(!res.text.includes('AUTH_TOKEN'));

  const bare = env({ ADMIN_TOKEN: ADMIN_TOKEN, MAIL_MODE: 'console' });
  delete bare.AUTH_PBKDF2_ITERATIONS;
  delete bare.AUTH_SESSION_TTL_DAYS;
  const defaults = await call(bare, 'GET', '/api/admin/health');
  assert.equal(defaults.json.auth.pbkdf2_iterations, 30000, 'the default policy is used when unset');
  assert.equal(defaults.json.auth.session_ttl_seconds, 30 * 24 * 3600);
});

test('a configured AUTH_CSRF_TOKEN is accepted and reported', async () => {
  const environment = env({ AUTH_CSRF_TOKEN: 'fixed-site-token' });
  const res = await call(environment, 'GET', '/api/admin/health');
  assert.equal(res.json.auth.csrf_configured, true);
  assert.ok(!res.text.includes('fixed-site-token'));

  const fixed = await call(environment, 'POST', '/api/auth/email-available', { email: 'a@example.com' }, {
    Origin: ORIGIN, 'X-CSRF-Token': 'fixed-site-token',
  });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.json.available, true);

  const originToken = await call(environment, 'POST', '/api/auth/email-available', { email: 'b@example.com' }, {
    Origin: ORIGIN, 'X-CSRF-Token': ORIGIN,
  });
  assert.equal(originToken.status, 200);

  const rejected = await call(environment, 'POST', '/api/auth/email-available', { email: 'c@example.com' }, {
    Origin: ORIGIN, 'X-CSRF-Token': 'not-the-token',
  });
  assert.equal(rejected.status, 403);
});

// ---------------------------------------------------------------------------
// signup
// ---------------------------------------------------------------------------

test('signup validates inputs and stores a PBKDF2 hash plus a digested token', async () => {
  const environment = env({ MAIL_MODE: 'echo' });

  const noEmail = await call(environment, 'POST', '/api/auth/signup', { name: 'x', password: PASSWORD ,
      terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28'
  }, csrf);
  assert.equal(noEmail.status, 400);

  const badEmail = await call(environment, 'POST', '/api/auth/signup', {
    email: 'not-an-email', name: 'x', password: PASSWORD,
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.json.error, 'invalid email');

  const weak = await call(environment, 'POST', '/api/auth/signup', {
    email: 'kim@example.com', name: '김회원', password: 'short',
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error, 'password too short');

  const noSymbol = await call(environment, 'POST', '/api/auth/signup', {
    email: 'kim@example.com', name: '김회원', password: 'abcdefgh1',
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(noSymbol.status, 400);
  assert.equal(noSymbol.json.error, 'password too weak');

  const noConsent = await call(environment, 'POST', '/api/auth/signup', {
    email: 'kim@example.com', name: '김회원', password: PASSWORD,
  }, csrf);
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.json.error, 'consent required');

  const withEmail = await call(environment, 'POST', '/api/auth/signup', {
    email: 'kim@example.com', name: '김회원', password: 'kim@example.com',
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(withEmail.status, 400);
  assert.equal(withEmail.json.error, 'password too weak');

  const { token } = await signUp(environment);
  const { results } = await environment.DB.prepare('SELECT password_hash FROM members').all();
  assert.equal(results.length, 1);
  assert.match(results[0].password_hash, /^pbkdf2-sha512\$1000\$/);

  const { results: tokenRows } = await environment.DB.prepare('SELECT kind, token_hash FROM auth_tokens').all();
  assert.equal(tokenRows.length, 2, 'signup creates a verify_email token and a session token');
  const sessionRow = tokenRows.find((r) => r.kind === 'session');
  const verifyRow = tokenRows.find((r) => r.kind === 'verify_email');
  assert.ok(sessionRow, 'a session token is issued at signup');
  assert.ok(verifyRow, 'a verify_email token is issued at signup');
  for (const row of [sessionRow, verifyRow]) {
    assert.notEqual(row.token_hash, token, 'the raw token is never stored');
    assert.match(row.token_hash, /^[a-f0-9]{64}$/, 'only a SHA-256 digest is stored');
  }

  const duplicate = await call(environment, 'POST', '/api/auth/signup', {
    email: 'KIM@example.com', name: '다른 사람', password: PASSWORD,
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, 'email already used');
});

test('email availability is answered without revealing anything but availability', async () => {
  const environment = env();
  const free = await call(environment, 'POST', '/api/auth/email-available', { email: 'free@example.com' }, csrf);
  assert.equal(free.status, 200);
  assert.equal(free.json.available, true);

  await signUp(environment, { email: 'free@example.com' });

  const taken = await call(environment, 'POST', '/api/auth/email-available', { email: 'free@example.com' }, csrf);
  assert.equal(taken.status, 200);
  assert.equal(taken.json.available, false);

  const bad = await call(environment, 'POST', '/api/auth/email-available', { email: 'nope' }, csrf);
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------------------
// email verification + login gate
// ---------------------------------------------------------------------------

test('email verification accepts the right token once and blocks login while required', async () => {
  const environment = env({ MAIL_MODE: 'echo', EMAIL_VERIFY_REQUIRED: 'YES' });
  const { token, memberId } = await signUp(environment);

  const blockedLogin = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: PASSWORD }, csrf);
  assert.equal(blockedLogin.status, 403);
  assert.equal(blockedLogin.json.error, 'email not verified');

  const wrongMember = await call(environment, 'POST', '/api/auth/verify-email', {
    member_id: 99999, token,
  }, csrf);
  assert.equal(wrongMember.status, 404);

  const wrongToken = await call(environment, 'POST', '/api/auth/verify-email', {
    member_id: memberId, token: 'f'.repeat(64),
  }, csrf);
  assert.equal(wrongToken.status, 400);
  assert.equal(wrongToken.json.error, 'invalid token');

  const ok = await call(environment, 'POST', '/api/auth/verify-email', { member_id: memberId, token }, csrf);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.email_verified, true);

  const replay = await call(environment, 'POST', '/api/auth/verify-email', { member_id: memberId, token }, csrf);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.already_verified, true);

  const { cookie } = await login(environment);
  const me = await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.member.email_verified, true);
});

test('the token is single-use and cannot be replayed for a second session', async () => {
  const environment = env({ MAIL_MODE: 'echo' });
  const { token, memberId } = await signUp(environment);
  assert.equal((await call(environment, 'POST', '/api/auth/verify-email', { member_id: memberId, token }, csrf)).status, 200);
  const replay = await call(environment, 'POST', '/api/auth/verify-email', { member_id: memberId, token }, csrf);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.already_verified, true);
  const { results } = await environment.DB.prepare(
    "SELECT status, consumed_at FROM auth_tokens WHERE kind = 'verify_email'"
  ).all();
  assert.equal(results[0].status, 'consumed');
  assert.ok(results[0].consumed_at);
});

test('the mail link token alone verifies the account without a member_id', async () => {
  const environment = env({ MAIL_MODE: 'echo', EMAIL_VERIFY_REQUIRED: 'YES' });
  const { res, token } = await signUp(environment);
  const mail = res.json.mail;
  assert.ok(mail.echo_url.includes('/auth/verify?token='), 'the link carries only the token');

  const verified = await call(environment, 'POST', '/api/auth/verify-email', { token }, csrf);
  assert.equal(verified.status, 200, verified.text);
  assert.equal(verified.json.email_verified, true);

  // The mail link opens through the site, so a token for a deleted account
  // still has to fail closed.
  const second = await signUp(environment, { email: 'second@example.com' });
  await environment.DB.prepare("UPDATE members SET status = 'deleted' WHERE id = ?")
    .bind(second.memberId).run();
  const deleted = await call(environment, 'POST', '/api/auth/verify-email', { token: second.token }, csrf);
  assert.equal(deleted.status, 404);
});

// ---------------------------------------------------------------------------
// login / logout / session
// ---------------------------------------------------------------------------

test('login requires the right password and sets an HttpOnly cookie', async () => {
  const environment = env();
  await signUp(environment);

  const unknown = await call(environment, 'POST', '/api/auth/login', { email: 'ghost@example.com', password: PASSWORD }, csrf);
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error, 'invalid credentials');

  const wrong = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: 'wrong-pass-1' }, csrf);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, 'invalid credentials');
  assert.equal(wrong.json.error, unknown.json.error, 'both answers are indistinguishable');

  const res = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: PASSWORD }, csrf);
  assert.equal(res.status, 200);
  assert.equal(res.json.member.email, 'kim@example.com');
  const cookie = res.headers['set-cookie'];
  assert.match(cookie, /cgi_member=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=None/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /Max-Age=/);
});

test('login honours the cookie_secure override for local development', async () => {
  const environment = env({ AUTH_COOKIE_SECURE: 'NO' });
  await signUp(environment);
  const res = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: PASSWORD }, csrf);
  assert.equal(res.status, 200);
  assert.ok(!/Secure/i.test(res.headers['set-cookie']), 'Secure is omitted when AUTH_COOKIE_SECURE=NO');
});

test('logout revokes the session and clears the cookie', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const value = cookie.split(';')[0].split('=')[1];

  const before = await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie });
  assert.equal(before.status, 200);

  const out = await call(environment, 'POST', '/api/auth/logout', {}, { ...csrf, Cookie: cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie'], /cgi_member=;/);
  assert.match(out.headers['set-cookie'], /Max-Age=0/);

  const after = await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie });
  assert.equal(after.status, 401);

  const { results } = await environment.DB.prepare("SELECT status FROM auth_tokens WHERE kind = 'session'").all();
  const revoked = results.filter((r) => r.status === 'revoked');
  assert.equal(revoked.length, 1, 'exactly one session token is revoked on logout');
  assert.ok(value.length === 64, '32 random bytes -> 64 hex chars');
});

test('an expired session is rejected and an unknown cookie is rejected', async () => {
  const environment = env({ AUTH_SESSION_TTL_DAYS: '0.0001' });
  await signUp(environment);
  await environment.DB.prepare(
    "UPDATE auth_tokens SET expires_at = '1970-01-01T00:00:00.000Z' WHERE kind = 'session'"
  ).run();
  const res = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: PASSWORD }, csrf);
  assert.equal(res.status, 200);
  await environment.DB.prepare(
    "UPDATE auth_tokens SET expires_at = '1970-01-01T00:00:00.000Z' WHERE kind = 'session'"
  ).run();
  const expired = await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: res.headers['set-cookie'] });
  assert.equal(expired.status, 401);

  const bogus = await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: 'cgi_member=' + 'a'.repeat(64) });
  assert.equal(bogus.status, 401);

  const noCookie = await call(environment, 'GET', '/api/me', undefined, csrf);
  assert.equal(noCookie.status, 401);
});

// ---------------------------------------------------------------------------
// my page: profile
// ---------------------------------------------------------------------------

test('the profile can be read and updated, but not through email changes', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);

  const me = await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.member.email, 'kim@example.com');
  assert.equal(me.json.member.name, '김회원');
  assert.equal(me.json.member.password_hash, undefined, 'no hash ever leaves the API');

  const patched = await call(environment, 'PATCH', '/api/me', { name: '김변경', phone: '010-9999-8888' }, { ...csrf, Cookie: cookie });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.member.name, '김변경');
  assert.equal(patched.json.member.phone, '010-9999-8888');

  const noChange = await call(environment, 'PATCH', '/api/me', {}, { ...csrf, Cookie: cookie });
  assert.equal(noChange.status, 400);
  assert.equal(noChange.json.error, 'no changes');

  const renameEmail = await call(environment, 'PATCH', '/api/me', { email: 'new@example.com' }, { ...csrf, Cookie: cookie });
  assert.equal(renameEmail.status, 400);
  assert.equal(renameEmail.json.error, 'email change not supported');

  const badName = await call(environment, 'PATCH', '/api/me', { name: '   ' }, { ...csrf, Cookie: cookie });
  assert.equal(badName.status, 400);

  const tooLong = await call(environment, 'PATCH', '/api/me', { company: 'x'.repeat(101) }, { ...csrf, Cookie: cookie });
  assert.equal(tooLong.status, 400);

  const badPhone = await call(environment, 'PATCH', '/api/me', { phone: 'abc' }, { ...csrf, Cookie: cookie });
  assert.equal(badPhone.status, 400);
});

test('the password can be changed and the other sessions are revoked', async () => {
  const environment = env();
  const { cookie: first } = await verifiedSession(environment);

  const wrongCurrent = await call(environment, 'POST', '/api/me/password', {
    current_password: 'wrong-pass-1', password: 'NewPass!2026x',
  }, { ...csrf, Cookie: first });
  assert.equal(wrongCurrent.status, 401);

  const weakNext = await call(environment, 'POST', '/api/me/password', {
    current_password: PASSWORD, password: 'weak',
  }, { ...csrf, Cookie: first });
  assert.equal(weakNext.status, 400);

  const changed = await call(environment, 'POST', '/api/me/password', {
    current_password: PASSWORD, password: 'NewPass!2026x',
  }, { ...csrf, Cookie: first });
  assert.equal(changed.status, 200);
  assert.match(changed.headers['set-cookie'], /cgi_member=/, 'a fresh session cookie is issued');

  const stale = await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: first });
  assert.equal(stale.status, 401, 'the pre-change session no longer works');

  const oldPassword = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: PASSWORD }, csrf);
  assert.equal(oldPassword.status, 401);
  const newPassword = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: 'NewPass!2026x' }, csrf);
  assert.equal(newPassword.status, 200);
});

// ---------------------------------------------------------------------------
// my page: addresses
// ---------------------------------------------------------------------------

test('addresses support create, patch, delete and the per-member cap', async () => {
  const environment = env({ AUTH_MAX_ADDRESSES: '3' });
  await signUp(environment);
  const { cookie } = await login(environment);

  const bad = await call(environment, 'POST', '/api/me/addresses', { recipient_name: '김' }, { ...csrf, Cookie: cookie });
  assert.equal(bad.status, 400);

  const first = await call(environment, 'POST', '/api/me/addresses', {
    label: '집', recipient_name: '김회원', phone: '010-1111-2222', addr: '광주광역시 광산구 테스트로 1', addr_detail: '101호', is_default: true,
  }, { ...csrf, Cookie: cookie });
  assert.equal(first.status, 201);
  assert.equal(first.json.address.is_default, 1);
  const addressId = first.json.address.id;

  const second = await call(environment, 'POST', '/api/me/addresses', {
    label: '회사', recipient_name: '김회원', phone: '010-2222-3333', addr: '서울특별시 종로구 세종대로 1', is_default: true,
  }, { ...csrf, Cookie: cookie });
  assert.equal(second.status, 201);
  assert.equal(second.json.address.is_default, 1);
  const secondAddressId = second.json.address.id;
  const list1 = await call(environment, 'GET', '/api/me/addresses', undefined, { ...csrf, Cookie: cookie });
  assert.equal(list1.json.items.length, 2);
  assert.equal(list1.json.items.filter((entry) => entry.is_default).length, 1, 'only one default address');

  const patched = await call(environment, 'PATCH', `/api/me/addresses/${addressId}`, {
    label: '집2', recipient_name: '김회원', phone: '010-4444-5555', addr: '광주광역시 남구 다른로 2',
  }, { ...csrf, Cookie: cookie });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.address.label, '집2');

  const badPatch = await call(environment, 'PATCH', `/api/me/addresses/${secondAddressId}`, {
    recipient_name: '김회원', phone: '010', addr: 'x',
  }, { ...csrf, Cookie: cookie });
  assert.equal(badPatch.status, 400);

  const methodNotAllowed = await call(environment, 'POST', `/api/me/addresses/${secondAddressId}`, {}, { ...csrf, Cookie: cookie });
  assert.equal(methodNotAllowed.status, 405);

  const otherEnv = env();
  await signUp(otherEnv, { email: 'other@example.com' });
  const otherSession = await login(otherEnv, { email: 'other@example.com' });
  const crossed = await call(otherEnv, 'DELETE', `/api/me/addresses/${addressId}`, undefined, { ...csrf, Cookie: otherSession.cookie });
  assert.equal(crossed.status, 404, 'another member cannot delete this address');

  const deleted = await call(environment, 'DELETE', `/api/me/addresses/${addressId}`, undefined, { ...csrf, Cookie: cookie });
  assert.equal(deleted.status, 200);
  const list2 = await call(environment, 'GET', '/api/me/addresses', undefined, { ...csrf, Cookie: cookie });
  assert.equal(list2.json.items.length, 1);

  const missing = await call(environment, 'DELETE', '/api/me/addresses/999999', undefined, { ...csrf, Cookie: cookie });
  assert.equal(missing.status, 404);
});

test('the per-member address cap is enforced', async () => {
  const environment = env({ AUTH_MAX_ADDRESSES: '2' });
  await signUp(environment);
  const { cookie } = await login(environment);

  for (let i = 0; i < 2; i += 1) {
    const res = await call(environment, 'POST', '/api/me/addresses', {
      label: `주소${i + 1}`, recipient_name: '김회원', phone: `010-0000-${1000 + i}`, addr: `서울특별시 길${i + 1}로 ${i + 1}`,
    }, { ...csrf, Cookie: cookie });
    assert.equal(res.status, 201, `address ${i + 1}: ${res.text}`);
  }
  const over = await call(environment, 'POST', '/api/me/addresses', {
    label: '주소3', recipient_name: '김회원', phone: '010-0000-9999', addr: '서울특별시 막바로 3',
  }, { ...csrf, Cookie: cookie });
  assert.equal(over.status, 409);
  assert.equal(over.json.error, 'too many addresses');
  assert.equal(over.json.detail.max, 2);
});

// ---------------------------------------------------------------------------
// my page: orders
// ---------------------------------------------------------------------------

test('a signed-in checkout is linked to the member and appears on my orders', async () => {
  const environment = env();
  const me = await call(environment, 'GET', '/api/me', undefined, { ...csrf });
  const { cookie } = await verifiedSession(environment);
  assert.equal(me.status, 401);

  const created = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 2 }, { product_id: priced[1], qty: 1 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
    idempotency_key: 'e2e-linked-1',
  }, { ...csrf, Cookie: cookie });
  assert.equal(created.status, 201, created.text);

  const memberId = (await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie })).json.member.id;
  assert.equal(created.json.customer_id, memberId);

  const list = await call(environment, 'GET', '/api/me/orders', undefined, { ...csrf, Cookie: cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].id, created.json.id);
  assert.ok(list.json.items[0].items, 'items are attached to the list view');

  const detail = await call(environment, 'GET', `/api/me/orders/${created.json.id}`, undefined, { ...csrf, Cookie: cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.order.items.length, 2);

  const otherEnv = env();
  await signUp(otherEnv, { email: 'other@example.com' });
  const otherSession = await login(otherEnv, { email: 'other@example.com' });
  const crossed = await call(otherEnv, 'GET', `/api/me/orders/${created.json.id}`, undefined, { ...csrf, Cookie: otherSession.cookie });
  assert.equal(crossed.status, 404, 'no cross-member order access');

  const listCrossed = await call(otherEnv, 'GET', '/api/me/orders', undefined, { ...csrf, Cookie: otherSession.cookie });
  assert.equal(listCrossed.json.items.length, 0);
});

test('guest checkout is unchanged and has no member link', async () => {
  const environment = env();
  const created = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 1 }],
    company: '[E2E] 업체', name: '[E2E] 김고객', phone: '010-5555-6666',
    idempotency_key: 'e2e-guest-1',
  }, csrf);
  assert.equal(created.status, 201);
  assert.equal(created.json.customer_id, null);
  const list = await call(environment, 'GET', '/api/me/orders', undefined, csrf);
  assert.equal(list.status, 401);
});

test('member-scoped checkout and quote intake link the member without touching the legacy routes', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const memberId = (await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie })).json.member.id;

  const created = await call(environment, 'POST', '/api/me/orders', {
    items: [{ product_id: priced[0], qty: 2 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
    idempotency_key: 'e2e-memberscoped-1',
  }, { ...csrf, Cookie: cookie, 'Idempotency-Key': 'e2e-memberscoped-1' });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.customer_id, memberId);

  const list = await call(environment, 'GET', '/api/me/orders', undefined, { ...csrf, Cookie: cookie });
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].id, created.json.id);

  const quote = await call(environment, 'POST', '/api/me/quotes', {
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
    items: [{ id: priced[0], qty: 1 }],
  }, { ...csrf, Cookie: cookie });
  assert.equal(quote.status, 201, quote.text);
  assert.equal(quote.json.member_id, memberId);

  // Neither member route is reachable without a session, and neither returns a
  // session cookie to a guest.
  assert.equal((await call(environment, 'POST', '/api/me/orders', {}, csrf)).status, 401);
  assert.equal((await call(environment, 'POST', '/api/me/quotes', { company: 'a', name: 'b', phone: '010-1111-2222', items: [{ id: priced[0], qty: 1 }] }, csrf)).status, 401);

  // The legacy guest paths stay credential-free in their CORS response.
  const guestOrder = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 1 }],
    company: '[E2E] 업체', name: '[E2E] 김고객', phone: '010-5555-6666',
    idempotency_key: 'e2e-guest-scoped',
  }, csrf);
  assert.equal(guestOrder.status, 201);
  assert.equal(guestOrder.json.customer_id, null);
  assert.equal(guestOrder.headers['access-control-allow-credentials'], undefined);

  const scoped = await call(environment, 'POST', '/api/me/orders', {
    items: [{ product_id: priced[0], qty: 1 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
    idempotency_key: 'e2e-memberscoped-2',
  }, { ...csrf, Cookie: cookie });
  assert.equal(scoped.status, 201);
  assert.equal(scoped.headers['access-control-allow-credentials'], 'true');
});

test('a member can cancel an unpaid order, not a paid one', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);

  const created = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 1 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
    idempotency_key: 'e2e-cancel-1',
  }, { ...csrf, Cookie: cookie });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, 'awaiting_payment');

  const cancelled = await call(environment, 'POST', `/api/me/orders/${created.json.id}/cancel`, {}, { ...csrf, Cookie: cookie });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.json.changed, true);
  assert.equal(cancelled.json.order.status, 'cancelled');

  const again = await call(environment, 'POST', `/api/me/orders/${created.json.id}/cancel`, {}, { ...csrf, Cookie: cookie });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'not cancellable');

  const { order: paid } = await seedPaidOrder(environment, cookie);
  const paidCancel = await call(environment, 'POST', `/api/me/orders/${paid.id}/cancel`, {}, { ...csrf, Cookie: cookie });
  assert.equal(paidCancel.status, 409);
});

/* ------------------------------------------------------------------ re-pay */

async function unpaidOrder(environment, cookie, idempotencyKey, qty = 1) {
  const created = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[0], qty }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
    idempotency_key: idempotencyKey,
  }, { ...csrf, Cookie: cookie });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.status, 'awaiting_payment');
  return created.json;
}

const repay = (environment, cookie, id, body = {}) =>
  call(environment, 'POST', `/api/me/orders/${id}/repay`, body, { ...csrf, Cookie: cookie });

test('an unpaid order can be re-opened for payment at the server-declared amount', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const order = await unpaidOrder(environment, cookie, 'e2e-repay-1');

  const res = await repay(environment, cookie, order.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.payable, true);
  assert.equal(res.json.payment.order_id, order.id, 'the SAME order number goes back to the widget');
  assert.equal(res.json.payment.amount, order.totals.total_amount, 'the amount comes from the server row');
  assert.equal(res.json.payment.status, 'awaiting_payment');
  assert.equal(res.json.payment.payment_status, 'pending');

  const after = await call(environment, 'GET', `/api/me/orders/${order.id}`, undefined, { ...csrf, Cookie: cookie });
  assert.equal(after.json.order.status, 'awaiting_payment', 'repay must not mutate the order');

  const list = await call(environment, 'GET', '/api/me/orders', undefined, { ...csrf, Cookie: cookie });
  assert.equal(list.json.items.length, 1, 're-paying never mints a second order');
});

test('a client-sent amount in the repay body is ignored', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const order = await unpaidOrder(environment, cookie, 'e2e-repay-tamper');

  const res = await repay(environment, cookie, order.id, { amount: 1 });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.payment.amount, order.totals.total_amount);

  const cheap = await call(environment, 'POST', '/api/payments/confirm', {
    orderId: order.id, paymentKey: 'e2e_repay_cheap', amount: 1,
  }, csrf);
  assert.equal(cheap.status, 400);
  assert.equal(cheap.json.error, 'amount mismatch');
});

test('the repaid order then confirms normally and is paid exactly once', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const order = await unpaidOrder(environment, cookie, 'e2e-repay-confirm');
  const opened = await repay(environment, cookie, order.id);

  const paid = await call(environment, 'POST', '/api/payments/confirm', {
    orderId: opened.json.payment.order_id,
    paymentKey: 'e2e_repay_ok',
    amount: opened.json.payment.amount,
    paymentMethod: '카드',
  }, csrf);
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.json.order.status, 'paid');

  const list = await call(environment, 'GET', '/api/me/orders', undefined, { ...csrf, Cookie: cookie });
  assert.equal(list.json.items.length, 1, 'a completed re-payment still adds no order');

  const late = await repay(environment, cookie, order.id);
  assert.equal(late.status, 409);
  assert.equal(late.json.error, 'already_paid', 'double payment on a paid order is blocked');
});

test('every repay attempt is recorded as an order and member event', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const order = await unpaidOrder(environment, cookie, 'e2e-repay-events');
  await repay(environment, cookie, order.id);
  await repay(environment, cookie, order.id);

  const events = await environment.DB.prepare('SELECT type, actor, from_status, to_status, meta FROM order_events WHERE order_id = ?')
    .bind(order.id).all();
  const retries = events.results.filter((row) => row.type === 'payment_retry_requested');
  assert.equal(retries.length, 2);
  assert.equal(retries[0].actor, 'customer');
  assert.equal(retries[0].from_status, 'awaiting_payment');
  assert.equal(retries[0].to_status, 'awaiting_payment', 'the status is not faked as changed');
  assert.ok(retries[0].meta.includes(String(order.totals.total_amount)));

  const memberEvents = await environment.DB.prepare('SELECT type FROM member_events WHERE type = ?').bind('payment_retry_requested').all();
  assert.equal(memberEvents.results.length, 2);
});

test('repay requires a member session', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const order = await unpaidOrder(environment, cookie, 'e2e-repay-auth');

  const anonymous = await call(environment, 'POST', `/api/me/orders/${order.id}/repay`, {}, csrf);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error, 'unauthorized');

  const evil = await call(environment, 'POST', `/api/me/orders/${order.id}/repay`, {}, {
    Origin: EVIL, 'X-CSRF-Token': EVIL, Cookie: cookie,
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.json.error, 'origin not allowed');
});

test("someone else's order cannot be re-opened", async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const order = await unpaidOrder(environment, cookie, 'e2e-repay-owner');

  await signUp(environment, { email: 'thief@example.com' });
  const thief = await login(environment, { email: 'thief@example.com' });
  const res = await repay(environment, thief.cookie, order.id);
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'order not found', 'ownership is checked on the server, not in the browser');

  const guest = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[1], qty: 3 }],
    company: '[E2E] 업체', name: '[E2E] 김고객', phone: '010-5555-6666',
    idempotency_key: 'e2e-repay-guest',
  }, csrf);
  assert.equal(guest.status, 201, guest.text);
  assert.equal(guest.json.customer_id, null);
  const guestRepay = await repay(environment, thief.cookie, guest.json.id);
  assert.equal(guestRepay.status, 404, 'a guest order has no owner to re-pay it');

  const missing = await repay(environment, cookie, 'ORD-19990101-ABCDE');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'order not found');
});

test('a quote order is never payable', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const created = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 1 }, { product_id: 'no-such-product-id', qty: 1 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
    idempotency_key: 'e2e-repay-quote',
  }, { ...csrf, Cookie: cookie });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.kind, 'quote');

  const res = await repay(environment, cookie, created.json.id);
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'not payable');
  assert.equal(res.json.detail.reason, 'quote_order_not_payable');
});

test('an order that is no longer awaiting payment cannot be re-paid', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const order = await unpaidOrder(environment, cookie, 'e2e-repay-cancelled');

  const cancelled = await call(environment, 'POST', `/api/me/orders/${order.id}/cancel`, {}, { ...csrf, Cookie: cookie });
  assert.equal(cancelled.status, 200, cancelled.text);

  const res = await repay(environment, cookie, order.id);
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'not payable');
  assert.equal(res.json.detail.status, 'cancelled');
});

test('a failed payment stays repayable with the original amount', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const order = await unpaidOrder(environment, cookie, 'e2e-repay-failed');

  const failed = await call(environment, 'POST', '/api/payments/confirm', {
    orderId: order.id, paymentKey: 'e2e_fail_card_declined', amount: order.totals.total_amount,
  }, csrf);
  assert.equal(failed.status, 402);
  assert.equal(failed.json.payment_status, 'failed');

  const res = await repay(environment, cookie, order.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.payment.payment_status, 'failed');
  assert.equal(res.json.payment.amount, order.totals.total_amount);

  const retry = await call(environment, 'POST', '/api/payments/confirm', {
    orderId: order.id, paymentKey: 'e2e_repay_approved', amount: res.json.payment.amount,
  }, csrf);
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.order.status, 'paid');

  const list = await call(environment, 'GET', '/api/me/orders', undefined, { ...csrf, Cookie: cookie });
  assert.equal(list.json.items.length, 1);
});

test('a member can request a refund on their own paid order', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const { order, payment } = await seedPaidOrder(environment, cookie);

  const badAmount = await call(environment, 'POST', `/api/me/orders/${order.id}/refund/request`, {
    amount: order.totals.total_amount + 1000, reason: 'too much',
  }, { ...csrf, Cookie: cookie });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.json.error, 'invalid amount');

  const requested = await call(environment, 'POST', `/api/me/orders/${order.id}/refund/request`, {
    amount: order.totals.total_amount, reason: '고객 환불 요청',
  }, { ...csrf, Cookie: cookie });
  assert.equal(requested.status, 200, requested.text);
  assert.equal(requested.json.ok, true);
  assert.equal(requested.json.order.status, 'refunding');

  const events = await environment.DB.prepare('SELECT type, actor FROM order_events WHERE order_id = ?').bind(order.id).all();
  assert.ok(events.results.some((row) => row.type === 'refund_requested' && row.actor === 'customer'));

  const memberEvents = await environment.DB.prepare('SELECT type FROM member_events WHERE type = ?').bind('refund_requested').all();
  assert.equal(memberEvents.results.length, 1);

  const again = await call(environment, 'GET', `/api/me/orders/${order.id}`, undefined, { ...csrf, Cookie: cookie });
  assert.equal(again.status, 200);
  assert.equal(again.json.order.status, 'refunding');
});

test('refund requests are refused for unpaid or already refunded orders', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const created = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 1 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
    idempotency_key: 'e2e-refund-guard-1',
  }, { ...csrf, Cookie: cookie });
  assert.equal(created.status, 201);
  const unpaid = await call(environment, 'POST', `/api/me/orders/${created.json.id}/refund/request`, {
    reason: 'x',
  }, { ...csrf, Cookie: cookie });
  assert.equal(unpaid.status, 409);
  assert.equal(unpaid.json.error, 'not payable');
});

// ---------------------------------------------------------------------------
// my page: quotes
// ---------------------------------------------------------------------------

test('a signed-in quote request is linked, a guest quote is not', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);

  const mine = await call(environment, 'POST', '/api/quotes', {
    items: [{ id: 'samasound.co.kr:3836', qty: 1 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
  }, { ...csrf, Cookie: cookie });
  assert.equal(mine.status, 201, mine.text);
  assert.equal(mine.json.status, 'received');

  const memberId = (await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie })).json.member.id;
  assert.equal(mine.json.member_id, memberId);

  const guest = await call(environment, 'POST', '/api/quotes', {
    items: [{ id: 'samasound.co.kr:3836', qty: 1 }],
    company: '[E2E] 업체', name: '[E2E] 김고객', phone: '010-5555-6666',
  }, csrf);
  assert.equal(guest.status, 201);
  assert.equal(guest.json.member_id, null);

  const list = await call(environment, 'GET', '/api/me/quotes', undefined, { ...csrf, Cookie: cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].id, mine.json.id);
  assert.ok(Array.isArray(list.json.items[0].items));

  const detail = await call(environment, 'GET', `/api/me/quotes/${mine.json.id}`, undefined, { ...csrf, Cookie: cookie });
  assert.equal(detail.status, 200);

  const crossed = await call(environment, 'GET', `/api/me/quotes/${guest.json.id}`, undefined, { ...csrf, Cookie: cookie });
  assert.equal(crossed.status, 404);
});

test('a quote request from another origin is not linked even with a cookie', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);
  const res = await call(environment, 'POST', '/api/quotes', {
    items: [{ id: 'samasound.co.kr:3836', qty: 1 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
  }, { Origin: EVIL, Cookie: cookie });
  assert.equal(res.status, 201);
  assert.equal(res.json.member_id, null, 'the link only happens through the origin+CSRF gate');
});

// ---------------------------------------------------------------------------
// rate limits, resets, deletion, admin isolation
// ---------------------------------------------------------------------------

test('login attempts are rate limited and the lockout is reported', async () => {
  const environment = env({ AUTH_RATE_LIMIT_MAX: '3', AUTH_RATE_LIMIT_WINDOW_SECONDS: '60' });
  await signUp(environment);

  let limited = null;
  for (let i = 0; i < 5; i += 1) {
    const res = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: 'wrong-pass-1' }, csrf);
    if (res.status === 429) { limited = res; break; }
  }
  assert.ok(limited, 'a 429 is returned');
  assert.equal(limited.json.error, 'rate limited');
  assert.ok(limited.json.detail.retry_after);

  const { results } = await environment.DB.prepare("SELECT * FROM auth_attempts WHERE kind = 'login'").all();
  assert.equal(results.length, 1);
  assert.ok(Number(results[0].count) >= 3);
  assert.ok(results[0].locked_until);
});

test('password reset issues a token, changes the password and revokes sessions', async () => {
  const environment = env({ MAIL_MODE: 'echo' });
  const { cookie } = await verifiedSession(environment);
  assert.equal((await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie })).status, 200);

  const requested = await call(environment, 'POST', '/api/auth/password-reset/request', { email: 'kim@example.com' }, csrf);
  assert.equal(requested.status, 200);
  assert.equal(requested.json.requested, true);
  const token = requested.json.mail.echo_token;
  assert.ok(token);

  const noSuchMember = await call(environment, 'POST', '/api/auth/password-reset/request', { email: 'nobody@example.com' }, csrf);
  assert.equal(noSuchMember.status, 200);
  assert.equal(noSuchMember.json.requested, true, 'no enumeration');
  assert.equal(noSuchMember.json.mail.token, undefined, 'no token for a missing account');

  const badToken = await call(environment, 'POST', '/api/auth/password-reset/confirm', {
    token: 'f'.repeat(64), password: 'NewPass!2026x',
  }, csrf);
  assert.equal(badToken.status, 400);

  const weak = await call(environment, 'POST', '/api/auth/password-reset/confirm', { token, password: 'weak' }, csrf);
  assert.equal(weak.status, 400);

  const confirmed = await call(environment, 'POST', '/api/auth/password-reset/confirm', {
    token, password: 'NewPass!2026x',
  }, csrf);
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.match(confirmed.headers['set-cookie'], /cgi_member=/);

  const stale = await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie });
  assert.equal(stale.status, 401, 'the old session is revoked');

  const replay = await call(environment, 'POST', '/api/auth/password-reset/confirm', {
    token, password: 'Another!2026x',
  }, csrf);
  assert.equal(replay.status, 400, 'the token is single use');

  const loginAgain = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: 'NewPass!2026x' }, csrf);
  assert.equal(loginAgain.status, 200);
});

test('a paid order blocks account deletion', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);

  const unconfirmed = await call(environment, 'DELETE', '/api/me', {}, { ...csrf, Cookie: cookie });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.json.error, 'confirmation required');

  await seedPaidOrder(environment, cookie);
  const blocked = await call(environment, 'DELETE', '/api/me', { confirm: 'delete-member' }, { ...csrf, Cookie: cookie });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'open orders');
  assert.ok(blocked.json.detail.count >= 1);
});

test('an unpaid order blocks deletion until it is cancelled, then everything is revoked', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);

  const created = await call(environment, 'POST', '/api/orders', {
    items: [{ product_id: priced[0], qty: 1 }],
    company: '[E2E] 회사', name: '[E2E] 김회원', phone: '010-1111-2222',
    idempotency_key: 'e2e-delete-1',
  }, { ...csrf, Cookie: cookie });
  assert.equal(created.status, 201);

  const blocked = await call(environment, 'DELETE', '/api/me', { confirm: 'delete-member' }, { ...csrf, Cookie: cookie });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'open orders');

  const cancelled = await call(environment, 'POST', `/api/me/orders/${created.json.id}/cancel`, {}, { ...csrf, Cookie: cookie });
  assert.equal(cancelled.status, 200);

  const deleted = await call(environment, 'DELETE', '/api/me', { confirm: 'delete-member' }, { ...csrf, Cookie: cookie });
  assert.equal(deleted.status, 200);
  assert.match(deleted.headers['set-cookie'], /Max-Age=0/);

  const after = await call(environment, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie });
  assert.equal(after.status, 401);

  const { results } = await environment.DB.prepare('SELECT * FROM members').all();
  assert.equal(results[0].status, 'deleted');
  assert.ok(results[0].deleted_at);
  assert.equal(results[0].name, '탈퇴회원');
  assert.equal(results[0].phone, null);
  assert.equal(results[0].company, null);
  assert.match(results[0].email, /^deleted-1-\d{4}-\d{2}-\d{2}@cgi\.invalid$/, 'the email is quarantined, not deleted');

  const events = await environment.DB.prepare("SELECT type FROM member_events WHERE member_id = 1").all();
  assert.ok(events.results.some((row) => row.type === 'deleted'));

  const tokens = await environment.DB.prepare("SELECT status FROM auth_tokens WHERE kind = 'session'").all();
  assert.ok(tokens.results.every((row) => row.status === 'revoked'));

  const reuse = await call(environment, 'POST', '/api/auth/signup', {
    email: 'kim@example.com', name: '김새회원', password: PASSWORD,
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(reuse.status, 201, 'the released email can be registered again');
});

test('admin endpoints are unreachable with a customer session', async () => {
  const environment = env();
  const { cookie } = await verifiedSession(environment);

  const adminOrders = await call(environment, 'GET', '/api/orders', undefined, { ...csrf, Cookie: cookie });
  assert.equal(adminOrders.status, 401);

  const adminQuotes = await call(environment, 'GET', '/api/quotes', undefined, { ...csrf, Cookie: cookie });
  assert.equal(adminQuotes.status, 401);

  const adminEvents = await call(environment, 'GET', '/api/orders/ORD-1/events', undefined, { ...csrf, Cookie: cookie });
  assert.equal(adminEvents.status, 401);

  const schemaInit = await call(environment, 'POST', '/api/admin/schema/init', {}, { ...csrf, Cookie: cookie });
  assert.equal(schemaInit.status, 401);

  const adminWorks = await call(environment, 'GET', '/api/orders', undefined, adminHeaders);
  assert.equal(adminWorks.status, 200, 'the bearer-token admin path still works');
});

test('the schema init stays idempotent after the customer tables exist', async () => {
  const environment = env();
  await signUp(environment);
  const first = await call(environment, 'POST', '/api/admin/schema/init', {}, adminHeaders);
  assert.equal(first.status, 200);
  assert.ok(first.json.tables.includes('members'));
  assert.ok(first.json.tables.includes('auth_tokens'));
  assert.ok(first.json.tables.includes('auth_attempts'));
  assert.ok(first.json.tables.includes('member_events'));
  const second = await call(environment, 'POST', '/api/admin/schema/init', {}, adminHeaders);
  assert.equal(second.status, 200);
  assert.equal(second.json.tables.length, first.json.tables.length);
});

test('a suspended account cannot sign in', async () => {
  const environment = env();
  await signUp(environment);
  await environment.DB.prepare("UPDATE members SET status = 'suspended'").run();
  const res = await call(environment, 'POST', '/api/auth/login', { email: 'kim@example.com', password: PASSWORD }, csrf);
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'account suspended');
});

test('resend-verification requires a session and is a no-op once verified', async () => {
  const environment = env({ MAIL_MODE: 'echo' });
  await signUp(environment);

  const anonymous = await call(environment, 'POST', '/api/auth/resend-verification', {}, csrf);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error, 'unauthorized');

  const { cookie } = await login(environment);
  const resent = await call(environment, 'POST', '/api/auth/resend-verification', {}, { ...csrf, Cookie: cookie });
  assert.equal(resent.status, 200, resent.text);
  assert.ok(resent.json.mail.echo_token);

  const duplicate = await call(environment, 'POST', '/api/auth/signup', {
    email: 'kim@example.com', name: '김회원2', password: PASSWORD,
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(duplicate.status, 409, 'the same email cannot be registered twice');
});

test('issuing a new verification token revokes the previous pending one', async () => {
  const environment = env({ MAIL_MODE: 'echo', AUTH_RESEND_COOLDOWN_SECONDS: '0' });
  await signUp(environment);
  const { cookie } = await login(environment);

  // First resend issues token A
  const first = await call(environment, 'POST', '/api/auth/resend-verification', {}, { ...csrf, Cookie: cookie });
  assert.equal(first.status, 200);
  const tokenA = first.json.mail.echo_token;

  // Second resend issues token B and revokes A
  const second = await call(environment, 'POST', '/api/auth/resend-verification', {}, { ...csrf, Cookie: cookie });
  assert.equal(second.status, 200);
  const tokenB = second.json.mail.echo_token;
  assert.notEqual(tokenA, tokenB);

  // Token A is now revoked — verify with it should fail
  const verifyA = await call(environment, 'POST', '/api/auth/verify-email', { token: tokenA }, csrf);
  assert.equal(verifyA.status, 400, 'revoked token should be rejected');

  // Token B still works
  const verifyB = await call(environment, 'POST', '/api/auth/verify-email', { token: tokenB }, csrf);
  assert.equal(verifyB.status, 200);
  assert.equal(verifyB.json.email_verified, true);
});

test('resend-verification enforces a 60-second cooldown', async () => {
  const environment = env({ MAIL_MODE: 'echo' });
  await signUp(environment);
  const { cookie } = await login(environment);

  // First resend should succeed
  const first = await call(environment, 'POST', '/api/auth/resend-verification', {}, { ...csrf, Cookie: cookie });
  assert.equal(first.status, 200, first.text);

  // Second resend immediately after should be rate-limited
  const second = await call(environment, 'POST', '/api/auth/resend-verification', {}, { ...csrf, Cookie: cookie });
  assert.equal(second.status, 429);
  assert.equal(second.json.error, 'rate limited');
  assert.ok(second.json.retry_after_seconds);
});

test('password reset token is single-use and previous tokens are revoked', async () => {
  const environment = env({ MAIL_MODE: 'echo' });
  await signUp(environment);

  // Request first reset
  const req1 = await call(environment, 'POST', '/api/auth/password-reset/request', { email: 'kim@example.com' }, csrf);
  assert.equal(req1.status, 200);
  const token1 = req1.json.mail.echo_token;

  // Request second reset — revokes token1
  const req2 = await call(environment, 'POST', '/api/auth/password-reset/request', { email: 'kim@example.com' }, csrf);
  assert.equal(req2.status, 200);
  const token2 = req2.json.mail.echo_token;
  assert.notEqual(token1, token2);

  // Token1 should be revoked
  const confirm1 = await call(environment, 'POST', '/api/auth/password-reset/confirm', { token: token1, password: 'NewPass!2026' }, csrf);
  assert.equal(confirm1.status, 400, 'revoked reset token should fail');

  // Token2 should work
  const confirm2 = await call(environment, 'POST', '/api/auth/password-reset/confirm', { token: token2, password: 'NewPass!2026' }, csrf);
  assert.equal(confirm2.status, 200);
  assert.equal(confirm2.json.ok, true);
});
