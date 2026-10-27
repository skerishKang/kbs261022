// NICEPAY environment split — one variable selects which credential set the
// app uses, so the PADIEM TEST-store settings can later be replaced by CGI's
// operating-store settings without touching protocol code.
//
// Deliberately not wired into worker.js yet: that file is owned by the open ERP
// PR #83, and production PG routing must not change without an explicit order.
// Everything here is pure and offline — no network, no credential values in any
// returned message.
//
// Facts encoded from the official manual (github.com/nicepayments/nicepay-manual)
// and the seller console, both observed 2026-10-27:
//   * sandbox store keys are issued in the console (개발정보 → KEY 정보 → 발급),
//     with 결제창 승인 방식 = Server 승인 and API 인가 방식 = Basic 인증
//   * sandbox and operating keys are different values; the manual warns that a
//     sandbox API response is not a real approval
//   * the sandbox rejects partial cancel (취소 요청 = △ "부분취소 불가")
//   * sandbox card approvals are pinned to one issuer (삼성)

import {
  NICEPAY_PROVIDER,
  NICEPAY_PROD_API,
  NICEPAY_SANDBOX_API,
  NICEPAY_JS_SDK_PROD,
} from './pg-nicepay.mjs';

export const NICEPAY_ENV_VAR = 'PG_NICEPAY_ENV';
export const NICEPAY_ENV_TEST = 'test';
export const NICEPAY_ENV_OPERATING = 'operating';

// The manual's outbound-allowlist table names sandbox-pay.nicepay.co.kr as the
// sandbox SDK host while its sample snippet still shows the production host, so
// the sandbox value is a documented guess pending a live window load.
export const NICEPAY_JS_SDK_SANDBOX = 'https://sandbox-pay.nicepay.co.kr/v1/js/';

export const NICEPAY_ENVIRONMENTS = Object.freeze({
  [NICEPAY_ENV_TEST]: Object.freeze({
    environment: NICEPAY_ENV_TEST,
    mode: 'sandbox',
    apiBaseUrl: `${NICEPAY_SANDBOX_API}/v1`,
    jsSdkUrl: NICEPAY_JS_SDK_SANDBOX,
    jsSdkUrlVerified: false,
    clientKeyVar: 'NICEPAY_TEST_CLIENT_KEY',
    secretKeyVar: 'NICEPAY_TEST_SECRET_KEY',
    shopNameVar: 'NICEPAY_TEST_SHOP_NAME',
  }),
  [NICEPAY_ENV_OPERATING]: Object.freeze({
    environment: NICEPAY_ENV_OPERATING,
    mode: 'production',
    apiBaseUrl: `${NICEPAY_PROD_API}/v1`,
    jsSdkUrl: NICEPAY_JS_SDK_PROD,
    jsSdkUrlVerified: true,
    clientKeyVar: 'NICEPAY_OPERATING_CLIENT_KEY',
    secretKeyVar: 'NICEPAY_OPERATING_SECRET_KEY',
    shopNameVar: 'NICEPAY_OPERATING_SHOP_NAME',
  }),
});

export const SANDBOX_CAPABILITIES = Object.freeze({
  windowApproval: true,
  approvalResultQuery: true,
  orderByOrderId: true,
  approveAmountCheck: true,
  accessToken: true,
  fullCancel: true,
  partialCancel: false,
  webhookTestCall: true,
  cardIssuerPinned: '삼성카드',
  realMoneyMoves: false,
});

export const OPERATING_CAPABILITIES = Object.freeze({
  windowApproval: true,
  approvalResultQuery: true,
  orderByOrderId: true,
  approveAmountCheck: true,
  accessToken: true,
  fullCancel: true,
  partialCancel: true,
  webhookTestCall: false,
  cardIssuerPinned: null,
  realMoneyMoves: true,
});

const MISSING = Object.freeze({
  environment_unknown: '선택한 NICEPAY 환경을 인식할 수 없습니다.',
  keys_missing: '이 환경에 연결된 발급 키가 없습니다. 키 이름과 값을 먼저 등록하세요.',
});

function blank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Resolves one credential set. Never mixes environments: if the selected
 * environment's keys are absent the result is unusable, even when the other
 * environment is fully configured — falling back would send a test call to the
 * operating store (or the reverse) with the wrong money attached.
 */
export function resolveNicepayEnv(envVars = {}) {
  const raw = envVars[NICEPAY_ENV_VAR];
  const environment = blank(raw) ? NICEPAY_ENV_TEST : raw.trim().toLowerCase();
  const profile = NICEPAY_ENVIRONMENTS[environment];
  if (!profile) {
    return {
      ok: false,
      provider: NICEPAY_PROVIDER,
      reason: 'environment_unknown',
      reasonText: MISSING.environment_unknown,
      environment: null,
      acceptedEnvironments: Object.keys(NICEPAY_ENVIRONMENTS),
    };
  }

  const clientId = envVars[profile.clientKeyVar];
  const secretKey = envVars[profile.secretKeyVar];
  const missing = [];
  if (blank(clientId)) missing.push(profile.clientKeyVar);
  if (blank(secretKey)) missing.push(profile.secretKeyVar);
  if (missing.length) {
    return {
      ok: false,
      provider: NICEPAY_PROVIDER,
      reason: 'keys_missing',
      reasonText: MISSING.keys_missing,
      environment,
      mode: profile.mode,
      apiBaseUrl: profile.apiBaseUrl,
      missing,
      // present-but-unusable must still not look like a successful resolution
      clientId: null,
      secretKey: null,
    };
  }

  return {
    ok: true,
    provider: NICEPAY_PROVIDER,
    environment,
    mode: profile.mode,
    apiBaseUrl: profile.apiBaseUrl,
    jsSdkUrl: profile.jsSdkUrl,
    jsSdkUrlVerified: profile.jsSdkUrlVerified,
    shopName: blank(envVars[profile.shopNameVar]) ? null : envVars[profile.shopNameVar].trim(),
    clientId,
    secretKey,
    capabilities: profile.mode === 'sandbox' ? SANDBOX_CAPABILITIES : OPERATING_CAPABILITIES,
  };
}

/** Any subset of a resolved config, safe to put in a log or an error body. */
export function redactNicepay(config) {
  if (!config) return null;
  return {
    provider: config.provider || NICEPAY_PROVIDER,
    ok: config.ok === true,
    reason: config.reason || null,
    environment: config.environment || null,
    mode: config.mode || null,
    apiBaseUrl: config.apiBaseUrl || null,
    shopName: config.shopName || null,
    hasClientId: !blank(config.clientId),
    hasSecretKey: !blank(config.secretKey),
    missing: config.missing || [],
  };
}
