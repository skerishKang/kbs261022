#!/usr/bin/env node
// Issue #95 — product registration readiness artifacts for all 4,575 CGI products.
//
// What it does: reads the committed catalogue + mapping material, classifies
// every product (backend/lib/registration-readiness.mjs), runs the two real
// payload gates (ecount 품목등록 column rules, 네이버 상품등록 required fields)
// and writes the seven deliverables.
//
// What it never does: no ERP/Naver client is constructed here, so no socket can
// be opened and nothing can be written anywhere except the chosen output path.
// The dry run is built by the same functions the worker transmits through, so
// its numbers describe the real wire shape — with transmitted=false.
//
//   node tools/product-registration-readiness.mjs \
//     --out-dir "G:/Ddrive/.../실증결과/상품등록준비_20261026" \
//     --summary reports/data/registration/readiness_summary.json
//
// Per-product artifacts carry product names and supplier ids, so they belong in
// the customer folder, not in a public repository. --summary is the de-identified
// aggregate and is the only file meant for git.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet } from '../lib/product-mapping.mjs';
import { planProductSync, OAPI_FIELD_LIMITS } from '../lib/erp-plan.mjs';
import { ERP_OAPI_ENDPOINTS } from '../lib/erp-oapi.mjs';
import { NCOM_ENDPOINTS, NCOM_LIMITS, NCOM_AUTH_GAP, NCOM_UNCONFIRMED } from '../lib/ncommerce.mjs';
import { joinImageEvidence, NAVER_IMAGE_DOC } from '../lib/naver-images.mjs';
import { classifyCatalog, missingEntries, summarizeClassification, toCsv, REASONS } from '../lib/registration-readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

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

const sha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const masterRows = readCsv(SOURCES.master);
const extendedRows = readCsv(SOURCES.extended);
const uploadRows = readCsv(SOURCES.upload);
const smartstoreRows = readCsv(SOURCES.smartstore);
const optionRows = readCsv(SOURCES.options);
const duplicateRows = readCsv(SOURCES.duplicates);
const imageMeasurementRows = readCsv(SOURCES.imageMeasurements);
const imageVariantRows = readCsv(SOURCES.imageVariantMeasurements);
const comparison = readJson(SOURCES.comparison);
const erpSummary = readJson(SOURCES.summary);

// The measured evidence index is keyed by sha256(URL), so a product whose supplier
// URL was never fetched comes back as `image_measurement_missing` rather than
// borrowing the verdict of a product that shares its image.
const imageEvidence = joinImageEvidence(imageMeasurementRows, imageVariantRows);

const records = buildMappingSet({ extendedRows, uploadRows, smartstoreRows, erpMasterRows: [] });
const { rows } = classifyCatalog({ masterRows, extendedRows, smartstoreRows, optionRows, duplicateRows, records, comparison, summary: erpSummary, imageEvidence });
const missing = missingEntries(rows);
const stats = summarizeClassification({
  rows,
  missing,
  inputs: { masterRows: masterRows.length, records: records.length, optionRows: optionRows.length, duplicateRows: duplicateRows.length },
  comparison,
  summary: erpSummary,
});

const outDir = option('out-dir', null);
const summaryPath = option('summary', null);
if (!outDir && !summaryPath) {
  console.error('nothing to write: pass --out-dir (private artifacts) and/or --summary (de-identified aggregate)');
  process.exit(2);
}

const rowByCgiId = new Map(rows.map((row) => [row.cgi_id, row]));
const collectedByCgiId = new Map(masterRows.map((row) => [`${row.source_site}:${row.source_product_id}`, String(row.collected_at || '').trim()]));
const collectedDates = [...new Set([...collectedByCgiId.values()].filter(Boolean))].sort();

const productPlan = planProductSync(rows.map((row) => ({
  productId: row.erp_prod_cd_proposed,
  productName: row.product_name,
  unit: row.erp_unit,
  prodType: row.erp_prod_type,
  barCode: row.erp_barcode,
  taxRate: row.vat_rate_percent,
  outPrice: row.erp_out_price === '' ? null : Number(row.erp_out_price),
  remarksWin: row.erp_size_des,
})), { maxRowsPerCall: 1 });

const imageUploadCalls = rows.filter((row) => row.representative_image_url).length;
const minIntervalMs = ERP_OAPI_ENDPOINTS.saveBasicProduct.minIntervalMs;

