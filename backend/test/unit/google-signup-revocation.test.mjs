// Launch-blocker regression: the shared Google-only password hash and the
// 0010 data migration that revokes it without touching a member who has since
// set a password through reset or change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openD1 } from '../../d1-shim.mjs';
import {
  GOOGLE_SIGNUP_PASSWORD_SENTINEL,
  revokeGoogleSignupPasswords,
} from '../../lib/migrate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, '..', '..', 'migrations', '0010_revoke_google_signup_passwords.sql'), 'utf8');
const LEGACY = 'pbkdf2-sha512$1000$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CHANGED = 'pbkdf2-sha512$1000$cccccccccccccccccccccccccccccccc$dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

async function dbWithMembers() {
  const db = openD1();
  const rows = [
    [1, 'legacy-google@example.test', LEGACY, 'google-1'],
    [2, 'reset-google@example.test', LEGACY, 'google-2'],
    [3, 'changed-google@example.test', CHANGED, 'google-3'],
    [4, 'not-google@example.test', LEGACY, null],
    [5, 'google-no-signup@example.test', LEGACY, 'google-5'],
  ];
  for (const [id, email, hash, googleId] of rows) {
    await db.prepare('INSERT INTO members (id, email, password_hash, name, google_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, email, hash, email.split('@')[0], googleId, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z').run();
  }
  const events = [
    [1, 1, 'google_signup'],
    [2, 2, 'google_signup'], [3, 2, 'password_reset'],
    [4, 3, 'google_signup'], [5, 3, 'password_changed'],
    [6, 4, 'signup'],
  ];
  for (const [id, memberId, type] of events) {
    await db.prepare('INSERT INTO member_events (id, member_id, type, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, memberId, type, '2026-11-01T00:00:00.000Z').run();
  }
  return db;
}

const hashOf = async (db, id) => (await db.prepare('SELECT password_hash FROM members WHERE id = ?').bind(id).first()).password_hash;

test('migration 0010 revokes only Google-signup members who never set a password', async () => {
  const db = await dbWithMembers();
  await db.exec(MIGRATION);
  assert.equal(await hashOf(db, 1), GOOGLE_SIGNUP_PASSWORD_SENTINEL);
  assert.equal(await hashOf(db, 2), LEGACY, 'a completed reset keeps the usable password');
  assert.equal(await hashOf(db, 3), CHANGED, 'a password change keeps the usable password');
  assert.equal(await hashOf(db, 4), LEGACY, 'a non-Google member is untouched');
  assert.equal(await hashOf(db, 5), LEGACY, 'the google_signup event is required');
});

test('the schema-init data upgrade is idempotent and returns the affected count', async () => {
  const db = await dbWithMembers();
  assert.equal(await revokeGoogleSignupPasswords(db), 1);
  assert.equal(await revokeGoogleSignupPasswords(db), 0);
  assert.equal(await hashOf(db, 1), GOOGLE_SIGNUP_PASSWORD_SENTINEL);
});
