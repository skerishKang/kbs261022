#!/usr/bin/env node
// M1 — the eight-field registration readiness report over all 4,575 products.
//
// Reuses the committed classifier (backend/lib/registration-readiness.mjs) and
// the M1 detail template (backend/lib/detail-template.mjs) — no new verdict is
// invented here. Reads the same committed inputs as
// product-registration-readiness.mjs and writes ONE de-identified aggregate:
//
//   reports/data/registration/m1_readiness_report.json
//
// Per-product CSVs stay with product-registration-readiness.mjs; this report is
// the M1 field rollup (카테고리·판매가·재고·상세설명·이미지·원산지·배송·반품·AS·인증),
// the M1 additions (auth runtime facts, template draft census) and the gated
// candidate sets. No ERP login, no Naver call, no write outside the report.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet } from '../lib/product-mapping.mjs';
import { joinImageEvidence } from '../lib/naver-images.mjs';
import { classifyCatalog } from '../lib/registration-readiness.mjs';
import { buildOptionPlan } from '../lib/registration-content.mjs';
import { buildDetailTemplate } from '../lib/detail-template.mjs';
import { buildM1Readiness } from '../lib/m1-readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = {
  master: 'data/full_catalog/product_db_compact.csv',
  extended: 'data/erp_prep/erp_extended_mapping.csv',
  upload: 'data/erp_prep/ecount_item_upload.csv',
  smartstore: 'data/smartstore_prep/smartstore_registration_prep.csv',
  options: 'data/full_catalog/options_compact.csv',
  duplicates: 'data/product_quality/product_duplicate_candidates.csv',
  imageMeasurements: 'reports/data/naver/image_measurements.csv',
  imageVariantMeasurements: 'reports/data/naver/image_variant_measurements.csv',
  comparison: 'reports/data/erp/erp_readonly_comparison.json',
  summary: 'reports/data/erp/summary.json',
};
const OUT_REL = 'reports/data/registration/m1_readiness_report.json';

const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const sha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

const masterRows = readCsv(SOURCES.master);
const extendedRows = readCsv(SOURCES.extended);
const uploadRows = readCsv(SOURCES.upload);
const smartstoreRows = readCsv(SOURCES.smartstore);
const optionRows = readCsv(SOURCES.options);
const duplicateRows = readCsv(SOURCES.duplicates);
const comparison = readJson(SOURCES.comparison);
const erpSummary = readJson(SOURCES.summary);
const evidence = joinImageEvidence(readCsv(SOURCES.imageMeasurements), readCsv(SOURCES.imageVariantMeasurements));

const records = buildMappingSet({ extendedRows, uploadRows, smartstoreRows, erpMasterRows: [] });
const { rows } = classifyCatalog({
  masterRows, extendedRows, smartstoreRows, optionRows, duplicateRows, records, comparison, summary: erpSummary, imageEvidence: evidence,
});

// Draft census: run the M1 template over every product and count what it built.
// Join key: the classifier's cgi_id carries the master's domain form
// (samamusic.co.kr:100) while the prep CSV keys by the seller code form
// (samamusic:100) — and record.naver_seller_management_code is exactly that
// seller code for all 4,575 rows (measured), so it is the join.
const prepBySellerCode = new Map(smartstoreRows.map((row) => [String(row['판매자코드'] || '').trim(), row]));
const optionRowsByProduct = new Map();
for (const row of optionRows) {
  const key = `${String(row.source_site || '').trim()}:${String(row.source_product_id || '').trim()}`;
  if (!optionRowsByProduct.has(key)) optionRowsByProduct.set(key, []);
  optionRowsByProduct.get(key).push(row);
}
const draftReasons = {};
let draftsBuilt = 0;
let draftsWithHeroImage = 0;
let draftsWithPrice = 0;
let draftsWithOptions = 0;
for (const row of rows) {
  const prepRow = prepBySellerCode.get(String(row.naver_seller_management_code || '').trim()) || {};
  const optionPlan = buildOptionPlan({
    cgiId: row.naver_seller_management_code || row.cgi_id,
    productName: prepRow['상품명'] || row.product_name || '',
    summary: prepRow['옵션SKU요약'] || '',
    optionCount: prepRow['옵션수'] || '',
    groupRows: optionRowsByProduct.get(String(row.naver_seller_management_code || '').trim()) || [],
  });
  const template = buildDetailTemplate({ prepRow, optionPlan, evidence });
  const present = new Set(template.blocks.filter((b) => b.present).map((b) => b.key));
  if (present.has('image')) draftsWithHeroImage += 1;
  if (present.has('price')) draftsWithPrice += 1;
  if (present.has('options_table')) draftsWithOptions += 1;
  // A draft exists for every product that carries a usable name — the template
  // is the whole-catalogue deliverable; its approval is the operator's gate.
  if (String(prepRow['상품명'] || row.product_name || '').trim() !== '') draftsBuilt += 1;
  for (const reason of template.reasons) draftReasons[reason] = (draftReasons[reason] || 0) + 1;
}

const report = buildM1Readiness({
  rows,
  draftCensus: {
    drafts_built: draftsBuilt,
    approval_pending: draftsBuilt,
    with_hero_image: draftsWithHeroImage,
    with_price: draftsWithPrice,
    with_options_table: draftsWithOptions,
    reason_counts: draftReasons,
    counts_as_detail_content: false,
    operator_approval_required: true,
  },
});

report.inputs = Object.fromEntries(Object.entries(SOURCES).map(([key, rel]) => [key, { path: rel, sha256: sha256(rel) }]));
report.m1_additions = {
  auth_module: 'backend/lib/ncommerce-auth.mjs — 재시도 정책·토큰 수명 관리·로컬 bcrypt 바인딩(tools/naver), 테스트는 mock 만 사용',
  detail_template: 'backend/lib/detail-template.mjs — 확인된 데이터만 반영하는 반응형 상세 초안, 10건 시안은 reports/data/registration/detail_samples/',
  naver_requests: 0,
  erp_requests: 0,
  live_writes: 0,
  account_login: 'NO',
};

fs.mkdirSync(path.dirname(path.join(ROOT, OUT_REL)), { recursive: true });
fs.writeFileSync(path.join(ROOT, OUT_REL), JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  report: OUT_REL,
  products: report.products,
  registerable_now: report.registerable_now,
  fields: Object.fromEntries(Object.entries(report.fields).map(([key, f]) => [key, { usable: f.usable, blocked: f.blocked, source_ready: f.source_ready || undefined }])),
  candidates: { pilot: report.candidates.pilot.count, first_batch: report.candidates.first_batch.count },
  detail_template: { drafts_built: report.m1_detail_template.drafts_built, with_hero_image: report.m1_detail_template.with_hero_image, with_price: report.m1_detail_template.with_price, with_options_table: report.m1_detail_template.with_options_table },
}, null, 2));