const dryRun = {
  kind: 'cgi-registration-dry-run',
  issue: 95,
  transmitted: false,
  account_login: 'NO',
  erp_requests: 0,
  naver_requests: 0,
  live_writes: 0,
  data_as_of: { collected_at_min: collectedDates[0] || null, collected_at_max: collectedDates[collectedDates.length - 1] || null },
  inputs: Object.fromEntries(Object.entries(SOURCES).map(([key, rel]) => [key, { path: rel, sha256: sha256(rel) }])),
  input_row_counts: {
    master: masterRows.length,
    extended: extendedRows.length,
    upload: uploadRows.length,
    smartstore: smartstoreRows.length,
    options: optionRows.length,
    duplicate_pairs: duplicateRows.length,
    mapping_records: records.length,
    image_measurements: imageMeasurementRows.length,
    image_variant_verdicts: imageVariantRows.length,
  },
  conservation: stats.conservation,
  buckets: stats.buckets,
  buckets_if_policy_defaults: stats.buckets_if_policy_defaults,
  erp: {
    endpoint: 'SaveBasicProduct',
    path: ERP_OAPI_ENDPOINTS.saveBasicProduct.path,
    list_key: ERP_OAPI_ENDPOINTS.saveBasicProduct.listKey,
    min_interval_ms: minIntervalMs,
    field_limits: OAPI_FIELD_LIMITS,
    rows_requested: rows.length,
    accepted: productPlan.acceptedCount,
    rejected: productPlan.rejected.length,
    reject_reasons: productPlan.rejected.slice(0, 20),
    batches: productPlan.batches.length,
    estimated_serial_ms: productPlan.batches.length * minIntervalMs,
    per_item_dedupe_key_scheme: 'saveBasicProduct:PROD_CD:<erp_prod_cd>',
    per_item_dedupe_keys_unique: stats.erp.unique_dedupe_keys,
    batch_dedupe_keys_unique: new Set(productPlan.batches.map((batch) => batch.dedupeKey)).size,
    register_first_required: stats.erp.register_required,
    verified_against_erp_master: stats.erp.master_matches,
    mapping_aggregates_only: {
      name_exact_pairs: comparison.name_exact_pairs,
      model_exact_pairs: comparison.model_exact_pairs,
      candidate_pairs: comparison.candidate_pairs,
      per_product_evidence: 'not_persisted',
      note: 'compare_erp_cgi.py는 집계를 쓰기만 하지 쌍 목록을 파일로 남기지 않았고, ERP 마스터 원본은 gitignore 상태 — 상품별 후보를 재현할 수 없어 임일치를 하지 않습니다.',
    },
    ordering: [
      '1. SaveBasicProduct(품목) — 품목코드가 없으면 후속 단계가 전부 조인 실패',
      '2. GetListInventoryBalanceStatus(재고 read) — 등록 확인 후에만 우리 품목코드로 BAL_QTY를 읽을 수 있음',
      '3. POST /v1/product-images/upload(네이버 이미지) — 실호스트 링크 불가',
      '4. POST /v2/products(네이버 등록) — leafCategoryId·detailContent·stockQuantity·업로드 이미지 URL 필요',
      '5. PUT /v1/products/origin-products/{originProductNo}/option-stock — 4의 응답 ID 필요',
    ],
    dependencies: {
      step2_requires_step1: 'ERP 품목 실존 확인',
      step4_requires_step3: 'images.representative는 업로드 API 응답 URL만 허용',
      step5_requires_step4: 'option-stock 경로는 등록 응답 originProductNo를 사용',
      slip_requires_step1: '전표 행은 verified PROD_CD만 허용 — register_first면 전송 불가',
      rows_independent: '품목 등록 행 상호간 의존 없음(실패 재시도는 상품별 키로)',
    },
    resume_contract: {
      why_safe: 'PROD_CD가 벤더의 고유 키이고 우리 생성안(SS-/SM-<공급처원본ID>)이 4,575건 전부 유일 — 재실행 시 같은 키가 같은 상품을 가리켜 중복 품목이 늘지 않음',
      ledger_fields: ['erp_dedupe_key', 'state(pending|registered|failed)', 'attempt', 'error_code'],
      on_restart: 'state=registered 키는 건너뛰고 pending/failed만 재시도. batch 순번 키는 허용 집합이 바뀌면 어긋나므로 상품별 PROD_CD 키만 영구 대조 키로 사용',
      quota_note: '연속 오류 한도 앞에서 중단되므로 실패 행은 응답 코드와 함께 남긴다',
    },
  },
  naver: {
    endpoints: NCOM_ENDPOINTS,
    limits: NCOM_LIMITS,
    registerable_now: stats.naver.registerable_now,
    register_problems_by_field: stats.naver.register_problems_by_field,
    image_upload_calls_required: imageUploadCalls,
    images_per_upload_call_limit: NCOM_LIMITS.imagesPerUploadCall,
    products_over_extra_image_max: stats.images.over_extra_limit,
    image_evidence: {
      measurements_csv: SOURCES.imageMeasurements,
      variant_csv: SOURCES.imageVariantMeasurements,
      urls_in_evidence_index: imageEvidence.size,
      products_by_measured_state: stats.images.by_measured_state,
      byte_size_limit: NAVER_IMAGE_DOC.byteSizeLimit,
      minimum_resolution: NAVER_IMAGE_DOC.minimumResolution,
      note: '네이버 문서는 바이트 상한과 최소 해상도를 규정하지 않는다(null). 권장 1000x1000 미달은 등록 차단 사유가 아니라 운영 판단.',
    },
    auth_gap: NCOM_AUTH_GAP,
    unconfirmed: NCOM_UNCONFIRMED,
  },
  reason_codes: stats.reason_codes,
  reason_kinds: stats.reason_kinds,
  owners: stats.owners,
};

