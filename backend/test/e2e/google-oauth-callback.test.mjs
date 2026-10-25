// Google OAuth callback E2E (issue #79, #80): Set-Cookie split, state CSRF,
// session issuance, role-based access, logout, and email-login regression.
//
//   node --experimental-sqlite test/e2e/google-oauth-callback.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { mock } from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';
import { createOAuthState } from '../../lib/google-oauth.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const ADMIN_TEST_KEY = 'example-admin-token';
const TEST_PASSWORD = 'Test!2026-abc';
const TEST_SECRET = 'test-oauth-secret';

function makeEnv(overrides = {}) {
  return {
    DB: openD1(),
    ADMIN_TOKEN: ADMIN_TEST_KEY,
    PG_PROVIDER_MODE: 'mock',
    ERP_LIVE_WRITE: 'NO',
    ERP_MODE: 'test',
    SHIPPING_FEE_DEFAULT: '0',
    MAIL_MODE: 'echo',
    AUTH_PBKDF2_ITERATIONS: '1000',
    AUTH_RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    AUTH_SESSION_SECRET: TEST_SECRET,
    ...overrides,
  };
}

const csrf = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN };

/** Call the worker and return headers as a Record (lower-cased keys). */
async function call(env, method, path, body, headers = {}) {
  const init = { method, headers: { Origin: ORIGIN, ...headers } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, init), env);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const out = {};
  response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return { status: response.status, json, text, headers: out };
}

/**
 * Mock globalThis.fetch to intercept Google OAuth token-exchange and userinfo
 * calls. Returns a restore function.
 */
function mockGoogleOAuth({
  mockAccessToken = 'mock-access-token-123',
  subject = '1234567890',
  email = 'googleuser@example.com',
  name = 'Google User',
  verified = true,
} = {}) {
  const originalFetch = globalThis.fetch;
  const mockFetch = mock.method(
    globalThis,
    'fetch',
    async (url, init = {}) => {
      const urlStr = String(url);
      // Token exchange endpoint
      if (urlStr === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: mockAccessToken,
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Userinfo endpoint
      if (urlStr === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        if (init.headers?.Authorization === 'Bearer ' + mockAccessToken) {
          return new Response(JSON.stringify({
            id: subject,
            email,
            verified_email: verified,
            name,
            picture: 'https://lh3.googleusercontent.com/photo.jpg',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Unauthorized', { status: 401 });
      }
      return originalFetch(url, init);
    },
  );
  return () => { mockFetch.mock.restore(); globalThis.fetch = originalFetch; };
}

/** Extract all Set-Cookie header values from a response. */
function getSetCookies(response) {
  const cookies = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value);
  });
  return cookies;
}

// ---------------------------------------------------------------------------
// 1. Google callback sends 2 separate Set-Cookie headers
// ---------------------------------------------------------------------------

test('google callback issues session and state-clear cookies as separate Set-Cookie headers', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  // Step 1: start OAuth to get the state cookie
  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  assert.equal(startResp.status, 302);
  const startCookies = [];
  startResp.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') startCookies.push(v); });
  assert.equal(startCookies.length, 1, 'start sets exactly one cookie (the state cookie)');
  const stateCookieHeader = startCookies[0];
  assert.match(stateCookieHeader, /cgi_oauth_state=/);
  const stateValue = stateCookieHeader.match(/cgi_oauth_state=([^;]+)/)[1];

  // Step 2: call back with the state
  const restoreAfter = mockGoogleOAuth();
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302, `callback failed: ${await callbackResp.text()}`);

  const cookies = [];
  callbackResp.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookies.push(v); });
  assert.equal(cookies.length, 2, `expected 2 Set-Cookie headers, got ${cookies.length}: ${cookies.join(' | ')}`);

  // First cookie: session
  const sessionCookie = cookies[0];
  assert.match(sessionCookie, /cgi_member=/, 'first cookie is the session');
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /SameSite=None/i);
  assert.match(sessionCookie, /Secure/i);
  assert.match(sessionCookie, /Path=\//);
  assert.match(sessionCookie, /Max-Age=/);

  // Second cookie: state clearing
  const clearCookie = cookies[1];
  assert.match(clearCookie, /cgi_oauth_state=;/, 'second cookie clears the state');
  assert.match(clearCookie, /Max-Age=0/);

  // Redirect to SITE_BASE_URL
  const location = callbackResp.headers.get('location');
  assert.equal(location, 'https://skerishkang.github.io/kbs261022/site/#/login');

  restoreAfter();
  restore();
});

