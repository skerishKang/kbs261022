// The order -> product match -> ERP 전표 path, over synthetic data.
//
// This is deliberately the whole chain rather than a unit of one function: the
// failure that costs real money is a slip line referencing a 품목코드 the ERP
// does not have, or two slips for one order after a retry. Both are invisible to
// any single module's tests, so the chain is exercised against the loopback mock
// of the vendor wire contract (mock-erp-oapi.mjs), never the vendor itself.
//
// Safety properties asserted here, all of which must hold before any live run:
//   - an unmapped product produces no transmittable row (register_first/unverified)
//   - a verified 품목코드 does produce a legal slip row
//   - a retried order cannot book a second document (dedupe claim)
//   - no live mode is reachable from these fixtures

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet, resolveErpProdCd } from '../../lib/product-mapping.mjs';
import { planSlip, slipRows, validateRow, ecountDate } from '../../lib/erp-plan.mjs';
import { createErpOapiClient } from '../../lib/erp-oapi.mjs';
import { canonicalCgiId, proposedProdCd, classifyLink, reconcileLive } from '../../lib/erp-linkage-plan.mjs';
import { startMockOapiServer, closeAllMockOapiServers } from '../helpers/mock-erp-oapi.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const LEDGER = 'reports/data/registration/ncom_registration_ledger.json';
const MASTER = 'data/full_catalog/product_db_compact.csv';

const SYNTHETIC_ORDER = {
  id: 'SYN-ORD-20261030-0001',
  paid_at: '2026-10-30T01:00:00Z',
  customer_name: '합성고객',
};

const SYNTHETIC_ITEMS = [
  { product_id: 'samamusic:2098', product_name: 'GENELEC 8020-320B 스탠드', qty: 1, unit_price: 163000, option_label: '기본' },
  { product_id: 'samasound:3836', product_name: 'SQ5+', qty: 2, unit_price: 1680000, option_label: '기본' },
];

test.after(async () => {
  await closeAllMockOapiServers();
});

test('canonicalCgiId collapses the domain/no-domain spellings the data actually mixes', () => {
  // The ledger holds "samamusic:2098" and "samamusic.co.kr:1769" for one store.
  assert.equal(canonicalCgiId('samamusic:2098'), 'samamusic:2098');
  assert.equal(canonicalCgiId('samamusic.co.kr:1769'), 'samamusic:1769');
  assert.equal(canonicalCgiId('samasound.co.kr:3836'), 'samasound:3836');
  assert.equal(proposedProdCd('samamusic.co.kr:1769'), 'SM-1769');
  assert.equal(proposedProdCd('samasound:3836'), 'SS-3836');
});

test('every one of the 1,000 live products joins the CGI master with no duplicate key', () => {
  const ledger = json(LEDGER);
  const master = parseCsv(read(MASTER));
  const recon = reconcileLive({ ledgerRows: ledger, masterRows: master });

  assert.equal(recon.liveCount, 1000);
  assert.equal(recon.uniqueLiveCgiIds, 1000, 'no cgiId registered twice');
  assert.equal(recon.uniqueOriginProductNos, 1000, 'no originProductNo registered twice');
  assert.equal(recon.duplicateCgiIds.length, 0);
  assert.equal(recon.duplicateOriginProductNos.length, 0);
  assert.equal(recon.inMasterCount, 1000, 'every live product exists in the 4,575 master');
  assert.equal(recon.notInMasterCount, 0);
  assert.equal(recon.masterCount, 4575);
  assert.equal(recon.unregisteredOnNaverCount, 3575, 'the remainder of the master is not on Naver');
  assert.equal(recon.inMasterCount + recon.unregisteredOnNaverCount, recon.masterCount);
});

