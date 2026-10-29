// M1 — LOCAL Node runtime wiring for the Naver Commerce API auth policy layer.
//
// backend/lib/ncommerce-auth.mjs keeps the contract and the retry policy but
// takes the bcrypt primitive as an injected seam (the Worker runtime has none,
// and backend/ carries no runtime dependencies by design). This file is the
// local runner side of that seam:
//
//   - bcryptjs comes from tools/node_modules (tools owns its own dependency,
//     mirroring the vendor's own Node.js sample: bcrypt.hashSync(password,
//     clientSecret) — Naver issues client_secret as a $2a$-formatted salt).
//   - credentials are read from the environment ONLY (NCOM_CLIENT_ID /
//     NCOM_CLIENT_SECRET / NCOM_ACCOUNT_TYPE / NCOM_ACCOUNT_ID). They are
//     never logged, never returned, never written.
//
// No network happens at import time. Real token issuance is the operator's
// explicit act (M0 credentials + live gates), never this module's side effect.

import { createRequire } from 'node:module';
import { createNcomAuthRuntime, loadLocalBcrypt } from '../../backend/lib/ncommerce-auth.mjs';

/**
 * Resolves bcryptjs from tools/node_modules. Returns the same shape as
 * loadLocalBcrypt so callers can branch without knowing which side resolved.
 */
export async function resolveLocalBcrypt() {
  try {
    const require = createRequire(import.meta.url);
    const bcrypt = require('bcryptjs');
    if (typeof bcrypt?.hashSync !== 'function') {
      return { bcryptHashpw: null, implementation: null, reason: 'bcryptjs resolved but hashSync missing' };
    }
    return {
      bcryptHashpw: async (plain, salt) => bcrypt.hashSync(plain, salt),
      implementation: 'bcryptjs',
      reason: null,
    };
  } catch (error) {
    return { bcryptHashpw: null, implementation: null, reason: `bcryptjs not installed in tools/ — run: npm install (in tools/) — npm: ${error?.code || error?.message}` };
  }
}

/**
 * Builds the local auth runtime with the real bcrypt primitive. Throws when
 * the environment carries no credentials — a runtime without credentials must
 * not exist, or a live call would look configured while it is not.
 */
export async function createLocalNcomAuth({ env = process.env } = {}) {
  const resolved = await resolveLocalBcrypt();
  const runtime = createNcomAuthRuntime({ env, bcryptHashpw: resolved.bcryptHashpw });
  return { runtime, bcrypt: resolved };
}

/**
 * Self-test WITHOUT any network: builds the signature exactly as the vendor
 * recipe requires, against a vendor-shaped ($2a$...) stand-in secret, and
 * returns the verdict. Used by tools/naver/auth-check.mjs --selftest so an
 * operator can prove the local primitive before M0 hands over real credentials.
 */
export async function selfTestSignature({ clientId = 'aaaabbbbcccc', vendorStyleSecret = '$2a$10$abcdefghijklmnopqrstuu', timestampMs = 1643961623299 } = {}) {
  const { buildClientSecretSign } = await import('../../backend/lib/ncommerce.mjs');
  const resolved = await resolveLocalBcrypt();
  if (!resolved.bcryptHashpw) return { ok: false, stage: 'bcrypt_resolve', reason: resolved.reason };
  try {
    const sign = await buildClientSecretSign({ clientId, timestampMs, clientSecret: vendorStyleSecret, bcryptHashpw: resolved.bcryptHashpw });
    const decoded = Buffer.from(sign, 'base64').toString('utf8');
    return {
      ok: /^\$2[aby]\$/.test(decoded) && !/[-_]/.test(sign),
      stage: 'sign_built',
      implementation: resolved.implementation,
      detail: {
        signLength: sign.length,
        decodedIsCryptHash: /^\$2[aby]\$/.test(decoded),
        standardBase64: !/[-_]/.test(sign),
      },
    };
  } catch (error) {
    return { ok: false, stage: 'sign_build', reason: error?.message };
  }
}
