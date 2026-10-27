import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NICEPAY_ENV_VAR,
  NICEPAY_ENVIRONMENTS,
  NICEPAY_ENV_OPERATING,
  NICEPAY_ENV_TEST,
  NICEPAY_JS_SDK_SANDBOX,
  OPERATING_CAPABILITIES,
  SANDBOX_CAPABILITIES,
  redactNicepay,
  resolveNicepayEnv,
} from '../../lib/pg-nicepay-env.mjs';
import { NICEPAY_JS_SDK_PROD } from '../../lib/pg-nicepay.mjs';

const TEST_IDS = { NICEPAY_TEST_CLIENT_KEY: 'nicepay-fixture-test-client-a', NICEPAY_TEST_SECRET_KEY: 'nicepay-fixture-test-secret-a' };
const OPS_IDS = { NICEPAY_OPERATING_CLIENT_KEY: 'nicepay-fixture-ops-client-b', NICEPAY_OPERATING_SECRET_KEY: 'nicepay-fixture-ops-secret-b' };

const full = (extra = {}) => ({ ...TEST_IDS, ...OPS_IDS, ...extra });

test('default environment is the sandbox TEST store, never the operating store', () => {
  const cfg = resolveNicepayEnv(full());
  assert.equal(cfg.ok, true);
  assert.equal(cfg.environment, NICEPAY_ENV_TEST);
  assert.equal(cfg.mode, 'sandbox');
  assert.equal(cfg.apiBaseUrl, 'https://sandbox-api.nicepay.co.kr/v1');
  assert.equal(cfg.clientId, TEST_IDS.NICEPAY_TEST_CLIENT_KEY);
});

test('selecting the operating environment swaps host, SDK and credential set', () => {
  const cfg = resolveNicepayEnv(full({ [NICEPAY_ENV_VAR]: NICEPAY_ENV_OPERATING }));
  assert.equal(cfg.ok, true);
  assert.equal(cfg.environment, NICEPAY_ENV_OPERATING);
  assert.equal(cfg.mode, 'production');
  assert.equal(cfg.apiBaseUrl, 'https://api.pay.nicepay.co.kr/v1');
  assert.equal(cfg.jsSdkUrl, NICEPAY_JS_SDK_PROD);
  assert.equal(cfg.clientId, OPS_IDS.NICEPAY_OPERATING_CLIENT_KEY);
  assert.equal(cfg.secretKey, OPS_IDS.NICEPAY_OPERATING_SECRET_KEY);
});

test('one variable alone re-points the whole connection', () => {
  const base = full();
  const asTest = resolveNicepayEnv(base);
  const asOps = resolveNicepayEnv({ ...base, [NICEPAY_ENV_VAR]: NICEPAY_ENV_OPERATING });
  assert.notEqual(asTest.apiBaseUrl, asOps.apiBaseUrl);
  assert.notEqual(asTest.clientId, asOps.clientId);
  assert.notEqual(asTest.capabilities, asOps.capabilities);
});

test('an unknown environment name fails closed instead of defaulting', () => {
  // 'production' is the obvious alias and is still rejected: silently accepting
  // it would let a mistyped switch point a test deploy at real money.
  const cfg = resolveNicepayEnv(full({ [NICEPAY_ENV_VAR]: 'production' }));
  assert.equal(cfg.ok, false);
  assert.equal(cfg.reason, 'environment_unknown');
  assert.equal(cfg.environment, null);
  assert.equal(cfg.apiBaseUrl, undefined);
  assert.deepEqual(cfg.acceptedEnvironments, [NICEPAY_ENV_TEST, NICEPAY_ENV_OPERATING]);
});

test('environment names are matched after trim and case folding', () => {
  assert.equal(resolveNicepayEnv(full({ [NICEPAY_ENV_VAR]: ' Operating ' })).ok, true);
  assert.equal(resolveNicepayEnv(full({ [NICEPAY_ENV_VAR]: 'TEST' })).environment, NICEPAY_ENV_TEST);
});

test('test store without keys is unusable even though operating keys exist', () => {
  const cfg = resolveNicepayEnv({ ...OPS_IDS, [NICEPAY_ENV_VAR]: NICEPAY_ENV_TEST });
  assert.equal(cfg.ok, false);
  assert.equal(cfg.reason, 'keys_missing');
  assert.equal(cfg.environment, NICEPAY_ENV_TEST);
  assert.equal(cfg.apiBaseUrl, NICEPAY_ENVIRONMENTS[NICEPAY_ENV_TEST].apiBaseUrl);
  assert.equal(cfg.clientId, null);
  assert.equal(cfg.secretKey, null);
  assert.deepEqual(cfg.missing, ['NICEPAY_TEST_CLIENT_KEY', 'NICEPAY_TEST_SECRET_KEY']);
});

test('operating store without keys never falls back to the test store', () => {
  const cfg = resolveNicepayEnv({ ...TEST_IDS, [NICEPAY_ENV_VAR]: NICEPAY_ENV_OPERATING });
  assert.equal(cfg.ok, false);
  assert.equal(cfg.reason, 'keys_missing');
  assert.equal(cfg.mode, 'production');
  assert.deepEqual(cfg.missing, ['NICEPAY_OPERATING_CLIENT_KEY', 'NICEPAY_OPERATING_SECRET_KEY']);
  assert.notEqual(cfg.clientId, TEST_IDS.NICEPAY_TEST_CLIENT_KEY);
});

