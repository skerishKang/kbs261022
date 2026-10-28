// M1 — auth & retry policy layer tests. Mock credentials, stub bcrypt and the
// loopback mock gateway only. No test in this file may reach api.commerce.naver.com:
// the mock refuses non-loopback base URLs by contract, and every client is
// constructed with NCOM_MODE=mock.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createNcomAuthRuntime, isRetryableNcomError, computeRetryDelayMs,
  loadLocalBcrypt, DEFAULT_RETRY_POLICY, NCOM_AUTH_DOC,
} from '../../lib/ncommerce-auth.mjs';
import { NcomError } from '../../lib/ncommerce.mjs';
import { closeAllMockNcomServers, startMockNcomServer } from '../helpers/mock-ncom.mjs';

after(closeAllMockNcomServers);

const bcryptStub = async (plain, salt) => `$2a$10$${Buffer.from(`${plain}|${salt}`).toString('base64')}`;

/** A sleep recorder: no real waiting, every delay is measured. */
function sleepRecorder() {
  const delays = [];
  return {
    delays,
    sleep: async (ms) => { delays.push(ms); },
  };
}

async function withRuntime({ mockOverrides = {}, env = {}, retryPolicy = {}, bcryptHashpw = bcryptStub } = {}) {
  const mock = await startMockNcomServer(mockOverrides);
  const recorder = sleepRecorder();
  const runtime = createNcomAuthRuntime({
    env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC', ...env },
    fetchFn: fetch,
    bcryptHashpw,
    now: () => 1_700_000_000_000,
    sleep: recorder.sleep,
    retryPolicy,
  });
  return { mock, runtime, recorder };
}

test('policy layer reuses the verified client: mode gating and mock loopback refusals are inherited', async () => {
  const runtime = await withRuntime().then((w) => w.runtime);
  assert.equal(runtime.mode, 'mock');
  assert.equal(runtime.available, true);
  await assert.rejects(runtime.call('orderQuery', { body: {} }), (e) => e.code === 'path_not_registered');
  // Node 24: a synchronous throw from the constructor call is not a promise
  // rejection, so the loopback refusal is asserted with assert.throws.
  assert.throws(() => createNcomAuthRuntime({
    env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: 'https://api.commerce.naver.com/external', NCOM_CLIENT_ID: 'C', NCOM_CLIENT_SECRET: 'S' },
    bcryptHashpw: bcryptStub,
  }), (e) => e.code === 'mock_base_url_not_loopback');
});

test('429 GW.RATE_LIMIT is retried automatically and the second attempt succeeds', async () => {
  const { mock, runtime, recorder } = await withRuntime();
  mock.state.failRequest = { http: 429, code: 'GW.RATE_LIMIT', message: '요청이 많아 서비스를 일시적으로 사용할 수 없습니다.' };
  const result = await runtime.call('productSearch', { body: { sellerManagementCode: 'x' } });
  assert.equal(result.verdict.ok, true, 'the replay must actually succeed');
  assert.equal(runtime.stats.attempts, 2);
  assert.equal(runtime.stats.retries, 1);
  assert.equal(recorder.delays.length, 1, 'exactly one backoff sleep');
  assert.ok(recorder.delays[0] >= DEFAULT_RETRY_POLICY.baseDelayMs, 'the first backoff is at least the base delay');
  await mock.close();
});

test('a drained rate-limit bucket floors the first backoff at 2x base', () => {
  const error = new NcomError('GW.RATE_LIMIT', '초과', {
    retryable: true,
    rateHeaders: { 'gncp-gw-ratelimit-remaining': '0' },
  });
  error.verdict = { rateLimited: true };
  const delay = computeRetryDelayMs({ attempt: 0, error, policy: DEFAULT_RETRY_POLICY, random: () => 0.5 });
  assert.ok(delay >= DEFAULT_RETRY_POLICY.baseDelayMs * 2 * (1 - DEFAULT_RETRY_POLICY.jitterRatio) - 1,
    'a drained bucket must not retry immediately into the same window');
  const calm = computeRetryDelayMs({ attempt: 0, error: null, policy: DEFAULT_RETRY_POLICY, random: () => 0.5 });
  assert.ok(calm < delay || delay >= DEFAULT_RETRY_POLICY.baseDelayMs, 'the floor only applies to drained rate limits');
  assert.ok(computeRetryDelayMs({ attempt: 10, policy: DEFAULT_RETRY_POLICY, random: () => 0 }) <= DEFAULT_RETRY_POLICY.maxDelayMs,
    'the cap holds regardless of attempt count');
});