test('google callback uses SITE_BASE_URL env var for redirect', async () => {
  const env = makeEnv({ SITE_BASE_URL: 'https://custom.example.com/app/#/login' });
  const restore = mockGoogleOAuth();

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  const restoreAfter = mockGoogleOAuth();
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302);
  assert.equal(callbackResp.headers.get('location'), 'https://custom.example.com/app/#/login');

  restoreAfter();
  restore();
});

// ---------------------------------------------------------------------------
// 2. OAuth state cookie attributes
// ---------------------------------------------------------------------------

test('google start sets state cookie with correct attributes', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  const resp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  assert.equal(resp.status, 302);
  const cookie = resp.headers.get('set-cookie');
  assert.ok(cookie, 'state cookie is set');
  assert.match(cookie, /cgi_oauth_state=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=600/);

  // Redirect to Google auth URL
  const location = resp.headers.get('location');
  assert.ok(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
  assert.ok(location.includes('client_id=test-client-id.apps.googleusercontent.com'));

  restore();
});

test('google start returns 503 when OAuth is not configured', async () => {
  const env = makeEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
  const resp = await call(env, 'GET', '/api/auth/google/start');
  assert.equal(resp.status, 503);
  assert.equal(resp.json.error, 'google oauth not configured');
});

// ---------------------------------------------------------------------------
// 3. OAuth state CSRF protection
// ---------------------------------------------------------------------------

test('google callback rejects a missing state', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  const resp = await call(env, 'GET', '/api/auth/google/callback?code=mock-code');
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error, 'missing code or state');

  restore();
});

test('google callback rejects a state mismatch (CSRF)', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const realState = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  // Call back with a different state in the cookie
  const resp = await call(env, 'GET', `/api/auth/google/callback?code=mock-code&state=${realState}`, undefined, {
    Cookie: 'cgi_oauth_state=wrong-state-value',
  });
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error, 'invalid state');

  restore();
});

test('google callback rejects an expired state', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  // Create an expired state (11 minutes old)
  const past = Date.now() - (11 * 60 * 1000);
  const expiredState = await createOAuthState(TEST_SECRET, past);

  const resp = await call(env, 'GET', `/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(expiredState)}`, undefined, {
    Cookie: `cgi_oauth_state=${expiredState}`,
  });
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error, 'invalid state');

  restore();
});

test('google callback rejects a tampered state', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  const validState = await createOAuthState(TEST_SECRET);
  const parts = validState.split('.');
  parts[0] = parts[0].slice(0, -2) + 'XX';
  const tamperedState = parts.join('.');

  const resp = await call(env, 'GET', `/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(tamperedState)}`, undefined, {
    Cookie: `cgi_oauth_state=${tamperedState}`,
  });
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error, 'invalid state');

  restore();
});

test('google callback rejects an error parameter from Google', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  const resp = await call(env, 'GET', '/api/auth/google/callback?error=access_denied');
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error, 'google auth failed');
  assert.equal(resp.json.detail, 'access_denied');

  restore();
});

// ---------------------------------------------------------------------------
// 4. Session cookie cross-site policy
// ---------------------------------------------------------------------------

test('session cookie has SameSite=None; Secure for cross-origin github.io <-> workers.dev', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  const restoreAfter = mockGoogleOAuth({
    subject: 'superadmin-google-id',
    email: 'charliekant@gmail.com',
    name: 'Charlie Kang',
  });
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  const cookies = [];
  callbackResp.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookies.push(v); });

  const sessionCookie = cookies[0];
  assert.match(sessionCookie, /SameSite=None/i, 'SameSite=None for cross-origin');
  assert.match(sessionCookie, /Secure/i, 'Secure for HTTPS-only');
  assert.match(sessionCookie, /HttpOnly/i, 'HttpOnly to prevent JS access');

  restoreAfter();
  restore();
});

test('auth routes advertise Access-Control-Allow-Credentials: true', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  // Preflight for /api/auth/login
  const preflight = await call(env, 'OPTIONS', '/api/auth/login', undefined, {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true');

  // Preflight for /api/me
  const mePreflight = await call(env, 'OPTIONS', '/api/me', undefined, {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'GET',
  });
  assert.equal(mePreflight.status, 204);
  assert.equal(mePreflight.headers['access-control-allow-credentials'], 'true');

  // Google start (302 redirect) — CORS headers are not critical for top-level nav
  // but the response should still have the origin pinned
  restore();
});

// ---------------------------------------------------------------------------
// 5. Session member lookup and role-based access
// ---------------------------------------------------------------------------

test('google callback creates a new member with google_id', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth({
    subject: 'new-google-user-123',
    email: 'newgoogleuser@example.com',
    name: 'New Google User',
  });

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  const restoreAfter = mockGoogleOAuth({
    subject: 'new-google-user-123',
    email: 'newgoogleuser@example.com',
    name: 'New Google User',
  });
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302);

  // Verify the member was created with google_id
  const { results } = await env.DB.prepare('SELECT email, google_id, status, email_verified_at FROM members').all();
  assert.equal(results.length, 1);
  assert.equal(results[0].email, 'newgoogleuser@example.com');
  assert.equal(results[0].google_id, 'new-google-user-123');
  assert.equal(results[0].status, 'active');
  assert.ok(results[0].email_verified_at, 'Google users are auto-verified');

  // Verify the session cookie works
  const cookies = [];
  callbackResp.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookies.push(v); });
  const sessionCookie = cookies[0];

  const meResp = await call(env, 'GET', '/api/me', undefined, { ...csrf, Cookie: sessionCookie });
  assert.equal(meResp.status, 200);
  assert.equal(meResp.json.member.email, 'newgoogleuser@example.com');
  assert.equal(meResp.json.member.role, 'member');

  restoreAfter();
  restore();
});

test('google callback links to an existing member by email', async () => {
  const env = makeEnv();

  // Pre-create a member
  const csrfHeaders = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN, 'Content-Type': 'application/json' };
  const signupResp = await call(env, 'POST', '/api/auth/signup', {
    email: 'existing@example.com', name: 'Existing Member', password: TEST_PASSWORD,
  }, csrf);
  assert.equal(signupResp.status, 201);

  const restore = mockGoogleOAuth({
    subject: 'link-google-id-456',
    email: 'existing@example.com',
    name: 'Existing Member',
  });

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  const restoreAfter = mockGoogleOAuth({
    subject: 'link-google-id-456',
    email: 'existing@example.com',
    name: 'Existing Member',
  });
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302);

  // Verify the google_id was linked and Google verification was propagated
  const { results } = await env.DB.prepare('SELECT email, google_id, email_verified_at FROM members').all();
  assert.equal(results.length, 1);
  assert.equal(results[0].email, 'existing@example.com');
  assert.equal(results[0].google_id, 'link-google-id-456');
  assert.ok(results[0].email_verified_at, 'an existing member linked to Google becomes email-verified');

  // Verify member events were recorded
  const { results: events } = await env.DB.prepare("SELECT type FROM member_events WHERE type IN ('google_linked', 'email_verified') ORDER BY type").all();
  assert.deepEqual(events.map((row) => row.type), ['email_verified', 'google_linked']);

  restoreAfter();
  restore();
});

test('google callback verifies an existing google-linked superadmin member on login', async () => {
  const env = makeEnv();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO members (email, password_hash, name, google_id, status, role, email_verified_at, created_at, updated_at) VALUES (?, 'unusable-google-only-hash', ?, ?, 'active', 'member', NULL, ?, ?)"
  ).bind('charliekant@gmail.com', 'Charlie Kang', 'already-linked-google-id', now, now).run();

  const restore = mockGoogleOAuth({
    subject: 'already-linked-google-id',
    email: 'charliekant@gmail.com',
    name: 'Charlie Kang',
  });

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  const restoreAfter = mockGoogleOAuth({
    subject: 'already-linked-google-id',
    email: 'charliekant@gmail.com',
    name: 'Charlie Kang',
  });
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302);

  const member = await env.DB.prepare('SELECT email, google_id, email_verified_at, role FROM members WHERE email = ?')
    .bind('charliekant@gmail.com').first();
  assert.ok(member.email_verified_at, 'a google-linked member is marked verified on the next Google login');

  const cookies = [];
  callbackResp.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookies.push(v); });
  const meResp = await call(env, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookies[0] });
  assert.equal(meResp.status, 200);
  assert.equal(meResp.json.member.email_verified, true);
  assert.equal(meResp.json.member.role, 'superadmin');
  assert.equal(meResp.json.member.is_admin, true);

  restoreAfter();
  restore();
});

