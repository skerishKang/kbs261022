// Google OAuth client for CGI storefront (issue #79).
//
// Reuses PADIEM's OAuth flow pattern: authorization code + CSRF state cookie.
// State is signed with the same session secret used for CGI sessions.
//
// Pure module: no D1, no sessions. The Worker wires it to storage.

const OAUTH_STATE_COOKIE = 'cgi_oauth_state';
const OAUTH_STATE_TTL_SECONDS = 10 * 60; // 10 minutes

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Create an OAuth state token (signed, time-limited).
 * Format: base64(json) + '.' + hmac-sha256(base64(json), secret)
 */
export async function createOAuthState(secret, now = Date.now()) {
  const payload = {
    n: now,
    e: now + OAUTH_STATE_TTL_SECONDS * 1000,
    r: crypto.getRandomValues(new Uint8Array(16)).reduce((a, b) => a + b.toString(16).padStart(2, '0'), ''),
  };
  const json = JSON.stringify(payload);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  const { hex } = await hmacSha256(encoded, secret);
  return encoded + '.' + hex;
}

/**
 * Verify an OAuth state token. Returns true if valid and not expired.
 */
export async function verifyOAuthState(secret, state, now = Date.now()) {
  try {
    const parts = String(state || '').split('.');
    if (parts.length !== 2) return false;
    const [encoded, signature] = parts;
    const { hex } = await hmacSha256(encoded, secret);
    if (hex !== signature) return false;

    const json = decodeURIComponent(escape(atob(encoded)));
    const payload = JSON.parse(json);
    if (!payload.n || !payload.e) return false;
    if (now < payload.n - 60000) return false; // 1 minute clock skew tolerance
    if (now > payload.e) return false;

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * HMAC-SHA256 for state token signing.
 */
async function hmacSha256(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign({ name: 'HMAC' }, key, enc.encode(message));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { hex, sig };
}

/**
 * Build the Google authorization URL.
 */
export function buildAuthorizationUrl(config, state) {
  const { clientId, redirectUri } = config;
  if (!clientId) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    include_granted_scopes: 'true',
    access_type: 'online',
    prompt: 'select_account',
  });
  return GOOGLE_AUTH_URL + '?' + params.toString();
}

/**
 * Exchange an authorization code for an access token.
 */
export async function exchangeCode(config, code, redirectUri) {
  const { clientId, clientSecret } = config;
  if (!clientId || !clientSecret) throw new Error('OAuth not configured');

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
  });

  const data = await resp.json();
  if (!data.access_token) {
    throw new Error('Token exchange failed: ' + (data.error || 'unknown error'));
  }
  return data.access_token;
}

/**
 * Fetch Google user info using an access token.
 */
export async function fetchUserInfo(accessToken) {
  const resp = await fetch(GOOGLE_USERINFO_URL, {
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' },
  });

  if (!resp.ok) throw new Error('Userinfo fetch failed: ' + resp.status);

  const data = await resp.json();
  const subject = data.id;
  const email = data.email;
  const verified = data.verified_email;
  const name = data.name;
  const picture = data.picture;

  if (!subject || !email || verified !== true) {
    throw new Error('Unverified Google account');
  }

  return {
    subject: String(subject).slice(0, 255),
    email: String(email).slice(0, 320).toLowerCase(),
    name: name ? String(name).slice(0, 160) : '',
    picture: picture ? String(picture).slice(0, 1000) : '',
  };
}

/**
 * Create the Google OAuth state cookie options.
 */
export function oauthStateCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: OAUTH_STATE_TTL_SECONDS,
  };
}

export { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS };
