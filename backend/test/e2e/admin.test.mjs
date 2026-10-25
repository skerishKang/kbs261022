import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PRICE_INDEX } from '../../data/price_index.mjs';
import { openD1 } from '../../d1-shim.mjs';
import { makeEnv, call, auth, CUSTOMER, purchaseCart, pricedProductIds } from '../helpers.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const PASSWORD = 'Test!2026-abc';
const csrf = { 'X-CSRF-Token': ORIGIN };

const [PA, PB] = pricedProductIds(3);
const TOTAL = PRICE_INDEX[PA].p * 2 + PRICE_INDEX[PB].p;

async function seed(env) {
  const specs = [
    { id: 'a', company: '[E2E] Alpha 회사', phone: '010-0000-0001' },
    { id: 'b', company: '[E2E] Beta 회사', phone: '010-0000-0002' },
    { id: 'c', company: '[E2E] Gamma 회사', phone: '010-0000-0003' },
  ];
  const orders = {};
  for (const spec of specs) {
    const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER, ...spec });
    assert.equal(created.status, 201, created.text);
    orders[spec.id] = created.json;
  }
  // pay the second one
  const paid = await call(env, 'POST', '/api/payments/confirm', {
    orderId: orders.b.id,
    paymentKey: 'pk_admin_b',
    amount: TOTAL,
  });
  assert.equal(paid.status, 200, paid.text);
  return orders;
}

test('requires admin auth for the order list', async () => {
  const env = makeEnv();
  await seed(env);
  assert.equal((await call(env, 'GET', '/api/orders')).status, 401);
  assert.equal((await call(env, 'GET', '/api/orders', undefined, { Authorization: 'Bearer wrong' })).status, 401);
});

test('lists orders newest first and applies filters', async () => {
  const env = makeEnv();
  const orders = await seed(env);

  const all = await call(env, 'GET', '/api/orders', undefined, auth());
  assert.equal(all.status, 200);
  assert.equal(all.json.count, 3);
  assert.equal(all.json.items[0].id, orders.c.id, 'newest first');

  const byStatus = await call(env, 'GET', '/api/orders?status=paid', undefined, auth());
  assert.equal(byStatus.json.count, 1);
  assert.equal(byStatus.json.items[0].id, orders.b.id);

  const byPayment = await call(env, 'GET', '/api/orders?payment_status=paid', undefined, auth());
  assert.equal(byPayment.json.count, 1);

  const awaiting = await call(env, 'GET', '/api/orders?status=awaiting_payment', undefined, auth());
  assert.equal(awaiting.json.count, 2);

  const limited = await call(env, 'GET', '/api/orders?limit=2', undefined, auth());
  assert.equal(limited.json.count, 2);

  const tooLarge = await call(env, 'GET', '/api/orders?limit=99999', undefined, auth());
  assert.equal(tooLarge.json.count, 3, 'limit is capped');
  const negative = await call(env, 'GET', '/api/orders?limit=-5', undefined, auth());
  assert.equal(negative.json.count, 3);
});

test('searches by id, company, contact and phone', async () => {
  const env = makeEnv();
  const orders = await seed(env);

  const byCompany = await call(env, 'GET', '/api/orders?q=Alpha', undefined, auth());
  assert.equal(byCompany.json.count, 1);
  assert.equal(byCompany.json.items[0].id, orders.a.id);

  const byContact = await call(env, 'GET', '/api/orders?q=' + encodeURIComponent(CUSTOMER.name), undefined, auth());
  assert.equal(byContact.json.count, 3, 'all orders share the same contact');

  const byPhone = await call(env, 'GET', '/api/orders?q=0000-0003', undefined, auth());
  assert.equal(byPhone.json.count, 1);

  const byId = await call(env, 'GET', `/api/orders?q=${orders.b.id.slice(-5)}`, undefined, auth());
  assert.equal(byId.json.count, 1);

  const none = await call(env, 'GET', '/api/orders?q=존재하지않는회사', undefined, auth());
  assert.equal(none.json.count, 0);

  const combined = await call(env, 'GET', '/api/orders?status=awaiting_payment&q=Alpha', undefined, auth());
  assert.equal(combined.json.count, 1);
});

