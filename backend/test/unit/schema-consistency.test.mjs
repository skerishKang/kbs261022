// The repository keeps three schema sources in sync: migrations/0001..0014
// (production truth), schema.sql (fresh databases and the local D1 shim) and
// lib/migrate.mjs (guarded upgrades). This test applies the migrations to a
// brand-new SQLite database and compares the tables and columns with schema.sql,
// so drift is caught here instead of in production.

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, '..', '..');

function applySql(db, file) {
  db.exec(readFileSync(file, 'utf8'));
}

function shape(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => row.name);
  const out = {};
  for (const table of tables) {
    out[table] = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name).sort();
  }
  return out;
}

function columnDefault(db, table, column) {
  const row = db.prepare(`PRAGMA table_info(${table})`).all().find((entry) => entry.name === column);
  return row ? row.dflt_value : undefined;
}

function migratedDatabase(upto = '0011') {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(join(BACKEND, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => name.slice(0, 4) <= upto);
  for (const name of files) applySql(db, join(BACKEND, 'migrations', name));
  return db;
}

test('schema.sql matches a fresh database built from migrations 0001-0014', () => {
  const fromMigrations = shape(migratedDatabase('0014'));
  const schemaDb = new DatabaseSync(':memory:');
  applySql(schemaDb, join(BACKEND, 'schema.sql'));
  const schemaShape = shape(schemaDb);

  assert.deepEqual(Object.keys(schemaShape), Object.keys(fromMigrations), 'same table set');
  for (const table of Object.keys(fromMigrations)) {
    assert.deepEqual(schemaShape[table], fromMigrations[table], `${table} columns match`);
  }
});

test('payments.provider defaults to nicepay in both schema sources', () => {
  const fromMigrations = migratedDatabase('0011');
  assert.equal(columnDefault(fromMigrations, 'payments', 'provider'), "'nicepay'");
  const schemaDb = new DatabaseSync(':memory:');
  applySql(schemaDb, join(BACKEND, 'schema.sql'));
  assert.equal(columnDefault(schemaDb, 'payments', 'provider'), "'nicepay'");
});

test('migration 0011 adds consent columns and backfills existing consent events', () => {
  const db = migratedDatabase('0010');
  const now = '2026-11-01T00:00:00.000Z';
  db.prepare("INSERT INTO members (email, password_hash, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run('backfill@example.com', 'pbkdf2-sha512$1$aa$bb', '백필회원', 'active', now, now);
  const member = db.prepare('SELECT id FROM members WHERE email = ?').get('backfill@example.com');
  db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?,?,?,?)')
    .run(member.id, 'consent', JSON.stringify({ terms: true, privacy: true, terms_version: 'v1', privacy_version: 'v1' }), now);
  // A second, older consent record must not win the backfill.
  db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?,?,?,?)')
    .run(member.id, 'consent', JSON.stringify({ terms_version: 'v0', privacy_version: 'v0' }), '2026-10-01T00:00:00.000Z');

  applySql(db, join(BACKEND, 'migrations', '0011_member_consent.sql'));

  const row = db.prepare('SELECT terms_consent_version, privacy_consent_version, consented_at FROM members WHERE id = ?').get(member.id);
  assert.equal(row.terms_consent_version, 'v1');
  assert.equal(row.privacy_consent_version, 'v1');
  assert.equal(row.consented_at, now);

  // A member with no consent event stays NULL instead of inventing consent.
  db.prepare("INSERT INTO members (email, password_hash, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run('noconsent@example.com', 'pbkdf2-sha512$1$aa$bb', '무동의회원', 'active', now, now);
  const untouched = db.prepare('SELECT terms_consent_version FROM members WHERE email = ?').get('noconsent@example.com');
  assert.equal(untouched.terms_consent_version, null);
});

test('migration 0014 moves #226 feedback values to the lovetree codes and is safe to re-run', () => {
  const db = migratedDatabase('0013');
  const now = '2026-11-20T00:00:00.000Z';
  const ins = db.prepare("INSERT INTO feedback (id, created_at, kind, body, status, updated_at) VALUES (?,?,?,?,?,?)");
  ins.run('FB-1', now, 'idea', 'a', 'checking', now);
  ins.run('FB-2', now, 'bug', 'b', 'answered', now);
  ins.run('FB-3', now, 'product', 'c', 'on_hold', now);
  ins.run('FB-4', now, 'weird', 'd', 'mystery', now);
  ins.run('FB-5', now, 'inconvenient', 'e', 'fixed', now);
  const file = join(BACKEND, 'migrations', '0014_ops_center_align.sql');
  applySql(db, file);
  const rows = Object.fromEntries(db.prepare('SELECT id, kind, status FROM feedback ORDER BY id').all().map((r) => [r.id, `${r.kind}/${r.status}`]));
  assert.deepEqual(rows, {
    'FB-1': 'feature/reviewing',
    'FB-2': 'bug/closed',
    'FB-3': 'product/later',
    'FB-4': 'other/received',
    'FB-5': 'inconvenient/fixed',
  });
  // 다시 실행해도 값이 바뀌지 않고 오류도 없다.
  applySql(db, file);
  const again = Object.fromEntries(db.prepare('SELECT id, kind, status FROM feedback ORDER BY id').all().map((r) => [r.id, `${r.kind}/${r.status}`]));
  assert.deepEqual(again, rows);
  // 같은 회원·같은 날짜 일지는 한 건뿐이다.
  db.prepare("INSERT INTO feedback_journal (member_id, journal_date, body, created_at, updated_at) VALUES (1, '2026-11-20', 'x', ?, ?)").run(now, now);
  assert.throws(() => db.prepare("INSERT INTO feedback_journal (member_id, journal_date, body, created_at, updated_at) VALUES (1, '2026-11-20', 'y', ?, ?)").run(now, now));
});
