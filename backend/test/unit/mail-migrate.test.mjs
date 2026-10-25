import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAIL_MODES, createMailAdapter } from '../../lib/mail.mjs';
import { COLUMN_UPGRADES, tableColumns, ensureColumns } from '../../lib/migrate.mjs';
import { openD1, applyColumnUpgrades } from '../../d1-shim.mjs';

const MESSAGE = {
  to: 'kim@example.com',
  subject: 'CGI email verification',
  text: 'please verify your account',
  url: 'https://example.com/verify?token=tok_1',
  token: 'tok_1',
};

test('console mode logs and never delivers', async () => {
  const logs = [];
  const mail = createMailAdapter({ MAIL_MODE: 'console' }, (line) => logs.push(line));
  const out = await mail.deliver(MESSAGE);
  assert.deepEqual(out, {
    delivered: false,
    channel: 'console-log',
    note: 'EMAIL 발송 미연결: 메시지는 Worker 로그로만 기록되었습니다',
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /console/);
  assert.match(logs[0], /kim@example.com/);
  assert.match(logs[0], /verify/);
});

test('echo mode returns the token so a local environment can verify', async () => {
  const mail = createMailAdapter({ MAIL_MODE: 'echo' });
  const out = await mail.deliver(MESSAGE);
  assert.equal(out.delivered, false);
  assert.equal(out.channel, 'echo');
  assert.equal(out.token, 'tok_1');
  assert.equal(out.url, MESSAGE.url);
});

test('sendgrid mode without API key returns unconfigured', async () => {
  const mail = createMailAdapter({ MAIL_MODE: 'sendgrid' });
  const out = await mail.deliver(MESSAGE);
  assert.equal(out.delivered, false);
  assert.equal(out.channel, 'unconfigured');
  assert.match(out.note, /SENDGRID_API_KEY/);
  assert.equal(out.token, undefined);
});

test('sendgrid mode with API key sends the message and returns delivered', async () => {
  const origFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    const mail = createMailAdapter({
      MAIL_MODE: 'sendgrid',
      SENDGRID_API_KEY: 'SG.test_key',
      MAIL_FROM: 'CGI <noreply@test.com>',
    });
    const out = await mail.deliver(MESSAGE);
    assert.equal(out.delivered, true);
    assert.equal(out.channel, 'sendgrid');
    assert.ok(captured);
    assert.match(captured.url, /api\.sendgrid\.com/);
    assert.match(captured.init.headers.Authorization, /Bearer SG\.test_key/);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.personalizations[0].to[0].email, MESSAGE.to);
    assert.equal(body.from.email, 'noreply@test.com');
    assert.equal(body.content.length, 2);
    assert.ok(body.content[1].value.includes('CGI'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('sendgrid mode reports API errors', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return { ok: false, status: 403, text: async () => JSON.stringify({ errors: [{ message: 'bad key' }] }) };
  };
  try {
    const mail = createMailAdapter({
      MAIL_MODE: 'sendgrid',
      SENDGRID_API_KEY: 'SG.bad_key',
    });
    const out = await mail.deliver(MESSAGE);
    assert.equal(out.delivered, false);
    assert.equal(out.channel, 'sendgrid');
    assert.match(out.note, /403/);
    assert.match(out.note, /bad key/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('sendgrid mode reports network errors', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const mail = createMailAdapter({
      MAIL_MODE: 'sendgrid',
      SENDGRID_API_KEY: 'SG.test_key',
    });
    const out = await mail.deliver(MESSAGE);
    assert.equal(out.delivered, false);
    assert.equal(out.channel, 'sendgrid');
    assert.match(out.note, /ECONNREFUSED/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resend mode without API key returns unconfigured', async () => {
  const mail = createMailAdapter({ MAIL_MODE: 'resend' });
  const out = await mail.deliver(MESSAGE);
  assert.equal(out.delivered, false);
  assert.equal(out.channel, 'unconfigured');
  assert.match(out.note, /CGI_RESEND_API_KEY/);
  assert.equal(out.token, undefined);
});

test('resend mode with API key sends the message and returns delivered', async () => {
  const origFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'resend_msg_1' }) };
  };
  try {
    const mail = createMailAdapter({
      MAIL_MODE: 'resend',
      CGI_RESEND_API_KEY: 're_test_key_abc12345',
      MAIL_FROM: 'CGI <noreply@test.com>',
    });
    const out = await mail.deliver(MESSAGE);
    assert.equal(out.delivered, true);
    assert.equal(out.channel, 'resend');
    assert.ok(captured);
    assert.match(captured.url, /api\.resend\.com/);
    assert.match(captured.init.headers.Authorization, /Bearer re_test_key_abc12345/);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.from, 'noreply@test.com');
    assert.deepEqual(body.to, [MESSAGE.to]);
    assert.equal(body.subject, MESSAGE.subject);
    assert.ok(body.text);
    assert.ok(body.html);
    assert.ok(body.html.includes('CGI'));
    // The API key must never appear in the body
    assert.ok(!body.text.includes('re_test_key'));
    assert.ok(!body.html.includes('re_test_key'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resend mode reports API errors', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return { ok: false, status: 401, text: async () => JSON.stringify({ message: 'Unauthorized' }) };
  };
  try {
    const mail = createMailAdapter({
      MAIL_MODE: 'resend',
      CGI_RESEND_API_KEY: 're_bad_key_12345',
    });
    const out = await mail.deliver(MESSAGE);
    assert.equal(out.delivered, false);
    assert.equal(out.channel, 'resend');
    assert.match(out.note, /401/);
    assert.match(out.note, /Unauthorized/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resend mode reports network errors', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const mail = createMailAdapter({
      MAIL_MODE: 'resend',
      CGI_RESEND_API_KEY: 're_test_key_abc12345',
    });
    const out = await mail.deliver(MESSAGE);
    assert.equal(out.delivered, false);
    assert.equal(out.channel, 'resend');
    assert.match(out.note, /ECONNREFUSED/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('an unknown mode falls back to console and is logged as such', async () => {
  const logs = [];
  const mail = createMailAdapter({ MAIL_MODE: 'postmark' }, (line) => logs.push(line));
  assert.equal(mail.mode, 'console');
  const out = await mail.deliver(MESSAGE);
  assert.equal(out.channel, 'console-log');
  assert.match(logs[0], /MAIL:console/);
});

test('urlFor builds a stable link with a token query parameter', () => {
  const mail = createMailAdapter({ MAIL_BASE_URL: 'https://site.example/kbs' });
  assert.equal(mail.urlFor('/auth/verify', 'tok_1'), 'https://site.example/kbs/auth/verify?token=tok_1');
  assert.equal(mail.urlFor('auth/verify', 'tok_1'), 'https://site.example/kbs/auth/verify?token=tok_1');
  assert.equal(mail.urlFor('/auth/verify?step=1', 'tok_1'), 'https://site.example/kbs/auth/verify?step=1&token=tok_1');
  assert.equal(mail.urlFor('/auth/verify', ''), 'https://site.example/kbs/auth/verify');
  assert.equal(mail.urlFor('/auth/verify', null), 'https://site.example/kbs/auth/verify');
  assert.equal(mail.urlFor('/auth/verify?x=%2F', 'tok_1'), 'https://site.example/kbs/auth/verify?x=%2F&token=tok_1');
});

test('the adapter never marks anything verified by itself', async () => {
  for (const mode of MAIL_MODES) {
    const mail = createMailAdapter({ MAIL_MODE: mode });
    const out = await mail.deliver(MESSAGE);
    assert.equal(out.delivered, false, mode);
    assert.equal(out.verified, undefined, mode);
  }
});

test('from is configurable and has a safe default', () => {
  assert.equal(createMailAdapter({}).from, 'CGI no-reply <no-reply@cgi.example>');
  assert.equal(createMailAdapter({ MAIL_FROM: 'CGI <owner@example.com>' }).from, 'CGI <owner@example.com>');
});

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------

test('COLUMN_UPGRADES lists every member link and role', () => {
  assert.deepEqual(
    COLUMN_UPGRADES.map((upgrade) => `${upgrade.table}.${upgrade.column}`),
    ['orders.customer_id', 'quote_requests.member_id', 'members.role'],
  );
  for (const upgrade of COLUMN_UPGRADES) {
    assert.match(upgrade.ddl, new RegExp(`ADD COLUMN ${upgrade.column}`));
  }
});

test('tableColumns returns the column names or an empty list for a missing table', async () => {
  const db = openD1();
  assert.deepEqual(await tableColumns(db, 'members'), [
    'id', 'email', 'password_hash', 'name', 'phone', 'company',
    'email_verified_at', 'role', 'status', 'created_at', 'updated_at', 'deleted_at',
  ]);
  assert.deepEqual(await tableColumns(db, 'no_such_table'), []);
});

test('ensureColumns is idempotent and reports what it applied', async () => {
  const db = openD1();
  assert.deepEqual(await ensureColumns(db), []);
  assert.deepEqual(await ensureColumns(db), []);

  // Dropping a column and re-running applies exactly the one missing upgrade.
  db._db.exec('ALTER TABLE orders RENAME TO orders_renamed');
  db._db.exec(`CREATE TABLE orders (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  const applied = await ensureColumns(db);
  assert.deepEqual(applied, ['ALTER TABLE orders ADD COLUMN customer_id INTEGER']);
  assert.ok((await tableColumns(db, 'orders')).includes('customer_id'));

  // Now fully populated: nothing more to do.
  assert.deepEqual(await ensureColumns(db), []);
});

test('applyColumnUpgrades adds only the missing columns', () => {
  const db = openD1();
  applyColumnUpgrades(db._db);
  const orders = db._db.prepare('PRAGMA table_info(orders)').all().map((row) => row.name);
  assert.ok(orders.includes('customer_id'));
  const quotes = db._db.prepare('PRAGMA table_info(quote_requests)').all().map((row) => row.name);
  assert.ok(quotes.includes('member_id'));
});

test('a fresh schema.sql already contains the upgraded columns', async () => {
  const db = openD1();
  for (const table of ['members', 'member_addresses', 'auth_tokens', 'auth_attempts', 'member_events']) {
    const columns = await tableColumns(db, table);
    assert.ok(columns.length > 0, table);
  }
  assert.ok((await tableColumns(db, 'orders')).includes('customer_id'));
  assert.ok((await tableColumns(db, 'quote_requests')).includes('member_id'));
});