test('kind filter separates quote and purchase orders', async () => {
  const env = makeEnv();
  const purchase = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER, phone: '010-1111-0001' });
  assert.equal(purchase.status, 201);
  const [a] = pricedProductIds(1);
  const quote = await call(env, 'POST', '/api/orders', {
    ...CUSTOMER,
    phone: '010-1111-0002',
    items: [{ product_id: a, qty: 1 }, { product_id: 'nope:1', qty: 1 }],
  });
  assert.equal(quote.status, 201);

  const purchases = await call(env, 'GET', '/api/orders?kind=purchase', undefined, auth());
  assert.equal(purchases.json.count, 1);
  assert.equal(purchases.json.items[0].kind, 'purchase');

  const quotes = await call(env, 'GET', '/api/orders?kind=quote', undefined, auth());
  assert.equal(quotes.json.count, 1);
  assert.equal(quotes.json.items[0].kind, 'quote');
});

test('walks the fulfillment statuses and rejects illegal transitions', async () => {
  const env = makeEnv();
  const orders = await seed(env);
  const id = orders.b.id;

  const processing = await call(env, 'PATCH', `/api/orders/${id}`, { status: 'processing' }, auth());
  assert.equal(processing.status, 200, processing.text);
  assert.equal(processing.json.changed, true);
  assert.equal(processing.json.order.status, 'processing');
  assert.equal(processing.json.order.delivery_status, 'processing');

  const shipped = await call(env, 'PATCH', `/api/orders/${id}`, { status: 'shipped', delivery_tracking: 'TRACK-12345' }, auth());
  assert.equal(shipped.status, 200);
  assert.equal(shipped.json.order.status, 'shipped');
  assert.equal(shipped.json.order.delivery_status, 'shipped');
  assert.equal(shipped.json.order.delivery.tracking, 'TRACK-12345');

  const delivered = await call(env, 'PATCH', `/api/orders/${id}`, { status: 'delivered' }, auth());
  assert.equal(delivered.status, 200);
  assert.equal(delivered.json.order.delivery_status, 'delivered');

  const illegal = await call(env, 'PATCH', `/api/orders/${id}`, { status: 'awaiting_payment' }, auth());
  assert.equal(illegal.status, 400);
  assert.equal(illegal.json.error, 'transition not allowed');
  assert.deepEqual(illegal.json.detail, { from: 'delivered', to: 'awaiting_payment', allowed: ['refunding'] });

  const forced = await call(env, 'PATCH', `/api/orders/${id}`, { status: 'processing', force: true }, auth());
  assert.equal(forced.status, 200);
  assert.equal(forced.json.order.status, 'processing');
});

test('rejects unknown statuses and delivery statuses', async () => {
  const env = makeEnv();
  const orders = await seed(env);
  const id = orders.a.id;

  const badStatus = await call(env, 'PATCH', `/api/orders/${id}`, { status: 'banana' }, auth());
  assert.equal(badStatus.status, 400);
  assert.equal(badStatus.json.error, 'unknown status');
  assert.ok(badStatus.json.detail.valid.includes('awaiting_payment'));

  const badDelivery = await call(env, 'PATCH', `/api/orders/${id}`, { delivery_status: 'teleport' }, auth());
  assert.equal(badDelivery.status, 400);
  assert.equal(badDelivery.json.error, 'unknown delivery_status');

  const unrelated = await call(env, 'PATCH', `/api/orders/${id}`, { unrelated: true }, auth());
  assert.equal(unrelated.status, 200);
  assert.equal(unrelated.json.changed, false);
});

test('a quote order follows the quote status path', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', {
    ...purchaseCart(),
    ...CUSTOMER,
    phone: '010-2222-0002',
    items: [{ product_id: 'nope:1', qty: 1 }],
  });
  assert.equal(created.status, 201);
  const id = created.json.id;

  assert.equal((await call(env, 'PATCH', `/api/orders/${id}`, { status: 'shipped' }, auth())).json.error, 'transition not allowed');
  const quoted = await call(env, 'PATCH', `/api/orders/${id}`, { status: 'quoted' }, auth());
  assert.equal(quoted.status, 200);
  assert.equal(quoted.json.order.payment_status, 'none');
  const cancelled = await call(env, 'PATCH', `/api/orders/${id}`, { status: 'cancelled' }, auth());
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.order.status, 'cancelled');
});

