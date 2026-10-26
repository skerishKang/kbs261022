#!/usr/bin/env node
// CGI LOCAL 2 step ⑤ — what the catalogue can actually answer for 상세설명·옵션·
// 숫자형 재고·중복 방지, product by product, without a single authenticated call.
//
//   node tools/registration-content-plan.mjs \
//     --summary reports/data/registration/content_plan_summary.json \
//     --plan-dir "G:/Ddrive/.../상품등록준비_20261026"
//
// --summary is the de-identified aggregate (counts and reason codes only) and is
// the only output meant for git. --plan-dir holds the per-product rows, which carry
// supplier product names and option labels, so it must be a path outside the
// repository — the run refuses to place it inside the working tree.
//
// What this lane may not do, and this tool therefore does not do: authenticate to
// Naver or 이카운트, register/modify/delete a product, or invent an option child, a
// stock quantity, a detail body, or a category id. A plan value is either copied out
// of a source column or it stays a reason code. The stock plan and the duplicate
// search both come back with `requests: []` / `searched: 0` — that is the correct
// output for a lane that cannot log in, not a stub.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet } from '../lib/product-mapping.mjs';
import { toCsv } from '../lib/registration-readiness.mjs';
import { NCOM_LIMITS, NAVER_OPTION_TYPES } from '../lib/ncommerce.mjs';
import { CONTENT_DOC, planRegistrationContent, summarizeContentPlan, findPlanViolations } from '../lib/registration-content.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const SOURCES = {
  prep: option('prep', 'data/smartstore_prep/smartstore_registration_prep.csv'),
  options: option('options', 'data/full_catalog/options_compact.csv'),
  extended: option('extended', 'data/erp_prep/erp_extended_mapping.csv'),
  upload: option('upload', 'data/erp_prep/ecount_item_upload.csv'),
};
const SUMMARY = option('summary', null);
const PLAN_DIR = option('plan-dir', null);

const sha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

if (!SUMMARY && !PLAN_DIR) {
  console.error('nothing to write: pass --summary (de-identified aggregate) and/or --plan-dir (private per-product rows)');
  process.exit(2);
}
for (const [label, rel] of Object.entries(SOURCES)) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`source file not found: ${label}=${rel}`);
    process.exit(2);
  }
}
// The per-product rows carry supplier text, so they may only land outside the repo;
// the aggregate is counts only, so it may only land inside it.
if (PLAN_DIR) {
  const resolved = path.resolve(ROOT, PLAN_DIR);
  if (resolved === ROOT || resolved.startsWith(ROOT + path.sep)) {
    console.error(`--plan-dir target escapes into the repository; private rows must stay outside it: ${resolved}`);
    process.exit(2);
  }
}
const summaryTarget = SUMMARY ? path.resolve(ROOT, SUMMARY) : null;
if (summaryTarget && !summaryTarget.startsWith(ROOT + path.sep)) {
  console.error(`--summary target escapes the repository: ${summaryTarget}`);
  process.exit(2);
}

const prepRows = readCsv(SOURCES.prep);
const optionRows = readCsv(SOURCES.options);
const extendedRows = readCsv(SOURCES.extended);
const uploadRows = readCsv(SOURCES.upload);

const records = buildMappingSet({ extendedRows, uploadRows, smartstoreRows: prepRows, erpMasterRows: [] });
// buildMappingSet normalizes "samasound:3836" to "samasound.co.kr:3836" while the
// prep CSV and options_compact keep the short form, so the join map carries both.
const recordsByCgiId = new Map();
for (const record of records) {
  recordsByCgiId.set(record.cgiId, record);
  if (record.sourceId) recordsByCgiId.set(record.sourceId, record);
}
const joined = prepRows.filter((row) => recordsByCgiId.has(String(row['공급처원본ID'] ?? '').trim())).length;
if (joined !== prepRows.length) {
  console.error(`mapping join incomplete: ${joined}/${prepRows.length} prep rows matched a mapping record — refusing to plan on fallback records`);
  process.exit(1);
}
const optionRowsByProduct = new Map();
for (const row of optionRows) {
  const key = String(row.source_key ?? '').trim();
  if (key === '') continue;
  if (!optionRowsByProduct.has(key)) optionRowsByProduct.set(key, []);
  optionRowsByProduct.get(key).push(row);
}

const { rows, stockPlan, duplicateGuard, priceCheck } = planRegistrationContent({ masterRows: prepRows, recordsByCgiId, optionRowsByProduct, searchEvidence: new Map() });
const census = summarizeContentPlan({ rows, stockPlan, duplicateGuard, priceCheck });

// Fail closed: a plan that emits an option child not present in the supplier's own
// summary string, or a draft that claims to satisfy detailContent, is a defect in
// this file — nothing is written in that case.
const summaryByCgiId = new Map(prepRows.map((row) => [String(row['공급처원본ID'] ?? '').trim(), String(row['옵션SKU요약'] ?? '')]));
const violations = findPlanViolations({ rows, summaryByCgiId, stockPlan });
if (violations.length > 0) {
  console.error(`refusing to write: ${violations.length} violation(s)`);
  for (const violation of violations.slice(0, 10)) console.error(`  - ${violation}`);
  process.exit(1);
}

