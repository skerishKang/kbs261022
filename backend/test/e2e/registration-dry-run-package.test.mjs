// End-to-end coverage for the dry-run registration package CLI. The runs are offline
// by construction — no client is built anywhere in this lane — so what is pinned here
// is (a) the committed aggregates are exactly what the tool reproduces, byte for byte,
// (b) every number is re-measured in-process from the same inputs rather than copied
// from the artefact it checks, (c) the two artefacts that gate the same field agree,
// and (d) the refusals actually stop the run: a live mode, a package directory inside
// the repository, and a readiness authority whose tally no longer matches the gate.
//
//   node --test test/e2e/registration-dry-run-package.test.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet, normalizeCgiId } from '../../lib/product-mapping.mjs';
import { classifyCatalog } from '../../lib/registration-readiness.mjs';
import { joinImageEvidence } from '../../lib/naver-images.mjs';
import { planRegistrationContent } from '../../lib/registration-content.mjs';
import { buildDryRunPackage, summarizeDryRunPackages, dryRunFailureRows } from '../../lib/registration-dry-run.mjs';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(BACKEND, '..');
const TOOL = path.join(BACKEND, 'tools', 'registration-dry-run-package.mjs');
const WORK_REL = '.work/dryrun-test';
const WORK = path.join(ROOT, WORK_REL);
const COMMITTED_SUMMARY = path.join(ROOT, 'reports', 'data', 'registration', 'dry_run_summary.json');
const COMMITTED_FAILURES = path.join(ROOT, 'reports', 'data', 'registration', 'dry_run_failures.csv');
const PRIVATE = fs.mkdtempSync(path.join(os.tmpdir(), 'cgi-dryrun-private-'));

after(() => {
  if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(PRIVATE, { recursive: true, force: true });
});

const SOURCES = {
  master: 'data/full_catalog/product_db_compact.csv',
  prep: 'data/smartstore_prep/smartstore_registration_prep.csv',
  options: 'data/full_catalog/options_compact.csv',
  extended: 'data/erp_prep/erp_extended_mapping.csv',
  upload: 'data/erp_prep/ecount_item_upload.csv',
  duplicates: 'data/product_quality/product_duplicate_candidates.csv',
  erpSummary: 'reports/data/erp/summary.json',
  erpComparison: 'reports/data/erp/erp_readonly_comparison.json',
  imageMeasurements: 'reports/data/naver/image_measurements.csv',
  imageVariants: 'reports/data/naver/image_variant_measurements.csv',
  categoryPaths: 'reports/data/naver/category_paths.csv',
  readinessSummary: 'reports/data/registration/readiness_summary.json',
};
const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// The same assembly the tool performs, done here so the published census is a
// cross-check rather than an echo.
const prepRows = readCsv(SOURCES.prep);
const optionRows = readCsv(SOURCES.options);
const records = buildMappingSet({ extendedRows: readCsv(SOURCES.extended), uploadRows: readCsv(SOURCES.upload), smartstoreRows: prepRows, erpMasterRows: [] });
const recordsByCgiId = new Map();
for (const record of records) {
  recordsByCgiId.set(record.cgiId, record);
  if (record.sourceId) recordsByCgiId.set(record.sourceId, record);
}
const optionRowsByProduct = new Map();
for (const row of optionRows) {
  const key = String(row.source_key ?? '').trim();
  if (key === '') continue;
  if (!optionRowsByProduct.has(key)) optionRowsByProduct.set(key, []);
  optionRowsByProduct.get(key).push(row);
}
const content = planRegistrationContent({ masterRows: prepRows, recordsByCgiId, optionRowsByProduct, searchEvidence: new Map() });
const contentByCgiId = new Map();
for (const row of content.rows) {
  contentByCgiId.set(row.cgiId, row);
  contentByCgiId.set(normalizeCgiId(row.cgiId), row);
}
const categoryByPath = new Map(readCsv(SOURCES.categoryPaths).map((row) => [String(row.category_path ?? '').trim(), row]));
const imageEvidence = joinImageEvidence(readCsv(SOURCES.imageMeasurements), readCsv(SOURCES.imageVariants));
const readyRows = classifyCatalog({
  masterRows: readCsv(SOURCES.master), extendedRows: readCsv(SOURCES.extended), smartstoreRows: prepRows,
  optionRows, duplicateRows: readCsv(SOURCES.duplicates), records, comparison: json(SOURCES.erpComparison),
  summary: json(SOURCES.erpSummary), imageEvidence,
}).rows;
const categoryPathByCgiId = new Map(prepRows.map((row) => [normalizeCgiId(row['공급처원본ID'] ?? ''), String(row['카테고리경로_CGI'] ?? '').trim()]));
const localPackages = readyRows.map((row) => {
  const categoryPath = categoryPathByCgiId.get(row.cgi_id) ?? row.supplier_category_path;
  return buildDryRunPackage({
    readyRow: { ...row, supplier_category_path: categoryPath },
    contentRow: contentByCgiId.get(row.cgi_id) || contentByCgiId.get(String(row.source_product_id).includes(':') ? row.source_product_id : `${row.source_site}:${row.source_product_id}`) || null,
    categoryRow: categoryByPath.get(categoryPath) || null,
    duplicateSearchExecuted: false,
  });
});
const localCensus = summarizeDryRunPackages(localPackages);
const localFailures = dryRunFailureRows(localPackages);

