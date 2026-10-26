#!/usr/bin/env node
// CGI LOCAL 2 step ⑥ — the dry-run registration package, product by product, with
// the 실패사유 broken out. No authentication, no transmission, no live mode.
//
//   node tools/registration-dry-run-package.mjs \
//     --summary reports/data/registration/dry_run_summary.json \
//     --failures reports/data/registration/dry_run_failures.csv \
//     --package-dir "G:/Ddrive/.../상품등록준비_20261026"
//
// --summary and --failures are counts and reason codes only, so they are the git-facing
// artefacts. --package-dir holds the assembled bodies and supplier product names, so it
// must be outside the repository — the run refuses a target inside the working tree.
//
// The body is built by buildRegisterBody, the same function the real register lane
// would call, so a clean package here would be a clean package there. None are clean:
// the four values the vendor requires and this catalogue does not have — a confirmed
// leafCategoryId, a detailContent body that counts, a counted stockQuantity, and an
// image URL returned by POST /v1/product-images/upload — are absent for every product,
// and search-before-register has not run. This tool therefore reports 0 candidates and
// names the reason per field, which is the correct output for a lane that cannot log in.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet, normalizeCgiId } from '../lib/product-mapping.mjs';
import { toCsv, classifyCatalog } from '../lib/registration-readiness.mjs';
import { joinImageEvidence } from '../lib/naver-images.mjs';
import { planRegistrationContent } from '../lib/registration-content.mjs';
import { buildDryRunPackage, summarizeDryRunPackages, dryRunFailureRows, findPackageViolations, REGISTER_GATE_DOC } from '../lib/registration-dry-run.mjs';
import { ncomModeFromEnv, NCOM_ENDPOINTS } from '../lib/ncommerce.mjs';
import { oapiModeFromEnv } from '../lib/erp-oapi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const SOURCES = {
  master: option('master', 'data/full_catalog/product_db_compact.csv'),
  prep: option('prep', 'data/smartstore_prep/smartstore_registration_prep.csv'),
  options: option('options', 'data/full_catalog/options_compact.csv'),
  extended: option('extended', 'data/erp_prep/erp_extended_mapping.csv'),
  upload: option('upload', 'data/erp_prep/ecount_item_upload.csv'),
  duplicates: option('duplicates', 'data/product_quality/product_duplicate_candidates.csv'),
  erpSummary: option('erp-summary', 'reports/data/erp/summary.json'),
  erpComparison: option('erp-comparison', 'reports/data/erp/erp_readonly_comparison.json'),
  imageMeasurements: option('image-measurements', 'reports/data/naver/image_measurements.csv'),
  imageVariants: option('image-variants', 'reports/data/naver/image_variant_measurements.csv'),
  categoryPaths: option('category-paths', 'reports/data/naver/category_paths.csv'),
  // The committed readiness aggregate is an authority here: the same rows are gated by
  // the same buildRegisterBody, so any field where the two artefacts disagree has to be
  // explained by a stated rule rather than left as a silent difference.
  readinessSummary: option('readiness-summary', 'reports/data/registration/readiness_summary.json'),
};
const SUMMARY = option('summary', null);
const FAILURES = option('failures', null);
const PACKAGE_DIR = option('package-dir', null);

// The lane cannot log in, and this entry point is not where a live run would start.
const ncomMode = ncomModeFromEnv(process.env);
const erpMode = oapiModeFromEnv(process.env);
if (ncomMode === 'live' || erpMode === 'live') {
  console.error(`this entry point is dry-run only: NCOM_MODE=${ncomMode} ERP_MODE=${erpMode}`);
  process.exit(2);
}
if (!SUMMARY && !FAILURES && !PACKAGE_DIR) {
  console.error('nothing to write: pass --summary and --failures (git-facing aggregates) and/or --package-dir (private assembled bodies)');
  process.exit(2);
}
for (const [label, rel] of Object.entries(SOURCES)) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`source file not found: ${label}=${rel}`);
    process.exit(2);
  }
}
// Assembled bodies carry supplier text, so they may only land outside the repo; the two
// aggregates are counts, so they may only land inside it.
if (PACKAGE_DIR) {
  const resolved = path.resolve(ROOT, PACKAGE_DIR);
  if (resolved === ROOT || resolved.startsWith(ROOT + path.sep)) {
    console.error(`--package-dir target escapes into the repository; assembled bodies must stay outside it: ${resolved}`);
    process.exit(2);
  }
}
for (const [flagName, rel] of [['--summary', SUMMARY], ['--failures', FAILURES]]) {
  if (!rel) continue;
  const resolved = path.resolve(ROOT, rel);
  if (!resolved.startsWith(ROOT + path.sep)) {
    console.error(`${flagName} target escapes the repository: ${resolved}`);
    process.exit(2);
  }
}