test('blank and whitespace-only credentials count as absent', () => {
  const cfg = resolveNicepayEnv({
    NICEPAY_TEST_CLIENT_KEY: '   ',
    NICEPAY_TEST_SECRET_KEY: '',
    [NICEPAY_ENV_VAR]: NICEPAY_ENV_TEST,
  });
  assert.equal(cfg.ok, false);
  assert.equal(cfg.reason, 'keys_missing');
  assert.equal(cfg.missing.length, 2);
});

test('a half-configured environment names only the missing variable', () => {
  const cfg = resolveNicepayEnv({ NICEPAY_TEST_CLIENT_KEY: 'only-the-id' });
  assert.equal(cfg.ok, false);
  assert.deepEqual(cfg.missing, ['NICEPAY_TEST_SECRET_KEY']);
});

test('missing with no env bundle at all still resolves to the sandbox set', () => {
  const cfg = resolveNicepayEnv({});
  assert.equal(cfg.ok, false);
  assert.equal(cfg.environment, NICEPAY_ENV_TEST);
  assert.equal(cfg.reason, 'keys_missing');
});

test('sandbox cannot partial-cancel; the operating store can', () => {
  assert.equal(SANDBOX_CAPABILITIES.partialCancel, false);
  assert.equal(SANDBOX_CAPABILITIES.fullCancel, true);
  assert.equal(SANDBOX_CAPABILITIES.realMoneyMoves, false);
  assert.equal(OPERATING_CAPABILITIES.partialCancel, true);
  assert.equal(OPERATING_CAPABILITIES.realMoneyMoves, true);
  const cfg = resolveNicepayEnv(full());
  assert.equal(cfg.capabilities.partialCancel, false);
});

test('sandbox API host is never the production host and vice versa', () => {
  const sandbox = resolveNicepayEnv(full());
  const operating = resolveNicepayEnv(full({ [NICEPAY_ENV_VAR]: NICEPAY_ENV_OPERATING }));
  assert.match(sandbox.apiBaseUrl, /^https:\/\/sandbox-api\.nicepay\.co\.kr\/v1$/);
  assert.doesNotMatch(sandbox.apiBaseUrl, /api\.pay\.nicepay|https:\/\/api\.nicepay/);
  assert.match(operating.apiBaseUrl, /^https:\/\/api\.pay\.nicepay\.co\.kr\/v1$/);
  assert.doesNotMatch(operating.apiBaseUrl, /sandbox/);
});

test('the sandbox SDK host is flagged as unverified', () => {
  assert.equal(NICEPAY_JS_SDK_SANDBOX, 'https://sandbox-pay.nicepay.co.kr/v1/js/');
  assert.equal(NICEPAY_ENVIRONMENTS[NICEPAY_ENV_TEST].jsSdkUrlVerified, false);
  assert.equal(NICEPAY_ENVIRONMENTS[NICEPAY_ENV_OPERATING].jsSdkUrlVerified, true);
});

test('redaction keeps booleans and drops every credential value', () => {
  const cfg = resolveNicepayEnv(full());
  const red = redactNicepay(cfg);
  assert.equal(red.hasClientId, true);
  assert.equal(red.hasSecretKey, true);
  assert.equal(red.ok, true);
  const dump = JSON.stringify(red);
  for (const secret of Object.values(full())) {
    assert.doesNotMatch(dump, new RegExp(secret.slice(0, 12)), 'redacted shape leaked a credential');
  }
  assert.equal(red.clientId, undefined);
  assert.equal(red.secretKey, undefined);
});

test('a failure message never carries a credential value', () => {
  const cfg = resolveNicepayEnv({ ...OPS_IDS, [NICEPAY_ENV_VAR]: NICEPAY_ENV_TEST });
  const text = JSON.stringify(cfg);
  for (const secret of Object.values(OPS_IDS)) {
    assert.doesNotMatch(text, new RegExp(secret.slice(0, 12)));
  }
  assert.equal(redactNicepay(cfg).hasSecretKey, false);
});

test('environment profiles are frozen so a lane cannot rewrite the hosts', () => {
  assert.equal(Object.isFrozen(NICEPAY_ENVIRONMENTS), true);
  assert.equal(Object.isFrozen(NICEPAY_ENVIRONMENTS[NICEPAY_ENV_TEST]), true);
  const before = NICEPAY_ENVIRONMENTS[NICEPAY_ENV_OPERATING].apiBaseUrl;
  try {
    NICEPAY_ENVIRONMENTS[NICEPAY_ENV_OPERATING].apiBaseUrl = 'https://evil.example/v1';
  } catch {
    /* strict mode throws; sloppy mode ignores — both must leave the value alone */
  }
  assert.equal(NICEPAY_ENVIRONMENTS[NICEPAY_ENV_OPERATING].apiBaseUrl, before);
});

test('shop name is carried for operator display and never required', () => {
  const named = resolveNicepayEnv(full({ NICEPAY_TEST_SHOP_NAME: 'PADIEM-CGI-SANDBOX' }));
  assert.equal(named.ok, true);
  assert.equal(named.shopName, 'PADIEM-CGI-SANDBOX');
  assert.equal(resolveNicepayEnv(full()).shopName, null);
});