const runTool = (label, args, env = {}) => {
  fs.mkdirSync(path.join(WORK, label), { recursive: true });
  return execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd: BACKEND, maxBuffer: 1 << 26, env: { ...process.env, ...env } });
};
const failWith = (args, env = {}) => {
  try {
    return { status: 0, text: execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd: BACKEND, stdio: 'pipe', maxBuffer: 1 << 26, env: { ...process.env, ...env } }) };
  } catch (error) {
    return { status: error.status, text: `${error.stderr || ''}${error.stdout || ''}` };
  }
};
const sameBytes = (a, b) => Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;

test('the committed aggregates are exactly what the tool reproduces, twice', () => {
  runTool('run-a', ['--summary', `${WORK_REL}/run-a/summary.json`, '--failures', `${WORK_REL}/run-a/failures.csv`]);
  runTool('run-b', ['--summary', `${WORK_REL}/run-b/summary.json`, '--failures', `${WORK_REL}/run-b/failures.csv`]);
  for (const name of ['summary.json', 'failures.csv']) {
    const a = path.join(WORK, 'run-a', name);
    const b = path.join(WORK, 'run-b', name);
    assert.ok(sameBytes(a, b), `${name} differs between two runs`);
    assert.ok(sameBytes(a, name === 'summary.json' ? COMMITTED_SUMMARY : COMMITTED_FAILURES), `the committed ${name} is not what the tool reproduces`);
  }
  const aggregate = json(path.relative(ROOT, COMMITTED_SUMMARY));
  assert.equal(aggregate.kind, 'cgi-registration-dry-run-packages');
  assert.equal(aggregate.generated_by, 'backend/tools/registration-dry-run-package.mjs');
  assert.deepEqual(aggregate.census, localCensus, 'the published census must equal the in-process assembly');
  assert.deepEqual(aggregate.failure_rows.map((row) => `${row.field}:${row.reason}:${row.products}`), localFailures.map((row) => `${row.field}:${row.reason}:${row.products}`));
  for (const [key, rel] of Object.entries(SOURCES)) {
    assert.equal(aggregate.inputs[key].path, rel, `${key} must name the file the tool reads`);
    assert.match(aggregate.inputs[key].sha256, /^[0-9a-f]{64}$/, `${key} must pin the sha256 of the file it read`);
  }
  assert.deepEqual(aggregate.input_row_counts, {
    master: readCsv(SOURCES.master).length,
    prep: prepRows.length,
    mapping_records: records.length,
    readiness_rows: readyRows.length,
    option_products: optionRowsByProduct.size,
    category_paths: categoryByPath.size,
    image_measurements: imageEvidence.size,
  }, 'row counts are re-measured here from the same sources the tool read');
});

