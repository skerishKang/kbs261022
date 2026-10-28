#!/usr/bin/env node
// M2 후속 — 네이버 카테고리 코퍼스 수집·검증 도구.
//
//   node tools/naver-category-corpus.mjs fetch  --corpus-out <repo-relative>   # mock 전용
//   node tools/naver-category-corpus.mjs verify --corpus <path> --report-out <repo-relative>
//
// fetch 는 NCOM_MODE=mock (루프백 목업) 에서만 동작한다. 실제 판매자 토큰으로의
// 수집은 운영자 승인 뒤 별도 실행이며, 이 레인은 그 경로를 열지 않는다 — 실수로
// 실서버에 닿는 것보다 거부가 낫다. 수집 결과에는 sha256·행 수·리프 수가 함께
// 기록되어, 나중에 검증 절차가 '무엇을 받았는지'부터 확인할 수 있다.
//
// verify 는 코퍼스 파일을 받아 (a) 코퍼스 자체의 형태·중복·비숫자 id 를 재고,
// (b) 커밋된 153개 공급처 경로에 대해 매핑 계약(invented=0, 브랜드/프로모션 경로
// 비매핑)을 검사한다. 실패하면 exit 1 — 부분 통과로 넘기지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createNcomAuthRuntime } from '../lib/ncommerce-auth.mjs';
import { classifySupplierPath, loadOfficialCorpus, mapSupplierCategories } from '../lib/naver-categories.mjs';
import { parseCsv } from '../lib/product-mapping.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const resolveInside = (rel, label) => {
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep)) {
    console.error(`refused: ${label} must stay inside the repository (got ${rel})`);
    process.exit(2);
  }
  return full;
};
const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

