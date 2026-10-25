// Issue #95 — the whole catalogue, end to end.
//
// This file is the reason the report's zeros are trustworthy. It runs the real
// generator (`backend/tools/product-registration-readiness.mjs`) as a child
// process over the committed 4,575-row inputs, and compares what it prints and
// what it writes against (a) an in-process classification of the same files and
// (b) three committed authorities that were produced by other work
// (reports/data/erp/summary.json, reports/data/erp/erp_readonly_comparison.json,
// data/product_quality/product_duplicate_candidates.csv).
//
// Nothing here restates the generator's own expectations: a number is either
// cross-checked against an independent authority or asserted as a property
// (conservation, uniqueness, determinism, absence). 등록 가능 0건 is asserted as
// “no row may carry a transmittable payload while these gates are empty”, so it
// cannot be satisfied by a hardcoded zero.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet } from '../../lib/product-mapping.mjs';
import {
  classifyCatalog, missingEntries, summarizeClassification,
  REASONS, REASON_KINDS, STOREWIDE_DECISION_CODES,
} from '../../lib/registration-readiness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TOOL = path.join(ROOT, 'backend/tools/product-registration-readiness.mjs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const SOURCES = {
  masterRows: 'data/full_catalog/product_db_compact.csv',
  extendedRows: 'data/erp_prep/erp_extended_mapping.csv',
  uploadRows: 'data/erp_prep/ecount_item_upload.csv',
  smartstoreRows: 'data/smartstore_prep/smartstore_registration_prep.csv',
  optionRows: 'data/full_catalog/options_compact.csv',
  duplicateRows: 'data/product_quality/product_duplicate_candidates.csv',
};
const AUTHORITIES = {
  comparison: 'reports/data/erp/erp_readonly_comparison.json',
  summary: 'reports/data/erp/summary.json',
};

const inputs = Object.fromEntries(Object.entries(SOURCES).map(([key, rel]) => [key, parseCsv(read(rel))]));
const comparison = json(AUTHORITIES.comparison);
const erpSummary = json(AUTHORITIES.summary);
const records = buildMappingSet({
  extendedRows: inputs.extendedRows,
  uploadRows: inputs.uploadRows,
  smartstoreRows: inputs.smartstoreRows,
  erpMasterRows: [],
});

const classified = classifyCatalog({ ...inputs, records, comparison, summary: erpSummary });
const rows = classified.rows;
const missing = missingEntries(rows);
const stats = summarizeClassification({
  rows,
  missing,
  inputs: {
    masterRows: inputs.masterRows.length,
    records: records.length,
    optionRows: inputs.optionRows.length,
    duplicateRows: inputs.duplicateRows.length,
  },
  comparison,
  summary: erpSummary,
});