test('no package is a transmission candidate, and the census shows which values are missing', () => {
  const aggregate = json(path.relative(ROOT, COMMITTED_SUMMARY));
  const census = aggregate.census;
  assert.equal(census.products, 4575);
  assert.equal(census.products, readyRows.length, 'one package per readiness row');
  assert.deepEqual(census.status_by_products, { blocked: 4575 }, 'nothing is even awaiting approval while four values are unconfirmed');
  assert.equal(census.would_transmit_true, 0);
  assert.equal(census.undeclared_gate_reasons, 0);
  assert.equal(census.values_in_bodies.leaf_category_ids, 0, 'no leafCategoryId was confirmed by the category lane');
  assert.equal(census.values_in_bodies.detail_content, 0, 'a supplier 한 줄 설명 and an operator draft are both not detailContent');
  assert.equal(census.values_in_bodies.stock_quantities, 0, 'the useStockManagement=false auto-set is not a measured quantity');
  assert.equal(census.values_in_bodies.images_from_upload_api, 0, 'nothing has passed through POST /v1/product-images/upload');
  assert.equal(census.values_in_bodies.duplicate_searches_executed, 0, 'search-before-register has not run');
  assert.equal(census.values_in_bodies.seller_codes, 4575);
  assert.equal(census.values_in_bodies.option_infos, content.rows.filter((row) => row.optionPlan.emittable).length);
  assert.equal(census.values_in_bodies.sale_prices, readyRows.filter((row) => row.price_usable === 'yes').length);
  assert.equal(census.values_in_bodies.images_supplying_url_only, readyRows.filter((row) => row.representative_image_url).length);
  assert.equal(census.documented_bounds.sale_price_max, 999999990, 'the bound named in the census is the documented one');
  assert.equal(census.precedence_claimed, false);
  for (const [key, value] of Object.entries({ transmitted: false, account_login: 'NO', naver_requests: 0, erp_requests: 0, live_writes: 0 })) {
    assert.equal(census[key], value);
  }
  assert.deepEqual(census.blocking_field_count_histogram, Object.keys(census.blocking_field_count_histogram).reduce((out, key) => { out[key] = localPackages.filter((p) => String(p.blocking_field_count) === key).length; return out; }, {}));
});

test('the package gate and the committed readiness gate agree on every vendor field', () => {
  const aggregate = json(path.relative(ROOT, COMMITTED_SUMMARY));
  const authority = json(SOURCES.readinessSummary).naver.register_problems_by_field;
  const deltas = aggregate.readiness_cross_check.field_deltas;
  const census = aggregate.census;
  assert.equal(aggregate.readiness_cross_check.authority.path, SOURCES.readinessSummary);
  // Comparison happens on the per-PRODUCT tally. The instance tally is published too,
  // and it is deliberately NOT the basis: a gated price puts two salePrice problems on
  // one product, so comparing it to a product count would be a permanent false alarm.
  assert.match(aggregate.readiness_cross_check.basis, /상품 단위/);
  assert.deepEqual(census.products_by_blocking_field, Object.keys(census.products_by_blocking_field).reduce((out, field) => { out[field] = localPackages.filter((p) => p.blocking_fields.includes(field)).length; return out; }, {}));
  for (const [field, count] of Object.entries(census.problems_by_field)) {
    assert.ok(count >= census.products_by_blocking_field[field], `${field}: instances cannot be fewer than products`);
  }
  for (const [field, entry] of Object.entries(deltas)) {
    if (entry.kind !== 'vendor_field') {
      assert.equal(field, 'sellerManagementCode', 'only the lane-only gate may sit outside the vendor field list');
      assert.equal(entry.this_lane, 4575);
      continue;
    }
    assert.equal(entry.readiness, authority[field], `${field}: the cross-check must read the committed authority`);
    assert.equal(entry.this_lane, census.products_by_blocking_field[field], `${field}: the delta must be stated on the compared basis`);
    if (field === 'detailContent') continue;
    if (field === 'salePrice') {
      // Two sources refuse a price for different reasons: the vendor gate sees no number
      // where the classifier saw an untrusted one. Both are measured here, not asserted.
      const untrusted = readyRows.filter((row) => String(row.sale_price) !== '' && row.price_usable !== 'yes').length;
      const missing = readyRows.filter((row) => String(row.sale_price) === '').length;
      assert.equal(authority[field], missing, 'the readiness tally flags salePrice only when no number reaches it');
      assert.equal(entry.this_lane, missing + untrusted);
      assert.equal(entry.delta, untrusted, 'this lane blocks exactly the numbers the classifier refuses to trust, one product at a time');
      assert.equal(aggregate.readiness_cross_check.sale_price_untrusted_by_readiness, untrusted);
      assert.match(entry.explained_by, /price_untrusted_by_readiness=/);
      assert.ok(aggregate.readiness_cross_check.sale_price_rule.includes('price_value_untrusted_parse_artifact'));
      continue;
    }
    assert.equal(entry.delta, 0, `${field}: two artefacts gate the same rows and disagree`);
  }
  // The one legitimate divergence, measured from the source column rather than argued.
  const emptySentences = prepRows.filter((row) => String(row['상세설명'] ?? '').trim() === '').length;
  assert.equal(aggregate.readiness_cross_check.empty_supplier_sentences_measured, emptySentences);
  assert.equal(deltas.detailContent.readiness, emptySentences, 'the readiness tally counts only products with no supplier sentence at all');
  assert.equal(deltas.detailContent.this_lane, prepRows.length, 'this lane refuses to treat a one-line description as a 본문');
  assert.ok(aggregate.readiness_cross_check.detail_content_rule.includes('한 줄 설명'));
});