const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const sha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

const masterRows = readCsv(SOURCES.master);
const prepRows = readCsv(SOURCES.prep);
const optionRows = readCsv(SOURCES.options);
const extendedRows = readCsv(SOURCES.extended);
const uploadRows = readCsv(SOURCES.upload);
const duplicateRows = readCsv(SOURCES.duplicates);
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const comparison = json(SOURCES.erpComparison);
const erpSummary = json(SOURCES.erpSummary);
const imageEvidence = joinImageEvidence(readCsv(SOURCES.imageMeasurements), readCsv(SOURCES.imageVariants));

const records = buildMappingSet({ extendedRows, uploadRows, smartstoreRows: prepRows, erpMasterRows: [] });
// buildMappingSet normalizes "samasound:3836" to "samasound.co.kr:3836" while the prep
// CSV and options_compact keep the short form, so the content join map carries both.
const recordsByCgiId = new Map();
for (const record of records) {
  recordsByCgiId.set(record.cgiId, record);
  if (record.sourceId) recordsByCgiId.set(record.sourceId, record);
}
const joined = prepRows.filter((row) => recordsByCgiId.has(String(row['공급처원본ID'] ?? '').trim())).length;
if (joined !== prepRows.length) {
  console.error(`mapping join incomplete: ${joined}/${prepRows.length} prep rows matched a mapping record — refusing to package on fallback records`);
  process.exit(1);
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
const readinessRows = classifyCatalog({
  masterRows, extendedRows, smartstoreRows: prepRows, optionRows, duplicateRows, records, comparison, summary: erpSummary, imageEvidence,
}).rows;

// The candidate table is keyed on the prep column it was generated from, not on the
// classifier's supplier_category_path (which prefers the ERP category), so the join
// goes through the prep value the table actually holds.
const categoryByPath = new Map(readCsv(SOURCES.categoryPaths).map((row) => [String(row.category_path ?? '').trim(), row]));
const categoryPathByCgiId = new Map(prepRows.map((row) => [normalizeCgiId(row['공급처원본ID'] ?? ''), String(row['카테고리경로_CGI'] ?? '').trim()]));

const packages = readinessRows.map((row) => {
  const categoryPath = categoryPathByCgiId.get(row.cgi_id) ?? row.supplier_category_path;
  return buildDryRunPackage({
    readyRow: { ...row, supplier_category_path: categoryPath },
    contentRow: contentByCgiId.get(row.cgi_id) || contentByCgiId.get(String(row.source_product_id).includes(':') ? row.source_product_id : `${row.source_site}:${row.source_product_id}`) || null,
    categoryRow: categoryByPath.get(categoryPath) || null,
    duplicateSearchExecuted: false,
  });
});

// Fail closed before anything is written: the library guards the per-package invariants,
// and the readiness cross-check below guards the aggregate.
const emittable = content.rows.filter((row) => row.optionPlan.emittable).length;
const violations = findPackageViolations({ packages, readinessRows, emittableOptionPlans: emittable });

const census = summarizeDryRunPackages(packages);
const failureRows = dryRunFailureRows(packages);

// Cross-check against the committed readiness aggregate. Both artefacts call the same
// gate over the same rows, so the per-PRODUCT blocking tally must match field by field.
// Two differences are declared rather than smoothed over: detailContent, where the
// classifier accepts the supplier's 한 줄 설명 as a value and this lane refuses to treat
// it as a 상세설명 본문; and salePrice, where this lane additionally gates the numbers the
// classifier itself refuses to trust (price_value_untrusted_parse_artifact).
const readinessAuthority = json(SOURCES.readinessSummary);
const authorityProblems = (readinessAuthority.naver && readinessAuthority.naver.register_problems_by_field) || {};
const emptySupplierSentences = prepRows.filter((row) => String(row['상세설명'] ?? '').trim() === '').length;
const untrustedPrices = readinessRows.filter((row) => String(row.sale_price) !== '' && row.price_usable !== 'yes').length;
const fieldDeltas = {};
// sellerManagementCode is this lane's own gate: buildRegisterBody cannot check it,
// because Naver states 판매자관리코드 does not guarantee uniqueness. It is named here
// rather than being allowed to slip through the comparison unmentioned.
const LANE_ONLY_GATES = ['sellerManagementCode'];
for (const [field, count] of Object.entries(census.products_by_blocking_field)) {
  const authority = authorityProblems[field];
  fieldDeltas[field] = { this_lane: count, readiness: authority ?? null, delta: authority == null ? null : count - authority, kind: authority == null ? 'lane_only' : 'vendor_field' };
  if (field === 'detailContent') continue;
  if (authority === undefined) {
    if (!LANE_ONLY_GATES.includes(field)) violations.push(`${field}: 준비도 집계에 없는 필드를 이 레인이 차단했다 — 추가 게이트인지 확인 필요`);
    continue;
  }
  const expected = field === 'salePrice' ? authority + untrustedPrices : authority;
  if (count !== expected) violations.push(`${field}: 준비도 집계(${authority})와 패키지 집계(${count})가 다름 — 설명된 차이 ${expected}를 넘는다`);
  if (field === 'salePrice' && count !== authority) {
    fieldDeltas[field].explained_by = `price_untrusted_by_readiness=${untrustedPrices}`;
  }
}
for (const field of Object.keys(authorityProblems)) {
  if (!(field in census.products_by_blocking_field)) violations.push(`${field}: 준비도 집계가 차단한 필드인데 패키지 집계에서 사라졌다`);
}
if (authorityProblems.detailContent !== emptySupplierSentences) {
  violations.push(`준비도 집계는 상세설명 없는 상품을 ${authorityProblems.detailContent}건으로 봤는데 원천 컬럼 실측은 ${emptySupplierSentences}건입니다`);
}
if (census.products_by_blocking_field.detailContent !== prepRows.length) {
  violations.push('이 레인은 공급처 한 줄 설명을 detailContent 로 인정하지 않으므로 전 상품 차단이어야 한다');
}
if (violations.length > 0) {
  console.error(`refusing to write: ${violations.length} violation(s)`);
  for (const violation of violations.slice(0, 10)) console.error(`  - ${violation}`);
  process.exit(1);
}

const PACKAGE_COLUMNS = ['cgi_id', 'product_name', 'naver_seller_management_code', 'status', 'blocking_fields', 'blocking_field_count', 'rejected_fields', 'option_status', 'option_emittable', 'category_path', 'category_status', 'category_confirmed', 'category_candidate_ids', 'detail_draft_available', 'detail_counts_as_content', 'image_representative_state', 'image_from_upload_api', 'sale_price_in_body', 'stock_quantity_in_body', 'duplicate_search_executed', 'would_transmit', 'readiness_bucket', 'note'];
const packageRows = packages.map((pkg) => ({
  cgi_id: pkg.cgiId,
  product_name: pkg.productName,
  naver_seller_management_code: pkg.sellerManagementCode,
  status: pkg.status,
  blocking_fields: pkg.blocking_fields.join(';'),
  blocking_field_count: pkg.blocking_field_count,
  rejected_fields: pkg.problems.map((p) => `${p.field}:${p.reason}`).join(';'),
  option_status: pkg.evidence.option.status,
  option_emittable: pkg.evidence.option.emittable === true ? 'yes' : 'no',
  category_path: pkg.evidence.category ? pkg.evidence.category.path : '',
  category_status: pkg.evidence.category ? pkg.evidence.category.status : 'not_computed',
  category_confirmed: pkg.evidence.category ? pkg.evidence.category.confirmed : 'no',
  category_candidate_ids: pkg.evidence.category ? pkg.evidence.category.candidates.join('|') : '',
  detail_draft_available: pkg.evidence.detail.draft_available ? 'yes' : 'no',
  detail_counts_as_content: pkg.evidence.detail.counts_as_detail_content === true ? 'yes' : 'no',
  image_representative_state: pkg.evidence.image.measured_state,
  image_from_upload_api: pkg.evidence.image.representative_is_upload_api_url ? 'yes' : 'no',
  sale_price_in_body: pkg.body.originProduct.salePrice ?? '',
  stock_quantity_in_body: pkg.body.originProduct.stockQuantity ?? '',
  duplicate_search_executed: 'no',
  would_transmit: 'no',
  readiness_bucket: pkg.bucket,
  note: pkg.note,
}));

const FAILURE_COLUMNS = ['field', 'reason', 'products', 'field_authority', 'owner', 'meaning', 'action'];

if (PACKAGE_DIR) {
  const resolved = path.resolve(ROOT, PACKAGE_DIR);
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, 'cgi_dry_run_packages.csv'), toCsv(packageRows, PACKAGE_COLUMNS));
  const lines = packages.map((pkg) => JSON.stringify({
    cgi_id: pkg.cgiId,
    naver_seller_management_code: pkg.sellerManagementCode,
    blocking_fields: pkg.blocking_fields,
    problems: pkg.problems,
    would_transmit: false,
    execute: false,
    transmitted: false,
    endpoint_key: 'productRegister',
    endpoint_path: NCOM_ENDPOINTS.productRegister.path,
    body: pkg.body,
    evidence: pkg.evidence,
  }));
  fs.writeFileSync(path.join(resolved, 'cgi_dry_run_packages.jsonl'), `${lines.join('\n')}\n`);
  console.log(`PACKAGE_DIR=${resolved}`);
}