// The generator is run twice, into throwaway directories, so byte-for-byte
// reproducibility is measured rather than claimed.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cgi95-'));
const runTool = (label) => {
  const outDir = path.join(scratch, label);
  const stdout = execFileSync(process.execPath, [TOOL, '--out-dir', outDir], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { outDir, report: JSON.parse(stdout), files: fs.readdirSync(outDir).sort() };
};
const runA = runTool('run-a');
const runB = runTool('run-b');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const csvOf = (dir, name) => parseCsv(fs.readFileSync(path.join(dir, name), 'utf8'));

test('the committed inputs are the ones the generator reads, unpinned and unmodified', () => {
  const tool = read('backend/tools/product-registration-readiness.mjs');
  for (const rel of [...Object.values(SOURCES), ...Object.values(AUTHORITIES)]) {
    assert.ok(tool.includes(`'${rel}'`), `the generator must read the same authority this test reads: ${rel}`);
  }
  assert.equal(inputs.masterRows.length, 4575, 'the order of magnitude is the collected catalogue size');
  assert.equal(erpSummary.total_items, inputs.masterRows.length, 'the published ERP-prep count must match the master file');
  assert.equal(erpSummary.unique_item_codes, inputs.masterRows.length);
  for (const key of ['extendedRows', 'uploadRows', 'smartstoreRows']) {
    assert.equal(inputs[key].length, inputs.masterRows.length, `${key} must join one-to-one with the master`);
  }
  assert.equal(records.length, inputs.masterRows.length);
});

test('the generator prints exactly what the in-process classifier measures', () => {
  const r = runA.report;
  assert.equal(r.TOTAL_PRODUCTS, rows.length);
  assert.equal(r.TOTAL_PRODUCTS, stats.products_classified);
  assert.deepEqual(r.BUCKETS, stats.buckets);
  assert.deepEqual(r.BUCKETS_IF_POLICY_DEFAULTS, stats.buckets_if_policy_defaults);
  assert.deepEqual(r.NAVER_MISSING_FIELDS, stats.naver.register_problems_by_field);
  assert.equal(r.NAVER_READY, stats.naver.registerable_now);
  assert.equal(r.ERP_READY, stats.erp.master_matches);
  assert.equal(r.ERP_MAPPING_MISSING, stats.erp.register_required);
  assert.equal(r.DUPLICATE_PRODUCTS, stats.duplicates.products_in_a_pair);
  assert.equal(r.PRICE_USABLE, stats.price.usable_count);
  assert.equal(r.MISSING_ENTRIES, missing.length);
  assert.equal(r.DRY_RUN_BATCHES, stats.erp.register_required);
  assert.equal(r.INPUT_EQUALS_OUTPUT, true);
});

test('re-running the generator reproduces every artifact byte for byte', () => {
  assert.deepEqual(runA.files, runB.files, 'the same set of files must be produced');
  for (const name of runA.files) {
    assert.equal(sha(path.join(runA.outDir, name)), sha(path.join(runB.outDir, name)), `${name} must be identical across runs`);
  }
  assert.ok(runA.files.includes('README_상품등록준비_결과.md'), 'the Korean filename must survive the write');
});

test('the artifacts carry the required columns and one row per product', () => {
  const readiness = csvOf(runA.outDir, 'cgi_product_registration_readiness.csv');
  assert.equal(readiness.length, rows.length, 'one classified row per product, no fan-out');
  const header = Object.keys(readiness[0]);
  assert.equal(new Set(header).size, header.length, 'no duplicated column');
  const required = [
    'product_name', 'brand', 'model', 'source_site', 'source_product_id',
    'sale_price', 'vat_rate_percent', 'vat_base', 'vat_amount',
    'representative_image_url', 'detail_content_chars', 'option_rows', 'manufacturer',
    'erp_prod_cd_proposed', 'erp_master_match', 'naver_leaf_category_id',
    'stock_quantity_confirmed', 'duplicate_pair_count', 'bucket', 'missing_codes',
  ];
  for (const column of required) assert.ok(header.includes(column), `the order requires a column for ${column}`);

  const gaps = csvOf(runA.outDir, 'cgi_product_missing_fields.csv');
  assert.equal(gaps.length, missing.length, 'the long table must reach the CSV untouched');
  assert.equal(Object.values(stats.reason_codes).reduce((a, b) => a + b, 0), gaps.length, 'the reason tally must sum to the long table');

  for (const name of ['cgi_product_registration_readiness.csv', 'cgi_product_missing_fields.csv', 'cgi_erp_mapping_candidates.csv', 'cgi_naver_category_candidates.csv', 'cgi_product_duplicates.csv']) {
    const text = fs.readFileSync(path.join(runA.outDir, name), 'utf8');
    assert.ok(text.startsWith('﻿'), `${name} needs the BOM for Excel`);
    assert.ok(!/﻿/.test(text.slice(1)), `${name} must carry the BOM exactly once`);
    assert.match(text, /\r\n$/, `${name} must end with a CRLF line`);
    assert.ok(!text.includes('\ufffd'), `${name} must not contain a replacement character`);
  }
});

test('every reason code emitted across all 4,575 rows is declared, scoped and owned', () => {
  const codes = new Set(rows.flatMap((row) => row.gap_codes.split(';')).filter(Boolean));
  const declared = new Set(missing.map((entry) => entry.reason_code));
  assert.ok(codes.size > 40, `the full catalogue must exercise a wide vocabulary, saw ${codes.size}`);
  for (const code of codes) {
    const meta = REASONS[code];
    assert.ok(meta, `${code} is emitted but not declared`);
    assert.ok(REASON_KINDS.includes(meta.kind), `${code} has kind ${meta.kind}`);
    assert.ok(meta.field && meta.owner && meta.meaning, `${code} needs field, owner and meaning`);
    if (meta.kind !== 'usable') assert.ok(declared.has(code), `${code} is a gap but never reaches the long table`);
  }
  for (const entry of missing) {
    assert.ok(['storewide_policy', 'product_specific'].includes(entry.scope), `${entry.reason_code} has scope ${entry.scope}`);
    assert.equal(entry.scope, STOREWIDE_DECISION_CODES.includes(entry.reason_code) ? 'storewide_policy' : 'product_specific');
  }
  assert.deepEqual(
    new Set(missing.map((e) => e.scope)),
    new Set(rows.flatMap((row) => (row.blocker_codes_storewide_policy ? ['storewide_policy'] : []).concat(row.blocker_codes_product_specific ? ['product_specific'] : []))),
    'the row columns and the long table must agree on scope',
  );
});

test('inputs, buckets and the scope split are conserved', () => {
  const sum = (object) => Object.values(object).reduce((a, b) => a + b, 0);
  assert.equal(sum(stats.buckets), rows.length);
  assert.equal(sum(stats.buckets_if_policy_defaults), rows.length);
  assert.equal(sum(stats.blockers_by_scope.storewide_policy) + sum(stats.blockers_by_scope.product_specific), rows.reduce((a, r) => a + (r.missing_codes ? r.missing_codes.split(';').length : 0), 0));
  for (const row of rows) {
    assert.equal(
      (row.blocker_codes_storewide_policy ? row.blocker_codes_storewide_policy.split(';').length : 0) +
      (row.blocker_codes_product_specific ? row.blocker_codes_product_specific.split(';').length : 0),
      row.missing_count,
      `${row.cgi_id}: the two blocker columns must sum to missing_count`,
    );
    assert.equal(row.missing_count <= row.gap_count, true, `${row.cgi_id}: blockers cannot outnumber gaps`);
  }
});

test('no Naver payload is transmittable, and the report proves why rather than asserting zero', () => {
  assert.equal(stats.naver.registerable_now, 0);
  for (const row of rows) assert.notEqual(row.naver_register_problems, '', `${row.cgi_id} would have been sent`);
  const problems = stats.naver.register_problems_by_field;
  assert.equal(problems.leafCategoryId, rows.length, 'not one category number was ever collected');
  assert.equal(problems.stockQuantity, rows.length, 'not one confirmed quantity exists');
  assert.equal(problems['images.representative'], rows.length, 'no image has passed through the upload API');
  assert.equal(problems.salePrice, rows.filter((r) => r.sale_price === '').length, 'the vendor gate flags salePrice exactly when no number reaches it');
  assert.equal(rows.filter((r) => r.price_usable === 'no' && r.sale_price !== '').length, stats.price.unusable_codes.price_value_untrusted_parse_artifact,
    'the parse artifact is a number the vendor would accept and this classifier refuses — the seam is reported, not smoothed over');
  assert.equal(rows.filter((r) => r.naver_leaf_category_id).length, 0);
  assert.equal(rows.filter((r) => r.stock_quantity_confirmed === 'yes').length, 0);
  assert.equal(rows.filter((r) => r.naver_uploaded_image).length, 0);
});

test('ERP codes stay proposals: nothing is invented and nothing is matched', () => {
  assert.equal(comparison.exact_code_matches, 0, 'the authority says no code matched exactly');
  assert.equal(stats.erp.master_matches, 0, 'so no row may claim a master match');
  assert.equal(rows.filter((r) => r.erp_master_match === 'yes').length, 0);
  assert.equal(new Set(rows.map((r) => r.erp_code_source)).size, 1, 'every code must come from one declared source');
  assert.equal(stats.erp.unique_dedupe_keys, rows.length, 'one restart key per product');
  assert.equal(new Set(rows.map((r) => r.erp_prod_cd_proposed)).size, erpSummary.unique_item_codes);
  assert.equal(rows.filter((r) => r.erp_wire_validation !== 'ok').length, 0, 'the wire gate must be the only rejection');
  assert.equal(stats.erp.candidate_pairs_aggregate, comparison.candidate_pairs, 'candidate pairs stay an aggregate — no per-product match is fabricated');
  assert.equal(stats.erp.name_exact_pairs_aggregate, comparison.name_exact_pairs);
  assert.equal(stats.erp.model_exact_pairs_aggregate, comparison.model_exact_pairs);
});

test('prices and VAT are measured against the published ERP-prep counts', () => {
  assert.equal(rows.filter((r) => r.model).length, erpSummary.model_present_count);
  assert.equal(rows.filter((r) => r.brand).length, erpSummary.brand_present_count);
  assert.equal(rows.filter((r) => r.manufacturer).length, erpSummary.manufacturer_present_count);
  assert.equal(rows.filter((r) => r.representative_image_url).length, erpSummary.image_ok_count);
  assert.equal(stats.vat.rows_with_public_price, erpSummary.price_available_count, 'price-bearing rows must equal the published count');
  assert.equal(rows.length - stats.vat.rows_with_public_price, erpSummary.price_missing_count);
  assert.equal(stats.price.usable_count, erpSummary.price_available_count - (stats.price.unusable_codes.price_value_untrusted_parse_artifact ?? 0),
    'the parse artifact is the only published price this classifier refuses to use');
  assert.equal(stats.vat.decomposition_failed, 0);
  for (const row of rows.filter((r) => r.sale_price !== '').slice(0, 500)) {
    assert.equal(Number(row.vat_base) + Number(row.vat_amount), Number(row.sale_price), `${row.cgi_id}: 공급가 + 부가세 must rebuild the measured price`);
    assert.ok(Number(row.sale_price) <= 999999990, `${row.cgi_id}: above the Naver ceiling`);
  }
  assert.equal(stats.vat.out_price_conflicts_sale_price, 0);
});

test('duplicates reach both sides of a pair and the source file is not silently expanded', () => {
  assert.equal(stats.duplicates.pairs_in_source_file, inputs.duplicateRows.length);
  assert.equal(
    rows.reduce((sum, r) => sum + r.duplicate_pair_count, 0),
    2 * inputs.duplicateRows.filter((p) => {
      const known = new Set(rows.map((r) => r.cgi_id));
      return known.has(p.왼쪽통합키) && known.has(p.오른쪽통합키);
    }).length,
    'every pair with both products in the catalogue must be counted from each side',
  );
  assert.equal(stats.duplicates.products_in_a_pair, runA.report.DUPLICATE_PRODUCTS);
  for (const verdict of Object.keys(stats.duplicates.by_verdict)) {
    assert.ok(REASONS[`duplicate_pair_${verdict}`] || verdict === 'confirmed', `${verdict} must be a declared verdict`);
  }
});

test('detail content is judged on its measured shape, never on a wish', () => {
  const longest = rows.reduce((m, r) => Math.max(m, r.detail_content_chars), 0);
  assert.equal(stats.detail_content.max_chars, longest);
  assert.ok(longest < stats.detail_content.judged_at_or_above_chars,
    `the corpus tops out at ${longest} characters, below the ${stats.detail_content.judged_at_or_above_chars}-character body threshold`);
  assert.equal(stats.detail_content.authored_body, 0);
  assert.equal(stats.detail_content.summary_only + stats.detail_content.absent, rows.length);
  assert.equal(stats.detail_content.absent, stats.naver.register_problems_by_field.detailContent);
  assert.equal(inputs.smartstoreRows.filter((p) => /<(p|div|br|img|table|ul|ol|li|span|section)\b/i.test(String(p.상세설명 || ''))).length, 0,
    'no prep 상세설명 carries markup — that is the measurement behind 본문 0건');
});

test('the classifier never performs a live call, by construction', () => {
  const sources = [
    'backend/lib/registration-readiness.mjs',
    'backend/tools/product-registration-readiness.mjs',
    'backend/lib/product-mapping.mjs',
  ];
  for (const rel of sources) {
    const text = read(rel);
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'https.request', 'bcryptHashpw', 'Authorization']) {
      assert.ok(!text.includes(forbidden), `${rel} must not contain the call site ${forbidden}`);
    }
  }
  assert.equal(runA.report.ACCOUNT_LOGIN, 'NO');
  assert.equal(runA.report.ERP_REQUESTS, 0);
  assert.equal(runA.report.NAVER_REQUESTS, 0);
  assert.equal(runA.report.LIVE_WRITES, 0);
  const dryRun = JSON.parse(fs.readFileSync(path.join(runA.outDir, 'cgi_registration_dry_run.json'), 'utf8'));
  assert.equal(dryRun.transmitted, false);
  assert.equal(dryRun.account_login, 'NO');
  assert.equal(dryRun.erp_requests, 0);
  assert.equal(dryRun.naver_requests, 0);
  assert.equal(dryRun.live_writes, 0);
  assert.equal(dryRun.erp.endpoint, 'SaveBasicProduct', 'the plan names the endpoint it would have called');
  assert.equal(dryRun.erp.rows_requested, rows.length);
  assert.equal(dryRun.erp.accepted, rows.length);
  assert.equal(dryRun.erp.rejected, 0);
  assert.equal(dryRun.erp.per_item_dedupe_keys_unique, rows.length);
  assert.equal(dryRun.erp.batch_dedupe_keys_unique, dryRun.erp.batches, 'batch-position keys are unique only while the accepted set is unchanged, which is why the per-item key is the restart key');
  assert.equal(dryRun.erp.register_first_required, rows.length);
  assert.equal(dryRun.erp.verified_against_erp_master, 0);
  assert.equal(dryRun.erp.mapping_aggregates_only.per_product_evidence, 'not_persisted', 'candidate pairs must stay an aggregate');
  assert.equal(dryRun.naver.registerable_now, 0);
  assert.ok(dryRun.naver.auth_gap.reason.length > 0, 'the auth gap must be stated, not hidden');
  assert.ok(Array.isArray(dryRun.naver.unconfirmed) && dryRun.naver.unconfirmed.length > 0, 'unconfirmed contract items must be listed');
  assert.equal(dryRun.conservation.input_equals_output, true);
});

test('row order is the restart contract: cgi_id ascending and unique', () => {
  const ids = rows.map((r) => r.cgi_id);
  assert.equal(new Set(ids).size, ids.length, 'one row per product id');
  assert.deepEqual(ids, [...ids].sort(), 'stable order so a re-run can skip by key');
  const erpArtifact = csvOf(runA.outDir, 'cgi_erp_mapping_candidates.csv');
  assert.deepEqual(erpArtifact.map((r) => r.cgi_id), ids, 'the ERP artifact must line up row for row');
});