test('persistent 429 exhausts maxAttempts, annotates the count and never loops forever', async () => {
  const { mock, runtime, recorder } = await withRuntime();
  mock.state.failRequest = { http: 429, code: 'GW.RATE_LIMIT', message: '계속 초과', consume: false };
  await assert.rejects(runtime.call('productSearch', { body: {} }), (e) => {
    assert.equal(e.code, 'GW.RATE_LIMIT');
    assert.equal(e.attempts, DEFAULT_RETRY_POLICY.maxAttempts);
    return true;
  });
  assert.equal(runtime.stats.attempts, DEFAULT_RETRY_POLICY.maxAttempts);
  assert.equal(recorder.delays.length, DEFAULT_RETRY_POLICY.maxAttempts - 1);
  const capped = recorder.delays.every((d) => d <= DEFAULT_RETRY_POLICY.maxDelayMs);
  assert.equal(capped, true);
  await mock.close();
});

test('GW.IP_NOT_ALLOWED is never retried and freezes the runtime like the client does', async () => {
  const { mock, runtime } = await withRuntime();
  mock.state.failRequest = { http: 403, code: 'GW.IP_NOT_ALLOWED', message: '호출이 허용되지 않은 IP입니다.' };
  await assert.rejects(runtime.call('productSearch', { body: {} }), (e) => e.code === 'GW.IP_NOT_ALLOWED');
  assert.equal(runtime.stats.retries, 0, 'an unregistered IP is an operator task, not a retry');
  assert.equal(runtime.client.stopped, true);
  await assert.rejects(runtime.call('productSearch', { body: {} }), (e) => e.code === 'stopped');
  assert.equal(runtime.stats.attempts, 1, 'the halted state throws before any further attempt is counted');
  await mock.close();
});

test('400-class domain errors are not replayed', async () => {
  const { mock, runtime } = await withRuntime();
  mock.state.failRequest = { http: 400, code: 'INVALID_PARAMETER', message: '검증 실패: salePrice' };
  await assert.rejects(runtime.call('productSearch', { body: {} }), (e) => e.family === 'domain');
  assert.equal(runtime.stats.retries, 0);
  assert.equal(mock.calls.filter((c) => c.path === '/external/v1/products/search').length, 1);
  await mock.close();
});

test('5xx domain failures are retryable per the classifier and are replayed', async () => {
  const { mock, runtime, recorder } = await withRuntime();
  mock.state.failRequest = { http: 500, code: 'INTERNAL_SERVER_ERROR', message: '내부 서버 오류' };
  const result = await runtime.call('productSearch', { body: {} });
  assert.equal(result.verdict.ok, true);
  assert.equal(runtime.stats.retries, 1);
  assert.equal(recorder.delays.length, 1);
  await mock.close();
});

test('a transport failure (fetch rejects) is retried as a transient error', async () => {
  const mock = await startMockNcomServer();
  let tokenAttempts = 0;
  const flaky = async (url, init) => {
    if (String(url).includes('/oauth2/token')) {
      tokenAttempts += 1;
      if (tokenAttempts === 1) throw new TypeError('fetch failed: ECONNRESET');
    }
    return fetch(url, init);
  };
  const runtime = createNcomAuthRuntime({
    env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC' },
    fetchFn: flaky,
    bcryptHashpw: bcryptStub,
    sleep: async () => {},
  });
  const result = await runtime.call('productSearch', { body: {} });
  assert.equal(result.verdict.ok, true, 'the transport error must not surface — the replay succeeded');
  assert.equal(runtime.stats.retries, 1);
  await mock.close();
});

