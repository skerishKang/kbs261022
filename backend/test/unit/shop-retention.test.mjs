import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';
import {
  purgeExpiredShopLogs,
  SHOP_LOG_BATCH_SIZE,
  SHOP_LOG_RETENTION_DAYS,
} from '../../lib/retention.mjs';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const CUTOFF = '2026-08-05T12:00:00.000Z';
const BEFORE_CUTOFF = '2026-08-05T11:59:59.000Z';
const AFTER_CUTOFF = '2026-08-05T12:00:01.000Z';

function openShopD1() {
  const db = openD1();
  const migration = readFileSync(new URL('../../migrations/0005_product_sync_state.sql', import.meta.url), 'utf8');
  db._db.exec(migration);
  return db;
}

function insertAuthAttempt(db, key, lastAt) {
  db.prepare(
    'INSERT INTO auth_attempts (kind, key, count, first_at, last_at) VALUES (?, ?, ?, ?, ?)',
  ).bind('login', key, 1, lastAt, lastAt).run();
}

function insertMemberEvent(db, type, createdAt) {
  db.prepare(
    'INSERT INTO member_events (member_id, type, created_at) VALUES (?, ?, ?)',
  ).bind(null, type, createdAt).run();
}

function insertProductChange(db, cgiId, detectedAt) {
  db.prepare(
    'INSERT INTO product_change_log (cgi_id, change_type, hash_after, detected_at) VALUES (?, ?, ?, ?)',
  ).bind(cgiId, 'updated', `hash-${cgiId}`, detectedAt).run();
}

test('90-day cutoff removes only rows strictly older than the boundary', async () => {
  const db = openShopD1();
  try {
    for (const [key, stamp] of [
      ['auth-old', BEFORE_CUTOFF], ['auth-at', CUTOFF], ['auth-new', AFTER_CUTOFF],
    ]) insertAuthAttempt(db, key, stamp);
    for (const [type, stamp] of [
      ['event-old', BEFORE_CUTOFF], ['event-at', CUTOFF], ['event-new', AFTER_CUTOFF],
    ]) insertMemberEvent(db, type, stamp);
    for (const [cgiId, stamp] of [
      ['product-old', BEFORE_CUTOFF], ['product-at', CUTOFF], ['product-new', AFTER_CUTOFF],
    ]) insertProductChange(db, cgiId, stamp);
    // product_change_log's historical DEFAULT uses SQLite's space-separated UTC form.
    for (const [cgiId, stamp] of [
      ['product-sql-old', '2026-08-05 11:59:59'],
      ['product-sql-at', '2026-08-05 12:00:00'],
      ['product-sql-new', '2026-08-05 12:00:01'],
    ]) insertProductChange(db, cgiId, stamp);

    const counts = await purgeExpiredShopLogs(db, { now: NOW });

    assert.deepEqual(counts, {
      auth_attempts: 1,
      member_events: 1,
      product_change_log: 2,
    });
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM auth_attempts').get().n, 2);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM member_events').get().n, 2);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM product_change_log').get().n, 4);
    assert.equal(SHOP_LOG_RETENTION_DAYS, 90);
  } finally {
    db._db.close();
  }
});

