// Member-name encoding boundary (issue #92, item 3): reproduce how a Korean name
// gets damaged, and prove a new one cannot be stored that way again.
//
// members.id 20 and 21 hold a name whose syllables were replaced by U+FFFD. The
// bytes were never UTF-8: a Korean Windows client posting a JSON body from a cp949
// console sends EUC-KR octets, and a non-fatal UTF-8 decode turns those octets into
// U+022B, U+FFFD and U+6D7F - one Latin Extended letter, one replacement character,
// one Han ideograph. The substitution is irreversible, so the only safe place to
// react is where the body is decoded.
//
// The expected name here is decoded from those same octets by the windows-949
// codec and never typed, so the fixture cannot drift from the payload.
//
//   node --experimental-sqlite test/e2e/member-name-encoding.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const PASSWORD = 'Test!2026-abc';
const EMAIL = 'name-encoding@cgi.test';
const REPLACEMENT = '\uFFFD';

/** EUC-KR octets for a three-syllable Korean name (hong / gil / dong). */
const CP949_NAME = [200, 171, 177, 230, 181, 191];
const NAME = new TextDecoder('windows-949').decode(new Uint8Array(CP949_NAME));
const encode = (text) => Array.from(new TextEncoder().encode(text));

/** A signup frame whose name field carries raw bytes instead of UTF-8. */
function signupBody(nameBytes) {
  return new Uint8Array([
    ...encode('{"email":"' + EMAIL + '","password":"' + PASSWORD + '","phone":"010-0000-0000","terms":true,"privacy":true,"name":"'),
    ...nameBytes,
    ...encode('"}'),
  ]);
}

function env(overrides = {}) {
  return {
    DB: openD1(),
    ADMIN_TOKEN: 'example-admin-token',
    PG_PROVIDER_MODE: 'mock',
    SHIPPING_FEE_DEFAULT: '0',
    MAIL_MODE: 'echo',
    AUTH_PBKDF2_ITERATIONS: '1000',
    AUTH_RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
    ...overrides,
  };
}

async function postRaw(environment, path, body, headers = {}) {
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN, 'Content-Type': 'application/json', ...headers },
    body,
  }), environment);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  const out = {};
  response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return { status: response.status, json, text, headers: out };
}

async function patchRaw(environment, path, body, cookie) {
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, {
    method: 'PATCH',
    headers: { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
    body,
  }), environment);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: response.status, json, text };
}

async function memberRow(environment) {
  const { results } = await environment.DB.prepare('SELECT id, name FROM members WHERE email = ?').bind(EMAIL).all();
  return results[0] || null;
}

async function quoteNames(environment) {
  const { results } = await environment.DB.prepare('SELECT contact_name FROM quote_requests').all();
  return results.map((row) => row.contact_name);
}

/* ------------------------------------------------------------ the cause */

test('the same octets decoded as UTF-8 lose the name to U+FFFD', () => {
  // This is what the pre-fix boundary did with a cp949 body: the octets are valid
  // EUC-KR but not valid UTF-8, so one syllable survives as a Latin Extended letter,
  // the middle becomes the substitution character, and the last lands on an
  // unrelated Han ideograph. Nothing downstream can undo that.
  const lossy = new TextDecoder().decode(new Uint8Array(CP949_NAME));
  assert.deepEqual([...lossy].map((c) => c.codePointAt(0)), [0x022b, 0xfffd, 0x6d7f]);
  assert.ok(lossy.includes(REPLACEMENT), 'the substitution itself');
  assert.notEqual(lossy, NAME, 'and none of the intended syllables survive');
});

/* --------------------------------------------------------- the boundary */

test('signup refuses a body that is not UTF-8 and stores nothing', async () => {
  const environment = env();
  const res = await postRaw(environment, '/api/auth/signup', signupBody(CP949_NAME));

  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error, 'body must be valid utf-8');
  assert.equal(await memberRow(environment), null, 'a refused signup may not leave a member row behind');
});

test('the same name sent as UTF-8 is stored character for character', async () => {
  const environment = env();
  const res = await postRaw(environment, '/api/auth/signup', signupBody(encode(NAME)));

  assert.equal(res.status, 201, res.text);
  const row = await memberRow(environment);
  assert.ok(row, 'the member exists');
  assert.equal(row.name, NAME, 'the name round-trips exactly');
  assert.ok(!row.name.includes(REPLACEMENT), 'and carries no substitution');
  assert.equal(res.json.member.name, NAME);
});

test('a damaged profile write cannot overwrite a stored name', async () => {
  const environment = env();
  const signup = await postRaw(environment, '/api/auth/signup', signupBody(encode(NAME)));
  assert.equal(signup.status, 201, signup.text);
  const cookie = signup.headers['set-cookie'];
  assert.match(String(cookie), /=/, 'the session cookie is what authenticates the patch');

  const damaged = await patchRaw(environment, '/api/me', new Uint8Array([
    ...encode('{"name":"'),
    ...CP949_NAME,
    ...encode('"}'),
  ]), cookie);

  assert.equal(damaged.status, 400, damaged.text);
  assert.equal(damaged.json.error, 'body must be valid utf-8');
  assert.equal((await memberRow(environment)).name, NAME, 'the stored name is untouched');

  const renamed = await patchRaw(environment, '/api/me', new TextEncoder().encode(
    JSON.stringify({ company: 'CGI' })), cookie);
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal((await memberRow(environment)).name, NAME, 'a clean write still lands');
});

test('the quote wire is guarded by the same boundary', async () => {
  const environment = env();
  const items = '{"items":[{"id":"p1","name":"Mic","qty":1}],"company":"CGI","phone":"010-0000-0000",';

  const damaged = await postRaw(environment, '/api/quotes', new Uint8Array([
    ...encode(items + '"name":"'),
    ...CP949_NAME,
    ...encode('"}'),
  ]));

  assert.equal(damaged.status, 400, damaged.text);
  assert.equal(damaged.json.error, 'body must be valid utf-8',
    'the encoding is refused before the schema, so a damaged contact name cannot reach the table');
  assert.deepEqual(await quoteNames(environment), [], 'nothing is written for a refused body');

  const good = await postRaw(environment, '/api/quotes', new TextEncoder().encode(
    items + '"name":"' + NAME + '"}'));
  assert.equal(good.status, 201, good.text);
  assert.deepEqual(await quoteNames(environment), [NAME], 'the same bytes as UTF-8 are stored intact');
});

test('a malformed body is still reported as malformed, not as a missing field', async () => {
  const environment = env();
  const broken = await postRaw(environment, '/api/auth/signup', new TextEncoder().encode('{"email":'));

  assert.equal(broken.status, 400, broken.text);
  assert.equal(broken.json.error, 'invalid json');
});
