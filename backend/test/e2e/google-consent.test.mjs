// Google 가입 동의(PR-3): Google 최초 로그인은 동의 화면을 거치기 전까지
// 회원을 만들지 않고 세션도 발급하지 않는다. 동의 후 0011 칸이 기록된다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mock } from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const TEST_SECRET = 'test-oauth-secret';

function makeEnv(overrides = {}) {
  return {
    DB: openD1(),
    ADMIN_TOKEN: 'example-admin-token',
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
    CORS_ALLOWED_ORIGINS: ORIGIN,
    SITE_BASE_URL: 'https://cgishop.pages.dev/site',
    ...overrides,
  };
}

const csrf = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN };

function mockGoogleOAuth({ subject = 'google-subject-1', email = 'newgoogle@example.com', name = 'Google User' } = {}) {
  const originalFetch = globalThis.fetch;
  const mockFetch = mock.method(globalThis, 'fetch', async (url) => {
    const urlStr = String(url);
    if (urlStr === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlStr === 'https://www.googleapis.com/oauth2/v2/userinfo') {
      return new Response(JSON.stringify({
        id: subject, email, verified_email: true, name, picture: 'https://lh3.googleusercontent.com/photo.jpg',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url);
  });
  return () => { mockFetch.mock.restore(); globalThis.fetch = originalFetch; };
}

function cookieValue(response, name) {
  const out = [];
  response.headers.forEach((value, key) => { if (key.toLowerCase() === 'set-cookie') out.push(value); });
  const found = out.find((line) => line.startsWith(name + '='));
  return found ? found.split(';')[0] : null;
}

async function startAndCallback(env) {
  const start = await worker.fetch(
    new Request('http://cgi.local/api/auth/google/start', { method: 'GET', headers: { Origin: ORIGIN } }),
    env,
  );
  const stateCookie = cookieValue(start, 'cgi_oauth_state');
  const state = stateCookie.split('=')[1];
  const callback = await worker.fetch(
    new Request(`http://cgi.local/api/auth/google/callback?code=mock&state=${encodeURIComponent(state)}`, {
      method: 'GET', headers: { Origin: ORIGIN, Cookie: stateCookie },
    }),
    env,
  );
  return { callback, state, stateCookie };
}

async function call(env, method, path, body, headers = {}) {
  const init = { method, headers: { Origin: ORIGIN, ...headers } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, init), env);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  const out = {};
  response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return { status: response.status, json, text, headers: out };
}

test('a new Google account is not created before consent', async () => {
  const env = makeEnv();
  const restore = mockGoogleOAuth();
  try {
    const { callback } = await startAndCallback(env);
    assert.equal(callback.status, 302);
    const location = callback.headers.get('location');
    assert.match(location, /#\/auth\/google-consent\?token=/);
    assert.ok(!cookieValue(callback, 'cgi_member'), 'no session before consent');
    const count = env.DB.prepare('SELECT COUNT(*) AS n FROM members').first();
    assert.equal(Number(count.n), 0, 'no member row before consent');

    const token = new URL(location).hash.split('token=')[1];
    assert.ok(token && token.length >= 32);

    const noConsent = await call(env, 'POST', '/api/auth/google/consent', { token }, csrf);
    assert.equal(noConsent.status, 400);
    assert.equal(noConsent.json.error, 'consent required');
    assert.equal(Number(env.DB.prepare('SELECT COUNT(*) AS n FROM members').first().n), 0);

    const accepted = await call(env, 'POST', '/api/auth/google/consent', {
      token, terms: true, privacy: true,
      terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
    }, csrf);
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.json.created, true);
    const member = env.DB.prepare('SELECT * FROM members').first();
    assert.equal(member.email, 'newgoogle@example.com');
    assert.equal(member.google_id, 'google-subject-1');
    assert.ok(member.email_verified_at);
    assert.equal(member.terms_consent_version, 'draft-2026-10-28');
    assert.equal(member.privacy_consent_version, 'draft-2026-10-28');
    assert.ok(member.consented_at);

    const session = accepted.headers['set-cookie'];
    assert.match(session, /cgi_member=/);
    const me = await call(env, 'GET', '/api/me', undefined, { ...csrf, Cookie: session.split(';')[0] });
    assert.equal(me.status, 200);
    assert.equal(me.json.member.email, 'newgoogle@example.com');
  } finally {
    restore();
  }
});

test('an existing Google member without consent is asked once, then linked', async () => {
  const env = makeEnv();
  // Legacy Google-created member: verified email, google_id set, consent NULL.
  env.DB.prepare(
    `INSERT INTO members (email, password_hash, name, google_id, status, email_verified_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(
    'legacy@example.com', 'revoked$google-signup$0$0', 'Legacy', 'legacy-subject',
    'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  ).run();
  const legacyId = env.DB.prepare('SELECT id FROM members WHERE email = ?').bind('legacy@example.com').first().id;

  const restore = mockGoogleOAuth({ subject: 'legacy-subject', email: 'legacy@example.com', name: 'Legacy' });
  try {
    const { callback } = await startAndCallback(env);
    assert.equal(callback.status, 302);
    const location = callback.headers.get('location');
    assert.match(location, /#\/auth\/google-consent\?token=/);
    assert.ok(!cookieValue(callback, 'cgi_member'));
    assert.equal(Number(env.DB.prepare('SELECT COUNT(*) AS n FROM members').first().n), 1, 'no duplicate member');

    const token = new URL(location).hash.split('token=')[1];
    const accepted = await call(env, 'POST', '/api/auth/google/consent', {
      token, terms: true, privacy: true,
      terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
    }, csrf);
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.json.created, false);
    assert.equal(Number(accepted.json.member.id), Number(legacyId));
    const member = env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(legacyId).first();
    assert.equal(member.terms_consent_version, 'draft-2026-10-28');
    assert.equal(member.privacy_consent_version, 'draft-2026-10-28');
    assert.ok(member.consented_at);
    assert.match(accepted.headers['set-cookie'], /cgi_member=/);
  } finally {
    restore();
  }
});

test('a consented Google member signs in directly on later logins', async () => {
  const env = makeEnv();
  env.DB.prepare(
    `INSERT INTO members (email, password_hash, name, google_id, status, email_verified_at,
       terms_consent_version, privacy_consent_version, consented_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    'done@example.com', 'revoked$google-signup$0$0', 'Done', 'done-subject',
    'active', '2026-01-01T00:00:00.000Z', 'v1', 'v1', '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  ).run();

  const restore = mockGoogleOAuth({ subject: 'done-subject', email: 'done@example.com', name: 'Done' });
  try {
    const { callback } = await startAndCallback(env);
    assert.equal(callback.status, 302);
    assert.doesNotMatch(callback.headers.get('location'), /google-consent/);
    assert.match(cookieValue(callback, 'cgi_member') || '', /cgi_member=/);
    assert.equal(Number(env.DB.prepare('SELECT COUNT(*) AS n FROM members').first().n), 1);
  } finally {
    restore();
  }
});