test('the ERP linkage is reported as undetermined, never guessed as a new item', () => {
  const ledger = json(LEDGER);
  const master = parseCsv(read(MASTER));
  const records = ledger.filter((r) => r.kind === 'cgi-ncom-registration').map((r) => ({
    cgiId: canonicalCgiId(r.cgiId),
  }));

  // With no ERP item master in the repository, nothing can be confirmed.
  let undetermined = 0;
  for (const r of records) {
    const link = classifyLink({ ledgerRow: { cgiId: r.cgiId }, erpReadComplete: false });
    assert.equal(link.status, 'undetermined');
    undetermined += 1;
  }
  assert.equal(undetermined, 1000);

  // Inverse proof: give it the ERP code and the classification moves. Without
  // this the previous assertion would pass on a classifier that always returns
  // undetermined.
  const confirmed = classifyLink({
    ledgerRow: { cgiId: 'samamusic:2098' },
    erpCodes: new Set(['SM-2098']),
    erpReadComplete: true,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.basis, 'erp_code_exact');

  const byBarcode = classifyLink({
    ledgerRow: { cgiId: 'samamusic:2098' },
    masterRow: { barcode: '8801234567890' },
    erpBarcodes: new Map([['8801234567890', '000123']]),
    erpReadComplete: true,
  });
  assert.equal(byBarcode.status, 'confirmed');
  assert.equal(byBarcode.erpProdCd, '000123', 'the ERP code wins over the CGI-proposed code');

  const genuinelyNew = classifyLink({ ledgerRow: { cgiId: 'samamusic:2098' }, erpReadComplete: true });
  assert.equal(genuinelyNew.status, 'needs_new_item');
});

test('an unverified product yields no transmittable slip row, a verified one does', () => {
  const records = buildMappingSet({
    extendedRows: parseCsv(read('data/erp_prep/erp_extended_mapping.csv')),
    uploadRows: parseCsv(read('data/erp_prep/ecount_item_upload.csv')),
    smartstoreRows: parseCsv(read('data/smartstore_prep/smartstore_registration_prep.csv')),
    erpMasterRows: [],
  });

  // Today: nothing is ERP-verified, so the resolver refuses to claim a mapping.
  const unresolved = resolveErpProdCd('samamusic.co.kr:2098', records);
  assert.equal(unresolved.status, 'register_first');
  assert.match(unresolved.reason, /0 exact code matches/);

  // A slip planned without a 거래처 must be rejected locally, not on the server.
  const noCust = planSlip({ order: SYNTHETIC_ORDER, items: SYNTHETIC_ITEMS });
  assert.equal(noCust.acceptedCount, 0);
  assert.equal(noCust.rejected.length, 2, 'both lines fail on the missing 거래처');
  for (const r of noCust.rejected) {
    assert.ok(r.problems.some((p) => p.field === 'CUST' && p.reason === 'required'));
  }
  assert.equal(noCust.batches.length, 0, 'no batch exists when nothing is accepted');
  assert.equal(noCust.transmitted, false);

  // With 거래처/창고 resolved the same items become a legal document.
  const resolved = planSlip({
    order: SYNTHETIC_ORDER,
    items: SYNTHETIC_ITEMS,
    cust: '00035',
    custDes: '합성고객',
    whCd: '00001',
    ioDate: ecountDate(SYNTHETIC_ORDER.paid_at),
  });
  assert.equal(resolved.acceptedCount, 2);
  assert.equal(resolved.rejected.length, 0);
  assert.equal(resolved.batches.length, 1);
  assert.equal(resolved.endpoint, 'saveSaleOrder');
  assert.match(resolved.dedupeKey, /saveSaleOrder:order:SYN-ORD-20261030-0001/);

  const rows = resolved.batches[0].body.SaleOrderList.map((b) => b.BulkDatas);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.PROD_CD), ['SM-2098', 'SS-3836']);
  assert.deepEqual([...new Set(rows.map((r) => r.UPLOAD_SER_NO))], ['1'], 'one order = one 전표묶음');
  assert.equal(rows[0].IO_DATE, '20261030');
  for (const row of rows) assert.deepEqual(validateRow('saveSaleOrder', row), []);
});

test('an over-long 품목명 is rejected locally instead of burning the error quota', () => {
  const longNameItem = { product_id: 'samasound:3836', product_name: 'ㄱ'.repeat(120), qty: 1, unit_price: 1000 };
  const plan = planSlip({ order: SYNTHETIC_ORDER, items: [longNameItem], cust: '00035', whCd: '00001' });
  assert.equal(plan.acceptedCount, 0);
  assert.equal(plan.rejected.length, 1);
  assert.deepEqual(plan.rejected[0].problems[0], { field: 'PROD_DES', reason: 'too_long', length: 120, limit: 100 });
});

test('a zero-quantity line never reaches the ERP', () => {
  const zero = { product_id: 'samasound:3836', product_name: 'SQ5+', qty: 0, unit_price: 1000 };
  const plan = planSlip({ order: SYNTHETIC_ORDER, items: [zero], cust: '00035', whCd: '00001' });
  assert.equal(plan.acceptedCount, 0);
  assert.ok(plan.rejected[0].problems.some((p) => p.field === 'QTY' && p.reason === 'must_be_positive'));
});

