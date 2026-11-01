// Cookie-authenticated staff API CSRF gate (security audit, 2026-11-01).
// Staff routes (/api/quotes, /api/orders admin, refund, ERP resend) accept a
// member session cookie; without the Origin + X-CSRF-Token gate a malicious
// page could drive those calls with a logged-in superadmin's browser state.
//
//   node --experimental-sqlite test/e2e/staff-csrf.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const ADMIN_TOKEN = 'example-admin-token';
const STAFF_LOGIN_PW = 'staff-login-fixture-2026';
const SUPERADMIN = 'skerish@naver.com';

function env() {
  return {
    DB: openD1(),
    ADMIN_TOKEN,
    PG_PROVIDER_MODE: 'mock',
    ERP_LIVE_WRITE: 'NO',
    ERP_MODE: 'test',
    SHIPPING_FEE_DEFAULT: '0',
    MAIL_MODE: 'echo',
    AUTH_PBKDF2_ITERATIONS: '1000',
    AUTH_RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
  };
}

async function call(environment, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
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

/** signup → email verify → login for a designated superadmin email; returns its cookie. */
async function superadminCookie(environment) {
  const csrf = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN, 'Content-Type': 'application/json' };
  const signup = await call(environment, 'POST', '/api/auth/signup', {
    email: SUPERADMIN, name: '스테프', password: STAFF_LOGIN_PW,
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(signup.status, 201, signup.text);
  const verify = await call(environment, 'POST', '/api/auth/verify-email', {
    member_id: signup.json.member.id, token: signup.json.mail.echo_token,
  }, csrf);
  assert.equal(verify.status, 200, verify.text);
  const login = await call(environment, 'POST', '/api/auth/login', { email: SUPERADMIN, password: STAFF_LOGIN_PW }, csrf);
  assert.equal(login.status, 200, login.text);
  return login.headers['set-cookie'];
}

test('cookie staff list requires Origin + X-CSRF-Token', async () => {
  const environment = env();
  const cookie = await superadminCookie(environment);

  const noOrigin = await call(environment, 'GET', '/api/quotes', null, { Cookie: cookie });
  assert.equal(noOrigin.status, 401, 'a cookie call without Origin must not pass');

  const originOnly = await call(environment, 'GET', '/api/quotes', null, { Cookie: cookie, Origin: ORIGIN });
  assert.equal(originOnly.status, 401, 'Origin alone is not a CSRF claim');

  const wrongToken = await call(environment, 'GET', '/api/quotes', null, {
    Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': 'http://evil.example.com',
  });
  assert.equal(wrongToken.status, 401, 'X-CSRF-Token must equal the Origin');

  const good = await call(environment, 'GET', '/api/quotes', null, {
    Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': ORIGIN,
  });
  assert.equal(good.status, 200, good.text);
  assert.ok(Array.isArray(good.json.items));
});

test('bearer admin path is unaffected by the cookie CSRF gate', async () => {
  const environment = env();
  const res = await call(environment, 'GET', '/api/quotes', null, {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
  });
  assert.equal(res.status, 200, res.text);
});

test('guest cookie cannot reach the staff list even with a CSRF header', async () => {
  const environment = env();
  const csrf = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN, 'Content-Type': 'application/json' };
  const signup = await call(environment, 'POST', '/api/auth/signup', {
    email: 'plain-member@example.com', name: '일반', password: STAFF_LOGIN_PW,
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, csrf);
  assert.equal(signup.status, 201, signup.text);
  await call(environment, 'POST', '/api/auth/verify-email', {
    member_id: signup.json.member.id, token: signup.json.mail.echo_token,
  }, csrf);
  const login = await call(environment, 'POST', '/api/auth/login', { email: 'plain-member@example.com', password: STAFF_LOGIN_PW }, csrf);
  assert.equal(login.status, 200, login.text);

  const res = await call(environment, 'GET', '/api/quotes', null, {
    Cookie: login.headers['set-cookie'], Origin: ORIGIN, 'X-CSRF-Token': ORIGIN,
  });
  assert.equal(res.status, 401, 'a verified plain member is not staff');
});