test('the published artefacts carry counts, not the catalogue', () => {
  const summaryText = fs.readFileSync(COMMITTED_SUMMARY, 'utf8');
  const failuresText = fs.readFileSync(COMMITTED_FAILURES, 'utf8');
  assert.ok(!/https?:\/\//.test(summaryText), 'a dry-run aggregate needs no link to anything');
  for (const text of [summaryText, failuresText]) {
    assert.ok(!/samamusic|samasound|samastore|yamaha/i.test(text), 'no supplier host appears');
    const ids = new Set(prepRows.map((row) => String(row['공급처원본ID'] ?? '').trim()).filter(Boolean));
    assert.equal([...ids].filter((id) => text.includes(id)).length, 0, 'no product id appears');
    const codes = new Set(prepRows.map((row) => String(row['판매자코드'] ?? '').trim()).filter(Boolean));
    assert.equal([...codes].filter((code) => text.includes(code)).length, 0, 'no 판매자코드 appears');
    const names = prepRows.map((row) => String(row['상품명'] ?? '').trim()).filter((name) => name.length > 6);
    assert.equal(names.filter((name) => text.includes(name)).length, 0, `no supplier product name appears (sampled ${names.length})`);
  }
  const failures = parseCsv(failuresText);
  assert.deepEqual(Object.keys(failures[0]), ['field', 'reason', 'products', 'field_authority', 'owner', 'meaning', 'action']);
  assert.deepEqual(failures.map((row) => `${row.field}:${row.reason}`), localFailures.map((row) => `${row.field}:${row.reason}`));
  for (const row of failures) assert.ok(Number(row.products) > 0 && row.owner && row.action, `${row.reason} reaches the CSV without an owner or action`);
  assert.ok(failuresText.startsWith('\uFEFF') && /\r\n$/.test(failuresText), 'the failure table is BOM+CRLF as toCsv writes it — note that every other tracked CSV in this repo is LF, so this file is deliberately Excel-shaped rather than repo-shaped');
});

test('the private packages are written outside the repository and stay unsendable', () => {
  const dir = path.join(PRIVATE, '상품등록준비_20261026');
  const stdout = runTool('private', ['--package-dir', dir, '--summary', `${WORK_REL}/private/summary.json`]);
  assert.match(stdout, /PACKAGE_DIR=/);
  assert.ok(!dir.startsWith(ROOT), 'the assembled bodies must sit outside the repository');
  const text = fs.readFileSync(path.join(dir, 'cgi_dry_run_packages.csv'), 'utf8');
  const rows = parseCsv(text);
  assert.equal(rows.length, 4575);
  assert.deepEqual(Object.keys(rows[0]), ['cgi_id', 'product_name', 'naver_seller_management_code', 'status', 'blocking_fields', 'blocking_field_count', 'rejected_fields', 'option_status', 'option_emittable', 'category_path', 'category_status', 'category_confirmed', 'category_candidate_ids', 'detail_draft_available', 'detail_counts_as_content', 'image_representative_state', 'image_from_upload_api', 'sale_price_in_body', 'stock_quantity_in_body', 'duplicate_search_executed', 'would_transmit', 'readiness_bucket', 'note']);
  assert.equal(rows.every((row) => row.would_transmit === 'no'), true);
  assert.equal(rows.every((row) => row.stock_quantity_in_body === ''), true);
  assert.equal(rows.filter((row) => row.category_candidate_ids !== '').length, 0, 'no candidate id was confirmed, so none may be copied');
  assert.equal(rows.filter((row) => row.detail_counts_as_content === 'yes').length, 0);
  assert.equal(rows.filter((row) => row.image_from_upload_api === 'yes').length, 0);
  assert.equal(rows.filter((row) => row.option_emittable === 'yes').length, content.rows.filter((row) => row.optionPlan.emittable).length);
  assert.equal(rows.filter((row) => row.detail_draft_available === 'yes').length, 4575, 'every product has a draft, and none of them counts as content');

  const lines = fs.readFileSync(path.join(dir, 'cgi_dry_run_packages.jsonl'), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 4575, 'one JSON line per product');
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed.filter((p) => p.would_transmit === false && p.execute === false && p.transmitted === false).length, 4575);
  assert.equal(parsed.filter((p) => p.endpoint_key === 'productRegister' && p.endpoint_path === '/v2/products').length, 4575, 'the package names the documented register endpoint');
  assert.equal(parsed.filter((p) => p.body.originProduct.stockQuantity === null).length, 4575);
  assert.equal(parsed.filter((p) => 'detailContent' in p.body.originProduct).length, 0);
  assert.equal(parsed.filter((p) => 'leafCategoryId' in p.body.originProduct).length, 0);
  assert.deepEqual(parsed.map((p) => p.cgi_id), [...parsed.map((p) => p.cgi_id)].sort(), 'row order is the restart contract');
  assert.equal(new Set(parsed.map((p) => p.naver_seller_management_code)).size, 4575, 'one seller code per package');
});

