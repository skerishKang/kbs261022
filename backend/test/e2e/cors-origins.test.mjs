import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../../worker.js';
import { makeEnv, ORIGIN } from '../helpers.mjs';

const PROD_ORIGIN = 'https://skerishkang.github.io';
const SECOND = 'https://sandbox.example.dev';
const LOCAL = 'http://localhost:8901';

async function ask(env, path, { method = 'GET', origin = SECOND, headers = {} } = {}) {
  const init = { method, headers: { Origin: origin, Accept: 'application/json', ...headers } };
  if (method === 'OPTIONS') {
    init.headers['Access-Control-Request-Method'] = 'POST';
    init.headers['Access-Control-Request-Headers'] = 'content-type';
  }
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, init), env);
  const h = {};
  response.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return { status: response.status, headers: h, text: await response.text() };
}

const multiEnv = (over = {}) => makeEnv({ CORS_ALLOWED_ORIGINS: `${SECOND},${LOCAL}`, ...over });

test('an allow-listed second origin gets its own origin reflected', async () => {
  const res = await ask(multiEnv(), '/api/orders');
  assert.equal(res.headers['access-control-allow-origin'], SECOND);
  assert.match(res.headers.vary || '', /\bOrigin\b/i, 'Vary must say Origin or caches poison the header');
});

test('the preflight for an allow-listed origin answers for that origin', async () => {
  const res = await ask(multiEnv(), '/api/orders', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], SECOND);
  assert.match(res.headers['access-control-allow-methods'] || '', /POST/);
});

test('localhost is admitted by the dev switch, not by the deployment being non-strict in general', async () => {
  // AUTH_ORIGIN_STRICT=NO is what lets a localhost origin through without naming it
  const dev = await ask(multiEnv({ CORS_ALLOWED_ORIGINS: SECOND, AUTH_ORIGIN_STRICT: 'NO' }), '/api/orders', { origin: LOCAL });
  assert.equal(dev.headers['access-control-allow-origin'], LOCAL);

  // with strict on and localhost NOT listed, it must not be reflected
  const strict = await ask(multiEnv({ CORS_ALLOWED_ORIGINS: SECOND, AUTH_ORIGIN_STRICT: 'YES' }), '/api/orders', { origin: LOCAL });
  assert.equal(strict.headers['access-control-allow-origin'], PROD_ORIGIN);

  // naming it explicitly is a deployment decision, so it holds even under strict
  const named = await ask(multiEnv({ AUTH_ORIGIN_STRICT: 'YES' }), '/api/orders', { origin: LOCAL });
  assert.equal(named.headers['access-control-allow-origin'], LOCAL);
});

test('an origin outside the list never gets reflected', async () => {
  const evil = await ask(multiEnv(), '/api/orders', { origin: 'https://evil.example.com' });
  assert.equal(evil.headers['access-control-allow-origin'], PROD_ORIGIN);
  assert.equal(evil.text.includes('evil.example.com'), false);
});

test('a deployment without an allow list behaves exactly as before', async () => {
  const plain = makeEnv();
  const res = await ask(plain, '/api/orders', { origin: SECOND });
  assert.equal(res.headers['access-control-allow-origin'], PROD_ORIGIN);
});

test('the production origin is untouched by the reflection path', async () => {
  const res = await ask(multiEnv(), '/api/orders', { origin: PROD_ORIGIN });
  assert.equal(res.headers['access-control-allow-origin'], PROD_ORIGIN);
  const varies = (res.headers.vary || '').split(',').map((s) => s.trim()).filter((s) => /^origin$/i.test(s));
  assert.equal(varies.length, 1, 'Vary must not accumulate duplicates');
});

test('cookie responses from a reflected origin still advertise credentials', async () => {
  const res = await ask(multiEnv(), '/api/orders', { origin: SECOND, headers: { Cookie: 'cgi_session=invalid' } });
  assert.equal(res.headers['access-control-allow-origin'], SECOND);
  assert.equal(res.headers['access-control-allow-credentials'], 'true',
    'a reflected origin that carries the session cookie must still be readable by the browser');
});

test('the NICEPAY routes are reachable from the allow-listed origin', async () => {
  const env = multiEnv({ PG_PROVIDER: 'nicepay', PG_PROVIDER_MODE: 'mock' });
  const res = await ask(env, '/api/payments/config', { origin: LOCAL });
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], LOCAL);
  assert.equal(JSON.parse(res.text).provider, 'nicepay');
});
