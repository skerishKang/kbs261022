// The 4,575-row catalogue, measured through the new mapping module against the
// mapping material already committed in this repository.
//
// These tests read real repo data and compare it to the numbers three separate
// committed authorities publish (reports/data/erp/summary.json,
// erp_readonly_comparison.json, duplicate_item_codes_report.json and
// reports/erp-item-master-mapping.csv). That makes the assertions falsifiable:
// if a parser or a join is wrong, the measured count disagrees with the
// published count and the test goes red — it cannot pass by restating itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet, coverageOf, resolveErpProdCd, saleableRows, duplicateProdCds } from '../../lib/product-mapping.mjs';
import { validateRow, productRow, OAPI_FIELD_LIMITS } from '../../lib/erp-plan.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const EXTENDED = 'data/erp_prep/erp_extended_mapping.csv';
const UPLOAD = 'data/erp_prep/ecount_item_upload.csv';
const SMARTSTORE = 'data/smartstore_prep/smartstore_registration_prep.csv';

const extendedRows = parseCsv(read(EXTENDED));
const uploadRows = parseCsv(read(UPLOAD));
const smartstoreRows = parseCsv(read(SMARTSTORE));
const summary = json('reports/data/erp/summary.json');
const comparison = json('reports/data/erp/erp_readonly_comparison.json');
const duplicateReport = json('reports/data/erp/duplicate_item_codes_report.json');

// The ERP item master is NOT in this repository: the 964-row read lives only in
// the comparison aggregates. An empty master is therefore the honest input for
// the join, and every positive match below is proven separately with a fixture.
const records = buildMappingSet({ extendedRows, uploadRows, smartstoreRows, erpMasterRows: [] });
const coverage = coverageOf(records);

test('the three prep files parse to the same 4,575 rows the summary publishes', () => {
  assert.equal(extendedRows.length, summary.total_items);
  assert.equal(uploadRows.length, summary.total_items);
  assert.equal(smartstoreRows.length, summary.total_items);
  assert.equal(records.length, summary.total_items);
  assert.equal(comparison.cgi_total_items, summary.total_items, 'the two authorities agree');
  assert.equal(coverage.total, 4575, 'the committed figure is also the literal count');
  const perSite = {};
  for (const record of records) {
    const site = record.cgiId.split(':')[0];
    perSite[site] = (perSite[site] || 0) + 1;
  }
  assert.deepEqual(Object.keys(perSite).sort(), ['samamusic.co.kr', 'samasound.co.kr']);
  assert.deepEqual(Object.values(perSite).sort((a, b) => a - b), Object.values(comparison.cgi_sources).sort((a, b) => a - b), 'the per-site split matches the committed comparison');
  assert.equal(perSite['samasound.co.kr'], comparison.cgi_sources.samasound);
  assert.equal(perSite['samamusic.co.kr'], comparison.cgi_sources.samamusic);
  assert.equal(coverage.fullyJoinedAllThree, 4575, 'no row exists in only one file: the join is complete');
});

test('column coverage equals the published coverage, measured not transcribed', () => {
  assert.equal(coverage.pricePublic, summary.price_available_count);
  assert.equal(coverage.priceInquiry, summary.price_missing_count);
  assert.equal(coverage.barCode, summary.barcode_filled_count);
  assert.equal(coverage.pricePublic + coverage.priceInquiry + coverage.priceUnknown, coverage.total, 'the price states partition the catalogue');
  assert.equal(saleableRows(records).length, summary.price_available_count);
  assert.equal(duplicateProdCds(records).length, duplicateReport.duplicate_code_count);
  assert.equal(new Set(records.map((r) => r.erpProdCdProposed)).size, duplicateReport.unique_codes);
  assert.equal(coverage.stockNumeric, 0, 'the CGI catalogue carries no numeric stock anywhere, so ERP is the only stock source');
  assert.equal(coverage.rates.pricePublic, summary.price_available_count / summary.total_items);
});

test('the CSV reader is proven against a number only correct parsing can reproduce', () => {
  // reports/erp-item-master-mapping.csv states Cafe24 product codes repeat 856
  // times, which is why the ERP key is SS-/SM-<공급처원본ID>. A split-on-comma
  // reader would not reproduce that count at all.
  const counts = new Map();
  for (const row of extendedRows) {
    const code = String(row.cafe24ProductCd || '').trim();
    if (code) counts.set(code, (counts.get(code) || 0) + 1);
  }
  const repeated = [...counts.values()].filter((n) => n > 1);
  assert.equal(repeated.length, 856);
  assert.equal(repeated.reduce((s, n) => s + n - 1, 0), 856, 'exactly one extra row per repeated code');
  assert.ok(!records.some((r) => /^XX-/.test(r.erpProdCd)), 'no row fell through to the unknown-site prefix');
  assert.equal(coverage.erpProdCdSynthetic, 4575);
});