test('google callback creates a superadmin when email is in SUPERADMIN_EMAILS', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth({
    subject: 'superadmin-google-id',
    email: 'charliekant@gmail.com',
    name: 'Charlie Kang',
  });

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  const restoreAfter = mockGoogleOAuth({
    subject: 'superadmin-google-id',
    email: 'charliekant@gmail.com',
    name: 'Charlie Kang',
  });
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302);

  const cookies = [];
  callbackResp.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookies.push(v); });
  const sessionCookie = cookies[0];

  const meResp = await call(env, 'GET', '/api/me', undefined, { ...csrf, Cookie: sessionCookie });
  assert.equal(meResp.status, 200);
  assert.equal(meResp.json.member.role, 'superadmin');
  assert.equal(meResp.json.member.is_admin, true);

  restoreAfter();
  restore();
});

test('normal member cannot access admin API', async () => {
  const env = makeEnv();
  const csrfHeaders = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN, 'Content-Type': 'application/json' };
  const signupResp = await call(env, 'POST', '/api/auth/signup', {
    email: 'normal@example.com', name: 'Normal Member', password: TEST_PASSWORD,
  }, csrf);
  assert.equal(signupResp.status, 201);

  const loginResp = await call(env, 'POST', '/api/auth/login', {
    email: 'normal@example.com', password: TEST_PASSWORD,
  }, csrf);
  assert.equal(loginResp.status, 200);
  const cookie = loginResp.headers['set-cookie'];

  // Try to access admin endpoints
  const adminOrders = await call(env, 'GET', '/api/orders', undefined, { ...csrf, Cookie: cookie });
  assert.equal(adminOrders.status, 401);

  const adminQuotes = await call(env, 'GET', '/api/quotes', undefined, { ...csrf, Cookie: cookie });
  assert.equal(adminQuotes.status, 401);

  const adminSchema = await call(env, 'POST', '/api/admin/schema/init', {}, { ...csrf, Cookie: cookie });
  assert.equal(adminSchema.status, 401);
});

test('superadmin can access admin API', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth({
    subject: 'superadmin-google-id',
    email: 'skerish@naver.com',
    name: 'Skerish',
  });

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  const restoreAfter = mockGoogleOAuth({
    subject: 'superadmin-google-id',
    email: 'skerish@naver.com',
    name: 'Skerish',
  });
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302);

  const cookies = [];
  callbackResp.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookies.push(v); });
  const sessionCookie = cookies[0];

  // Superadmin can access /api/orders
  const adminOrders = await call(env, 'GET', '/api/orders', undefined, { ...csrf, Cookie: sessionCookie });
  assert.equal(adminOrders.status, 200);

  // Superadmin can access /api/quotes
  const adminQuotes = await call(env, 'GET', '/api/quotes', undefined, { ...csrf, Cookie: sessionCookie });
  assert.equal(adminQuotes.status, 200);

  // Superadmin can access /api/admin/schema/init
  const adminSchema = await call(env, 'POST', '/api/admin/schema/init', {}, { ...csrf, Cookie: sessionCookie });
  assert.equal(adminSchema.status, 200);

  restoreAfter();
  restore();
});

// ---------------------------------------------------------------------------
// 6. Logout session invalidation
// ---------------------------------------------------------------------------

test('google session can be logged out and invalidated', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  const restoreAfter = mockGoogleOAuth({
    subject: 'logout-google-id',
    email: 'logoutuser@example.com',
    name: 'Logout User',
  });
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302);

  const cookies = [];
  callbackResp.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookies.push(v); });
  const sessionCookie = cookies[0];

  // Verify session works
  const before = await call(env, 'GET', '/api/me', undefined, { ...csrf, Cookie: sessionCookie });
  assert.equal(before.status, 200);

  // Logout
  const out = await call(env, 'POST', '/api/auth/logout', {}, { ...csrf, Cookie: sessionCookie });
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie'], /cgi_member=;/);
  assert.match(out.headers['set-cookie'], /Max-Age=0/);

  // Session is now invalid
  const after = await call(env, 'GET', '/api/me', undefined, { ...csrf, Cookie: sessionCookie });
  assert.equal(after.status, 401);

  // Token is revoked in the DB
  const { results } = await env.DB.prepare("SELECT status FROM auth_tokens WHERE kind = 'session'").all();
  assert.ok(results.some((r) => r.status === 'revoked'));

  restoreAfter();
  restore();
});

// ---------------------------------------------------------------------------
// 7. Email login and Resend auth regression
// ---------------------------------------------------------------------------

