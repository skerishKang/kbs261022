#!/usr/bin/env node
// M2 후속 — 파일럿 3건(samamusic:1769·3417·3418) 등록 준비 패키지.
//
// buildDryRunPackage(전송 차단 게이트의 유일한 본문 조립 경로)을 그대로 쓰고,
// 여기에 M2 후속의 세 가지를 붙인다:
//   - 차단 사유별 해소 주체 분리(splitBlockers — 고객 제공 vs 도구 실행)
//   - 이미지 업로드 계획(planImageUpload — dry-run, 실행은 판매자 토큰 선행)
//   - 잔여 조치 목록(누가, 무엇을, 어떤 순서로)
//
// 본문에는 미확정 값이 들어가지 않는다: leafCategoryId·detailContent·숫자 재고·
// 업로드 API 이미지 URL 은 비어 있는 것이 정상이며, 그것이 이 패키지의 결론이다.
// 산출물은 결정론적(타임스탬프 없음, 커밋된 입력만).
//
//   node tools/m2b-pilot-packages.mjs [--out <repo-relative>]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet, normalizeCgiId } from '../lib/product-mapping.mjs';
import { classifyCatalog } from '../lib/registration-readiness.mjs';
import { joinImageEvidence, planImageUpload } from '../lib/naver-images.mjs';
import { planRegistrationContent } from '../lib/registration-content.mjs';
import { buildDryRunPackage, findPackageViolations } from '../lib/registration-dry-run.mjs';
import { splitBlockers } from '../lib/m2-blocker-split.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const OUT_REL = String(flag('out', 'reports/data/registration/m2b_pilot_packages.json'));
const outPath = path.join(ROOT, OUT_REL);
if (!outPath.startsWith(ROOT + path.sep)) {
  console.error(`refused: --out must stay inside the repository (got ${OUT_REL})`);
  process.exit(2);
}

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
  m1Readiness: 'reports/data/registration/m1_readiness_report.json',
};
const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

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
  optionRows, duplicateRows: readCsv(SOURCES.duplicates), records, comparison: readJson(SOURCES.erpComparison),
  summary: readJson(SOURCES.erpSummary), imageEvidence,
}).rows;
const categoryPathByCgiId = new Map(prepRows.map((row) => [normalizeCgiId(row['공급처원본ID'] ?? ''), String(row['카테고리경로_CGI'] ?? '').trim()]));

const m1Report = readJson(SOURCES.m1Readiness);
const pilotIds = m1Report.candidates.pilot.cgi_ids;
const pilotNormalized = new Set(pilotIds.map((id) => normalizeCgiId(id)));
const pilotRows = readyRows.filter((row) => pilotNormalized.has(normalizeCgiId(row.cgi_id)));
if (pilotRows.length !== 3) {
  console.error(`refused: 파일럿은 정확히 3건이어야 한다 (준비도 행 ${pilotRows.length}건) — 임의 대체하지 않는다`);
  process.exit(2);
}

const packages = pilotRows.map((readyRow) => {
  const categoryPath = categoryPathByCgiId.get(normalizeCgiId(readyRow.cgi_id)) ?? readyRow.supplier_category_path;
  const contentRow = contentByCgiId.get(readyRow.cgi_id)
    || contentByCgiId.get(normalizeCgiId(readyRow.cgi_id))
    || contentByCgiId.get(String(readyRow.source_product_id).includes(':') ? readyRow.source_product_id : `${readyRow.source_site}:${readyRow.source_product_id}`)
    || null;
  const categoryRow = categoryByPath.get(categoryPath) || null;

  const pkg = buildDryRunPackage({ readyRow: { ...readyRow, supplier_category_path: categoryPath }, contentRow, categoryRow, duplicateSearchExecuted: false });

  const split = splitBlockers([{ ...readyRow, cgi_id: readyRow.cgi_id }]);
  const measuredState = String(readyRow.image_measured_state ?? '');
  const representativeUrl = String(readyRow.representative_image_url ?? '');
  const formatAllowed = ['ok', 'ok_via_segment', 'below_recommended'].includes(measuredState);
  const uploadPlan = representativeUrl && formatAllowed
    ? planImageUpload([{ url: representativeUrl, formatAllowed: true }])
    : { representative: '', additional: [], dropped_over_limit: [], upload_calls: 0, batches: [], over_extra_limit: false };

  return {
    cgi_id: readyRow.cgi_id,
    product_name: readyRow.product_name,
    seller_management_code: readyRow.naver_seller_management_code,
    package: pkg,
    blockers: {
      reason_split: split.reason_split,
      product_class: split.product_split.customer_required > 0 ? (split.product_split.mixed > 0 ? 'mixed' : 'customer_required') : 'auto_resolvable',
      resolution_classes: split.resolution_classes,
    },
    images: {
      representative_url_present: Boolean(representativeUrl),
      image_measured_state: measuredState,
      upload_plan: uploadPlan,
      runner_note: '러너(lib/image-upload-runner.mjs)는 dry-run 검증을 마쳤다 — 실행(execute=true)은 NCOM_MODE=mock 검증만 이 레인에 있고, 실제 업로드는 판매자 토큰 승인 후 운영자 레인이다.',
    },
    category: {
      path: categoryPath,
      kind: categoryRow ? categoryRow.path_kind : null,
      status: categoryRow ? categoryRow.status : null,
      confirmed: categoryRow ? categoryRow.confirmed : null,
      note: '코퍼스 수집 도구(tools/naver-category-corpus.mjs)는 mock 으로 검증돼 있다 — 실수집은 판매자 토큰 승인 후.',
    },
    stock: {
      body_value: pkg.body.originProduct.stockQuantity ?? null,
      note: 'ERP BAL_QTY 연동은 본 레인에서 제외됐다 — docs/CGI_M2B_ERP_DEFERRED_20261028.md 의 후속 과제.',
    },
    customer_inputs_pending: ['원산지 정책', '배송비·배송 방식', '반품·교환 배송비', 'AS 안내', 'KC 인증(리프 요구 확인 후)'],
  };
});

const violations = findPackageViolations({ packages: packages.map((p) => p.package), readinessRows: pilotRows, duplicateSearchExecuted: false });
if (violations.length) {
  console.error(`refused: 패키지 위반 ${violations.length}건 — 전송 후보가 될 수 있는 패키지는 쓰지 않는다`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(2);
}

const report = {
  kind: 'cgi-m2b-pilot-packages',
  products: packages.length,
  pilot_selection: `${SOURCES.m1Readiness} candidates.pilot.cgi_ids`,
  packages,
  would_transmit: false,
  transmitted: false,
  account_login: 'NO',
  naver_requests: 0,
  live_writes: 0,
  violations,
  note: '이 패키지들은 등록 준비 상태의 사진이다 — 본문의 빈 필드(카테고리·상세본문·재고·업로드 이미지)는 게이트가 열릴 때까지 비어 있는 것이 정상이다.',
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${OUT_REL}`);
for (const p of packages) console.log(`${p.cgi_id} → ${p.package.status} blocking=[${p.package.blocking_fields.join(', ')}] class=${p.blockers.product_class}`);
