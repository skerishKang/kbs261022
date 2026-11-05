// PR-4 hardening: PBKDF2 upgrade-on-login, email-availability IP limit, login
// account-state disclosure, portable default-address update, OAuth secret gate.
import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';
import { hashPassword, AUTH_POLICY } from '../../lib/auth.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const CSRF = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN };
const PASSWORD = 'Test!2026-abc';

function env(overrides = {}) {
  return {
    DB: openD1(),
    ADMIN_TOKEN: 'test-admin-token',
    PG_PROVIDER: 'nicepay',
    SITE_PG_PROVIDER: 'nicepay',
    PG_PROVIDER_MODE: 'mock',
    ERP_LIVE_WRITE: 'NO',
    ERP_MODE: 'test',
    SHIPPING_FEE_DEFAULT: '0',
    MAIL_MODE: 'echo',
    AUTH_PBKDF2_ITERATIONS: '2000',
    AUTH_RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
    AUTH_SESSION_SECRET: 'test-oauth-secret',
    CORS_ALLOWED_ORIGINS: ORIGIN,
    ...overrides,
  };
}

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
  const out = {};
  response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return { status: response.status, json, text, headers: out };
}

async function insertMember(environment, { email, hash, status = 'active' }) {
  const now = '2026-01-01T00:00:00.000Z';
  const result = await environment.DB.prepare(
    `INSERT INTO members (email, password_hash, name, status, email_verified_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(email, hash, 'Test Member', status, now, now, now).run();
  return result.meta.last_row_id ?? result.meta.last_rowid;
}

// ---------------------------------------------------------------------------
// 2. PBKDF2
// ---------------------------------------------------------------------------

test('a successful login upgrades an old 1000-iteration hash to the current policy', async () => {
  const environment = env();
  const oldHash = await hashPassword(PASSWORD, { ...AUTH_POLICY, pbkdf2Iterations: 1000 });
  await insertMember(environment, { email: 'old@example.com', hash: oldHash });
  assert.match(environment.DB.prepare('SELECT password_hash FROM members').first().password_hash, /^\S+\$1000\$/);

  const login = await call(environment, 'POST', '/api/auth/login', { email: 'old@example.com', password: PASSWORD }, CSRF);
  assert.equal(login.status, 200, login.text);
  assert.match(
    environment.DB.prepare('SELECT password_hash FROM members').first().password_hash,
    /^\S+\$2000\$/,
    'the stored hash moves to the policy iteration count',
  );

  const again = await call(environment, 'POST', '/api/auth/login', { email: 'old@example.com', password: PASSWORD }, CSRF);
  assert.equal(again.status, 200, 'the upgraded hash still verifies');
});

test('a failed login does not rewrite the hash', async () => {
  const environment = env();
  const oldHash = await hashPassword(PASSWORD, { ...AUTH_POLICY, pbkdf2Iterations: 1000 });
  await insertMember(environment, { email: 'keep@example.com', hash: oldHash });
  const before = environment.DB.prepare('SELECT password_hash FROM members').first().password_hash;

  const bad = await call(environment, 'POST', '/api/auth/login', { email: 'keep@example.com', password: 'WrongTest!2026' }, CSRF);
  assert.equal(bad.status, 401);
  assert.equal(environment.DB.prepare('SELECT password_hash FROM members').first().password_hash, before);
});

// ---------------------------------------------------------------------------
// 3. email availability + login disclosure
// ---------------------------------------------------------------------------

test('email availability is rate limited per source IP', async () => {
  const environment = env();
  for (let i = 0; i < 30; i += 1) {
    const res = await call(environment, 'POST', '/api/auth/email-available', { email: `probe${i}@example.com` }, {
      ...CSRF, 'CF-Connecting-IP': '203.0.113.50',
    });
    assert.equal(res.status, 200, `probe ${i + 1}: ${res.text}`);
  }
  const blocked = await call(environment, 'POST', '/api/auth/email-available', { email: 'probe-final@example.com' }, {
    ...CSRF, 'CF-Connecting-IP': '203.0.113.50',
  });
  assert.equal(blocked.status, 429);

  const other = await call(environment, 'POST', '/api/auth/email-available', { email: 'probe-other@example.com' }, {
    ...CSRF, 'CF-Connecting-IP': '203.0.113.51',
  });
  assert.equal(other.status, 200, 'another IP is unaffected');
});

test('deleted/suspended is disclosed only after the password verifies', async () => {
  const environment = env();
  const hash = await hashPassword(PASSWORD, { ...AUTH_POLICY, pbkdf2Iterations: 2000 });
  await insertMember(environment, { email: 'deleted@example.com', hash, status: 'deleted' });
  await insertMember(environment, { email: 'suspended@example.com', hash, status: 'suspended' });

  for (const [email, message] of [['deleted@example.com', 'invalid credentials'], ['suspended@example.com', 'invalid credentials']]) {
    const wrong = await call(environment, 'POST', '/api/auth/login', { email, password: 'WrongTest!2026' }, CSRF);
    assert.equal(wrong.status, 401, `${email} wrong password`);
    assert.equal(wrong.json.error, message, 'the account state must not leak');
  }

  const deleted = await call(environment, 'POST', '/api/auth/login', { email: 'deleted@example.com', password: PASSWORD }, CSRF);
  assert.equal(deleted.status, 403);
  assert.equal(deleted.json.error, 'account deleted');

  const suspended = await call(environment, 'POST', '/api/auth/login', { email: 'suspended@example.com', password: PASSWORD }, CSRF);
  assert.equal(suspended.status, 403);
  assert.equal(suspended.json.error, 'account suspended');
});

// ---------------------------------------------------------------------------
// 4. default address + OAuth secret
// ---------------------------------------------------------------------------

test('deleting the default address promotes the oldest remaining address', async () => {
  const environment = env();
  const signup = await call(environment, 'POST', '/api/auth/signup', {
    email: 'addr@example.com', name: '주소회원', password: PASSWORD,
    terms: true, privacy: true, terms_version: 'v1', privacy_version: 'v1',
  }, CSRF);
  assert.equal(signup.status, 201, signup.text);
  const cookie = signup.headers['set-cookie'].split(';')[0];

  const first = await call(environment, 'POST', '/api/me/addresses', {
    label: '첫째', recipient_name: '주소회원', phone: '010-1111-2222', addr: '서울시 1', is_default: true,
  }, { ...CSRF, Cookie: cookie });
  const second = await call(environment, 'POST', '/api/me/addresses', {
    label: '둘째', recipient_name: '주소회원', phone: '010-2222-3333', addr: '서울시 2',
  }, { ...CSRF, Cookie: cookie });
  assert.equal(first.status, 201, first.text);
  assert.equal(second.status, 201, second.text);

  const del = await call(environment, 'DELETE', `/api/me/addresses/${first.json.address.id}`, undefined, { ...CSRF, Cookie: cookie });
  assert.equal(del.status, 200, del.text);

  const rows = environment.DB.prepare('SELECT label, is_default FROM member_addresses ORDER BY id').all().results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, '둘째');
  assert.equal(rows[0].is_default, 1, 'the remaining address becomes default through the rowid subquery');
});

test('Google login fails closed without AUTH_SESSION_SECRET', async () => {
  const environment = env({ AUTH_SESSION_SECRET: '', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
  const start = await call(environment, 'GET', '/api/auth/google/start');
  assert.equal(start.status, 503);
  assert.equal(start.json.error, 'google oauth not configured');
});