test('sets admin notes and tracks them in the audit log', async () => {
  const env = makeEnv();
  const orders = await seed(env);
  const id = orders.a.id;

  const noted = await call(env, 'PATCH', `/api/orders/${id}`, { admin_note: '대표님 확인 필요' }, auth());
  assert.equal(noted.status, 200);
  assert.equal(noted.json.order.admin_note, undefined, 'admin_note is not in the public view');

  const events = await call(env, 'GET', `/api/orders/${id}/events`, undefined, auth());
  assert.ok(events.json.items.some((e) => e.type === 'admin_note_set'));
});

test('requires admin auth and validates event lookup', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  const id = created.json.id;

  assert.equal((await call(env, 'GET', `/api/orders/${id}/events`)).status, 401);
  const events = await call(env, 'GET', `/api/orders/${id}/events`, undefined, auth());
  assert.equal(events.status, 200);
  assert.ok(events.json.items.length >= 1);
  assert.equal(events.json.items[0].type, 'created');
  assert.equal(events.json.items[0].actor, 'customer');

  const missing = await call(env, 'GET', '/api/orders/ORD-19990101-ABCDE/events', undefined, auth());
  assert.equal(missing.status, 200);
  assert.equal(missing.json.items.length, 0);
});

test('ERP sync is built in test mode and never transmitted', async () => {
  const env = makeEnv();
  const orders = await seed(env);
  const id = orders.b.id;

  const first = await call(env, 'POST', `/api/orders/${id}/erp`, {}, auth());
  assert.equal(first.status, 200, first.text);
  const result = first.json;
  assert.equal(result.status, 'skipped');
  assert.equal(result.mode, 'test');
  assert.equal(result.delivered, false);
  assert.equal(result.live_write, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.payload_lines, 2);
  assert.match(result.note, /ERP_LIVE_WRITE=NO/);
  assert.match(result.dedupe_key, /^ecount-test:sales_slip_create:order:/);

  const order = await call(env, 'GET', `/api/orders/${id}`, undefined, auth());
  assert.equal(order.json.erp_status, 'skipped');
  assert.equal(order.json.erp_sent_at, null, 'nothing was transmitted');

  const events = await call(env, 'GET', `/api/orders/${id}/events`, undefined, auth());
  assert.ok(events.json.items.some((e) => e.type === 'erp_skipped'));
});

test('ERP sync is deduplicated and retry increments attempts', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER, phone: '010-3333-0001' });
  const id = created.json.id;

  await call(env, 'POST', `/api/orders/${id}/erp`, {}, auth());
  const duplicate = await call(env, 'POST', `/api/orders/${id}/erp`, {}, auth());
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.idempotent, true);
  assert.equal(duplicate.json.attempts, 1, 'no duplicate transmission is enqueued');

  const retried = await call(env, 'POST', `/api/orders/${id}/erp/retry`, {}, auth());
  assert.equal(retried.status, 200);
  assert.equal(retried.json.attempts, 2);
  assert.equal(retried.json.idempotent, undefined);
});

test('ERP sync requires admin auth', async () => {
  const env = makeEnv();
  const created = await call(env, 'POST', '/api/orders', { ...purchaseCart(), ...CUSTOMER });
  assert.equal((await call(env, 'POST', `/api/orders/${created.json.id}/erp`, {})).status, 401);
  assert.equal((await call(env, 'POST', `/api/orders/${created.json.id}/erp/retry`, {})).status, 401);
  assert.equal((await call(env, 'POST', '/api/orders/ORD-19990101-ABCDE/erp', {}, auth())).status, 404);
});

test('health reports the active modes without leaking secrets', async () => {
  const env = makeEnv({ PG_PROVIDER_MODE: 'auto', TOSS_WIDGET_SECRET_KEY: 'example_gsk_DOCS_SECRET_DO_NOT_LEAK' });
  const res = await call(env, 'GET', '/api/admin/health');
  assert.equal(res.status, 200);
  const body = res.json;
  assert.equal(body.ok, true);
  assert.equal(body.pg.mode, 'test', 'a test_ secret key selects the test environment');
  assert.equal(body.pg.sandbox, true);
  assert.equal(body.pg.live, false);
  assert.equal(body.erp.adapter, 'ecount-test');
  assert.equal(body.erp.mode, 'test');
  assert.equal(body.erp.live_write, false);
  assert.equal(body.cors_origin, 'https://skerishkang.github.io');
  assert.equal(body.shipping_fee_default, 0);
  assert.ok(body.price_index.products_with_price > 2000);
  assert.equal(res.text.includes('DO_NOT_LEAK'), false, 'no secret material in the response');
});