test('orders, quotes, payments, transaction events and token rows are outside the purge list', async () => {
  const db = openShopD1();
  try {
    const member = db.prepare(
      `INSERT INTO members (email, password_hash, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind('retained@example.test', 'test-hash', 'Retained member', BEFORE_CUTOFF, BEFORE_CUTOFF).run();
    db.prepare(
      `INSERT INTO member_addresses (member_id, label, recipient_name, phone, addr, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(member.meta.last_row_id, 'home', 'Retained member', '01000000000', 'Test address', BEFORE_CUTOFF, BEFORE_CUTOFF).run();
    db.prepare(
      `INSERT INTO orders (id, kind, status, created_at, updated_at,
        customer_company, customer_name, customer_phone, total_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind('order-retained', 'purchase', 'paid', BEFORE_CUTOFF, BEFORE_CUTOFF,
      'Example Co', 'Example', '01000000000', 5000).run();
    db.prepare(
      `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, items)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('quote-retained', BEFORE_CUTOFF, 'Example Co', 'Example', '01000000000', '[]').run();
    db.prepare(
      `INSERT INTO payments (order_id, payment_key, pg_order_id, amount, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('order-retained', 'payment-retained', 'pg-retained', 5000, 'paid', BEFORE_CUTOFF, BEFORE_CUTOFF).run();
    db.prepare(
      'INSERT INTO order_events (order_id, type, error, created_at) VALUES (?, ?, ?, ?)'
    ).bind('order-retained', 'payment_confirmed', 'historical provider outcome', BEFORE_CUTOFF).run();
    db.prepare(
      `INSERT INTO erp_sync (order_id, dedupe_key, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind('order-retained', 'dedupe-retained', '{}', BEFORE_CUTOFF, BEFORE_CUTOFF).run();
    db.prepare(
      `INSERT INTO auth_tokens (kind, token_hash, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind('session', 'digest-only', 'expired', '2025-01-01T00:00:00.000Z', '2024-12-01T00:00:00.000Z').run();
    db.prepare(
      `INSERT INTO product_sync_state (cgi_id, target, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind('catalog-item-retained', 'erp', 'failed', BEFORE_CUTOFF, BEFORE_CUTOFF).run();

    await purgeExpiredShopLogs(db, { now: NOW });

    for (const table of ['members', 'member_addresses', 'orders', 'quote_requests', 'payments', 'order_events', 'erp_sync', 'auth_tokens', 'product_sync_state']) {
      assert.equal(db._db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);
    }
  } finally {
    db._db.close();
  }
});

test('each log table is limited to one batch per scheduled pass', async () => {
  const db = openShopD1();
  try {
    for (let i = 0; i < 5; i += 1) {
      const key = `auth-${i}`;
      const event = `event-${i}`;
      const product = `product-${i}`;
      insertAuthAttempt(db, key, BEFORE_CUTOFF);
      insertMemberEvent(db, event, BEFORE_CUTOFF);
      insertProductChange(db, product, BEFORE_CUTOFF);
    }

    const counts = await purgeExpiredShopLogs(db, { now: NOW, batchSize: 2 });

    assert.deepEqual(counts, {
      auth_attempts: 2,
      member_events: 2,
      product_change_log: 2,
    });
    assert.equal(SHOP_LOG_BATCH_SIZE, 500);
    for (const table of ['auth_attempts', 'member_events', 'product_change_log']) {
      assert.equal(db._db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 3);
    }
  } finally {
    db._db.close();
  }
});

test('scheduled worker reports table counts only and registers one daily cron', async () => {
  const db = openShopD1();
  const oldStamp = new Date(Date.now() - (SHOP_LOG_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
  insertAuthAttempt(db, 'must-not-be-logged', oldStamp);
  let scheduledWork;
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await worker.scheduled({}, { DB: db }, { waitUntil(promise) { scheduledWork = promise; } });
    await scheduledWork;
  } finally {
    console.log = originalLog;
    db._db.close();
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^SHOP_RETENTION_PURGE=ok detail=/);
  assert.doesNotMatch(lines[0], /must-not-be-logged/);
  const crons = [...readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
    .matchAll(/^\s*crons\s*=\s*(.+)$/gm)].map((match) => match[1].trim());
  assert.deepEqual(crons, ['["0 3 * * *"]']);
});

test('0007 adds an efficient created_at index for member service events', () => {
  const db = openD1();
  try {
    db._db.exec('DROP INDEX idx_member_events_created_at');
    const migration = readFileSync(new URL('../../migrations/0007_shop_retention_index.sql', import.meta.url), 'utf8');
    db._db.exec(migration);
    const columns = db._db.prepare('PRAGMA index_info(idx_member_events_created_at)').all();
    assert.deepEqual(columns.map((row) => row.name), ['created_at']);
  } finally {
    db._db.close();
  }
});