test('every proposed 품목코드 is wire-legal against the vendor column limits', () => {
  const offenders = [];
  for (const record of records) {
    const row = productRow({
      productId: record.erpProdCdProposed,
      productName: record.prodDes,
      unit: record.unit,
      prodType: record.prodType,
      barCode: record.barCode,
      taxRate: record.taxRate,
    });
    const problems = validateRow('saveBasicProduct', row);
    if (problems.length) offenders.push({ cgiId: record.cgiId, problems });
  }
  assert.deepEqual(offenders, [], 'a single over-long field would burn the consecutive-error quota on all 4,575 rows');
  const length = (v) => String(v || '').length;
  assert.equal(records.reduce((m, r) => Math.max(m, length(r.erpProdCdProposed)), 0), 7, 'well inside the 20-char PROD_CD column');
  assert.equal(records.reduce((m, r) => Math.max(m, length(r.prodDes)), 0), OAPI_FIELD_LIMITS.PROD_DES, 'the prep file already caps at the vendor limit');
  assert.equal(records.reduce((m, r) => Math.max(m, length(r.barCode)), 0), 12, 'the 바코드 column holds 12-char Cafe24 item codes, not EAN barcodes');
  assert.deepEqual([...new Set(records.map((r) => r.unit))], ['EA']);
  assert.deepEqual([...new Set(records.map((r) => r.taxRate))], ['10']);
});

test('no 품목코드 is verified against today, and no product is registerable today', () => {
  // The two facts that block activation. Both must stay 0 until a real ERP read
  // and a real image upload happen, so they are asserted as absolutes.
  assert.equal(coverage.erpProdCdVerified, comparison.exact_code_matches);
  assert.equal(comparison.exact_code_matches, 0);
  assert.equal(coverage.naverItemId, 0, '네이버상품ID is reserved empty in the prep file for every row');
  assert.equal(coverage.naverRegistered, 0);
  const statuses = records.reduce((m, r) => {
    const key = resolveErpProdCd(r.cgiId, records).status;
    m[key] = (m[key] || 0) + 1;
    return m;
  }, {});
  assert.deepEqual(statuses, { register_first: 4575 }, 'every slip line must register the item first or the vendor row-fails it');

  // Inverse proof: the counters are not hardcoded zeros. Give the resolver the
  // ERP master row it is missing and both numbers move.
  const withErp = buildMappingSet({
    extendedRows: extendedRows.slice(0, 2),
    uploadRows: uploadRows.slice(0, 2),
    erpMasterRows: [{ PROD_CD: records[0].erpProdCdProposed, BAR_CODE: '' }],
  });
  assert.equal(coverageOf(withErp).erpProdCdVerified, 1);
  assert.equal(resolveErpProdCd(withErp[0].cgiId, withErp).status, 'verified');
  assert.equal(resolveErpProdCd(withErp[1].cgiId, withErp).status, 'register_first');

  const withImage = buildMappingSet({
    extendedRows: extendedRows.slice(0, 1),
    smartstoreRows: [{ 공급처원본ID: records[0].sourceId, sourceId: records[0].sourceId, 네이버상품ID: '500001', naverItemId: '500001' }],
  });
  assert.equal(coverageOf(withImage).naverItemId, 1);
});

test('the mapping material already committed stays the authority for the field transform', () => {
  const mappingRows = parseCsv(read('reports/erp-item-master-mapping.csv'));
  assert.ok(mappingRows.length >= 20, 'the prior lane field-by-field mapping is reused, not reinvented');
  const byErpField = new Map(mappingRows.map((r) => [r.erpField || r.erp_field, r]));
  assert.equal(byErpField.get('prod_cd').coverage, '4575/4575');
  assert.equal(byErpField.get('bar_code').coverage, `${summary.barcode_filled_count}/4575`, 'the 2568 barcode figure this test measures is the same one the mapping sheet published');
  assert.match(byErpField.get('prod_cd').note, /20자 제한/);
  assert.match(byErpField.get('prod_cd').note, /856/, 'the duplicate-code reason for not using the Cafe24 key is carried forward');
  for (const field of ['prod_cd', 'prod_des', 'bar_code']) {
    const limitKey = field.toUpperCase();
    assert.ok(OAPI_FIELD_LIMITS[limitKey], `${limitKey} limit is encoded in erp-plan`);
  }
});
