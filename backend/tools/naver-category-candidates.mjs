// Which Naver leaf category should each supplier category path be registered under?
//
//   node tools/naver-category-candidates.mjs \
//     --source data/smartstore_prep/smartstore_registration_prep.csv \
//     --paths reports/data/naver/category_paths.csv \
//     --aggregate reports/data/naver/category_mapping_summary.json
//
// Optional: --corpus <file> (the JSON or CSV that GET /v1/categories returned on an
// authenticated read made elsewhere) and --limit / --min-score / --margin.
//
// The prep CSV carries the supplier's own navigation path in every row (153
// distinct paths over 4,575 products). SmartStore needs `leafCategoryId` from
// Naver's tree, and the only documented way to get that tree is
// GET /v1/categories with a seller Bearer token. This lane may not authenticate,
// so the corpus is absent and the correct output today is a mapping that resolves
// nothing while still doing the work that does not need a token: deciding which
// supplier paths are product classifications at all.
//
// That distinction is not cosmetic. 43 of the 153 paths are the supplier's brand
// index (`APOGEE`, `홈 > 브랜드별 보기 > H-K > KLOTZ`) and one is a discount shelf;
// a brand page has no product meaning to carry over, so mapping it onto a Naver
// leaf would invent an equivalence the supplier never claimed. Those rows stay
// unresolved even after the corpus arrives, and this file says which ones and why.
//
// No network, no credential, no write outside the named outputs. Every proposed
// id is copied out of the corpus file — the run refuses to write anything if a
// single id appeared that the corpus does not contain.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../lib/product-mapping.mjs';
import { toCsv } from '../lib/registration-readiness.mjs';
import { NAVER_CATEGORY_DOC, NAVER_EXCEPTIONAL_CATEGORY_ENUM, NAVER_CERTIFICATION_KIND_ENUM, loadOfficialCorpus, mapSupplierCategories } from '../lib/naver-categories.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const SOURCESPEC = option('source', 'data/smartstore_prep/smartstore_registration_prep.csv');
const PATH_COLUMN = option('path-column', '카테고리경로_CGI');
const KEY_COLUMN = option('key-column', '공급처원본ID');
const BRAND_COLUMN = option('brand-column', '브랜드');
const CORPUS = option('corpus', null);
const CORPUS_FORMAT = option('corpus-format', 'auto');
const LIMIT = Number(option('limit', 5));
const MIN_SCORE = Number(option('min-score', 0.5));
const MARGIN = Number(option('margin', 0.08));
const PATHS = option('paths', null);
const AGGREGATE = option('aggregate', null);

// Nothing this file writes is private: it is the supplier's own navigation paths
// (already committed in the prep CSV) plus counts, so both outputs stay repo-facing
// and the per-product view remains the readiness CSV's job rather than a duplicate.
if (!PATHS && !AGGREGATE) {
  console.error('nothing to write: pass --paths (per-path table) and/or --aggregate (repo JSON)');
  process.exit(2);
}
// The repo-facing files are the committed evidence for this lane, so they may not
// be redirected outside the repository.
for (const [name, value] of [['--paths', PATHS], ['--aggregate', AGGREGATE]]) {
  if (!value) continue;
  const target = path.resolve(ROOT, value);
  if (!target.startsWith(path.resolve(ROOT) + path.sep)) {
    console.error(`${name} target escapes the repository: ${value}`);
    process.exit(2);
  }
}

const sourceRows = parseCsv(fs.readFileSync(path.join(ROOT, SOURCESPEC), 'utf8'));
if (!sourceRows.length) {
  console.error(`no rows read from ${SOURCESPEC}`);
  process.exit(2);
}
for (const column of [PATH_COLUMN, KEY_COLUMN]) {
  if (!(column in sourceRows[0])) {
    console.error(`column ${column} is not in ${SOURCESPEC}: ${Object.keys(sourceRows[0]).join(',')}`);
    process.exit(2);
  }
}

const products = sourceRows.map((row) => ({
  cgiId: String(row[KEY_COLUMN] || '').trim(),
  brand: String(row[BRAND_COLUMN] || '').trim(),
  categoryPath: String(row[PATH_COLUMN] || '').trim(),
}));

