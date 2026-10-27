import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOAuthState,
  verifyOAuthState,
  decodeOAuthState,
  normalizeOAuthReturn,
  resolveOAuthRedirect,
  buildAuthorizationUrl,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  oauthStateCookieOptions,
} from '../../lib/google-oauth.mjs';

const SECRET = 'test-secret-key-2026';

test('createOAuthState produces a signed token with two parts', async () => {
  const state = await createOAuthState(SECRET);
  assert.equal(typeof state, 'string');
  const parts = state.split('.');
  assert.equal(parts.length, 2);
  assert.equal(parts[1].length, 64); // 32 bytes hex = 64 chars
});

test('createOAuthState produces unique tokens', async () => {
  const s1 = await createOAuthState(SECRET);
  const s2 = await createOAuthState(SECRET);
  assert.notEqual(s1, s2);
});

test('verifyOAuthState accepts a valid state', async () => {
  const state = await createOAuthState(SECRET);
  const ok = await verifyOAuthState(SECRET, state);
  assert.equal(ok, true);
});

test('verifyOAuthState rejects a tampered state', async () => {
  const state = await createOAuthState(SECRET);
  const parts = state.split('.');
  parts[0] = parts[0].slice(0, -2) + 'XX';
  const tampered = parts.join('.');
  const ok = await verifyOAuthState(SECRET, tampered);
  assert.equal(ok, false);
});

test('verifyOAuthState rejects a state signed with a different secret', async () => {
  const state = await createOAuthState('secret-a');
  const ok = await verifyOAuthState('secret-b', state);
  assert.equal(ok, false);
});

test('verifyOAuthState rejects an expired state', async () => {
  const past = Date.now() - (OAUTH_STATE_TTL_SECONDS + 5) * 1000;
  const state = await createOAuthState(SECRET, past);
  const ok = await verifyOAuthState(SECRET, state);
  assert.equal(ok, false);
});

test('verifyOAuthState rejects a state from the future beyond clock skew', async () => {
  const future = Date.now() + 120000; // 2 minutes in the future
  const state = await createOAuthState(SECRET, future);
  const ok = await verifyOAuthState(SECRET, state);
  assert.equal(ok, false);
});

test('verifyOAuthState allows a state within 1-minute clock skew', async () => {
  const future = Date.now() + 30000; // 30 seconds in the future
  const state = await createOAuthState(SECRET, future);
  const ok = await verifyOAuthState(SECRET, state);
  assert.equal(ok, true);
});

test('verifyOAuthState rejects an empty string', async () => {
  const ok = await verifyOAuthState(SECRET, '');
  assert.equal(ok, false);
});

test('verifyOAuthState rejects a malformed state (no dot)', async () => {
  const ok = await verifyOAuthState(SECRET, 'nodot');
  assert.equal(ok, false);
});

test('verifyOAuthState rejects a malformed state (three parts)', async () => {
  const ok = await verifyOAuthState(SECRET, 'a.b.c');
  assert.equal(ok, false);
});

test('verifyOAuthState rejects invalid base64 payload', async () => {
  // Construct a state with invalid base64 but a valid-looking signature
  const fakeEncoded = 'INVALID_BASE64!!';
  const state = fakeEncoded + '.0000000000000000000000000000000000000000000000000000000000000000';
  const ok = await verifyOAuthState(SECRET, state);
  assert.equal(ok, false);
});

test('buildAuthorizationUrl produces a valid Google OAuth URL', () => {
  const url = buildAuthorizationUrl({
    clientId: 'test-client-id.apps.googleusercontent.com',
    redirectUri: 'https://example.com/callback',
  }, 'test-state');
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
  assert.ok(url.includes('client_id=test-client-id.apps.googleusercontent.com'));
  assert.ok(url.includes('redirect_uri=https%3A%2F%2Fexample.com%2Fcallback'));
  assert.ok(url.includes('response_type=code'));
  assert.ok(url.includes('state=test-state'));
  assert.ok(url.includes('scope=openid+email+profile'));
});

test('buildAuthorizationUrl returns null when clientId is missing', () => {
  const url = buildAuthorizationUrl({
    clientId: '',
    redirectUri: 'https://example.com/callback',
  }, 'test-state');
  assert.equal(url, null);
});

