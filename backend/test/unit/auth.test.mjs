import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_POLICY,
  HASH_ALGO,
  randomHex,
  bytesToHex,
  hexToBytes,
  sha256Hex,
  hashPassword,
  verifyPassword,
  parseStoredPassword,
  randomToken,
  tokenDigest,
  validateEmail,
  validateName,
  validatePhone,
  validateOptionalText,
  validateText,
  validatePassword,
  passwordRules,
} from '../../lib/auth.mjs';

// Keep the hashing cheap in unit tests; the Worker reads the same override.
const POLICY = { ...AUTH_POLICY, pbkdf2Iterations: 200 };

test('hashPassword produces the documented self-describing format', async () => {
  const stored = await hashPassword('Test!2026-abc', POLICY);
  assert.match(stored, /^pbkdf2-sha512\$200\$/);
  const parts = stored.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], HASH_ALGO);
  assert.equal(parts[1], '200');
  assert.match(parts[2], /^[0-9a-f]{32}$/, '16 random salt bytes');
  assert.match(parts[3], /^[0-9a-f]{64}$/, '256-bit PBKDF2 output');
});

test('every password hash gets its own random salt', async () => {
  const a = await hashPassword('Test!2026-abc', POLICY);
  const b = await hashPassword('Test!2026-abc', POLICY);
  assert.notEqual(a, b);
  assert.notEqual(a.split('$')[2], b.split('$')[2]);
});

test('verifyPassword accepts the right password and rejects every other input', async () => {
  const stored = await hashPassword('Test!2026-abc', POLICY);
  assert.equal(await verifyPassword('Test!2026-abc', stored, POLICY), true);
  for (const guess of ['test!2026-abc', 'Test!2026-abс', 'Test!2026-abc ', '', 'Test!2026-abcd']) {
    assert.equal(await verifyPassword(guess, stored, POLICY), false, guess);
  }
});

test('verifyPassword never throws and always returns a boolean', async () => {
  for (const stored of [undefined, null, '', 'garbage', 'pbkdf2-sha512$200$aa$bb', 'pbkdf2-sha512$0$aa$bb', 'pbkdf2-sha512$abc$aa$bb', 'x$y$z$w', 'pbkdf2-sha512$200$zzzz$ff']) {
    const out = await verifyPassword('Test!2026-abc', stored, POLICY);
    assert.equal(out, false, `stored=${stored}`);
  }
});

test('verifyPassword honours the iteration count stored in the hash', async () => {
  const stored = await hashPassword('Test!2026-abc', { ...POLICY, pbkdf2Iterations: 200 });
  // A different iteration count in the *stored* hash must still be honoured.
  assert.equal(await verifyPassword('Test!2026-abc', stored, { ...POLICY, pbkdf2Iterations: 999 }), true);
});

test('parseStoredPassword rejects malformed values', () => {
  assert.equal(parseStoredPassword(null), null);
  assert.equal(parseStoredPassword(''), null);
  assert.equal(parseStoredPassword('not-a-hash'), null);
  assert.equal(parseStoredPassword('bcrypt$10$abc$def'), null);
  assert.equal(parseStoredPassword('pbkdf2-sha512$0$aa$bb'), null);
  assert.equal(parseStoredPassword('pbkdf2-sha512$200$'), null);
  assert.equal(parseStoredPassword('pbkdf2-sha512$200$aa$'), null);
  assert.equal(parseStoredPassword('pbkdf2-sha512$200$aa$bb$extra'), null);

  const ok = parseStoredPassword('pbkdf2-sha512$200$ab$cd');
  assert.deepEqual(ok, { algo: 'pbkdf2-sha512', iterations: 200, saltHex: 'ab', hashHex: 'cd' });
});

test('randomHex returns the requested number of bytes as hex', () => {
  assert.match(randomHex(1), /^[0-9a-f]{2}$/);
  assert.match(randomHex(32), /^[0-9a-f]{64}$/);
  assert.match(randomHex(64), /^[0-9a-f]{128}$/);
  assert.notEqual(randomHex(32), randomHex(32));
});

test('hex round trips through bytesToHex and hexToBytes', () => {
  for (const input of ['00ff', 'deadbeef', '0102030405060708090a0b0c0d0e0f10']) {
    assert.equal(bytesToHex(hexToBytes(input)), input.toLowerCase());
  }
  assert.deepEqual(hexToBytes('ab cd EF'), new Uint8Array([0xab, 0xcd, 0xef]));
  assert.equal(hexToBytes('').length, 0);
});