if (FAILURES) {
  const target = path.resolve(ROOT, FAILURES);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toCsv(failureRows, FAILURE_COLUMNS));
  console.log(`FAILURES=${path.relative(ROOT, target)}`);
}

if (SUMMARY) {
  const target = path.resolve(ROOT, SUMMARY);
  const aggregate = {
    kind: 'cgi-registration-dry-run-packages',
    generated_by: 'backend/tools/registration-dry-run-package.mjs',
    inputs: Object.fromEntries(Object.entries(SOURCES).map(([key, rel]) => [key, { path: rel, sha256: sha256(rel) }])),
    input_row_counts: { master: masterRows.length, prep: prepRows.length, mapping_records: records.length, readiness_rows: readinessRows.length, option_products: optionRowsByProduct.size, category_paths: categoryByPath.size, image_measurements: imageEvidence.size },
    census,
    readiness_cross_check: {
      authority: { path: SOURCES.readinessSummary, sha256: sha256(SOURCES.readinessSummary) },
      basis: 'products_by_blocking_field vs register_problems_by_field — 산출물 둘 다 상품 단위 집계로 비교한다. problems_by_field 는 사유 인스턴스 수라서 이 비교의 기준으로 쓰지 않는다.',
      field_deltas: fieldDeltas,
      detail_content_rule: '준비도 집기는 공급처 한 줄 설명을 detailContent 값으로 봐서 없는 상품만 세고, 이 레인은 그 값으로 인정하지 않아 전 상품이 차단된다.',
      sale_price_rule: '준비도 집기는 숫자가 없는 상품만 salePrice 로 세고, 이 레인은 거기에 더해 분류기가 신뢰할 수 없다고 판정한 숫자(price_value_untrusted_parse_artifact)도 본문에서 비운다. 따라서 이 레인의 차단 상품 수는 준비도 + 불신 숫자 건수다.',
      empty_supplier_sentences_measured: emptySupplierSentences,
      sale_price_untrusted_by_readiness: untrustedPrices,
    },
    failure_rows: failureRows.map((row) => ({ field: row.field, reason: row.reason, products: row.products, owner: row.owner })),
    gate_vocabulary: Object.keys(REGISTER_GATE_DOC).sort(),
    option_plans: { emittable_products: emittable, children_in_option_bodies: content.rows.reduce((sum, row) => sum + (row.optionPlan.emittable ? row.optionPlan.children.length : 0), 0) },
    rule: census.rule,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`SUMMARY=${path.relative(ROOT, target)}`);
}

