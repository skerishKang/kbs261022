import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../../worker.js';
import { loadApprovedEcountItemMap } from '../../lib/ecount-item-mapping.mjs';
import { makeEnv, ORIGIN, auth } from '../helpers.mjs';

const headers = 'shop_product_id,candidate1_code,candidate2_code,candidate3_code,approved_ecount_code';
const row = (id, candidates, approval = '') => [
  id, candidates[0] || '', candidates[1] || '', candidates[2] || '', approval,
].join(',');

async function importCsv(env, csv, authorization = {}) {
  const response = await worker.fetch(new Request('http://cgi.local/api/admin/ecount/item-mappings/import', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'text/csv; charset=utf-8', ...authorization },
    body: csv,
  }), env);
  return { status: response.status, body: await response.json() };
}

test('administrator imports approved rows and ignores blanks, including shared ECOUNT codes', async () => {
  const env = makeEnv();
  try {
    const result = await importCsv(env, [
      headers,
      row('shop-1', ['ERP-001'], 'ERP-001'),
      row('shop-2', ['ERP-001'], 'ERP-001'),
      row('shop-3', ['ERP-003']),
    ].join('\n'), auth());
    assert.equal(result.status, 200);
    assert.equal(result.body.imported, 2);
    assert.equal(result.body.unapproved_rows, 1);
    const stored = await env.DB.prepare('SELECT cgi_product_id, ecount_prod_cd FROM ecount_item_mapping ORDER BY cgi_product_id').all();
    assert.deepEqual(stored.results.map((entry) => [entry.cgi_product_id, entry.ecount_prod_cd]), [
      ['shop-1', 'ERP-001'],
      ['shop-2', 'ERP-001'],
    ]);
    const loaded = await loadApprovedEcountItemMap(env.DB, [
      { product_id: 'shop-1' }, { product_id: 'shop-2' }, { product_id: 'shop-3' },
    ]);
    assert.deepEqual({ ...loaded }, { 'shop-1': 'ERP-001', 'shop-2': 'ERP-001' });
  } finally {
    env.DB._db.close();
  }
});

test('administrator import rejects a code outside the candidate list without partial writes', async () => {
  const env = makeEnv();
  try {
    const result = await importCsv(env, [
      headers,
      row('shop-good', ['ERP-001'], 'ERP-001'),
      row('shop-bad', ['ERP-002'], 'ERP-WRONG'),
    ].join('\n'), auth());
    assert.equal(result.status, 400);
    assert.match(result.body.error, /approval_not_in_candidate_list/);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM ecount_item_mapping').first();
    assert.equal(count.count, 0);
  } finally {
    env.DB._db.close();
  }
});

test('non-admin cannot import mapping approvals', async () => {
  const env = makeEnv();
  try {
    const result = await importCsv(env, [headers, row('shop-1', ['ERP-001'], 'ERP-001')].join('\n'));
    assert.equal(result.status, 401);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM ecount_item_mapping').first();
    assert.equal(count.count, 0);
  } finally {
    env.DB._db.close();
  }
});