test('the mock wire contract books one 전표 and refuses a duplicate order', async () => {
  const mock = await startMockOapiServer();
  const client = createErpOapiClient({
    env: {
      ERP_MODE: 'mock',
      ERP_MOCK_BASE_URL: mock.baseUrl,
      ECOUNT_COM_CODE: 'SYN',
      ECOUNT_USER_ID: 'SYN',
      ECOUNT_API_CERT_KEY: 'MOCK',
    },
    now: () => 0,
    sleep: async () => {},
  });

  assert.equal(client.configured, true);
  assert.equal(client.mode, 'mock');
  const session = await client.bootstrap();
  assert.equal(session.sessionId, 'MOCK_SESSION_ID');

  const plan = planSlip({
    order: SYNTHETIC_ORDER,
    items: SYNTHETIC_ITEMS,
    cust: '00035',
    whCd: '00001',
    ioDate: ecountDate(SYNTHETIC_ORDER.paid_at),
  });
  const batch = plan.batches[0];

  const first = await client.call('saveSaleOrder', batch.body, { dedupeKey: batch.dedupeKey });
  assert.equal(first.ok, true, 'the vendor would have accepted this batch');
  assert.equal(first.failCnt, 0);
  assert.equal(first.successCnt, 2);
  assert.deepEqual(first.slipNos, ['20261026-1'], 'exactly one document booked');
  assert.equal(mock.pathsSeen().filter((p) => p.endsWith('SaveSaleOrder')).length, 1);

  // A retry of the same order must not book a second document.
  const dedupe = new Set();
  const guarded = createErpOapiClient({
    env: {
      ERP_MODE: 'mock',
      ERP_MOCK_BASE_URL: mock.baseUrl,
      ECOUNT_COM_CODE: 'SYN',
      ECOUNT_USER_ID: 'SYN',
      ECOUNT_API_CERT_KEY: 'MOCK',
    },
    now: () => 0,
    sleep: async () => {},
    claimDedupe: async (key) => {
      if (dedupe.has(key)) return false;
      dedupe.add(key);
      return true;
    },
  });
  await guarded.bootstrap();
  await guarded.call('saveSaleOrder', batch.body, { dedupeKey: batch.dedupeKey });
  await assert.rejects(
    guarded.call('saveSaleOrder', batch.body, { dedupeKey: batch.dedupeKey }),
    (error) => {
      assert.equal(error.code, 'dedupe_claimed');
      assert.match(error.message, /refusing to send twice/);
      return true;
    },
  );
  assert.equal(mock.pathsSeen().filter((p) => p.endsWith('SaveSaleOrder')).length, 2, 'the second send never left the client');
});

test('an item code the ERP does not hold fails the row rather than silently booking', async () => {
  const mock = await startMockOapiServer({ failProdCds: new Set(['SM-2098']) });
  const client = createErpOapiClient({
    env: {
      ERP_MODE: 'mock',
      ERP_MOCK_BASE_URL: mock.baseUrl,
      ECOUNT_COM_CODE: 'SYN',
      ECOUNT_USER_ID: 'SYN',
      ECOUNT_API_CERT_KEY: 'MOCK',
    },
    now: () => 0,
    sleep: async () => {},
  });
  await client.bootstrap();
  const plan = planSlip({ order: SYNTHETIC_ORDER, items: SYNTHETIC_ITEMS, cust: '00035', whCd: '00001' });

  await assert.rejects(
    client.call('saveSaleOrder', plan.batches[0].body),
    (error) => {
      assert.match(error.message, /존재하지 않는 품목/);
      // `rows` is every row the vendor reported on; the failed subset is what
      // identifies the offending 품목코드, and it must be exactly the one item.
      assert.equal(error.rows.length, 2, 'both rows are reported back');
      const failed = error.rows.filter((r) => r.IsSuccess !== true);
      assert.equal(failed.length, 1, 'exactly one row failed');
      assert.match(failed[0].TotalError, /SM-2098|품목코드/);
      return true;
    },
  );
});

test('the live path is unreachable from these fixtures', async () => {
  // Both guards must be present; anything less leaves mode disabled.
  const disabled = (env) => createErpOapiClient({ env }).mode;
  assert.equal(disabled({ ERP_MODE: 'live' }), 'disabled', 'write guard alone is not enough');
  assert.equal(disabled({ ERP_LIVE_WRITE: 'YES' }), 'disabled', 'mode alone is not enough');
  assert.equal(disabled({ ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES' }), 'live');

  const liveClient = createErpOapiClient({ env: { ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES' } });
  assert.equal(liveClient.mode, 'live');
  // bootstrap is async, so the refusal arrives as a rejection; awaiting it here
  // also keeps the rejection from escaping as an unhandled one after the test.
  await assert.rejects(liveClient.bootstrap(), (error) => {
    assert.equal(error.code, 'not_configured', 'no credentials in the test env, so nothing was transmitted');
    return true;
  });
});