console.log(`PRODUCTS=${packages.length}`);
console.log(`MAPPING_JOINED=${joined}/${prepRows.length}`);
console.log(`PACKAGES_BLOCKED=${census.status_by_products.blocked ?? 0}`);
console.log(`PACKAGES_AWAITING_APPROVAL=${census.status_by_products.awaiting_operator_approval ?? 0}`);
console.log(`TRANSMITTABLE_CANDIDATES=${packages.filter((p) => p.problems.length === 0).length}`);
console.log(`PROBLEMS_BY_FIELD=${JSON.stringify(census.problems_by_field)}`);
console.log(`PRODUCTS_BLOCKED_BY_FIELD=${JSON.stringify(census.products_by_blocking_field)}`);
console.log(`VALUES_IN_BODIES=${JSON.stringify(census.values_in_bodies)}`);
console.log(`OPTION_BODIES=${census.values_in_bodies.option_infos}/${emittable}`);
console.log(`FAILURE_REASONS=${failureRows.length}`);
console.log(`DETAILCONTENT_THIS_LANE_VS_READINESS=${census.products_by_blocking_field.detailContent}/${authorityProblems.detailContent}`);
console.log(`READINESS_FIELD_DELTAS=${JSON.stringify(Object.fromEntries(Object.entries(fieldDeltas).map(([field, entry]) => [field, entry.delta])))}`);
console.log(`PRICE_UNTRUSTED_BY_READINESS=${untrustedPrices}`);
console.log(`UNDECLARED_GATE_REASONS=${census.undeclared_gate_reasons}`);
console.log('ACCOUNT_LOGIN=NO');
console.log('NAVER_REQUESTS=0');
console.log('ERP_REQUESTS=0');
console.log('LIVE_WRITES=0');
console.log('TRANSMITTED=false');
console.log(`NAVER_MODE=${ncomMode}`);
console.log(`ERP_MODE=${erpMode}`);