test('a live mode, an inside-repo package directory, and a doctored authority all stop the run', () => {
  fs.mkdirSync(path.join(WORK, 'guard'), { recursive: true });
  const nothing = failWith([]);
  assert.equal(nothing.status, 2);
  assert.match(nothing.text, /nothing to write/);

  const live = failWith(['--summary', `${WORK_REL}/guard/x.json`], { NCOM_MODE: 'live', NCOM_LIVE_WRITE: 'YES' });
  assert.equal(live.status, 2);
  assert.match(live.text, /dry-run only/);
  const liveErp = failWith(['--summary', `${WORK_REL}/guard/x.json`], { ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES' });
  assert.equal(liveErp.status, 2);
  assert.ok(!fs.existsSync(path.join(WORK, 'guard', 'x.json')), 'a refused run writes nothing');

  const inside = path.join(WORK_REL, 'leak');
  const leak = failWith(['--package-dir', inside]);
  assert.equal(leak.status, 2);
  assert.match(leak.text, /must stay outside/);
  assert.ok(!fs.existsSync(path.join(ROOT, inside)), 'the assembled bodies were written into the repository anyway');

  const escape = failWith(['--summary', '../dryrun_escape.json']);
  assert.equal(escape.status, 2);
  assert.match(escape.text, /--summary target escapes the repository/);
  assert.ok(!fs.existsSync(path.resolve(ROOT, '..', 'dryrun_escape.json')));

  const missing = failWith(['--prep', 'data/smartstore_prep/no_such.csv', '--summary', `${WORK_REL}/guard/x.json`]);
  assert.equal(missing.status, 2);
  assert.match(missing.text, /source file not found: prep/);

  // The authority is a committed file, so a stale or edited tally must be caught
  // rather than silently published beside it.
  const authority = json(SOURCES.readinessSummary);
  const doctored = { ...authority, naver: { ...authority.naver, register_problems_by_field: { ...authority.naver.register_problems_by_field, salePrice: authority.naver.register_problems_by_field.salePrice + 1 } } };
  const doctoredPath = path.join(WORK, 'guard', 'readiness_doctored.json');
  fs.writeFileSync(doctoredPath, `${JSON.stringify(doctored, null, 1)}\n`, 'utf8');
  const clash = failWith(['--readiness-summary', `${WORK_REL}/guard/readiness_doctored.json`, '--summary', `${WORK_REL}/guard/clash.json`]);
  assert.equal(clash.status, 1, 'a package gate that disagrees with the readiness gate on a vendor field must stop the run');
  assert.match(clash.text, /salePrice: 준비도 집계\(\d+\)와 패키지 집계\(\d+\)가 다름/);
  assert.ok(!fs.existsSync(path.join(WORK, 'guard', 'clash.json')));

  const blankAuthority = { ...authority, naver: { ...authority.naver, register_problems_by_field: { ...authority.naver.register_problems_by_field, detailContent: 0 } } };
  fs.writeFileSync(path.join(WORK, 'guard', 'readiness_detail.json'), `${JSON.stringify(blankAuthority, null, 1)}\n`, 'utf8');
  const detailClash = failWith(['--readiness-summary', `${WORK_REL}/guard/readiness_detail.json`, '--summary', `${WORK_REL}/guard/detail.json`]);
  assert.equal(detailClash.status, 1);
  assert.match(detailClash.text, /상세설명 없는 상품/);
});