test('schema init is admin only and idempotent', async () => {
  const env = makeEnv();
  await seed(env);
  assert.equal((await call(env, 'POST', '/api/admin/schema/init')).status, 401);

  const first = await call(env, 'POST', '/api/admin/schema/init', {}, auth());
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.ok, true);
  for (const table of ['orders', 'order_items', 'payments', 'order_events', 'erp_sync', 'quote_requests']) {
    assert.ok(first.json.tables.includes(table), `table ${table} present`);
  }

  const second = await call(env, 'POST', '/api/admin/schema/init', {}, auth());
  assert.equal(second.status, 200, 're-applying the schema does not fail');
  const stillThere = await call(env, 'GET', '/api/orders', undefined, auth());
  assert.equal(stillThere.json.count, 3, 'existing rows survive schema init');
});

test('PATCH on an unknown order returns 404', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'PATCH', '/api/orders/ORD-19990101-ABCDE', { status: 'paid' }, auth())).status, 404);
});

// ---------------------------------------------------------------------------
// Admin member management (issue #76)
// ---------------------------------------------------------------------------

async function signUpAndVerify(env, { email = 'kim@example.com', name = '김회원' } = {}) {
  const res = await call(env, 'POST', '/api/auth/signup', {
    email, name, password: PASSWORD, phone: '010-1111-2222', company: '[E2E] 회사',
  }, csrf);
  assert.equal(res.status, 201, `signup failed: ${res.text}`);
  const verified = await call(env, 'POST', '/api/auth/verify-email', {
    member_id: res.json.member.id, token: res.json.mail.echo_token,
  }, csrf);
  assert.equal(verified.status, 200, verified.text);
  return res.json.member.id;
}

async function login(env, email = 'kim@example.com') {
  const res = await call(env, 'POST', '/api/auth/login', { email, password: PASSWORD }, csrf);
  assert.equal(res.status, 200, `login failed: ${res.text}`);
  return res.headers['set-cookie'];
}

async function superadminCookie(env) {
  await signUpAndVerify(env, { email: 'charliekant@gmail.com', name: 'Charlie Kang' });
  return login(env, 'charliekant@gmail.com');
}

async function adminCookie(env) {
  const memberId = await signUpAndVerify(env, { email: 'admin1@example.com', name: 'Admin Member' });
  await env.DB.prepare("UPDATE members SET role = 'admin' WHERE id = ?").bind(memberId).run();
  return login(env, 'admin1@example.com');
}

test('admin member endpoints require superadmin auth', async () => {
  const env = makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000' });

  // Anonymous -> 401
  assert.equal((await call(env, 'GET', '/api/admin/members')).status, 401);
  assert.equal((await call(env, 'PATCH', '/api/admin/members/1/role', { role: 'admin' })).status, 401);

  // ADMIN_TOKEN works
  const tokenList = await call(env, 'GET', '/api/admin/members', undefined, auth());
  assert.equal(tokenList.status, 200);
  assert.ok(Array.isArray(tokenList.json.items));

  // Ordinary member session -> 401
  await signUpAndVerify(env, { email: 'member1@example.com' });
  const memberCookie = await login(env, 'member1@example.com');
  const memberList = await call(env, 'GET', '/api/admin/members', undefined, { ...csrf, Cookie: memberCookie });
  assert.equal(memberList.status, 401, 'ordinary member cannot list members');

  const memberPatch = await call(env, 'PATCH', '/api/admin/members/1/role', { role: 'admin' }, { ...csrf, Cookie: memberCookie });
  assert.equal(memberPatch.status, 401, 'ordinary member cannot change roles');
});

test('ordinary admin cannot manage members (superadmin only)', async () => {
  const env = makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000' });

  const cookie = await adminCookie(env);
  const list = await call(env, 'GET', '/api/admin/members', undefined, { ...csrf, Cookie: cookie });
  assert.equal(list.status, 401, 'ordinary admin cannot list members');

  const patch = await call(env, 'PATCH', '/api/admin/members/1/role', { role: 'admin' }, { ...csrf, Cookie: cookie });
  assert.equal(patch.status, 401, 'ordinary admin cannot change roles');
});

