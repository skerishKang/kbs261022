#!/usr/bin/env node
// M2 사전개발 보고서 — 파일럿 3건 등록 준비도 dry-run + 필수 필드 출처별 분류 +
// ERP BAL_QTY 대응 구조 실측. 전송은 없다(실 API 호출 0건, 라이브 모드 진입 자체가
// 없다) — 패키지 본문은 buildDryRunPackage 가 만들고 어느 문서 게이트가 막는지만 잰다.
//
//   node tools/m2-predev-report.mjs                 # 커밋 경로에 기록
//   node tools/m2-predev-report.mjs --out <repo-relative path>
//
// 산출물은 결정론적이다: 타임스탬프가 없고, 입력은 커밋된 파일뿐이다.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet, normalizeCgiId } from '../lib/product-mapping.mjs';
import { classifyCatalog } from '../lib/registration-readiness.mjs';
import { joinImageEvidence } from '../lib/naver-images.mjs';
import { planRegistrationContent } from '../lib/registration-content.mjs';
import { buildDryRunPackage, findPackageViolations, summarizeDryRunPackages } from '../lib/registration-dry-run.mjs';
import { classifyFieldGapsBySource, stockCorrespondence } from '../lib/m2-field-analysis.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const OUT_REL = String(flag('out', 'reports/data/registration/m2_predev_report.json'));
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

// --- 어셈블리: dry-run 패키지 e2e 와 같은 조립 경로 (중복 판정 없음) -----------------
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

// --- 파일럿 선정: M1 리포트의 pilot 후보 3건 (임의 선정 아님) -------------------------
const m1Report = readJson(SOURCES.m1Readiness);
const pilotIds = m1Report.candidates.pilot.cgi_ids;
if (!Array.isArray(pilotIds) || pilotIds.length === 0) {
  console.error('refused: M1 리포트에 pilot 후보가 없다 — 임의로 3건을 뽑지 않는다');
  process.exit(2);
}
const pilotNormalized = new Set(pilotIds.map((id) => normalizeCgiId(id)));
const pilotRows = readyRows.filter((row) => pilotNormalized.has(normalizeCgiId(row.cgi_id)));
if (pilotRows.length !== pilotIds.length) {
  console.error(`refused: 파일럿 ${pilotIds.length}건 중 준비도 행은 ${pilotRows.length}건뿐이다 — 조용히 줄이지 않는다`);
  process.exit(2);
}

const packages = pilotRows.map((row) => {
  const categoryPath = categoryPathByCgiId.get(normalizeCgiId(row.cgi_id)) ?? row.supplier_category_path;
  const contentRow = contentByCgiId.get(row.cgi_id)
    || contentByCgiId.get(normalizeCgiId(row.cgi_id))
    || contentByCgiId.get(String(row.source_product_id).includes(':') ? row.source_product_id : `${row.source_site}:${row.source_product_id}`)
    || null;
  return buildDryRunPackage({
    readyRow: { ...row, supplier_category_path: categoryPath },
    contentRow,
    categoryRow: categoryByPath.get(categoryPath) || null,
    duplicateSearchExecuted: false,
  });
});
const violations = findPackageViolations({ packages, readinessRows: pilotRows, duplicateSearchExecuted: false });
if (violations.length) {
  console.error(`refused: 패키지 위반 ${violations.length}건 — 전송 후보가 될 수 있는 패키지는 쓰지 않는다`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(2);
}

// --- 필수 필드 출처별 분류 (전 4,575건 기준) ----------------------------------------
const GAP_COLUMNS = ['원산지코드', 'KC고시정보', 'ASTemplateCode', '배송비', '반품교환정책', '재고수량'];
const measuredColumns = {};
for (const column of GAP_COLUMNS) {
  measuredColumns[column] = { present: column in prepRows[0], non_blank: prepRows.filter((row) => String(row[column] ?? '').trim() !== '').length, rows: prepRows.length };
}
const fieldGaps = classifyFieldGapsBySource(readyRows, { columns: measuredColumns });

// --- BAL_QTY 대응 구조 실측 ----------------------------------------------------------
const stock = stockCorrespondence({ mappingRows: readCsv(SOURCES.extended), uploadRows: readCsv(SOURCES.upload) });

const report = {
  kind: 'cgi-m2-predev-report',
  products: readyRows.length,
  pilot: {
    selection_source: `${SOURCES.m1Readiness} candidates.pilot.cgi_ids (M1 준비도 게이트 통과 상위 후보)`,
    cgi_ids: pilotIds,
    packages,
    summary: summarizeDryRunPackages(packages),
    violations,
  },
  field_gaps_by_source: fieldGaps,
  stock_correspondence: stock,
  would_transmit: false,
  transmitted: false,
  account_login: 'NO',
  naver_requests: 0,
  erp_requests: 0,
  live_writes: 0,
  note: '이 보고서는 실등록 준비 확인용이다. 파일럿 패키지는 전송되지 않고, 카테고리 코퍼스·ERP 잔량·운영 정책이 채워질 때까지 본문의 필수 값은 비어 있는 것이 정상이다.',
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${OUT_REL}`);
console.log(`pilot=${pilotIds.length} products=${report.products} field_gap_fields=${Object.keys(fieldGaps.fields).length} undeclared=${fieldGaps.undeclared_total}`);