test('sha256Hex is stable and always 64 hex chars', async () => {
  const out = await sha256Hex('hello');
  assert.match(out, /^[0-9a-f]{64}$/);
  assert.equal(out, await sha256Hex('hello'));
  assert.notEqual(out, await sha256Hex('Hello'));
  assert.equal(out, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('randomToken and tokenDigest are 32-byte tokens hashed to SHA-256', async () => {
  const token = randomToken();
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(randomToken(), token);
  const digest = await tokenDigest(token);
  assert.equal(digest, await sha256Hex(token));
  assert.notEqual(digest, token, 'the digest is not the token');
});

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

test('validateEmail accepts real addresses and rejects broken ones', () => {
  for (const email of ['a@example.com', 'user.name+tag@example.co.kr', '김@example.com', 'A@EXAMPLE.COM', '  x@example.com  ']) {
    const out = validateEmail(email);
    assert.ok(out.ok, email);
  }
  assert.equal(validateEmail('a@example.com').email, 'a@example.com');
  assert.equal(validateEmail('  X@EXAMPLE.COM  ').email, 'x@example.com', 'trimmed and lower-cased');

  for (const email of [undefined, null, '', '  ', 'a', 'a@', '@example.com', 'a@b', 'a b@example.com', 'a@.com', 'a@example.']) {
    const out = validateEmail(email);
    assert.equal(out.ok, false, String(email));
  }
  assert.equal(validateEmail('a'.repeat(65) + '@example.com').error, 'invalid email', 'local part over 64 chars');
  assert.equal(validateEmail('a@' + 'x'.repeat(254) + '.com').error, 'invalid email', 'domain over 253 chars');
  assert.equal(validateEmail('a@@example.com').error, 'invalid email', 'an embedded @');
  assert.equal(validateEmail('a@' + 'x'.repeat(318) + '.com').error, 'email too long', 'address over 320 chars');
});

test('validateName trims, caps and rejects empty values', () => {
  assert.deepEqual(validateName('  김회원  '), { ok: true, name: '김회원' });
  assert.equal(validateName('').error, 'name required');
  assert.equal(validateName(null).error, 'name required');
  assert.equal(validateName('a'.repeat(61)).error, 'name too long');
  assert.equal(validateName('a'.repeat(60)).ok, true);
});

test('validatePhone accepts Korean mobile formats and rejects junk', () => {
  for (const phone of ['010-1111-2222', '010-1111-2222', '01011112222', '+82-10-1111-2222', '010.1111.2222', '010 1111 2222']) {
    assert.ok(validatePhone(phone).ok, phone);
  }
  for (const phone of [undefined, '', '  ', 'ab', '0123456789012345678901', '!@#', 'a@b', '1 2 3 4 5 6 7 8 9 0 1 2 3']) {
    const out = validatePhone(phone);
    assert.equal(out.ok, false, String(phone));
  }
});

test('validateOptionalText trims and caps free text', () => {
  assert.deepEqual(validateOptionalText('  hello  ', 'label', 10), { ok: true, value: 'hello' });
  assert.deepEqual(validateOptionalText('   ', 'label', 10), { ok: true, value: null });
  assert.deepEqual(validateOptionalText(null, 'label', 10), { ok: true, value: null });
  assert.deepEqual(validateOptionalText(undefined, 'label', 10), { ok: true, value: null });
  const tooLong = validateOptionalText('a'.repeat(11), 'label', 10);
  assert.equal(tooLong.ok, undefined);
  assert.equal(tooLong.error, 'label too long');
});

test('validateText requires non-empty text and caps the length', () => {
  assert.deepEqual(validateText('  hello  ', 'addr', 20), { ok: true, value: 'hello' });
  assert.equal(validateText('', 'addr', 20).error, 'addr required');
  assert.equal(validateText(null, 'addr', 20).error, 'addr required');
  assert.equal(validateText('a'.repeat(21), 'addr', 20).error, 'addr too long');
  assert.equal(validateText('a'.repeat(20), 'addr', 20).ok, true);
});

test('passwordRules reports the policy', () => {
  assert.equal(passwordRules().min, 8);
  assert.equal(passwordRules().max, 128);
  assert.deepEqual(passwordRules().requires, ['a letter', 'an English letter', 'a number', 'a symbol']);
});

test('validatePassword enforces length and complexity', () => {
  assert.equal(validatePassword('').error, 'password required');
  assert.equal(validatePassword('short', {}).error, 'password too short');
  assert.equal(validatePassword('a'.repeat(129)).error, 'password too long');
  assert.equal(validatePassword('abcdefgh1234!').ok, true);

  const cases = [
    ['9!!!!!!!1!!!', 'a letter'],
    ['김김김김김김1!', 'an English letter'],
    ['abcdefgh!!!!', 'a number'],
    ['abcdefgh1234', 'a symbol'],
  ];
  for (const [password, expected] of cases) {
    const out = validatePassword(password);
    assert.equal(out.ok, false, password);
    assert.equal(out.error, 'password too weak', password);
    assert.match(out.detail, new RegExp(expected), `${password} -> ${out.detail}`);
  }
  // Every class satisfied at once.
  assert.equal(validatePassword('김aA1!aaaa').ok, true);
});

test('validatePassword rejects a password that embeds the account email', () => {
  const email = 'kim@example.com';
  assert.equal(validatePassword('kim@example.com', { email }).error, 'password too weak');
  assert.equal(validatePassword('kim@EXAMPLE.COM9!', { email }).error, 'password too weak');
  assert.equal(validatePassword('abcdefgh1234!', { email }).ok, true);
  assert.equal(validatePassword('abcdefgh1234!', { email: '' }).ok, true);
});

test('validatePassword handles Hangul correctly', () => {
  // Hangul counts as a letter but not as an English letter.
  const koreanOnly = validatePassword('김철수김철수1!');
  assert.equal(koreanOnly.ok, false);
  assert.match(koreanOnly.detail, /English letter/);
  // With an English letter it passes.
  assert.equal(validatePassword('kim김철수1!').ok, true);
});

test('hashPassword and verifyPassword survive a reload of the stored string', async () => {
  const stored = await hashPassword('Test!2026-abc', POLICY);
  const reloaded = parseStoredPassword(stored);
  assert.ok(reloaded);
  assert.equal(await verifyPassword('Test!2026-abc', `${reloaded.algo}$${reloaded.iterations}$${reloaded.saltHex}$${reloaded.hashHex}`, POLICY), true);
});

test('token digests are unique per token and deterministic', async () => {
  const tokenA = randomToken();
  const tokenB = randomToken();
  assert.notEqual(await tokenDigest(tokenA), await tokenDigest(tokenB));
  assert.equal(await tokenDigest(tokenA), await tokenDigest(tokenA));
});
