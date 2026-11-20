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