const OPTION_COLUMNS = ['cgi_id', 'option_type', 'status', 'emittable', 'reasons', 'groups', 'children', 'children_total', 'usable_known_children', 'sold_out_children', 'add_price_children', 'claimed_option_count', 'summary_entry_count', 'truncated_entries', 'unparsed_entries', 'dropped_groups', 'notes'];
const optionPlanRows = rows.map((row) => ({
  cgi_id: row.cgiId,
  option_type: row.optionPlan.optionType,
  status: row.optionPlan.status,
  emittable: row.optionPlan.emittable ? 'yes' : 'no',
  reasons: row.optionPlan.reasons.join(';'),
  groups: row.optionPlan.groups.join(';'),
  children: row.optionPlan.children.map((c) => `${c.groupName}=${c.childName}${c.addPrice != null ? `(+${c.addPrice})` : c.usable === false ? '[품절]' : ''}`).join(';'),
  children_total: row.optionPlan.children.length,
  usable_known_children: row.optionPlan.usableKnownChildren,
  sold_out_children: row.optionPlan.soldOutChildren,
  add_price_children: row.optionPlan.addPriceChildren,
  claimed_option_count: row.optionPlan.claimedCount ?? '',
  summary_entry_count: row.optionPlan.shownEntries,
  truncated_entries: row.optionPlan.truncatedEntries,
  unparsed_entries: row.optionPlan.unparsedEntries,
  dropped_groups: row.optionPlan.droppedGroups.join(';'),
  notes: row.optionPlan.notes.join(' | '),
}));

const DETAIL_COLUMNS = ['cgi_id', 'counts_as_detail_content', 'operator_approval_required', 'source_fields', 'missing_fields', 'draft_text_length', 'draft_html'];
const detailRows = rows.map((row) => ({
  cgi_id: row.cgiId,
  counts_as_detail_content: row.detailDraft.counts_as_detail_content ? 'yes' : 'no',
  operator_approval_required: row.detailDraft.operator_approval_required ? 'yes' : 'no',
  source_fields: row.detailDraft.sourceFields.join(';'),
  missing_fields: row.detailDraft.reasons.join(';'),
  draft_text_length: row.detailDraft.textLength,
  draft_html: row.detailDraft.html,
}));

if (PLAN_DIR) {
  const resolved = path.resolve(ROOT, PLAN_DIR);
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, 'cgi_option_plan.csv'), toCsv(optionPlanRows, OPTION_COLUMNS));
  fs.writeFileSync(path.join(resolved, 'cgi_detail_drafts.csv'), toCsv(detailRows, DETAIL_COLUMNS));
  console.log(`PLAN_DIR=${resolved}`);
}

if (SUMMARY) {
  const aggregate = {
    kind: 'cgi-registration-content-plan',
    generated_by: 'backend/tools/registration-content-plan.mjs',
    inputs: Object.fromEntries(Object.entries(SOURCES).map(([key, rel]) => [key, { path: rel, sha256: sha256(rel) }])),
    input_row_counts: { prep: prepRows.length, option_rows: optionRows.length, option_products: optionRowsByProduct.size, mapping_records: records.length },
    census,
    stock_read_plan: {
      endpoint_key: stockPlan.endpointKey,
      oapi_path: stockPlan.oapiPath,
      authed: stockPlan.authed,
      min_interval_ms: stockPlan.minIntervalMs,
      batches_planned: stockPlan.batches,
      requests: stockPlan.requests,
      reasons: stockPlan.reasons,
      note: stockPlan.note,
    },
    duplicate_guard: duplicateGuard,
    price_check: priceCheck,
    documented_bounds: {
      sale_price_max: NCOM_LIMITS.salePriceMax,
      stock_quantity_max: NCOM_LIMITS.stockQuantityMax,
      standard_option_auto_stock: NCOM_LIMITS.standardOptionStockWhenUnmanaged,
      option_types: NAVER_OPTION_TYPES,
    },
    unconfirmed: CONTENT_DOC.unconfirmed,
    detail_content_contract: CONTENT_DOC.detailContent,
    seller_code_contract: CONTENT_DOC.sellerManagementCode,
    rule: '옵션 자식은 공급처 옵션SKU요약 문자열에 실제로 있는 항목만 담고, 잘린 목록의 상품은 등록 후보로 내지 않는다. 상세설명 초안은 counts_as_detail_content=false 로 운영자 승인을 요구한다. 재고 수량과 검색 결과는 읽지 않은 값이 0건이며 임의 생성하지 않는다.',
  };
  fs.mkdirSync(path.dirname(summaryTarget), { recursive: true });
  fs.writeFileSync(summaryTarget, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`SUMMARY=${path.relative(ROOT, summaryTarget)}`);
}

console.log(`PRODUCTS=${rows.length}`);
console.log(`MAPPING_JOINED=${joined}/${prepRows.length}`);
console.log(`OPTION_EMITTABLE=${census.options.emittable_products}`);
console.log(`OPTION_CHILDREN=${census.options.option_children_emitted}`);
console.log(`OPTION_TRUNCATED=${census.options.truncated_entries}`);
console.log(`OPTION_STATUS=${JSON.stringify(census.options.status_by_products)}`);
console.log(`DETAIL_DRAFTS=${census.detail.drafts}`);
console.log(`DETAIL_COUNTING_AS_CONTENT=${census.detail.counts_as_detail_content}`);
console.log(`STOCK_NUMERIC=${census.stock.numeric_in_catalogue}`);
console.log(`STOCK_REQUESTS=${census.stock.requests_executed}`);
console.log(`SELLER_CODES=${census.duplicates.distinct_seller_codes}/${rows.length}`);
console.log(`SELLER_CODE_DUPLICATED=${census.duplicates.duplicated_codes}`);
console.log(`SELLER_CODE_LENGTH=${duplicateGuard.codeLengthMin}-${duplicateGuard.codeLengthMax}`);
console.log(`PRICE_NUMERIC=${census.price.with_numeric_price}`);
console.log(`PRICE_OVER_MAX=${census.price.over_documented_max}`);
console.log('ACCOUNT_LOGIN=NO');
console.log('NAVER_REQUESTS=0');
console.log('ERP_REQUESTS=0');
console.log('LIVE_WRITES=0');
console.log('TRANSMITTED=false');