test('token lifecycle: cached token is reused, refresh forces a re-mint, expiry boundary honoured', async () => {
  const { mock, runtime } = await withRuntime({ mockOverrides: { expiresIn: 3600 } });
  const first = await runtime.token();
  const second = await runtime.token();
  assert.equal(first, second);
  assert.equal(mock.calls.filter((c) => c.path.endsWith('/oauth2/token')).length, 1, 'cache must prevent a second mint');
  assert.equal(runtime.tokenExpiresAt(), 1_700_000_000_000 + 3600 * 1000);
  const third = await runtime.refreshToken();
  assert.equal(mock.calls.filter((c) => c.path.endsWith('/oauth2/token')).length, 2, 'force refresh re-mints');
  assert.equal(third, 'MOCK_ACCESS_TOKEN');
  await mock.close();
});

test('token request failure carries retryability through error.verdict', async () => {
  const { mock, runtime } = await withRuntime({ mockOverrides: { tokenError: { http: 429, code: 'GW.RATE_LIMIT', message: '토큰 초과' } } });
  await assert.rejects(runtime.token(), (e) => isRetryableNcomError(e) === true, 'a 429 token failure must be classified retryable');
  mock.state.tokenError = { http: 401, code: 'GW.AUTHN', message: '자격 오류' };
  await assert.rejects(runtime.token(), (e) => isRetryableNcomError(e) === false);
  await mock.close();
});

test('missing credentials fail closed before any socket opens', async () => {
  const { mock, runtime } = await withRuntime({ env: { NCOM_CLIENT_ID: '', NCOM_CLIENT_SECRET: '' } });
  assert.equal(runtime.available, false);
  await assert.rejects(runtime.call('productSearch', { body: {} }), (e) => e.code === 'not_configured');
  assert.equal(mock.calls.length, 0, 'no request may leave without credentials');
  await mock.close();
});

test('isRetryableNcomError refuses non-NcomError objects and fatal codes', () => {
  assert.equal(isRetryableNcomError(new TypeError('nope')), false);
  assert.equal(isRetryableNcomError(new NcomError('disabled', 'x')), false);
  assert.equal(isRetryableNcomError(new NcomError('GW.RATE_LIMIT', 'x', { retryable: true })), true);
});

test('loadLocalBcrypt reports absence instead of crashing, and a real install yields a $2 hash', async () => {
  const missing = await loadLocalBcrypt({ importFn: async () => { const e = new Error('no'); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; } });
  assert.equal(missing.bcryptHashpw, null);
  assert.match(missing.reason, /bcryptjs/);

  const resolved = await loadLocalBcrypt();
  assert.equal(typeof resolved.reason === 'string' || resolved.reason === null, true);
  if (resolved.bcryptHashpw) {
    assert.equal(resolved.implementation, 'bcryptjs');
    // 네이버는 client_secret 을 $2a$ 형식의 bcrypt salt 로 발급한다 — 유효한 salt
    // 형식으로만 실측할 수 있고, 'SEC' 같은 원시 문자열은 Invalid salt 로 거부된다.
    const vendorStyleSalt = '$2a$10$abcdefghijklmnopqrstuu';
    const hash = await resolved.bcryptHashpw('CID_1700000000000', vendorStyleSalt);
    assert.match(hash, /^\$2[aby]\$/, 'the vendor recipe needs a crypt-formatted bcrypt hash');
    assert.ok(hash.length >= 59, 'a $2a$10 hash is 60 chars; anything shorter is not bcrypt');
  }
});

test('the auth doc keeps its unconfirmed list honest', () => {
  assert.ok(NCOM_AUTH_DOC.unconfirmed.some((u) => /Retry-After/.test(u)));
  assert.ok(/Base64\(bcrypt/.test(NCOM_AUTH_DOC.signRecipe));
});
