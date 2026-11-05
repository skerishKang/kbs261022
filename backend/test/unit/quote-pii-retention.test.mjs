// 견적 문의 개인정보 보관(PR-3): 주문으로 이어지지 않은 견적은 생성 1년 뒤
// 개인정보 칸만 비우고 행은 남긴다. 주문으로 이어진 견적과 기한 전 견적은 유지.
import test from 'node:test';
import assert from 'node:assert/strict';

import { openD1 } from '../../d1-shim.mjs';
import {
  purgeExpiredQuotePii,
  QUOTE_PII_BATCH_SIZE,
  QUOTE_PII_RETENTION_DAYS,
} from '../../lib/retention.mjs';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const OLD = '2025-10-01T00:00:00.000Z';       // 1년 초과
const RECENT = '2026-10-01T00:00:00.000Z';    // 1년 이내

function insertQuote(db, id, createdAt, overrides = {}) {
  db.prepare(
    `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, email, location, note, services, items, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, createdAt,
    overrides.company || '테스트 회사',
    overrides.contact_name || '홍길동',
    overrides.phone || '010-1234-5678',
    overrides.email === undefined ? `${id}@example.com` : overrides.email,
    overrides.location === undefined ? '광주광역시' : overrides.location,
    overrides.note || '설치 문의',
    '[]',
    JSON.stringify([{ id: 'x', qty: 1 }]),
    overrides.status || 'received',
  ).run();
}

function insertOrderForQuote(db, orderId, quoteId) {
  db.prepare(
    `INSERT INTO orders (id, kind, status, created_at, updated_at,
       customer_company, customer_name, customer_phone, source_quote_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(orderId, 'quote', 'pending', RECENT, RECENT, '테스트 회사', '홍길동', '010-1234-5678', quoteId).run();
}

function getQuote(db, id) {
  return db.prepare('SELECT * FROM quote_requests WHERE id = ?').bind(id).first();
}

test('unconverted quotes older than a year lose PII; the row survives', async () => {
  const db = openD1();
  try {
    insertQuote(db, 'Q-old', OLD);
    insertQuote(db, 'Q-recent', RECENT);
    insertQuote(db, 'Q-linked', OLD);
    insertOrderForQuote(db, 'ORD-LINKED', 'Q-linked');

    const changes = await purgeExpiredQuotePii(db, { now: NOW });
    assert.equal(changes, 1);

    const old = getQuote(db, 'Q-old');
    assert.ok(old, 'the row is kept');
    assert.equal(old.contact_name, '');
    assert.equal(old.phone, '');
    assert.equal(old.email, null);
    assert.equal(old.location, null);
    assert.equal(old.company, '테스트 회사', 'company is not one of the four PII columns');
    assert.equal(old.note, '설치 문의', 'memo is kept');

    const recent = getQuote(db, 'Q-recent');
    assert.equal(recent.contact_name, '홍길동');
    assert.equal(recent.email, 'Q-recent@example.com');

    const linked = getQuote(db, 'Q-linked');
    assert.equal(linked.contact_name, '홍길동', 'a quote that became an order keeps its PII');
    assert.equal(linked.email, 'Q-linked@example.com');

    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM quote_requests').get().n, 3);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  } finally {
    db._db.close();
  }
});

test('the boundary is strict and the batch size is bounded', async () => {
  const db = openD1();
  try {
    const exactlyCutoff = new Date(NOW.getTime() - QUOTE_PII_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
    insertQuote(db, 'Q-at', exactlyCutoff);
    insertQuote(db, 'Q-before', new Date(Date.parse(exactlyCutoff) - 1000).toISOString());
    insertQuote(db, 'Q-before2', new Date(Date.parse(exactlyCutoff) - 2000).toISOString());

    const first = await purgeExpiredQuotePii(db, { now: NOW, batchSize: 1 });
    assert.equal(first, 1, 'batchSize caps one run');
    assert.equal(getQuote(db, 'Q-at').contact_name, '홍길동', 'exactly at the cutoff is kept');

    const second = await purgeExpiredQuotePii(db, { now: NOW, batchSize: 1 });
    assert.equal(second, 1);
    const third = await purgeExpiredQuotePii(db, { now: NOW, batchSize: 1 });
    assert.equal(third, 0, 'only rows with PII left are updated');

    await assert.rejects(() => purgeExpiredQuotePii(db, { now: NOW, batchSize: 0 }), RangeError);
    await assert.rejects(() => purgeExpiredQuotePii(db, { now: NOW, batchSize: QUOTE_PII_BATCH_SIZE + 1 }), RangeError);
  } finally {
    db._db.close();
  }
});

test('the scheduled purge includes quote PII and never touches transaction tables', async () => {
  const db = openD1();
  try {
    insertQuote(db, 'Q-old', OLD);
    db.prepare(
      `INSERT INTO members (email, password_hash, name, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).bind('retained@example.test', 'hash', 'Retained', OLD, OLD).run();
    insertOrderForQuote(db, 'ORD-KEEP', 'Q-old');
    // 주문으로 이어진 경우는 위 테스트에서 확인했으므로 여기서는 연결을 지우고
    // 회원·주문 테이블이 그대로인지만 본다.
    db.prepare('DELETE FROM orders WHERE id = ?').bind('ORD-KEEP').run();
    insertOrderForQuote(db, 'ORD-OTHER', 'Q-other');
    insertOrderForQuote(db, 'ORD-OTHER2', 'Q-other2');

    const changes = await purgeExpiredQuotePii(db, { now: NOW });
    assert.equal(changes, 1);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 1);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 2);
  } finally {
    db._db.close();
  }
});