const ARTIFACT_COLUMNS = {
  readiness: [
    'cgi_id', 'source_site', 'source_product_id', 'master_product_key', 'product_name', 'brand', 'manufacturer', 'model',
    'supplier_category_id', 'supplier_category_name', 'supplier_category_path',
    'public_price_state', 'public_price_text', 'sale_price', 'price_usable', 'vat_rate_percent', 'vat_base', 'vat_amount',
    'supplier_sales_status', 'supplier_use_stock', 'stock_displayed', 'stock_quantity_confirmed',
    'image_count_master', 'detail_image_count_prep', 'representative_image_url', 'image_extension',
    'image_measured_state', 'image_container_measured', 'image_width_measured', 'image_height_measured',
    'image_size_bytes_measured', 'image_best_segment',
    'detail_content_chars', 'option_value_count_master', 'option_count_prep', 'option_rows',
    'option_rows_missing_price', 'option_rows_missing_item_code',
    'erp_prod_cd_proposed', 'erp_code_source', 'erp_master_match', 'erp_register_required', 'erp_wire_validation',
    'erp_dedupe_key', 'erp_barcode', 'erp_out_price', 'out_price_matches_sale_price', 'erp_unit', 'erp_prod_type', 'erp_bal_flag', 'erp_size_des',
    'naver_leaf_category_id', 'naver_product_id', 'naver_registration_status', 'naver_seller_management_code', 'naver_sale_price',
    'naver_stock_quantity', 'naver_register_problems', 'naver_uploaded_image',
    'duplicate_pair_count', 'duplicate_verdicts', 'duplicate_variant_conflict', 'cgi_sale_status',
    'gap_count', 'missing_count', 'blocker_codes_storewide_policy', 'blocker_codes_product_specific',
    'bucket', 'bucket_if_policy_defaults', 'join_complete', 'gap_codes', 'missing_codes',
  ],
  missing: ['cgi_id', 'source_site', 'product_name', 'field', 'reason_code', 'kind', 'owner', 'meaning', 'bucket', 'scope'],
  erp: [
    'cgi_id', 'product_name', 'erp_prod_cd_proposed', 'erp_code_source', 'erp_master_match', 'erp_register_required',
    'erp_wire_validation', 'erp_dedupe_key', 'erp_barcode', 'erp_out_price', 'erp_unit', 'erp_prod_type',
    'erp_bal_flag', 'erp_size_des', 'vat_rate_percent', 'candidate_pairs_aggregate', 'candidate_evidence_per_product',
    'sequence', 'depends_on',
  ],
  naver: [
    'cgi_id', 'product_name', 'supplier_category_id', 'supplier_category_name', 'supplier_category_path',
    'naver_leaf_category_id', 'naver_category_status', 'price_usable', 'naver_sale_price', 'stock_quantity_confirmed',
    'naver_stock_quantity', 'detail_content_chars', 'representative_image_url', 'image_extension',
    'image_count_master', 'naver_register_problems', 'classification', 'policy_decisions_needed', 'owner',
  ],
  duplicates: [
    'pair_no', 'verdict', 'auto_merge_allowed', 'source', 'left_cgi_id', 'left_name', 'left_brand', 'left_model',
    'right_cgi_id', 'right_name', 'right_brand', 'right_model', 'shared_model_expression', 'name_similarity',
    'variant_conflict', 'brand_value_match', 'reason', 'action', 'both_in_catalogue',
    'left_erp_prod_cd', 'right_erp_prod_cd', 'left_bucket', 'right_bucket',
  ],
};

