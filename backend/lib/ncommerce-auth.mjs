// M1 — authentication & retry POLICY layer for the Naver Commerce API.
//
// This module deliberately does NOT re-implement the API client. Token minting,
// the bcrypt signature seam, error classification and the single re-auth rule
// all live in lib/ncommerce.mjs (createNcomClient) and are covered by
// test/e2e/ncom.test.mjs. What M1 adds is the layer a local Node runner needs
// before it may talk to the real gateway:
//
//   1. credentials come from environment variables only (NCOM_CLIENT_ID /
//      NCOM_CLIENT_SECRET); this module never hardcodes, logs or persists them.
//   2. token lifecycle helpers around the client's cached authorize():
//      token() reuses the cached token, refreshToken() forces a re-mint. The
//      docs publish no numeric TTL, so only expires_in is honoured — a server
//      that still has >=30 minutes left simply returns the same token again,
//      which makes an early refresh safe but never required.
//   3. an automatic retry policy for the failure families the docs mark as
//      retryable: 429 GW.RATE_LIMIT / GW.QUOTA_LIMIT, 5xx gateway codes and
//      domain >=500. GW.IP_NOT_ALLOWED (operator must register the IP) and
//      GW.NOT_FOUND (the path itself is wrong) are never retried; 400-class
//      domain errors are re-validated by a human, not replayed.
//   4. loadLocalBcrypt(): resolves the real bcrypt primitive for LOCAL runs.
//      backend/ has zero runtime dependencies by design (the Worker bundle must
//      stay clean), so bcryptjs is resolved dynamically and its absence is
//      reported, never hidden and never worked around.
//
// Tests in test/unit/ncommerce-auth.test.mjs use mock credentials, a stub
// bcrypt and the loopback mock server only. No test, tool or run in this
// repository may mint a real token; live use requires an operator to set
// NCOM_MODE=live, NCOM_LIVE_WRITE=YES and the app credentials themselves.

import { createNcomClient, NcomError, NCOM_LIMITS } from './ncommerce.mjs';

/** What the official auth pages state, and what they leave open. */
export const NCOM_AUTH_DOC = {
  source: 'apicenter.commerce.naver.com — docs/auth, docs/commerce-api/current/exchange-sellers-auth, docs/commerce-api/current/o-auth-2-0',
  grantType: 'client_credentials',
  signRecipe: 'client_secret_sign = Base64(bcrypt(`${client_id}_${timestamp}`, salt = client_secret)), timestamp in milliseconds — client_secret 은 $2a$ 형식의 bcrypt salt 문자열로 발급된다(공식 문서 예시 출력이 $2a$10$... 로 시작하므로)',
  tokenEndpoint: 'POST /v1/oauth2/token (body-only form parameters)',
  tokenTtl: 'no numeric TTL is printed — only expires_in(seconds) is honoured',
  serverTokenReuse: '남은 유효 시간 30분 이상이면 서버가 기존 토큰을 반환 — 이른 재발급 요청은 안전하나 필수가 아니다',
  typeSelf: '내 스토어 애플리케이션은 type=SELF(자기 스토어 리소스만)',
  rateLimit: 'API별 초당 동시 요청 제한, 일일 한도 없음, 초과 시 429(GW.RATE_LIMIT / GW.QUOTA_LIMIT)',
  unconfirmed: [
    'Retry-After 헤더의 존재 여부 — 문서에 인쇄되지 않아 이 계층은 읽지 않는다',
    '토큰의 수치 TTL — expires_in 응답값만 신뢰',
  ],
};

/**
 * Retry policy for the failure families the vendor marks retryable. The first
 * attempt is attempt 0; maxAttempts counts it. Delays grow exponentially and
 * are capped; jitter keeps parallel batches from re-syncing.
 */
export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterRatio: 0.25,
};

/**
 * Single source of truth for "may this failure be replayed?". Reads the two
 * places the client attaches retryability: the error itself (call failures)
 * and error.verdict (token failures). A fetch-level TypeError (transport) is
 * transient by nature and is retried; any other foreign exception is not ours
 * to retry.
 */
