import assert from 'node:assert/strict';
import test from 'node:test';

import { call, CUSTOMER, makeTossEnv, pricedProductIds } from '../helpers.mjs';

const TOKEN = 'FAKE-RELAY-TOKEN';
const RELAY_HEADERS = { 'X-ERP-Relay-Token': TOKEN };
const [PRODUCT_A, PRODUCT_B] = pricedProductIds(2);

function relayEnv(overrides = {}) {
  return makeTossEnv({
    ECOUNT_SYNC_MODE: 'relay',
    ECOUNT_ORDER_SYNC_ENABLED: 'YES',
    ECOUNT_TARGET: 'test',
    ERP_RELAY_TOKEN: TOKEN,
    ...overrides,
  });
}

async function mapProduct(env, productId, code) {
  const ts = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO ecount_item_mapping
       (cgi_product_id, ecount_prod_cd, approved_by, approved_at, source_sha256, created_at, updated_at)
     VALUES (?,?, 'FAKE-APPROVER', ?, 'FAKE-SHA', ?, ?)`
  ).bind(productId, code, ts, ts, ts).run();
}

async function pay(env, key = 'pk_relay', items = null) {
  const cart = items ? { items } : { items: [{ product_id: PRODUCT_A, qty: 1 }] };
  const created = await call(env, 'POST', '/api/orders', { ...cart, ...CUSTOMER });
  assert.equal(created.status, 201, created.text);
  const paid = await call(env, 'POST', '/api/payments/confirm', {
    orderId: created.json.id,
    paymentKey: key,
    amount: created.json.totals.total_amount,
  });
  assert.equal(paid.status, 200, paid.text);
  return { orderId: created.json.id, paid };
}

async function rowFor(env, orderId) {
  return env.DB.prepare('SELECT * FROM erp_sync WHERE order_id = ?').bind(orderId).first();
}

test('relay mode records a pending outbox row and never transmits from the Worker', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId, paid } = await pay(env);
  assert.equal(paid.json.erp_sync.status, 'pending');
  const row = await rowFor(env, orderId);
  assert.equal(row.status, 'pending');
  assert.equal(row.mode, 'relay');
  assert.equal(row.attempts, 0);
  assert.equal(JSON.parse(row.payload).body.SaleOrderList[0].BulkDatas.PROD_CD, 'EC-A001');

  const outbox = await call(env, 'GET', '/api/erp/outbox?limit=5', undefined, RELAY_HEADERS);
  assert.equal(outbox.status, 200, outbox.text);
  assert.equal(outbox.json.items.length, 1);
  assert.equal(outbox.json.items[0].order_id, orderId);
  assert.equal(outbox.json.items[0].body.SaleOrderList.length, 1);
  assert.deepEqual(outbox.json.items[0].lines.map((line) => [line.prod_cd, line.qty, line.unit_price]), [['EC-A001', 1, JSON.parse(row.payload).lines[0].unit_price]]);
});

test('outbox routes reject a missing or wrong relay token with 401', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  await pay(env);
  const missing = await call(env, 'GET', '/api/erp/outbox');
  assert.equal(missing.status, 401);
  const wrong = await call(env, 'GET', '/api/erp/outbox', undefined, { 'X-ERP-Relay-Token': 'WRONG' });
  assert.equal(wrong.status, 401);
  const resultMissing = await call(env, 'POST', '/api/erp/outbox/1/result', { ok: true });
  assert.equal(resultMissing.status, 401);
  const resultWrong = await call(env, 'POST', '/api/erp/outbox/1/result', { ok: true }, { 'X-ERP-Relay-Token': 'WRONG' });
  assert.equal(resultWrong.status, 401);
});

test('claiming hides a row until the result arrives; a dry run does not claim', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env);
  const dry = await call(env, 'GET', '/api/erp/outbox?dry=1', undefined, RELAY_HEADERS);
  assert.equal(dry.json.dry_run, true);
  assert.equal(dry.json.items.length, 1);
  const secondDry = await call(env, 'GET', '/api/erp/outbox?dry=1', undefined, RELAY_HEADERS);
  assert.equal(secondDry.json.items.length, 1, 'dry run leaves the row claimable');

  const claimed = await call(env, 'GET', '/api/erp/outbox?limit=1', undefined, RELAY_HEADERS);
  assert.equal(claimed.json.items.length, 1);
  const again = await call(env, 'GET', '/api/erp/outbox?limit=1', undefined, RELAY_HEADERS);
  assert.equal(again.json.items.length, 0, 'a claimed row is not handed out twice');
  const row = await rowFor(env, orderId);
  assert.ok(Date.parse(JSON.parse(row.payload).relay.claimed_at) > 0);
});

test('a stale claim after fifteen minutes returns the row to the outbox', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env);
  await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  const row = await rowFor(env, orderId);
  const payload = JSON.parse(row.payload);
  payload.relay.claimed_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  await env.DB.prepare('UPDATE erp_sync SET payload = ? WHERE id = ?').bind(JSON.stringify(payload), row.id).run();
  const recovered = await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  assert.equal(recovered.json.items.length, 1);
  assert.equal(recovered.json.items[0].id, row.id);
});

test('success stores the slip number; a failure retries up to three times and then stops', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env);
  const outbox = await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  const id = outbox.json.items[0].id;

  const failed = await call(env, 'POST', `/api/erp/outbox/${id}/result`, { ok: false, error: 'FAKE vendor row failure' }, RELAY_HEADERS);
  assert.equal(failed.status, 200);
  assert.equal(failed.json.status, 'pending');
  assert.equal(failed.json.attempts, 1);
  assert.equal((await rowFor(env, orderId)).last_error, 'FAKE vendor row failure');
  const retried = await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  assert.equal(retried.json.items[0].id, id, 'a failed row is claimable again');

  await call(env, 'POST', `/api/erp/outbox/${id}/result`, { ok: false, error: 'second failure' }, RELAY_HEADERS);
  const third = await call(env, 'POST', `/api/erp/outbox/${id}/result`, { ok: false, error: 'third failure' }, RELAY_HEADERS);
  assert.equal(third.json.status, 'failed');
  assert.equal(third.json.attempts, 3);
  const afterStop = await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  assert.equal(afterStop.json.items.length, 0);

  const successEnv = relayEnv();
  await mapProduct(successEnv, PRODUCT_A, 'EC-A001');
  const secondOrder = await pay(successEnv, 'pk_relay_success');
  const secondId = (await call(successEnv, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0].id;
  const ok = await call(successEnv, 'POST', `/api/erp/outbox/${secondId}/result`, { ok: true, slipNo: 'SLIP-001' }, RELAY_HEADERS);
  assert.equal(ok.json.status, 'sent');
  const row = await rowFor(successEnv, secondOrder.orderId);
  assert.equal(row.status, 'sent');
  assert.equal(JSON.parse(row.payload).relay.slip_no, 'SLIP-001');
});

test('an unmapped product line is held with its product id and recovers once mapped', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env, 'pk_relay_unmapped', [{ product_id: PRODUCT_A, qty: 1 }, { product_id: PRODUCT_B, qty: 1 }]);
  const heldOutbox = await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  assert.equal(heldOutbox.json.items.length, 0);
  assert.deepEqual(heldOutbox.json.held.map((held) => [held.order_id, held.reason, held.product_ids]), [[orderId, 'product_mapping_missing', [PRODUCT_B]]]);
  const heldRow = await rowFor(env, orderId);
  assert.equal(heldRow.status, 'pending');
  assert.match(heldRow.last_error, /product_mapping_missing/);

  await mapProduct(env, PRODUCT_A, 'EC-A001');
  await mapProduct(env, PRODUCT_B, 'EC-B002');
  const recovered = await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  assert.equal(recovered.json.items.length, 1);
  assert.deepEqual(recovered.json.items[0].body.SaleOrderList.map((line) => line.BulkDatas.PROD_CD), ['EC-A001', 'EC-B002']);
});

test('a disabled switch records no outbox row at all', async () => {
  const env = relayEnv({ ECOUNT_ORDER_SYNC_ENABLED: 'NO' });
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId, paid } = await pay(env, 'pk_relay_off');
  assert.equal(paid.json.order.status, 'paid');
  assert.equal(await rowFor(env, orderId), null);
  const outbox = await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  assert.equal(outbox.json.items.length, 0);
});

test('health exposes the sync mode and token presence but never the token value', async () => {
  const env = relayEnv();
  const res = await call(env, 'GET', '/api/admin/health', undefined, { Authorization: 'Bearer example-admin-token' });
  assert.equal(res.status, 200);
  assert.equal(res.json.erp.sync_mode, 'relay');
  assert.equal(res.json.erp.relay_token_configured, true);
  assert.equal(res.text.includes(TOKEN), false);
});

test('the outbox carries a dedupe key for the relay ledger', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env, 'pk_relay_dedupe');
  const outbox = await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  const item = outbox.json.items[0];
  assert.match(item.dedupe_key, /sale_order_create/);
  assert.match(item.dedupe_key, new RegExp(orderId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('an unknown result stops retries and is excluded from the outbox', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId, paid } = await pay(env, 'pk_relay_unknown');
  const id = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0].id;
  const unknown = await call(env, 'POST', `/api/erp/outbox/${id}/result`, {
    ok: false, unknown: true, error: 'relay_error: response lost',
  }, RELAY_HEADERS);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.status, 'unknown');
  const row = await rowFor(env, orderId);
  assert.equal(row.status, 'unknown');
  assert.equal(row.attempts, 0, 'an uncertain delivery does not consume a retry');
  assert.equal(JSON.parse(row.payload).relay.last_result.unknown, true);

  const after = await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS);
  assert.equal(after.json.items.length, 0, 'unknown rows are never re-claimed automatically');
  const replay = await call(env, 'POST', '/api/payments/confirm', {
    orderId, paymentKey: 'pk_relay_unknown', amount: paid.json.order.totals.total_amount,
  });
  assert.equal(replay.status, 200);
  assert.equal((await rowFor(env, orderId)).status, 'unknown', 'enqueue treats unknown as idempotent');
});

test('a manual ok result after ERP lookup confirms an unknown row', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env, 'pk_relay_manual');
  const id = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0].id;
  await call(env, 'POST', `/api/erp/outbox/${id}/result`, { ok: false, unknown: true, error: 'response lost' }, RELAY_HEADERS);
  const confirmed = await call(env, 'POST', `/api/erp/outbox/${id}/result`, { ok: true, slipNo: 'SLIP-MANUAL' }, RELAY_HEADERS);
  assert.equal(confirmed.json.status, 'sent');
  const row = await rowFor(env, orderId);
  assert.equal(row.status, 'sent');
  assert.equal(JSON.parse(row.payload).relay.slip_no, 'SLIP-MANUAL');
});

test('an admin retry resets an unknown row for one fresh transmission', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env, 'pk_relay_retry');
  const id = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0].id;
  await call(env, 'POST', `/api/erp/outbox/${id}/result`, { ok: false, unknown: true, error: 'response lost' }, RELAY_HEADERS);
  const retried = await call(env, 'POST', `/api/orders/${orderId}/erp/retry`, {}, { Authorization: 'Bearer example-admin-token' });
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.status, 'pending');
  assert.equal((await rowFor(env, orderId)).status, 'pending');
  assert.equal((await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items.length, 1);
});

function notifyRelayEnv() {
  return relayEnv({
    MAIL_MODE: 'resend',
    B66_ALERT_RESEND_API_KEY: 're_fake_key_for_tests',
    ORDER_NOTIFY_TO: 'ops@example.com',
    ORDER_NOTIFY_TELEGRAM_CHAT_IDS: '111',
    TELEGRAM_BOT_TOKEN: 'fake-token-for-tests',
  });
}

async function withCapturedFetch(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
    return { ok: true, status: 200, async text() { return '{}'; }, async json() { return {}; } };
  };
  try { await fn(); } finally { globalThis.fetch = original; }
  return calls;
}

const attention = (calls) => calls.filter((c) => /이카운트/.test(JSON.stringify(c.body)));

test('a pending result releases the claim without using an attempt', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env, 'pk_relay_pending');
  const id = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0].id;
  assert.equal((await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items.length, 0, 'claimed');
  const res = await call(env, 'POST', `/api/erp/outbox/${id}/result`, {
    ok: false, pending: true, error: 'rate_limited: server request limit exceeded',
  }, RELAY_HEADERS);
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'pending');
  const row = await rowFor(env, orderId);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
  assert.match(row.last_error, /rate_limited/);
  assert.equal((await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items.length, 1, 'claimable again');
});

test('an unknown result alerts ops by mail and telegram once, and is not re-claimed', async () => {
  const env = notifyRelayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env, 'pk_relay_alert_unknown');
  const id = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0].id;
  const calls = await withCapturedFetch(async () => {
    await call(env, 'POST', `/api/erp/outbox/${id}/result`, { ok: false, unknown: true, error: 'relay_error: fetch failed' }, RELAY_HEADERS);
    await call(env, 'POST', `/api/erp/outbox/${id}/result`, { ok: false, unknown: true, error: 'relay_error: fetch failed' }, RELAY_HEADERS);
  });
  const sent = attention(calls);
  assert.equal(sent.filter((c) => c.url.startsWith('https://api.telegram.org/')).length, 1);
  assert.equal(sent.filter((c) => c.url.includes('api.resend.com')).length, 1);
  const text = JSON.stringify(sent);
  assert.match(text, new RegExp(orderId));
  assert.match(text, /UNKNOWN/);
  assert.match(text, /판매조회/);
  assert.equal(text.includes(TOKEN), false);
  const outbox = await env.DB.prepare("SELECT * FROM ops_notify_outbox WHERE event = 'erp_sync_attention'").all();
  assert.equal(outbox.results.length, 1);
  assert.equal((await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items.length, 0);
});

test('each rejection alerts ops and the last one says retries stopped', async () => {
  const env = notifyRelayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env, 'pk_relay_alert_reject');
  const calls = await withCapturedFetch(async () => {
    for (let i = 0; i < 3; i += 1) {
      const item = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0];
      await call(env, 'POST', `/api/erp/outbox/${item.id}/result`, { ok: false, error: 'api_error: E001 bad customer' }, RELAY_HEADERS);
    }
  });
  const telegrams = attention(calls).filter((c) => c.url.startsWith('https://api.telegram.org/'));
  assert.equal(telegrams.length, 3);
  const mails = attention(calls).filter((c) => c.url.includes('api.resend.com'));
  assert.match(JSON.stringify(mails.at(-1).body), /자동 재시도 종료/);
  assert.equal((await rowFor(env, orderId)).status, 'failed');
});

test('a pending result and a success never alert', async () => {
  const env = notifyRelayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  await pay(env, 'pk_relay_alert_none');
  const calls = await withCapturedFetch(async () => {
    let item = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0];
    await call(env, 'POST', `/api/erp/outbox/${item.id}/result`, { ok: false, pending: true, error: 'rate_limited' }, RELAY_HEADERS);
    item = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0];
    await call(env, 'POST', `/api/erp/outbox/${item.id}/result`, { ok: true, slipNo: 'SLIP-OK' }, RELAY_HEADERS);
  });
  assert.equal(attention(calls).length, 0);
});

test('an admin retry of an unknown row raises retry_gen so the relay ledger allows exactly one resend', async () => {
  const env = relayEnv();
  await mapProduct(env, PRODUCT_A, 'EC-A001');
  const { orderId } = await pay(env, 'pk_relay_gen');
  const first = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0];
  assert.equal(first.retry_gen, 0);
  await call(env, 'POST', `/api/erp/outbox/${first.id}/result`, { ok: false, unknown: true, error: 'lost' }, RELAY_HEADERS);
  await call(env, 'POST', `/api/orders/${orderId}/erp/retry`, {}, { Authorization: 'Bearer example-admin-token' });
  const second = (await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0];
  assert.equal(second.retry_gen, 1);
  assert.equal(second.dedupe_key, first.dedupe_key, 'the ERP dedupe key itself never changes');
  // a plain re-enqueue (payment confirm replay) does not bump the generation
  await call(env, 'POST', `/api/erp/outbox/${second.id}/result`, { ok: false, pending: true, error: 'rate_limited' }, RELAY_HEADERS);
  assert.equal((await call(env, 'GET', '/api/erp/outbox', undefined, RELAY_HEADERS)).json.items[0].retry_gen, 1);
});