const erpArtifact = rows.map((row, index) => ({
  ...row,
  candidate_pairs_aggregate: comparison.candidate_pairs,
  candidate_evidence_per_product: dryRun.erp.mapping_aggregates_only.per_product_evidence,
  sequence: index + 1,
  depends_on: 'rows_independent',
}));

const naverArtifact = rows.map((row) => ({
  ...row,
  naver_category_status: row.naver_leaf_category_id ? 'confirmed' : 'unassigned_no_official_source_in_repo',
  classification: row.bucket,
  policy_decisions_needed: row.blocker_codes_storewide_policy,
  owner: 'CGI operator + Naver category confirmation',
}));

const duplicateArtifact = duplicateRows.map((pair, index) => {
  const left = rowByCgiId.get(String(pair.왼쪽통합키).trim()) || {};
  const right = rowByCgiId.get(String(pair.오른쪽통합키).trim()) || {};
  return {
    pair_no: index + 1,
    verdict: pair.판정,
    auto_merge_allowed: pair.자동병합가능,
    source: pair.출처,
    left_cgi_id: pair.왼쪽통합키,
    left_name: left.product_name || pair.왼쪽상품명,
    left_brand: pair.왼쪽브랜드,
    left_model: pair.왼쪽모델명,
    right_cgi_id: pair.오른쪽통합키,
    right_name: right.product_name || pair.오른쪽상품명,
    right_brand: pair.오른쪽브랜드,
    right_model: pair.오른쪽모델명,
    shared_model_expression: pair.공통모델표현,
    name_similarity: pair.이름유사도,
    variant_conflict: pair.변형충돌,
    brand_value_match: pair.브랜드값일치,
    reason: pair.사유,
    action: pair.조치,
    both_in_catalogue: left.cgi_id && right.cgi_id ? 'yes' : 'no',
    left_erp_prod_cd: left.erp_prod_cd_proposed || '',
    right_erp_prod_cd: right.erp_prod_cd_proposed || '',
    left_bucket: left.bucket || '',
    right_bucket: right.bucket || '',
  };
});

// Two one-way checks, because a column list can fail in two directions:
//   missingColumn  — a column name no row carries writes an empty field forever.
//   unprintedField — a classifier field no column prints is lost silently.
// The mapping and category artifacts are deliberate projections of the readiness
// row, so only the first check applies to them.
const keysOf = (items) => new Set(items.flatMap((item) => Object.keys(item)));
const fail = (label, list) => {
  console.error(`${label}: ${list.join(', ')}`);
  process.exit(2);
};
const assertColumnsExist = (items, columns, label) => {
  const keys = keysOf(items);
  const missingColumns = columns.filter((column) => !keys.has(column));
  if (missingColumns.length) fail(`${label} artifact columns no row carries`, missingColumns);
};
const assertFieldsPrinted = (items, columns, label) => {
  const unprinted = [...keysOf(items)].filter((key) => !columns.includes(key));
  if (unprinted.length) fail(`${label} fields no artifact column prints`, unprinted);
};
assertColumnsExist(rows, ARTIFACT_COLUMNS.readiness, 'readiness');
assertFieldsPrinted(rows, ARTIFACT_COLUMNS.readiness, 'readiness');
assertColumnsExist(missing, ARTIFACT_COLUMNS.missing, 'missing');
assertFieldsPrinted(missing, ARTIFACT_COLUMNS.missing, 'missing');
assertColumnsExist(erpArtifact, ARTIFACT_COLUMNS.erp, 'erp mapping');
assertColumnsExist(naverArtifact, ARTIFACT_COLUMNS.naver, 'naver category');
assertColumnsExist(duplicateArtifact, ARTIFACT_COLUMNS.duplicates, 'duplicates');
assertFieldsPrinted(duplicateArtifact, ARTIFACT_COLUMNS.duplicates, 'duplicates');