test('oauthStateCookieOptions returns secure cookie options', () => {
  const opts = oauthStateCookieOptions();
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.secure, true);
  assert.equal(opts.sameSite, 'Lax');
  assert.equal(opts.path, '/');
  assert.equal(opts.maxAge, OAUTH_STATE_TTL_SECONDS);
});

test('OAUTH_STATE_COOKIE is a string constant', () => {
  assert.equal(typeof OAUTH_STATE_COOKIE, 'string');
  assert.ok(OAUTH_STATE_COOKIE.length > 0);
});

test('OAUTH_STATE_TTL_SECONDS is 10 minutes', () => {
  assert.equal(OAUTH_STATE_TTL_SECONDS, 600);
});

test('createOAuthState defaults the return target to the site login page', async () => {
  const state = await createOAuthState(SECRET);
  const payload = await decodeOAuthState(SECRET, state);
  assert.equal(payload.u, 'site');
});

test('createOAuthState signs the return target into the payload', async () => {
  const state = await createOAuthState(SECRET, Date.now(), 'staff');
  const payload = await decodeOAuthState(SECRET, state);
  assert.equal(payload.u, 'staff');
});

test('decodeOAuthState normalises an unknown target before signing', async () => {
  const state = await createOAuthState(SECRET, Date.now(), '../../evil');
  const payload = await decodeOAuthState(SECRET, state);
  assert.equal(payload.u, 'site');
});

test('decodeOAuthState rejects tampered, foreign-signed and expired states', async () => {
  const state = await createOAuthState(SECRET, Date.now(), 'orders');
  const parts = state.split('.');
  parts[0] = parts[0].slice(0, -2) + 'XX';
  assert.equal(await decodeOAuthState(SECRET, parts.join('.')), null);
  assert.equal(await decodeOAuthState('other-secret', state), null);
  assert.equal(await decodeOAuthState(SECRET, await createOAuthState(SECRET, Date.now() - 700000, 'orders')), null);
  assert.equal(await decodeOAuthState(SECRET, ''), null);
});

test('normalizeOAuthReturn only accepts the allowlist', () => {
  assert.equal(normalizeOAuthReturn('staff'), 'staff');
  assert.equal(normalizeOAuthReturn('orders'), 'orders');
  assert.equal(normalizeOAuthReturn('site'), 'site');
  for (const bad of ['', undefined, null, 'STAFF', 'staff.html', '../staff', 'https://x/staff', 'orders;rm']) {
    assert.equal(normalizeOAuthReturn(bad), 'site', String(bad));
  }
});

test('resolveOAuthRedirect rebuilds the location from the base directory plus an allowlisted page', () => {
  const base = 'https://skerishkang.github.io/kbs261022/site/#/login';
  assert.equal(resolveOAuthRedirect(base, 'site'), 'https://skerishkang.github.io/kbs261022/site/#/login');
  assert.equal(resolveOAuthRedirect(base, 'staff'), 'https://skerishkang.github.io/kbs261022/site/staff.html');
  assert.equal(resolveOAuthRedirect(base, 'orders'), 'https://skerishkang.github.io/kbs261022/site/orders.html');
  assert.equal(resolveOAuthRedirect(base, 'evil'), 'https://skerishkang.github.io/kbs261022/site/#/login');
});

test('resolveOAuthRedirect honours a custom site base and never leaks the target string', () => {
  const base = 'https://custom.example.com/app/';
  assert.equal(resolveOAuthRedirect(base, 'staff'), 'https://custom.example.com/app/staff.html');
  assert.equal(resolveOAuthRedirect(base, 'orders'), 'https://custom.example.com/app/orders.html');
  assert.equal(resolveOAuthRedirect(base, '../../../../etc/passwd'), 'https://custom.example.com/app/#/login');
});

test('resolveOAuthRedirect falls back to the production default for a broken base', () => {
  assert.equal(resolveOAuthRedirect('not a url', 'staff'), 'https://skerishkang.github.io/kbs261022/site/staff.html');
  assert.equal(resolveOAuthRedirect('', 'orders'), 'https://skerishkang.github.io/kbs261022/site/orders.html');
});