// A corpus file only ever gets here because an operator put one there after an
// authenticated read elsewhere; this run never produces one.
let corpus = { present: false, reason: `no --corpus passed; the tree needs ${NAVER_CATEGORY_DOC.endpoints[0].method} ${NAVER_CATEGORY_DOC.endpoints[0].path} with a seller token`, rows: [], leaves: [], problems: [], census: { rows: 0, leaves: 0, distinct_ids: 0, non_digit_ids: 0 }, file: null };
if (CORPUS) {
  const target = path.resolve(ROOT, CORPUS);
  if (!fs.existsSync(target)) {
    // A named corpus that is not there is a mistake, not a corpus-absent run: the
    // two states must not produce the same file.
    console.error(`--corpus file not found: ${CORPUS}`);
    process.exit(2);
  }
  const bytes = fs.readFileSync(target);
  corpus = {
    ...loadOfficialCorpus(bytes.toString('utf8'), { format: CORPUS_FORMAT }),
    file: { path: CORPUS, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
  };
}

const mapped = mapSupplierCategories({ products, corpus: corpus.rows, limit: LIMIT, minScore: MIN_SCORE, margin: MARGIN });
const { census } = mapped;

// Fail closed before a byte is written: an id that is not in the corpus would be
// the exact invented category the order forbids.
if (census.invented_leaf_category_ids > 0) {
  console.error(`refusing to write: ${census.invented_leaf_category_ids} proposed leaf ids are not present in the corpus`);
  process.exit(1);
}
if (census.confirmed_products > 0) {
  console.error('refusing to write: a category was marked confirmed, and nothing in this lane may confirm one');
  process.exit(1);
}

console.log(`products ${census.products} · distinct supplier paths ${census.distinct_supplier_paths} · corpus ${corpus.present ? `present (${census.corpus_leaves} leaves)` : 'ABSENT'} · path kinds ${JSON.stringify(census.paths_by_kind)} · to map ${Object.values(census.products_by_status).reduce((a, b) => a + b, 0)} · unresolved ${census.products_by_status.unresolved ?? 0}`);

const PATH_COLUMNS = ['category_path', 'leaf', 'path_kind', 'products', 'distinct_brands', 'brand_disagrees', 'status', 'reason', 'candidate_leaf_category_ids', 'candidate_leaf_category_names', 'candidate_scores', 'candidate_evidence', 'confirmed'];
const pathRows = mapped.paths.map((row) => ({
  category_path: row.path,
  leaf: row.leaf,
  path_kind: row.kind,
  products: row.products,
  distinct_brands: row.distinctBrands,
  brand_disagrees: row.brandDisagrees ? 'yes' : 'no',
  status: row.status,
  reason: row.reason,
  candidate_leaf_category_ids: row.candidates.map((c) => c.id).join('|'),
  candidate_leaf_category_names: row.candidates.map((c) => c.name).join('|'),
  candidate_scores: row.candidates.map((c) => c.score).join('|'),
  candidate_evidence: row.candidates.map((c) => c.evidence).join('|'),
  confirmed: 'no',
}));

const aggregate = {
  kind: 'cgi-naver-category-mapping',
  scope: 'supplier category paths from the committed prep CSV; no Naver call, no credential, no product touched',
  issue: 95,
  source: SOURCESPEC,
  path_column: PATH_COLUMN,
  thresholds: { limit: LIMIT, min_score: MIN_SCORE, margin: MARGIN },
  transmitted: false,
  account_login: 'NO',
  naver_requests: 0,
  live_writes: 0,
  corpus: {
    // Two different states, because conflating them would let a file of branch
    // categories read as "the tree is available".
    parsed: corpus.present,
    selectable_leaves: census.corpus_present,
    reason: corpus.reason,
    file: corpus.file,
    census: corpus.census,
    problems: corpus.problems,
  },
  census,
  paths_by_status: mapped.paths.reduce((out, row) => { out[row.status] = (out[row.status] || 0) + 1; return out; }, {}),
  documented_contract: NAVER_CATEGORY_DOC,
  exceptional_category_enum_size: NAVER_EXCEPTIONAL_CATEGORY_ENUM.length,
  certification_kind_enum_size: NAVER_CERTIFICATION_KIND_ENUM.length,
  rule: 'only path_kind=product_classification is scored against the corpus; brand_index and promotion_page are never given a leaf, and a leaf id is copied out of the corpus or not written at all',
};

const written = [];
const write = (target, content, records, unit = '행') => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  written.push({ name: path.basename(target), bytes: Buffer.byteLength(content), records, unit });
};

if (PATHS) write(path.resolve(ROOT, PATHS), toCsv(pathRows, PATH_COLUMNS), pathRows.length);
if (AGGREGATE) write(path.resolve(ROOT, AGGREGATE), `${JSON.stringify(aggregate, null, 1)}\n`, 1, '개 문서');

console.log(JSON.stringify({
  PRODUCTS: census.products,
  DISTINCT_PATHS: census.distinct_supplier_paths,
  PATH_KINDS: census.paths_by_kind,
  PRODUCTS_BY_KIND: census.products_by_kind,
  STATUS_BY_PRODUCT: census.products_by_status,
  REASONS_BY_PATH: census.paths_by_reason,
  CORPUS_PRESENT: census.corpus_present,
  CORPUS_ROWS: corpus.census.rows,
  CORPUS_LEAVES: census.corpus_leaves,
  LEAF_IDS_PROPOSED: census.proposed_products,
  INVENTED_LEAF_IDS: census.invented_leaf_category_ids,
  CONFIRMED: census.confirmed_products,
  OUTPUT_FILES: written.map((item) => item.name),
  NAVER_REQUESTS: 0,
  ACCOUNT_LOGIN: 'NO',
  LIVE_WRITES: 0,
}, null, 1));
