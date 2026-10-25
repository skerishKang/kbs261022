// CGI customer authentication primitives (issue #69).
//
// Password storage: PBKDF2-HMAC-SHA512 with a 16-byte random salt per account,
// folded into one self-describing string so an export can be re-verified with no
// side metadata:
//
//   pbkdf2-sha512$<iterations>$<saltHex>$<hashHex>
//
// Session / verification / reset tokens are 32 bytes of CSPRNG output. The
// database stores only a SHA-256 digest of each token, so a leaked database does
// not yield usable tokens.
//
// Pure module: no D1, no mail, no Clock. The Worker wires it to storage and to
// the mail adapter.

const TEXT = new TextEncoder();

export const PASSWORD_ALGO = 'pbkdf2-sha512';

/** Defaults. Every numeric field is overridable through worker env vars. */
export const AUTH_POLICY = {
  pbkdf2Iterations: 30000,
  pbkdf2KeyBits: 256,
  saltBytes: 16,
  tokenBytes: 32,

  passwordMin: 8,
  passwordMax: 128,

  sessionTtlSeconds: 30 * 24 * 3600,
  verifyEmailTtlSeconds: 24 * 24 * 60 * 60,
  passwordResetTtlSeconds: 60 * 60,
  maxAddressesPerMember: 10,

  /** Sliding-window rate limits, keyed by (bucket, identity). */
  rateLimit: {
    login: { max: 5, windowSeconds: 15 * 60 },
    signup: { max: 3, windowSeconds: 24 * 3600 },
    'email-check': { max: 30, windowSeconds: 60 },
    'password-reset': { max: 5, windowSeconds: 24 * 3600 },
    'email-verify': { max: 10, windowSeconds: 24 * 3600 },
    'password-change': { max: 5, windowSeconds: 60 * 60 },
  },
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const PHONE_RE = /^[0-9()+.\- ]{3,20}$/;

export function randomHex(bytes) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (const byte of value) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function bytesToHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', TEXT.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

async function deriveBits(password, salt, iterations, keyBits) {
  const keyMaterial = await crypto.subtle.importKey('raw', TEXT.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-512' },
    keyMaterial,
    keyBits,
  );
  return bytesToHex(new Uint8Array(bits));
}

/** Hash a password into the stored string form. */
export async function hashPassword(password, policy = AUTH_POLICY) {
  const salt = crypto.getRandomValues(new Uint8Array(policy.saltBytes));
  const hashHex = await deriveBits(password, salt, policy.pbkdf2Iterations, policy.pbkdf2KeyBits);
  return `${PASSWORD_ALGO}$${policy.pbkdf2Iterations}$${bytesToHex(salt)}$${hashHex}`;
}

/** Constant-shape verify. Returns false, never throws, for unknown formats. */
export async function verifyPassword(password, stored, policy = AUTH_POLICY) {
  try {
    const parsed = parseStoredPassword(stored);
    if (!parsed) return false;
    const actual = await deriveBits(password, hexToBytes(parsed.saltHex), parsed.iterations, policy.pbkdf2KeyBits);
    return constantTimeEqualHex(actual, parsed.hashHex);
  } catch (e) {
    return false;
  }
}

export function parseStoredPassword(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_ALGO) return null;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1) return null;
  if (!parts[2] || !parts[3]) return null;
  return { algo: parts[0], iterations, saltHex: parts[2], hashHex: parts[3] };
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken() {
  return randomHex(AUTH_POLICY.tokenBytes);
}

/** Tokens are persisted by digest only. */
export async function tokenDigest(token) {
  return sha256Hex(String(token));
}

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

export function validateEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return { ok: false, error: 'email required', detail: 'email address is required' };
  if (value.length > 320) return { ok: false, error: 'email too long', detail: 'email address is too long' };
  if (!EMAIL_RE.test(value)) {
    return { ok: false, error: 'invalid email', detail: 'enter a valid email address' };
  }
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || local.length > 64) return { ok: false, error: 'invalid email', detail: 'local part is not valid' };
  if (!domain || !/^[^\s@.][^\s@]{0,253}[^\s@.]$/.test(domain)) {
    return { ok: false, error: 'invalid email', detail: 'domain is not valid' };
  }
  return { ok: true, email: value };
}

export function validateName(name) {
  const value = String(name || '').trim();
  if (!value) return { ok: false, error: 'name required', detail: 'name is required' };
  if (value.length > 60) return { ok: false, error: 'name too long', detail: 'name is at most 60 characters' };
  return { ok: true, name: value };
}

export function validatePhone(phone) {
  const value = String(phone || '').trim();
  if (!value) return { ok: false, error: 'phone required', detail: 'phone number is required' };
  if (!PHONE_RE.test(value)) {
    return { ok: false, error: 'invalid phone', detail: 'enter a valid phone number' };
  }
  return { ok: true, phone: value };
}

/** Optional free text: trims, enforces a length cap, returns null when empty. */
export function validateOptionalText(value, field, max) {
  const text = value == null ? '' : String(value).trim();
  if (text.length > max) {
    return { error: `${field} too long`, detail: `${field} is at most ${max} characters` };
  }
  return { ok: true, value: text || null };
}

/** Required free text: trims, enforces a length cap. */
export function validateText(value, field, max) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return { ok: false, error: `${field} required`, detail: `${field} is required` };
  if (text.length > max) {
    return { ok: false, error: `${field} too long`, detail: `${field} is at most ${max} characters` };
  }
  return { ok: true, value: text };
}

/**
 * Strong password policy: PASSWORD_MIN..PASSWORD_MAX characters, at least one
 * letter, one English letter (case matters), one digit and one symbol. Also
 * rejects a password that embeds the account email.
 *
 * Hangul counts as a letter but not as an English letter, so a Korean-only
 * password still has to contain a-z/A-Z as well as digits and a symbol.
 */
export function validatePassword(password, options = {}) {
  const policy = options.policy || AUTH_POLICY;
  const value = String(password == null ? '' : password);
  if (!value) return { ok: false, error: 'password required', detail: 'password is required' };
  if (value.length < policy.passwordMin) {
    return { ok: false, error: 'password too short', detail: `password is at least ${policy.passwordMin} characters` };
  }
  if (value.length > policy.passwordMax) {
    return { ok: false, error: 'password too long', detail: `password is at most ${policy.passwordMax} characters` };
  }
  const email = String(options.email || '').trim().toLowerCase();
  if (email && value.toLowerCase().includes(email)) {
    return { ok: false, error: 'password too weak', detail: 'password must not contain the email address' };
  }
  const hasLetter = /[A-Za-z가-힣]/.test(value);
  const hasEnglishLetter = /[A-Za-z]/.test(value);
  const hasDigit = /\d/.test(value);
  const hasSymbol = /[^A-Za-z0-9가-힣\s]/.test(value);
  const missing = [];
  if (!hasLetter) missing.push('a letter');
  if (!hasEnglishLetter) missing.push('an English letter');
  if (!hasDigit) missing.push('a number');
  if (!hasSymbol) missing.push('a symbol');
  if (missing.length) {
    return { ok: false, error: 'password too weak', detail: `password needs ${missing.join(', ')}` };
  }
  return { ok: true, password: value };
}

export function passwordRules(policy = AUTH_POLICY) {
  return {
    min: policy.passwordMin,
    max: policy.passwordMax,
    requires: ['a letter', 'an English letter', 'a number', 'a symbol'],
  };
}