test('superadmin can list members and see roles', async () => {
  const env = makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000' });

  await signUpAndVerify(env, { email: 'kim@example.com', name: '김회원' });
  const superCookie = await superadminCookie(env);

  const list = await call(env, 'GET', '/api/admin/members', undefined, { ...csrf, Cookie: superCookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 2);

  const charlie = list.json.items.find((m) => m.email === 'charliekant@gmail.com');
  assert.equal(charlie.role, 'superadmin', 'hardcoded email is superadmin');

  const kim = list.json.items.find((m) => m.email === 'kim@example.com');
  assert.equal(kim.role, 'member', 'default role is member');
});

test('superadmin can promote a member to admin', async () => {
  const env = makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000' });

  await signUpAndVerify(env, { email: 'worker@example.com', name: 'Worker' });
  const superCookie = await superadminCookie(env);

  const list = await call(env, 'GET', '/api/admin/members', undefined, { ...csrf, Cookie: superCookie });
  const worker = list.json.items.find((m) => m.email === 'worker@example.com');

  const promoted = await call(env, 'PATCH', `/api/admin/members/${worker.id}/role`, { role: 'admin' }, { ...csrf, Cookie: superCookie });
  assert.equal(promoted.status, 200, promoted.text);
  assert.equal(promoted.json.member.role, 'admin');
});

test('superadmin can demote an admin back to member', async () => {
  const env = makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000' });

  await signUpAndVerify(env, { email: 'worker@example.com', name: 'Worker' });
  const superCookie = await superadminCookie(env);

  const list = await call(env, 'GET', '/api/admin/members', undefined, { ...csrf, Cookie: superCookie });
  const worker = list.json.items.find((m) => m.email === 'worker@example.com');

  // Promote then demote
  await call(env, 'PATCH', `/api/admin/members/${worker.id}/role`, { role: 'admin' }, { ...csrf, Cookie: superCookie });
  const demoted = await call(env, 'PATCH', `/api/admin/members/${worker.id}/role`, { role: 'member' }, { ...csrf, Cookie: superCookie });
  assert.equal(demoted.status, 200);
  assert.equal(demoted.json.member.role, 'member');
});

test('superadmin role is immutable for the two hardcoded emails', async () => {
  const env = makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000' });

  await signUpAndVerify(env, { email: 'skerish@naver.com', name: 'Skerish' });
  const superCookie = await superadminCookie(env);

  const list = await call(env, 'GET', '/api/admin/members', undefined, { ...csrf, Cookie: superCookie });

  for (const email of ['charliekant@gmail.com', 'skerish@naver.com']) {
    const member = list.json.items.find((m) => m.email === email);
    const result = await call(env, 'PATCH', `/api/admin/members/${member.id}/role`, { role: 'member' }, { ...csrf, Cookie: superCookie });
    assert.equal(result.status, 409, `immutable: ${email}`);
    assert.equal(result.json.error, 'superadmin_role_immutable');
  }
});

test('role PATCH rejects invalid role values', async () => {
  const env = makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000' });

  await signUpAndVerify(env, { email: 'worker@example.com', name: 'Worker' });
  const superCookie = await superadminCookie(env);

  const list = await call(env, 'GET', '/api/admin/members', undefined, { ...csrf, Cookie: superCookie });
  const worker = list.json.items.find((m) => m.email === 'worker@example.com');

  for (const badRole of ['superadmin', 'owner', 'admin2', '']) {
    const result = await call(env, 'PATCH', `/api/admin/members/${worker.id}/role`, { role: badRole }, { ...csrf, Cookie: superCookie });
    assert.equal(result.status, 400, `bad role: ${badRole}`);
    assert.equal(result.json.error, 'role must be admin or member');
  }
});

test('role PATCH on non-existent member returns 404', async () => {
  const env = makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000' });

  const superCookie = await superadminCookie(env);

  const result = await call(env, 'PATCH', '/api/admin/members/99999/role', { role: 'admin' }, { ...csrf, Cookie: superCookie });
  assert.equal(result.status, 404);
});

test('role PATCH with invalid member id returns 400', async () => {
  const env = makeEnv({ MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000' });

  const superCookie = await superadminCookie(env);

  for (const badId of ['0', '-1', 'abc', '1.5']) {
    const result = await call(env, 'PATCH', `/api/admin/members/${badId}/role`, { role: 'admin' }, { ...csrf, Cookie: superCookie });
    assert.equal(result.status, 400, `bad id: ${badId}`);
  }
});
