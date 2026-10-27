import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSandboxProbe } from '../../tools/nicepay-sandbox-probe.mjs';
import { querySignature, transactionSignature } from '../../lib/pg-nicepay.mjs';

const CLIENT = 'nicepay-fixture-client-not-real-a';
const SECRET = 'nicepay-fixture-secret-not-real';
const KEYS = {
  NICEPAY_TEST_CLIENT_KEY: CLIENT,
  NICEPAY_TEST_SECRET_KEY: SECRET,
  NICEPAY_OPERATING_CLIENT_KEY: 'nicepay-fixture-opclient-not-real',
  NICEPAY_OPERATING_SECRET_KEY: 'nicepay-fixture-opsecret-not-real',
};

function fakeFetch({ status = 400, body = { resultCode: '3011', message: '조회된 거래가 없습니다' }, json = true, throwAs = null } = {}) {
  const seen = [];
  return {
    seen,
    fn: async (url, init) => {
      seen.push({ url, init });
      if (throwAs) throw throwAs;
      return {
        status,
        async json() { if (!json) throw new Error('not json'); return body; },
        async text() { return JSON.stringify(body); },
      };
    },
  };
}

const base = { envVars: KEYS, orderId: 'CGI-SANDBOX-PROBE-TEST' };

test('the probe is exactly one GET and never a state-changing call', async () => {
  const f = fakeFetch();
  const out = await runSandboxProbe({ ...base, fetchFn: f.fn });
  assert.equal(f.seen.length, 1);
  assert.equal(out.calls, 1);
  assert.equal(f.seen[0].init.method, 'GET');
  assert.match(f.seen[0].url, /^https:\/\/sandbox-api\.nicepay\.co\.kr\/v1\/payments\/find\//);
  assert.equal(out.mode, 'sandbox');
});

test('the probe authenticates with Basic and keeps the secret out of the URL', async () => {
  const f = fakeFetch();
  await runSandboxProbe({ ...base, fetchFn: f.fn });
  const header = f.seen[0].init.headers.Authorization;
  assert.match(header, /^Basic /);
  assert.equal(Buffer.from(header.slice(6), 'base64').toString('utf8'), `${CLIENT}:${SECRET}`);
  assert.doesNotMatch(f.seen[0].url, new RegExp(SECRET));
  assert.doesNotMatch(f.seen[0].url, new RegExp(CLIENT));
  assert.equal(f.seen[0].init.headers['Content-Type'], 'application/json;charset=utf-8');
  assert.equal(f.seen[0].init.cache, 'no-store');
});

test('the probe signs the lookup with the 조회 rule, not the 승인 rule', async () => {
  const f = fakeFetch();
  await runSandboxProbe({ ...base, fetchFn: f.fn });
  const url = new URL(f.seen[0].url);
  const signData = url.searchParams.get('signData') || '';
  const ediDate = url.searchParams.get('ediDate');
  assert.match(signData, /^[0-9a-f]{64}$/);
  // oracle: the lib's own 조회 rule, and provably not the 승인 rule
  assert.equal(signData, querySignature({ tid: 'CGI-SANDBOX-PROBE-TEST', ediDate, secretKey: SECRET }));
  assert.notEqual(signData, transactionSignature({ tid: 'CGI-SANDBOX-PROBE-TEST', amount: 0, ediDate, secretKey: SECRET }));
  assert.match(ediDate || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.match(url.searchParams.get('orderDate') || '', /^\d{8}$/);
});

test('a rejected credential is reported as AUTH_REJECTED', async () => {
  const out = await runSandboxProbe({ ...base, fetchFn: fakeFetch({ status: 401, body: { resultCode: '3001' } }).fn });
  assert.equal(out.verdict, 'AUTH_REJECTED');
  assert.equal(out.httpStatus, 401);
  assert.equal(out.resultCode, '3001');
});

test('a non-found lookup still proves the credentials work', async () => {
  const out = await runSandboxProbe({ ...base, fetchFn: fakeFetch({ status: 400 }).fn });
  assert.equal(out.verdict, 'AUTH_OK_NO_SUCH_TRANSACTION');
  assert.equal(out.resultCode, '3011');
});

test('a real transaction is reported by field shape only', async () => {
  const out = await runSandboxProbe({
    ...base,
    fetchFn: fakeFetch({ status: 200, body: { resultCode: '0000', tid: 'UT0000113m0101', amount: 198000, status: 'paid' } }).fn,
  });
  assert.equal(out.verdict, 'AUTH_OK_TRANSACTION_RETURNED');
  assert.deepEqual(out.fields.sort(), ['amount:number', 'resultCode:string', 'status:string', 'tid:string']);
  assert.doesNotMatch(JSON.stringify(out), /UT0000113m0101|198000/);
});

test('a body that is not JSON is reported as a shape fact, not a dump', async () => {
  const out = await runSandboxProbe({ ...base, fetchFn: fakeFetch({ status: 500, json: false }).fn });
  assert.equal(out.responseHadBody, false);
  assert.deepEqual(out.fields, []);
  assert.equal(out.verdict, 'AUTH_OK_NO_SUCH_TRANSACTION');
});

test('transport failure is its own verdict with zero recorded calls', async () => {
  const err = new Error('getaddrinfo ENOTFOUND');
  err.name = 'TypeError';
  const out = await runSandboxProbe({ ...base, fetchFn: fakeFetch({ throwAs: err }).fn });
  assert.equal(out.verdict, 'NETWORK_UNAVAILABLE');
  assert.equal(out.errorClass, 'TypeError');
});

test('no keys means no call at all', async () => {
  const f = fakeFetch();
  const out = await runSandboxProbe({ envVars: {}, fetchFn: f.fn, orderId: 'X' });
  assert.equal(out.verdict, 'CONFIG_REFUSED');
  assert.equal(out.reason, 'keys_missing');
  assert.deepEqual(out.missing, ['NICEPAY_TEST_CLIENT_KEY', 'NICEPAY_TEST_SECRET_KEY']);
  assert.equal(f.seen.length, 0);
  assert.equal(out.calls, 0);
});

test('the operating store is refused unless the operator asks for it explicitly', async () => {
  const blocked = fakeFetch();
  const denied = await runSandboxProbe({
    envVars: KEYS, argv: ['--environment', 'operating'], fetchFn: blocked.fn, orderId: 'X',
  });
  assert.equal(denied.verdict, 'OPERATING_BLOCKED');
  assert.equal(blocked.seen.length, 0);

  const allowed = fakeFetch();
  const out = await runSandboxProbe({
    envVars: KEYS, argv: ['--environment', 'operating', '--allow-operating'], fetchFn: allowed.fn, orderId: 'X',
  });
  assert.equal(out.mode, 'production');
  assert.match(allowed.seen[0].url, /^https:\/\/api\.pay\.nicepay\.co\.kr\/v1\/payments\/find\/X\?/);
});

test('nothing the probe returns can carry a credential', async () => {
  const out = await runSandboxProbe({ ...base, fetchFn: fakeFetch({ status: 200 }).fn });
  const dump = JSON.stringify(out);
  for (const secret of Object.values(KEYS)) {
    assert.doesNotMatch(dump, new RegExp(secret.slice(0, 16)));
  }
  assert.equal(out.credentialEchoed, false);
});