async function fetchCorpus() {
  const outRel = String(flag('corpus-out', 'reports/data/naver/category_corpus.json'));
  const outPath = resolveInside(outRel, '--corpus-out');
  const env = process.env;
  const mode = String(env.NCOM_MODE || '').trim();
  if (mode !== 'mock') {
    console.error(`refused: 코퍼스 수집은 이 레인에서 NCOM_MODE=mock 만 허용된다 (현재 ${JSON.stringify(mode || 'unset')}).`);
    console.error('실제 판매자 토큰으로의 수집은 운영자 승인 뒤 별도 실행이다 — 이 도구는 실제 서버에 접속하지 않는다.');
    process.exit(2);
  }
  // mock 전용 실행 — 서명 봉합은 erp-naver-dry-run.mjs 와 같은 결정론적 스텁을 쓴다
  // (라이브는 위에서 이미 거부됐다. 실제 수집은 운영자 레인에서 bcryptjs 로 수행).  
  const bcryptHashpw = async (plain, salt) => `$2a$10$${Buffer.from(`${plain}|${salt}`).toString('base64')}`;
  const runtime = createNcomAuthRuntime({ env, bcryptHashpw });
  const result = await runtime.call('categoryList', { query: { last: 'true' } });
  const categories = Array.isArray(result.data) ? result.data : (Array.isArray(result.raw) ? result.raw : null);
  if (!categories) {
    console.error('refused: 응답이 카테고리 목록이 아니다 — 파일을 쓰지 않는다');
    process.exit(2);
  }
  const canonical = JSON.stringify(categories);
  const corpus = {
    kind: 'cgi-naver-category-corpus',
    source: 'GET /v1/categories?last=true',
    mode: 'mock',
    fetched_at: new Date().toISOString(),
    sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
    row_count: categories.length,
    categories,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(`wrote ${outRel}`);
  console.log(`mode=mock rows=${categories.length} sha256=${corpus.sha256.slice(0, 16)}… naver_requests=${runtime.stats.attempts}`);
  // undici 의 keep-alive 풀링 소켓이 이벤트 루프를 붙잡는다 — CLI 는 쓰고 나면 명시적으로 끝낸다.
  process.exit(0);
}

function verifyCorpus() {
  const corpusRel = String(flag('corpus', ''));
  if (!corpusRel) { console.error('usage: verify --corpus <path> [--report-out <repo-relative>]'); process.exit(2); }
  const reportRel = String(flag('report-out', 'reports/data/naver/category_corpus_verification.json'));
  const reportPath = resolveInside(reportRel, '--report-out');
  const corpusText = fs.readFileSync(path.join(ROOT, corpusRel), 'utf8');
  const envelope = JSON.parse(corpusText);
  const categories = Array.isArray(envelope) ? envelope : (Array.isArray(envelope.categories) ? envelope.categories : null);
  if (!categories) {
    console.error('refused: 코퍼스 파일이 목록을 담고 있지 않다');
    process.exit(2);
  }
  const corpus = loadOfficialCorpus(JSON.stringify(categories));
  const failures = [];

  // (a) 코퍼스 자체 — 존재·리프·id 형태. 비숫자 id 는 실패가 아니라 표시다(문서가 id 를 문자열로 타이핑).
  if (!corpus.present) failures.push('corpus_present_false');
  if (corpus.leaves.length === 0) failures.push('no_leaves');
  if (corpus.census.non_digit_ids > 0) {
    // 문서 타입이 string 이므로 실패는 아니지만, 운영자가 id 를 숫자로 가정하지 않게 보고서에 남긴다.
  }

  // (b) 매핑 계약 — 커밋된 공급처 경로 전체로 검사한다.
  const prep = readCsv('data/smartstore_prep/smartstore_registration_prep.csv');
  const products = prep.map((row, index) => ({ cgiId: `p:${index}`, categoryPath: String(row['카테고리경로_CGI'] ?? ''), brand: String(row['브랜드'] ?? '') }));
  const mapped = mapSupplierCategories({ products, corpus: corpus.rows });
  if (mapped.census.invented_leaf_category_ids !== 0) failures.push(`invented_leaf_ids=${mapped.census.invented_leaf_category_ids}`);
  const leafIds = new Set(corpus.leaves.map((leaf) => leaf.id));
  for (const row of mapped.rows) {
    if (row.proposedLeafCategoryId && !leafIds.has(row.proposedLeafCategoryId)) failures.push(`proposal_not_in_corpus:${row.cgiId}`);
  }
  // 구조 판정은 코퍼스와 무관하게 유지돼야 한다 — 브랜드/프로모션 경로가 후보를 받으면 계약 위반.
  const structuralViolations = [];
  const brandsByPath = new Map();
  for (const row of prep) {
    const p = String(row['카테고리경로_CGI'] ?? '');
    if (!brandsByPath.has(p)) brandsByPath.set(p, new Set());
    const b = String(row['브랜드'] ?? '');
    if (b) brandsByPath.get(p).add(b);
  }
  const brandValues = new Set([...brandsByPath.values()].flatMap((set) => [...set]).map((b) => b.toLowerCase()));
  for (const pathRow of mapped.paths) {
    const info = classifySupplierPath(pathRow.path, { brands: [...(brandsByPath.get(pathRow.path) || [])], brandValues });
    if (info.kind !== 'product_classification' && pathRow.status === 'candidate') structuralViolations.push({ path: pathRow.path, kind: info.kind, status: pathRow.status });
  }
  if (structuralViolations.length) failures.push(`structural_paths_mapped=${structuralViolations.length}`);

  const report = {
    kind: 'cgi-naver-category-corpus-verification',
    corpus_file: corpusRel,
    corpus_sha256: envelope.sha256 ?? null,
    corpus: { present: corpus.present, rows: corpus.census.rows, leaves: corpus.census.leaves, distinct_ids: corpus.census.distinct_ids, non_digit_ids: corpus.census.non_digit_ids, problems: corpus.problems },
    contract: {
      supplier_products: mapped.census.products,
      distinct_supplier_paths: mapped.census.distinct_supplier_paths,
      products_by_status: mapped.census.products_by_status,
      products_by_reason: mapped.census.products_by_reason,
      proposed_products: mapped.census.proposed_products,
      invented_leaf_category_ids: mapped.census.invented_leaf_category_ids,
      structural_violations: structuralViolations.length,
    },
    failures,
    passed: failures.length === 0,
    rule: '리프 id 는 코퍼스에서만 복사한다. 브랜드·프로모션·내비게이션 경로는 코퍼스가 있어도 매핑하지 않는다. 실패가 하나라도 있으면 passed=false 이며 exit 1 이다.',
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${reportRel}`);
  console.log(`passed=${report.passed} leaves=${report.corpus.leaves} invented=${report.contract.invented_leaf_category_ids} proposals=${report.contract.proposed_products}`);
  if (!report.passed) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
}

if (command === 'fetch') await fetchCorpus();
else if (command === 'verify') verifyCorpus();
else {
  console.error('usage: node tools/naver-category-corpus.mjs <fetch|verify> [options]');
  console.error('  fetch  --corpus-out <repo-relative>        (NCOM_MODE=mock 전용)');
  console.error('  verify --corpus <path> --report-out <repo-relative>');
  process.exit(2);
}