export function isRetryableNcomError(error) {
  if (!(error instanceof NcomError)) {
    if (error instanceof TypeError && /fetch/i.test(String(error?.message || ''))) return true;
    if (error?.name === 'AbortError') return true;
    return false;
  }
  if (error.stopped === true) return false;
  if (error.pathNotRegistered === true) return false;
  // GW.AUTHN: the client's own single re-auth + replay has already consumed the
  // vendor's 'after re-auth, once' rule by the time this error escapes. Replaying
  // it here would just repeat a credential failure the retry policy cannot fix.
  if (error.code === 'GW.AUTHN') return false;
  for (const fatal of ['stopped', 'disabled', 'not_configured', 'path_param_missing', 'unknown_endpoint', 'bcrypt_seam_missing', 'bcrypt_output_invalid', 'account_id_required', 'token_missing']) {
    if (error.code === fatal) return false;
  }
  if (typeof error.retryable === 'boolean') return error.retryable;
  if (error.verdict && typeof error.verdict.retryable === 'boolean') return error.verdict.retryable;
  return false;
}

/**
 * Exponential backoff with jitter. A rate-limit rejection with the remaining
 * quota at 0 floors the delay at 2×base so the next attempt cannot land inside
 * the same metering window. `Retry-After` is not honoured because the docs
 * never print such a header (declared unconfirmed above).
 */
export function computeRetryDelayMs({ attempt = 0, error = null, policy = DEFAULT_RETRY_POLICY, random = Math.random } = {}) {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt));
  let base = exp;
  const limited = error?.verdict?.rateLimited === true || error?.code === 'GW.RATE_LIMIT' || error?.code === 'GW.QUOTA_LIMIT';
  const drained = String(error?.rateHeaders?.['gncp-gw-ratelimit-remaining'] ?? '') === '0';
  if (limited && drained) base = Math.max(base, policy.baseDelayMs * 2);
  const jitter = 1 + (random() * 2 - 1) * policy.jitterRatio;
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(base * jitter)));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps the verified client with the retry policy and exposes token helpers.
 * Every credential reference stays inside `env` — the runtime object exposes
 * mode/availability, never the secret itself.
 */
export function createNcomAuthRuntime({ env = {}, fetchFn = fetch, bcryptHashpw = null, now = () => Date.now(), sleep = defaultSleep, retryPolicy = {} } = {}) {
  const policy = { ...DEFAULT_RETRY_POLICY, ...retryPolicy };
  const client = createNcomClient({ env, fetchFn, bcryptHashpw, now, sleep });
  const stats = { attempts: 0, retries: 0, lastDelayMs: null, lastRetryCode: null };

  async function call(key, args = {}, { allowReauth = true } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
      if (client.stopped) throw new NcomError('stopped', `Naver calls halted: ${client.stopReason}`, { operation: key });
      try {
        stats.attempts += 1;
        return await client.call(key, args, { allowReauth });
      } catch (error) {
        lastError = error;
        if (!isRetryableNcomError(error)) throw error;
        if (attempt === policy.maxAttempts - 1) {
          error.attempts = attempt + 1;
          throw error;
        }
        const delayMs = computeRetryDelayMs({ attempt, error, policy });
        stats.retries += 1;
        stats.lastDelayMs = delayMs;
        stats.lastRetryCode = error.code || null;
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  return {
    /** underlying verified client — use only when the retry policy is unwanted */
    client,
    mode: client.mode,
    policy,
    stats,
    available: client.available,
    /** cached token per the client's own skew rule; errors surface as thrown */
    token: () => client.authorize(),
    /** force a re-mint (e.g. after an operator rotated the secret) */
    refreshToken: () => client.authorize({ force: true }),
    tokenExpiresAt: () => client.accessTokenExpiresAt,
    call,
  };
}

/**
 * Resolves the real bcrypt primitive for a LOCAL Node run. Absence is a
 * report, not a crash: CI and Workers never install it, and a live run without
 * it fails loudly at the seam instead of sending a broken signature.
 */
export async function loadLocalBcrypt({ importFn } = {}) {
  const load = importFn ?? ((specifier) => import(specifier));
  try {
    const mod = await load('bcryptjs');
    const bcrypt = mod?.default ?? mod;
    const hashSync = typeof bcrypt?.hashSync === 'function' ? bcrypt.hashSync.bind(bcrypt) : null;
    if (!hashSync) return { bcryptHashpw: null, implementation: null, reason: 'bcryptjs loaded but hashSync is missing' };
    return {
      bcryptHashpw: async (plain, salt) => hashSync(plain, salt),
      implementation: 'bcryptjs',
      reason: null,
    };
  } catch (error) {
    return {
      bcryptHashpw: null,
      implementation: null,
      reason: `bcryptjs is not resolvable from backend/ — run: npm install --no-save bcryptjs (npm: ${error?.code || error?.message})`,
    };
  }
}