const written = [];
const PRIVATE_SCOPE = '비공개 폴더(고객 자료, git에 올리지 않음)';
const REPO_SCOPE = '저장소 비식별 집계';
const write = (target, content, records, unit = '행', scope = PRIVATE_SCOPE) => {
  fs.writeFileSync(target, content, 'utf8');
  written.push({ name: path.basename(target), path: target.split(path.sep).slice(-2).join('/'), bytes: Buffer.byteLength(content), records, unit, scope });
};

if (outDir) {
  const dir = path.resolve(ROOT, outDir);
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'cgi_product_registration_readiness.csv'), toCsv(rows, ARTIFACT_COLUMNS.readiness), rows.length);
  write(path.join(dir, 'cgi_product_missing_fields.csv'), toCsv(missing, ARTIFACT_COLUMNS.missing), missing.length);
  write(path.join(dir, 'cgi_erp_mapping_candidates.csv'), toCsv(erpArtifact, ARTIFACT_COLUMNS.erp), rows.length);
  write(path.join(dir, 'cgi_naver_category_candidates.csv'), toCsv(naverArtifact, ARTIFACT_COLUMNS.naver), rows.length);
  write(path.join(dir, 'cgi_product_duplicates.csv'), toCsv(duplicateArtifact, ARTIFACT_COLUMNS.duplicates), duplicateRows.length);
  write(path.join(dir, 'cgi_registration_dry_run.json'), `${JSON.stringify(dryRun, null, 1)}\n`, 1, '개 문서');
}