test('email signup and login still works after Google OAuth changes', async () => {
  const env = makeEnv();
  const csrfHeaders = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN, 'Content-Type': 'application/json' };

  // Signup
  const signup = await call(env, 'POST', '/api/auth/signup', {
    email: 'emailuser@example.com', name: 'Email User', password: TEST_PASSWORD,
  }, csrf);
  assert.equal(signup.status, 201);
  assert.equal(signup.json.member.email, 'emailuser@example.com');

  // Verify email (echo mode returns the token)
  const verify = await call(env, 'POST', '/api/auth/verify-email', {
    member_id: signup.json.member.id, token: signup.json.mail.echo_token,
  }, csrf);
  assert.equal(verify.status, 200);
  assert.equal(verify.json.email_verified, true);

  // Login
  const login = await call(env, 'POST', '/api/auth/login', {
    email: 'emailuser@example.com', password: TEST_PASSWORD,
  }, csrf);
  assert.equal(login.status, 200);
  assert.equal(login.json.member.email, 'emailuser@example.com');
  assert.equal(login.json.member.email_verified, true);

  // Session works
  const cookie = login.headers['set-cookie'];
  const me = await call(env, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.member.email, 'emailuser@example.com');

  // Logout
  const out = await call(env, 'POST', '/api/auth/logout', {}, { ...csrf, Cookie: cookie });
  assert.equal(out.status, 200);

  const after = await call(env, 'GET', '/api/me', undefined, { ...csrf, Cookie: cookie });
  assert.equal(after.status, 401);
});

test('email verification is not required for Google OAuth users', async () => {
  const env = makeEnv({ EMAIL_VERIFY_REQUIRED: 'YES' });
  const restore = mockGoogleOAuth({
    subject: 'verified-google-id',
    email: 'verifiedgoogle@example.com',
    name: 'Verified Google',
  });

  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  const restoreAfter = mockGoogleOAuth({
    subject: 'verified-google-id',
    email: 'verifiedgoogle@example.com',
    name: 'Verified Google',
  });
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302, 'Google callback succeeds even with EMAIL_VERIFY_REQUIRED=YES');

  const cookies = [];
  callbackResp.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookies.push(v); });
  const sessionCookie = cookies[0];

  // Session works — Google users are auto-verified
  const me = await call(env, 'GET', '/api/me', undefined, { ...csrf, Cookie: sessionCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.member.email_verified, true);

  restoreAfter();
  restore();
});

// ---------------------------------------------------------------------------
// 8. Unauthenticated access rejection
// ---------------------------------------------------------------------------

test('unauthenticated /api/me returns 401', async () => {
  const env = makeEnv();
  const resp = await call(env, 'GET', '/api/me', undefined, csrf);
  assert.equal(resp.status, 401);
  assert.equal(resp.json.error, 'unauthorized');
  assert.equal(resp.json.detail, 'sign in first');
});

test('google callback returns 400 for invalid code exchange', async () => {
  const env = makeEnv();

  // Mock fetch to return an error for token exchange
  const originalFetch = globalThis.fetch;
  const mockFetch = mock.method(
    globalThis,
    'fetch',
    async (url, init = {}) => {
      const urlStr = String(url);
      if (urlStr === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url, init);
    },
  );

  const state = await createOAuthState(TEST_SECRET);
  const resp = await call(env, 'GET', `/api/auth/google/callback?code=bad-code&state=${encodeURIComponent(state)}`, undefined, {
    Cookie: `cgi_oauth_state=${state}`,
  });
  assert.equal(resp.status, 400);
  assert.equal(resp.json.error, 'google auth failed');

  mockFetch.mock.restore();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// 9. Google start bypasses CSRF (top-level navigation)
// ---------------------------------------------------------------------------

test('google start does not require CSRF token (top-level navigation)', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  // No CSRF token, no Origin — should still work for top-level navigation
  const resp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start'),
    env,
  );
  assert.equal(resp.status, 302);

  restore();
});

test('google callback does not require CSRF token (top-level navigation)', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();

  // Get a valid state
  const startResp = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start'),
    env,
  );
  const stateValue = startResp.headers.get('set-cookie').match(/cgi_oauth_state=([^;]+)/)[1];

  // Call back without CSRF
  const restoreAfter = mockGoogleOAuth();
  const callbackResp = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateValue)}`, {
      headers: { Cookie: `cgi_oauth_state=${stateValue}` },
    }),
    env,
  );
  assert.equal(callbackResp.status, 302);

  restoreAfter();
  restore();
});
