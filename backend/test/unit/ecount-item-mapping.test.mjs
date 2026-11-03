import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  loadApprovedEcountItemMap,
  parseApprovedEcountMappingCsv,
} from '../../lib/ecount-item-mapping.mjs';
import {
  prepareEcountSaleOrder,
  transmitEcountSaleOrder,
} from '../../lib/ecount-order-adapter.mjs';
import { openD1 } from '../../d1-shim.mjs';

const row = (id, candidates, approval = '') => [
  id, candidates[0] || '', candidates[1] || '', candidates[2] || '', approval,
].join(',');

const csv = [
  'shop_product_id,candidate1_code,candidate2_code,candidate3_code,approved_ecount_code',
  row('shop-1', ['ERP-001'], 'ERP-001'),
  row('shop-2', ['ERP-001'], 'ERP-001'),
  row('shop-3', ['ERP-003']),
].join('\n');

test('approved CSV parser accepts explicit candidates and counts blank approvals', () => {
  const parsed = parseApprovedEcountMappingCsv(csv);
  assert.deepEqual(parsed.approvals.map(({ cgiProductId, ecountProdCd }) => [cgiProductId, ecountProdCd]), [
    ['shop-1', 'ERP-001'], ['shop-2', 'ERP-001'],
  ]);
  assert.equal(parsed.unapprovedRows, 1);
});

test('approved CSV parser rejects a code that is not one of the row candidates', () => {
  assert.throws(
    () => parseApprovedEcountMappingCsv([
      'shop_product_id,candidate1_code,candidate2_code,candidate3_code,approved_ecount_code',
      row('shop-1', ['ERP-001'], 'ERP-WRONG'),
    ].join('\n')),
    /approval_not_in_candidate_list_at_row_2/,
  );
});

test('recommendation alone does not create an approval', () => {
  const recommendedCsv = [
    'shop_product_id,candidate1_code,candidate2_code,candidate3_code,recommendation,approved_ecount_code',
    `shop-1,ERP-001,,,\uCD94\uCC9C,`,
  ].join('\n');
  const parsed = parseApprovedEcountMappingCsv(recommendedCsv);
  assert.equal(parsed.approvals.length, 0);
  assert.equal(parsed.unapprovedRows, 1);
});

test('approved CSV parser rejects duplicate shop IDs but permits shared ECOUNT codes', () => {
  assert.throws(
    () => parseApprovedEcountMappingCsv([
      'shop_product_id,candidate1_code,candidate2_code,candidate3_code,approved_ecount_code',
      row('shop-1', ['ERP-001'], 'ERP-001'),
      row('shop-1', ['ERP-002'], 'ERP-002'),
    ].join('\n')),
    /duplicate_cgi_product_id_at_row_3/,
  );
  assert.equal(parseApprovedEcountMappingCsv(csv).approvals.length, 2);
});

test('migration 0008 creates the mapping table in local SQLite', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const migration = readFileSync(new URL('../../migrations/0008_ecount_item_mapping.sql', import.meta.url), 'utf8');
    db.exec(migration);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ecount_item_mapping'").get();
    assert.equal(table?.name, 'ecount_item_mapping');
    const columns = db.prepare('PRAGMA table_info(ecount_item_mapping)').all().map((column) => column.name);
    assert.deepEqual(columns, [
      'cgi_product_id', 'ecount_prod_cd', 'approved_by', 'approved_at',
      'source_sha256', 'created_at', 'updated_at',
    ]);
  } finally {
    db.close();
  }
});

test('D1 approved mappings load from the new table', async () => {
  const db = openD1();
  await db.prepare(
    `INSERT INTO ecount_item_mapping
      (cgi_product_id, ecount_prod_cd, approved_by, approved_at, source_sha256, created_at, updated_at)
     VALUES (?, ?, 'admin', '2026-11-04T00:00:00.000Z', ?, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`
  ).bind('shop-1', 'ERP-001', 'a'.repeat(64)).run();
  const mappings = await loadApprovedEcountItemMap(db, [
    { product_id: 'shop-1' }, { product_id: 'shop-2' },
  ]);
  assert.equal(mappings['shop-1'], 'ERP-001');
  assert.equal(mappings['shop-2'], undefined);
  db._db.close();
});

test('unapproved products are blocked before any ECOUNT request in test and production modes', async (t) => {
  for (const target of ['test', 'prod']) {
    await t.test(`${target} target`, async () => {
      const env = {
        ECOUNT_ORDER_SYNC_ENABLED: 'YES',
        ERP_MODE: 'test',
        ECOUNT_TARGET: target,
        ECOUNT_COM_CODE: 'FAKE-COM',
        ECOUNT_USER_ID: 'FAKE-USER',
        ECOUNT_API_CERT_KEY: 'FAKE-CERT',
        ECOUNT_DEFAULT_CUST_CODE: 'FAKE-CUST',
        ECOUNT_DEFAULT_WH_CD: 'WH1',
        ECOUNT_ITEM_CODE_MAP_JSON: JSON.stringify({ 'shop-unapproved': 'ERP-LEGACY' }),
      };
      const order = { id: `ORDER-${target}`, status: 'paid', payment_status: 'paid', shipping_fee: 0 };
      const items = [{ product_id: 'shop-unapproved', product_name: 'Fake', qty: 1, unit_price: 100, line_total: 100 }];
      const prepared = prepareEcountSaleOrder({ env, order, items });
      assert.equal(prepared.ready, false);
      assert.equal(prepared.reason, 'item_mapping_missing');

      let requestCount = 0;
      const sent = await transmitEcountSaleOrder(prepared, {
        env,
        fetchFn: async () => { requestCount += 1; throw new Error('unexpected network request'); },
      });
      assert.equal(sent.status, 'not_configured');
      assert.equal(requestCount, 0);

      const approved = prepareEcountSaleOrder({
        env, order, items, approvedItemMap: { 'shop-unapproved': 'ERP-APPROVED' },
      });
      assert.equal(approved.ready, true);
      assert.equal(approved.plan.batches[0].body.SaleOrderList[0].BulkDatas.PROD_CD, 'ERP-APPROVED');
    });
  }
});