if (summaryPath) {
  const target = path.resolve(ROOT, summaryPath);
  if (!target.startsWith(path.resolve(ROOT) + path.sep)) fail('summary target escapes the repository', [summaryPath]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const aggregate = {
    ...stats,
    dry_run: {
      transmitted: false,
      erp_requests: 0,
      naver_requests: 0,
      live_writes: 0,
      product_batches: productPlan.batches.length,
      accepted: productPlan.acceptedCount,
      rejected: productPlan.rejected.length,
      image_upload_calls_required: imageUploadCalls,
    },
    reason_definitions: REASONS,
  };
  write(target, `${JSON.stringify(aggregate, null, 1)}\n`, 1, '개 문서', REPO_SCOPE);
}

if (outDir) {
  write(path.resolve(ROOT, outDir, 'README_상품등록준비_결과.md'), buildReadme({ stats, dryRun, rows, written, comparison }), 1, '개 문서');
}

function buildReadme({ stats: s, dryRun: d, rows: r, written: w, comparison: c }) {
  const pct = (x) => `${((100 * x) / r.length).toFixed(1)}%`;
  const n = (x) => Number(x).toLocaleString('ko-KR');
  const lines = [];
  const add = (text) => lines.push(text);
  add(`# CGI 상품 ${n(r.length)}건 등록 준비 결과 (이슈 #95)`);
  add('');
  add(`- 처리 대상: 공급처 공개 상품 마스터 **${n(r.length)}건 전수** (입력 ${n(d.input_row_counts.mapping_records)} = 출력 ${n(d.conservation.rows_out)}, 보존 검사 통과)`);
  add(`- 데이터 기준일: ${d.data_as_of.collected_at_min} ~ ${d.data_as_of.collected_at_max}`);
  add(`- 실행 원칙: 이카운트 로그인 0회 / ERP 요청 0건 / 네이버 요청 0건 / 기록 변경 0건 (transmitted=${d.transmitted})`);
  add('');
  add('## 1. 결론');
  add('');
  add(`- **네이버 등록 가능 ${n(s.naver.registerable_now)}건.** 측정값 그대로이며, 0건도 정확한 결과입니다. 게이트가 요구하는 값의 실측 확보: 네이버 leaf 카테고리번호 ${n(s.category.naver_leaf_category_present)}, 확정 재고수량 ${n(s.stock.numeric_confirmed)}, 이미지업로드API 경유 이미지 ${n(r.filter((x) => x.naver_uploaded_image).length)}, 사용 가능 판매가 ${n(s.price.usable_count)}. 임의 값 없이는 전송 가능한 페이로드가 존재하지 않습니다.`);
  add(`- **ERP 품목 등록 선행 필요 ${s.erp.register_required}건.** 품목코드는 전 상품 CGI 생성안이고 ERP 마스터(${c.erp_total_items ?? '집계 없음'}개)과의 코드 정확일치는 ${c.exact_code_matches ?? '집계 없음'}건이며 마스터 확인 ${s.erp.master_matches}건입니다.`);
  add(`- 1차 분류: ${Object.entries(s.buckets).map(([k, v]) => `${k} ${v}건(${pct(v)})`).join(', ')}`);
  add(`- 스토어 정책 일괄 확정을 가정한 2차 분류: ${Object.entries(s.buckets_if_policy_defaults).map(([k, v]) => `${k} ${v}건(${pct(v)})`).join(', ')}`);
  const ownDecisions = Object.entries(s.blockers_by_scope.product_specific).filter(([code]) => {
    const kind = REASONS[code].kind;
    return kind === 'requires_business_decision' || kind === 'requires_content_authoring' || kind === 'data_defect';
  });
  add(`  - 2차 분류가 ${s.buckets_if_policy_defaults.manual_review ?? 0}건에서 줄지 않는 이유: 스토어 일괄 정책이 아니라 상품별로 다른 결정·결함 (${ownDecisions.map(([code, n]) => `${code} ${n}건`).join(', ')}) 이 그대로 남기 때문입니다. 정책 한 번의 답으로 정리되는 항목은 ${Object.keys(s.blockers_by_scope.storewide_policy).length}개 코드입니다.`);
  add('');
  add('## 2. 필드별 실측');
  add('');
  add('| 항목 | 확보 | 미확보 | 결측 사유 코드 |');
  add('| --- | ---: | ---: | --- |');
  add(`| 상품명 | ${r.filter((x) => x.product_name).length} | ${r.filter((x) => !x.product_name).length} | product_name_* |`);
  add(`| 브랜드 | ${r.filter((x) => x.brand).length} | ${r.filter((x) => !x.brand).length} | brand_* |`);
  add(`| 제조사 | ${r.filter((x) => x.manufacturer).length} | ${r.filter((x) => !x.manufacturer).length} | manufacturer_blank_not_collected |`);
  add(`| 모델명 | ${r.filter((x) => x.model).length} | ${r.filter((x) => !x.model).length} | model_blank |`);
  add(`| 사용 가능 판매가 | ${s.price.usable_count} | ${r.length - s.price.usable_count} | ${Object.keys(s.price.unusable_codes).join(', ')} |`);
  add(`| 부가세 재구성 통과 | ${s.vat.rows_decomposed} | ${s.vat.decomposition_failed} | vat_decomposition_inconsistent |`);
  add(`| 확정 재고 수량 | ${s.stock.numeric_confirmed} | ${r.length - s.stock.numeric_confirmed} | stock_requires_erp_balance_read (표시수량 양수 ${s.stock.displayed_positive}건은 미검증) |`);
  add(`| 대표 이미지 URL | ${s.images.representative_present} | ${r.length - s.images.representative_present} | image_external_host_upload_required |`);
  add(`| 상세 설명 | 본문 ${s.detail_content.authored_body} / 한 줄 요약 ${s.detail_content.summary_only} | 공란 ${s.detail_content.absent} | detail_content_summary_only(요약 ${s.detail_content.max_chars}자 한계, 본문 기준 ${s.detail_content.judged_at_or_above_chars}자 이상 또는 마크업) / detail_content_absent |`);
  add(`| 공급처 카테고리 | ${r.filter((x) => x.supplier_category_id).length} (고유 ${s.category.supplier_categories_distinct}) | ${r.filter((x) => !x.supplier_category_id).length} | supplier_category_not_mapped_to_naver |`);
  add(`| 네이버 카테고리번호 | ${s.category.naver_leaf_category_present} | ${r.length - s.category.naver_leaf_category_present} | naver_leaf_category_absent |`);
  add(`| 옵션 실데이터 상품 | ${s.options.products_with_option_rows} (행 ${s.options.option_rows_total}) | ${r.length - s.options.products_with_option_rows} | option_price_undifferentiated, option_item_code_absent |`);
  add(`| ERP 마스터 확인 품목코드 | ${s.erp.master_matches} | ${s.erp.register_required} | erp_code_proposed_only |`);
  add(`| 네이버 상품ID | ${s.naver.product_id_present} | ${r.length - s.naver.product_id_present} | naver_product_id_absent — 신규 등록에서는 응답으로 발급되므로 등록 불가 사유가 아님. 등록상태 컬럼 실측: ${Object.entries(s.naver.registration_status_counts).map(([k, v]) => `${k || '공란'} ${v}건`).join(', ')} |`);
  add(`| 중복 후보 관련 상품 | ${s.duplicates.products_in_a_pair} | ${r.length - s.duplicates.products_in_a_pair} | duplicate_pair_* |`);
  add('');
  add('## 3. 금액·부가세 검사');
  add('');
  add(`- 판매가 최대 ${s.price.max_sale_price.toLocaleString('ko-KR')}원 (네이버 상한 ${d.naver.limits.salePriceMax.toLocaleString('ko-KR')}원, 초과 ${(s.price.unusable_codes.price_over_naver_max ?? 0).toLocaleString('ko-KR')}건)`);
  add(`- 부가세율 ${[...new Set(r.map((x) => x.vat_rate_percent))].join('/')}%로 공급가액+부가세 재구성 실패 ${s.vat.decomposition_failed}건`);
  add(`- ERP 출고단가 = 공개판매가 ${s.vat.out_price_equals_sale_price}건, 양쪽 모두 공란 ${s.vat.out_price_blank_with_blank_price}건, 충돌 ${s.vat.out_price_conflicts_sale_price}건`);
  const unusable = s.price.unusable_codes;
  add(`- 가격 필드 ${unusable.price_value_untrusted_parse_artifact ?? 0}건은 가격 문장이 아닌 텍스트에서 추출된 숫자(\`price_value_untrusted_parse_artifact\`)였으므로 사용 가능 판매가로 계상하지 않았습니다.`);
  add(`- 문의가 상품 ${unusable.price_inquiry_only ?? 0}건은 공급처 공개 가격도 없고 CGI 공급가도 DB 어디에 없어, 판매가를 임의 대체하지 않고 그대로 결측으로 남겼습니다. 미공개·품절·상한초과까지 결측 사유별 분류: ${Object.entries(unusable).map(([code, n]) => `${code} ${n}건`).join(', ')}`);
  add('');
  add('## 4. ERP 등록 준비 (호출 0건)');
  add('');
  add(`- SaveBasicProduct 계획: 요청 ${d.erp.rows_requested}건 → 허용 ${d.erp.accepted}건 / 거부 ${d.erp.rejected}건 / 배치 ${d.erp.batches}개, 호출 간격 ${d.erp.min_interval_ms}ms → 직렬 약 ${Math.round(d.erp.estimated_serial_ms / 3600000)}시간`);
  add(`- 중복 방지 키: ${d.erp.per_item_dedupe_key_scheme} (유일 ${d.erp.per_item_dedupe_keys_unique}개). 배치 순번 키는 허용 집합이 바뀌면 어긋나므로 상품별 키만 영구 대조키로 씁니다.`);
  add('- 중단 후 재실행: 등록 확인된 키를 건너뛰면 같은 PROD_CD는 벤더가 중복으로 거부해 품목이 늘지 않습니다(갱신/거절로 종료).');
  add(`- 순서·의존: ${d.erp.ordering.join(' → ')}`);
  add(`- 후보 매핑: 이름 정확 ${c.name_exact_pairs}건 / 모델 정확 ${c.model_exact_pairs}건 / 완후보 ${c.candidate_pairs}쌍은 집계로만 존재하고 상품별 대조표가 파일로 저장된 적이 없습니다(candidate_evidence_per_product=${d.erp.mapping_aggregates_only.per_product_evidence}). 따라서 전 건을 임의 일치시키지 않고 등록 선행 목록으로 남겼습니다.`);
  add('');
  add('## 5. 스마트스토어 등록 준비');
  add('');
  add(`- 등록 게이트 문제 필드: ${Object.entries(d.naver.register_problems_by_field).map(([k, v]) => `${k} ${v}건`).join(', ')}`);
  add(`- 이미지: 대표 URL ${n(s.images.representative_present)}건 중 본문 실측 ${n(s.images.bytes_measured)}건(미실측 ${n(s.images.not_measured)}건, 응답 없음 ${n(s.images.unreachable)}건, 200 외 응답 ${n(s.images.http_error)}건, 200 본문이 이미지 아님 ${n(s.images.unreadable)}건). 컨테이너 ${Object.entries(s.images.by_container).map(([k, v]) => `${k} ${v}건`).join(', ')}, 네이버 허용 형식 밖 ${n(s.images.format_rejected)}건. 권장 1000x1000 충족 ${n(s.images.meets_recommended)}건 / 미달 ${n(s.images.below_recommended)}건 — 미달분 중 공급처에 더 큰 파일 없음 ${n(s.images.no_larger_segment_measured)}건, 큰 세그먼트로 충족 ${n(s.images.larger_segment_meets)}건, 세그먼트 실측 부분적 ${n(s.images.segment_partial)}건. 해상도 미달은 등록 차단 사유가 아니라 운영 판단 항목입니다(문서에 최소 해상도·바이트 상한 규정 없음). 외부 호스트 링크는 전부 업로드 API 경유 필요 → 최소 ${n(d.naver.image_upload_calls_required)}회. 추가 이미지 9장 초과 ${n(s.images.over_extra_limit)}건은 남길 장면 선택이 필요합니다.`);
  add(`- 상세설명: 본문으로 인정된 ${s.detail_content.authored_body}건, 한 줄 스펙 요약 ${s.detail_content.summary_only}건(실측 최장 ${s.detail_content.max_chars}자, 마크업 0건), 공란 ${s.detail_content.absent}건. 요약문은 contract의 presence 검사만 통과하므로 내용 저작(requires_content_authoring)이 필요하다고 분류했습니다. 본문 인정 기준은 ${s.detail_content.judged_at_or_above_chars}자 이상 또는 HTML 마크업입니다.`);
  add(`- 인증: Workers 런타임에 bcrypt가 없어 서명 생성 불가 — ${d.naver.auth_gap.reason}`);
  add('- 미확정 항목(임의 값 금지): 네이버 leaf 카테고리번호, 원산지코드, KC 고시정보, AS 템플릿, 배송비, 반품·교환 정책, 수입사, 확정 재고수량, CGI 판매 승인 목록.');
  add('');
  add('## 6. 산출물');
  add('');
  for (const item of w) add(`- \`${item.name}\` — ${item.records.toLocaleString('ko-KR')}${item.unit}, ${item.bytes.toLocaleString('ko-KR')} 바이트, ${item.scope}`);
  add('');
  add('## 7. 검증');
  add('');
  add(`- 입력 ${d.input_row_counts.mapping_records}건 = 출력 ${d.conservation.rows_out}건 (input_equals_output=${d.conservation.input_equals_output}), 분류 합 ${d.conservation.buckets_sum}건`);
  add('- 재실행 시 산출물 바이트 동일: 입력 SHA-256 고정, 타임스탬프·랜덤 미사용, 행 순서 cgi_id 오름차순 — 회귀 테스트로 고정.');
  add('- 회귀 테스트: `backend/test/unit/registration-readiness.test.mjs`, `backend/test/e2e/issue95-readiness-4575.test.mjs`');
  add('');
  add('## 8. 다음 단계');
  add('');
  add('1. CGI 운영자가 스토어 정책(원산지·KC·AS·배송·반품·수입사)과 판매 승인 목록, 카테고리 대응을 일괄 확정.');
  add(`2. 문의가 상품 ${s.price.unusable_codes.price_inquiry_only ?? 0}건의 공급가·판매가 확정.`);
  add('3. ERP 인증 활성화 → 품목등록 실행 → 재고 read로 확정 수량 확보.');
  add('4. 네이버 이미지 업로드 + 카테고리번호 확정 → 1건 파일럿 후 일괄 등록.');
  add('5. 각 단계는 실제 계정 연결이 필요한 별개 승인 작업이며, 본 준비본은 그것을 실행하지 않았습니다.');
  return `${lines.join('\n')}\n`;
}

console.log(JSON.stringify({
  TOTAL_PRODUCTS: rows.length,
  ERP_READY: stats.erp.master_matches,
  ERP_MAPPING_MISSING: stats.erp.register_required,
  NAVER_READY: stats.naver.registerable_now,
  NAVER_MISSING_FIELDS: stats.naver.register_problems_by_field,
  DUPLICATE_PRODUCTS: stats.duplicates.products_in_a_pair,
  PRICE_USABLE: stats.price.usable_count,
  BUCKETS: stats.buckets,
  BUCKETS_IF_POLICY_DEFAULTS: stats.buckets_if_policy_defaults,
  MISSING_ENTRIES: missing.length,
  OUTPUT_FILES: written.map((item) => item.name),
  DRY_RUN_BATCHES: productPlan.batches.length,
  INPUT_EQUALS_OUTPUT: stats.conservation.input_equals_output,
  ACCOUNT_LOGIN: 'NO',
  ERP_REQUESTS: 0,
  NAVER_REQUESTS: 0,
  LIVE_WRITES: 0,
}, null, 1));
