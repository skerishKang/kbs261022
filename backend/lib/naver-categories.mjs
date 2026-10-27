// Naver category mapping, built so that an unverified id can never be emitted.
//
// The supplier catalogue carries its own navigation paths (153 distinct, measured
// from data/smartstore_prep/smartstore_registration_prep.csv). SmartStore needs a
// `leafCategoryId` from Naver's own tree. The only documented way to obtain that
// tree is GET /v1/categories with a seller Bearer token, and this lane is forbidden
// from authenticating — so the official corpus is absent here, and the honest output
// is "unresolved, zero invented ids" plus the machinery that becomes useful the
// moment the corpus exists.
//
// Everything below is pure: no network, no fs. `tools/naver-category-candidates.mjs`
// is the only caller that reads files, and the readiness classifier never calls it.

/** What the transcribed v2.90.x contract actually states about categories. */
export const NAVER_CATEGORY_DOC = {
  source: 'apicenter.commerce.naver.com docs/commerce-api/current (transcriptions)',
  endpoints: [
    { id: 'categoryList', method: 'GET', path: '/v1/categories', auth: 'Bearer', query: { last: 'boolean — 리프 카테고리만 조회' }, fields: ['wholeCategoryName', 'id', 'name', 'last'], docPage: 'get-category-list-product', docUrl: 'https://apicenter.commerce.naver.com/docs/commerce-api/current/get-category-list-product' },
    { id: 'categoryGet', method: 'GET', path: '/v1/categories/{categoryId}', auth: 'Bearer', fields: ['wholeCategoryName', 'id', 'name', 'last', 'exceptionalCategories', 'certificationInfos'], docPage: 'get-category-product', docUrl: 'https://apicenter.commerce.naver.com/docs/commerce-api/current/get-category-product' },
    { id: 'categorySub', method: 'GET', path: '/v1/categories/{categoryId}/sub-categories', auth: 'Bearer', fields: ['wholeCategoryName', 'id', 'name', 'last'], docPage: 'get-sub-category-product', docUrl: 'https://apicenter.commerce.naver.com/docs/commerce-api/current/get-sub-category-product' },
  ],
  responses: 'wholeCategoryName(전체 경로 표시명), id, name, last(리프 여부)',
  idType: 'the category-detail page types id as string, not integer — a corpus row is kept on any non-empty id and only flagged if it is not digits',
  unauthorized: { '403': 'FORBIDDEN — 권한 없음', '401': 'UNAUTHORIZED — 토큰 오류', '400': 'BAD_REQUEST — 형식 오류', '404': 'NOT_FOUND — 데이터 없음', '500': 'INTERNAL_SERVER_ERROR' },
  redirect: 'the category-detail page prints a 308 case: follow Location and re-request',
  caching: '카테고리 메타 데이터는 변경 빈도가 낮아 캐시 권장(일 단위/배포 주기 갱신)',
  leafRule: 'last=true 항목만 상품 등록 시 실제로 선택 가능',
  certificationFields: 'certificationInfos[]: id, name, kindTypes[], green, certificationMarkType, companyName, certificationDate, kcParallelImportExemptionObject, nonEssential',
  unconfirmed: [
    'the category tree itself — never retrieved in this lane (needs a seller token)',
    'how many leaf categories exist and which apply to audio equipment',
    'whether a category id is stable across SmartStore and Intelligent Store',
    'a page size or total for GET /v1/categories — no pagination parameter is printed',
  ],
};

/**
 * `exceptionalCategories` is documented verbatim on the category-detail page. The
 * Korean gloss is the doc's own label; `affects` names the column of OUR prep file
 * that the label implies — where that link is our reading rather than the doc's
 * words, `inferred` is true so nobody mistakes it for a published rule.
 */
export const NAVER_EXCEPTIONAL_CATEGORIES = {
  E_COUPON: { gloss: 'E쿠폰', affects: '상품 유형', inferred: true },
  ADULT: { gloss: '성인', affects: '성인 상품 노출·구매 제한', inferred: true },
  MARINE_PRODUCTS: { gloss: '수산물', affects: '원산지·품목 표시', inferred: true },
  REVIEW_UNEXPOSE: { gloss: '구매평 미노출', affects: '', inferred: false },
  CHILD_CERTIFICATION: { gloss: '어린이제품 인증 대상', affects: 'KC고시정보', inferred: false },
  ORIGINAREA_PRODUCTS: { gloss: '원산지 입력 대상', affects: '원산지코드', inferred: false },
  GREEN_PRODUCTS: { gloss: '친환경 인증 대상', affects: 'KC고시정보', inferred: false },
  KC_CERTIFICATION: { gloss: 'KC 인증 대상', affects: 'KC고시정보', inferred: false },
  CHEMICAL_CERTIFICATION: { gloss: '생활화학/살생물제 인증 대상', affects: 'KC고시정보', inferred: false },
  SAFE_CRITERION: { gloss: '안전기준준수대상', affects: 'KC고시정보', inferred: false },
  AFFILIATE: { gloss: '어필리에이트', affects: '', inferred: false },
  TRADITIONAL_ALCOHOL: { gloss: '전통주', affects: '', inferred: false },
  OPTION_PRICE: { gloss: '옵션가 제한 예외 카테고리', affects: '옵션 가격', inferred: false },
  BOOK: { gloss: '도서_일반', affects: '정가제', inferred: false },
  BOOK_EBOOK: { gloss: '도서_E북', affects: '정가제', inferred: false },
  BOOK_AUDIO: { gloss: '도서_오디오북', affects: '정가제', inferred: false },
  BOOK_MAGAZINE: { gloss: '도서_잡지', affects: '정가제', inferred: false },
  BOOK_USED: { gloss: '도서_중고', affects: '정가제', inferred: false },
  BOOK_OVERSEAS: { gloss: '도서_해외', affects: '정가제', inferred: false },
  BOOK_FREE: { gloss: '도서_정가제free', affects: '정가제', inferred: false },
  PERFORMANCE: { gloss: '문화비_소득공제', affects: '', inferred: false },
  FREE_RETURN_INSURANCE: { gloss: '반품안심케어', affects: '반품·교환 정책', inferred: true },
  REGULAR_SUBSCRIPTION: { gloss: '정기구독', affects: '상품 유형', inferred: true },
  RENTAL_SUBSCRIPTION: { gloss: '렌탈', affects: '상품 유형', inferred: true },
  MANUFACTURE_DEFINE_NO: { gloss: '품번', affects: '모델명', inferred: false },
};

/**
 * The full enum catalog the category-detail page prints under "사용 enum 카탈로그".
 * It is wider than the glossed table above: nine values appear only as bare names,
 * so nothing here may claim a Korean label or an effect for them. Keeping the
 * complete list matters because a leaf that returns one of them would otherwise be
 * silently dropped, and a dropped exceptionalCategory is a registration rule we
 * would never see.
 */
export const NAVER_EXCEPTIONAL_CATEGORY_ENUM = [
  'E_COUPON', 'ADULT', 'MARINE_PRODUCTS', 'REVIEW_UNEXPOSE', 'CHILD_CERTIFICATION', 'ORIGINAREA_PRODUCTS',
  'GREEN_PRODUCTS', 'KC_CERTIFICATION', 'SAFE_CRITERION', 'AFFILIATE', 'TRADITIONAL_ALCOHOL', 'ALCOHOL',
  'OPTION_PRICE', 'BOOK_CHILD', 'BOOK', 'BOOK_EBOOK', 'BOOK_AUDIO', 'BOOK_MAGAZINE', 'BOOK_USED',
  'BOOK_OVERSEAS', 'BOOK_FREE', 'PERFORMANCE', 'FREE_RETURN_INSURANCE', 'REGULAR_SUBSCRIPTION',
  'RENTAL_SUBSCRIPTION', 'VINTAGE_CITY', 'SEONE_AI_ASSISTANT_UNEXPOSE', 'GROUP_PRODUCT_MAX',
  'DYNAMIC_PRICING_CONFIG', 'MANUFACTURE_DEFINE_NO', 'PREORDER_VALID_DATE', 'UNIT_PRICE',
  'BUSINESSMALL_UNAVAILABLE', 'CHEMICAL_CERTIFICATION',
];

/** The values documented for `certificationInfos[].kindTypes[]`. */
export const NAVER_CERTIFICATION_KIND_ENUM = [
  'KC_CERTIFICATION', 'CHILD_CERTIFICATION', 'GREEN_PRODUCTS', 'CHEMICAL_CERTIFICATION', 'PARALLEL_IMPORT', 'OVERSEAS', 'ETC',
];

/** Enum members the docs list without a Korean gloss or any stated effect. */
export const NAVER_EXCEPTIONAL_CATEGORY_NAMES_ONLY = NAVER_EXCEPTIONAL_CATEGORY_ENUM.filter((value) => !Object.prototype.hasOwnProperty.call(NAVER_EXCEPTIONAL_CATEGORIES, value));

/**
 * Supplier-side path families, measured over all 4,575 rows of
 * data/smartstore_prep/smartstore_registration_prep.csv (153 distinct paths):
 *   27 paths run `홈 > 제품분류별 보기 > …` and none of their leaves is a brand;
 *   19 run `홈 > 브랜드별 보기 > <A-C> > <Brand>` and all 19 leaves are brands;
 *   107 carry no marker at all, and 24 of those are a bare brand name (`APOGEE`,
 *   `KLOTZ`, `SHURE`) — the supplier's brand page reached without any marker.
 * A brand page or a promotion page is not a product classification, so mapping it
 * onto a Naver leaf would invent an equivalence the supplier never claimed.
 */
export const SUPPLIER_NAVIGATION_SEGMENTS = ['홈', '브랜드별 보기', '브랜드별보기', '제품분류별 보기', '제품분류별보기', '카테고리', '전체', 'best', 'new', 'sale'];
export const SUPPLIER_PRODUCT_INDEX_MARKER = '제품분류별';
export const SUPPLIER_BRAND_INDEX_MARKER = '브랜드별';
/** `A-C`, `H-K`, `S-Z` — the alphabetical ranges only the brand index uses. */
export const SUPPLIER_BRAND_RANGE_PATTERN = /^[A-Z]-[A-Z]$/;
/** `10% 할인 상품` and friends: a merchandising shelf, measured at 1 path / 2 rows. */
export const SUPPLIER_PROMOTION_PATTERN = /(할인|이벤트|기획전|타임세일|best|new|sale)/i;

const normalize = (value) => String(value || '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s　]+/g, '')
  .replace(/[·・,.\-/()&'+*·]/g, '');

/** Splits a supplier path into meaningful segments, dropping pure navigation. */
export function supplierSegments(categoryPath) {
  const raw = String(categoryPath || '').split('>').map((part) => part.trim()).filter(Boolean);
  const kept = raw.filter((part) => !SUPPLIER_NAVIGATION_SEGMENTS.includes(part) && !SUPPLIER_NAVIGATION_SEGMENTS.includes(normalize(part)));
  return { raw, kept, navigationOnly: kept.length === 0, brandPath: raw.some((part) => part.includes(SUPPLIER_BRAND_INDEX_MARKER)) };
}

/**
 * Decides what a supplier path IS, from the catalogue's own structure plus the
 * brands that actually appear on it. Deliberately independent of the Naver corpus:
 * this is a property of our data and is knowable today, whereas a leaf id is not.
 * `kind` is one of navigation_only | promotion_page | brand_index |
 * product_classification, and only the last is ever scored against a corpus.
 */
export function classifySupplierPath(categoryPath, { brands = [], brandValues = new Set() } = {}) {
  const segments = supplierSegments(categoryPath);
  const leaf = segments.raw.length ? segments.raw[segments.raw.length - 1] : '';
  const leafNormalized = normalize(leaf);
  const markedProduct = segments.raw.some((part) => part.includes(SUPPLIER_PRODUCT_INDEX_MARKER));
  const markedBrand = segments.raw.some((part) => part.includes(SUPPLIER_BRAND_INDEX_MARKER));
  const rangeSegment = segments.raw.some((part) => SUPPLIER_BRAND_RANGE_PATTERN.test(part));
  const leafIsBrand = Boolean(leafNormalized) && brandValues.has(leafNormalized);
  const distinctBrands = new Set(brands.map(normalize).filter(Boolean));
  if (segments.navigationOnly) return { ...segments, leaf, kind: 'navigation_only', reason: 'navigation_only_path' };
  if (!markedProduct && (markedBrand || rangeSegment || leafIsBrand)) {
    return { ...segments, leaf, kind: 'brand_index', reason: 'brand_index_path', brandDisagrees: leafIsBrand && distinctBrands.size > 1, distinctBrands: distinctBrands.size };
  }
  if (SUPPLIER_PROMOTION_PATTERN.test(leaf)) return { ...segments, leaf, kind: 'promotion_page', reason: 'promotion_page' };
  return { ...segments, leaf, kind: 'product_classification', reason: '', distinctBrands: distinctBrands.size };
}

export function leafOf(categoryPath) {
  const parts = String(categoryPath || '').split('>').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Reads a Naver category corpus. The corpus is whatever `GET /v1/categories`
 * returned at some point; without that file the function reports `present: false`
 * and carries the reason, which is the state of this repository today.
 */
export function loadOfficialCorpus(text, { format = 'auto' } = {}) {
  const emptyCensus = { rows: 0, leaves: 0, distinct_ids: 0, non_digit_ids: 0 };
  if (!text || !String(text).trim()) {
    return { present: false, reason: 'corpus file absent or empty', rows: [], leaves: [], problems: [], census: emptyCensus };
  }
  const problems = [];
  const seenIds = new Set();
  let records = [];
  const body = String(text).trim();
  // A pasted corpus is JSON whether it starts as a list or as a response object;
  // sniffing only '[' would feed `{"data":[…]}` to the CSV reader and report an
  // empty tree for a file that plainly contains one.
  if (format === 'json' || (format === 'auto' && /^[[{]/.test(body))) {
    try {
      records = JSON.parse(body);
    } catch (error) {
      return { present: false, reason: `corpus is not valid JSON: ${error.message}`, rows: [], leaves: [], problems: ['corpus_unparseable'], census: emptyCensus };
    }
    // A pasted API response usually arrives wrapped, and a wrapper is not a corpus
    // error — but anything that is still not a list is reported, never guessed at.
    if (records && !Array.isArray(records) && Array.isArray(records.data)) records = records.data;
    if (!Array.isArray(records)) {
      return { present: false, reason: `corpus JSON carries no list of categories (got ${typeof records})`, rows: [], leaves: [], problems: ['corpus_shape_unrecognized'], census: emptyCensus };
    }
  } else {
    const lines = body.split(/\r?\n/).filter((line) => line.trim());
    const header = (lines.shift() || '').split(',').map((cell) => cell.trim().replace(/^﻿/, ''));
    const column = (name) => header.indexOf(name);
    const at = ['id', 'wholeCategoryName', 'name', 'last'].map(column);
    if (at[0] === -1) return { present: false, reason: `corpus header lacks id: ${header.join(',')}`, rows: [], leaves: [], problems: ['corpus_header_unexpected'], census: emptyCensus };
    records = lines.map((line) => {
      const cells = line.split(',');
      return { id: cells[at[0]], wholeCategoryName: at[1] === -1 ? '' : cells[at[1]], name: at[2] === -1 ? '' : cells[at[2]], last: at[3] === -1 ? true : cells[at[3]] };
    });
  }
  const rows = [];
  for (const record of records) {
    const id = String(record.id ?? '').trim();
    const name = String(record.name ?? '').trim();
    const whole = String(record.wholeCategoryName ?? name).trim();
    const last = record.last === true || String(record.last).toLowerCase() === 'true';
    if (!id || !name) { problems.push('row_without_id_or_name'); continue; }
    // The docs type `id` as string. Dropping a row because it is not digits would
    // quietly shrink the corpus a mapping was built from, so the row stays and the
    // shape is only flagged for a human to look at.
    if (!/^[0-9]+$/.test(id)) problems.push('id_not_digits');
    if (seenIds.has(id)) { problems.push('duplicate_id'); continue; }
    seenIds.add(id);
    rows.push({ id, name, wholeCategoryName: whole, last });
  }
  const leafRows = rows.filter((row) => row.last);
  return {
    present: rows.length > 0,
    reason: rows.length ? '' : 'no usable rows in corpus',
    rows,
    leaves: leafRows,
    problems: [...new Set(problems)],
    census: { rows: rows.length, leaves: leafRows.length, distinct_ids: new Set(rows.map((row) => row.id)).size, non_digit_ids: rows.filter((row) => !/^[0-9]+$/.test(row.id)).length },
  };
}

/** Token sets for overlap scoring, with navigation words removed. */
function tokensOf(value) {
  const parts = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s>›/|·、,()\-\_&+]+/)
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((token) => token.length > 1 && !SUPPLIER_NAVIGATION_SEGMENTS.map(normalize).includes(normalize(token)));
  return new Set(parts);
}

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/**
 * Scores one supplier path against every leaf in the corpus. A candidate is only
 * accepted when it clears both an absolute floor and a margin over the runner-up —
 * two leaves that score alike is exactly the case where guessing would be visible
 * in the product, so it goes to a human instead.
 *
 * The structural verdict comes first on purpose: a brand or promotion page stays
 * unmappable whether or not the corpus exists, so reporting `corpus_absent` for it
 * would imply that fetching the tree would settle it. It would not.
 */
export function rankCandidates(supplierPath, leaves = [], { limit = 5, minScore = 0.5, margin = 0.08, pathInfo = null } = {}) {
  const info = pathInfo || classifySupplierPath(supplierPath);
  const leafName = info.leaf || leafOf(supplierPath);
  const target = normalize(leafName);
  if (info.kind !== 'product_classification') return { status: 'unresolved', reason: info.reason, candidates: [] };
  if (!leaves.length || !target) {
    return { status: 'unresolved', reason: !leaves.length ? 'corpus_absent' : 'blank_path', candidates: [] };
  }
  const targetTokens = tokensOf(supplierPath);
  const scored = leaves.map((entry) => {
    const nameNorm = normalize(entry.name);
    const wholeTokens = tokensOf(entry.wholeCategoryName);
    const evidence = [];
    let score = 0;
    if (nameNorm === target) { score += 1; evidence.push('leaf_name_exact'); }
    else if (nameNorm && (target.includes(nameNorm) || nameNorm.includes(target))) { score += 0.6 + 0.2 * (Math.min(nameNorm.length, target.length) / Math.max(nameNorm.length, target.length)); evidence.push('leaf_name_contains'); }
    const overlap = jaccard(targetTokens, wholeTokens);
    if (overlap > 0) { score += overlap * 0.6; evidence.push(`path_token_overlap_${(overlap * 100).toFixed(0)}`); }
    return { entry, id: entry.id, name: entry.name, wholeCategoryName: entry.wholeCategoryName, score: Math.min(1, Number(score.toFixed(4))), evidence };
  }).filter((row) => row.score > 0).sort((a, b) => (b.score - a.score) || (a.wholeCategoryName < b.wholeCategoryName ? -1 : 1));
  const top = scored.slice(0, limit);
  if (!top.length) return { status: 'unresolved', reason: 'no_lexical_overlap', candidates: [] };
  const gap = top[0].score - (top[1] ? top[1].score : 0);
  if (top[0].score < minScore) return { status: 'unresolved', reason: 'best_below_min_score', candidates: top };
  if (gap < margin) return { status: 'ambiguous', reason: 'runner_up_within_margin', candidates: top };
  return { status: 'candidate', reason: '', candidates: top };
}

/**
 * Maps the whole catalogue. Returns per-supplier-path verdicts plus per-product
 * assignments, and a census that states how many rows could NOT be decided — the
 * number a report must not round away.
 *
 * `products` carries the supplier path and the brand the supplier printed on the
 * row, because the only way to tell `APOGEE` (a brand page) from `이어폰` (a product
 * class) is to ask the catalogue itself. A proposed leaf id is always copied out of
 * `corpus`; `invented_leaf_category_ids` counts any row that broke that rule, and
 * the CLI refuses to write a file while it is non-zero.
 */
export function mapSupplierCategories({ products = [], corpus = [], limit = 5, minScore = 0.5, margin = 0.08 } = {}) {
  const leaves = (corpus || []).filter((row) => row.last !== false);
  const brandValues = new Set(products.map((product) => normalize(product.brand)).filter(Boolean));
  const brandsByPath = new Map();
  for (const product of products) {
    const path = String(product.categoryPath || '');
    if (!brandsByPath.has(path)) brandsByPath.set(path, new Set());
    const brand = normalize(product.brand);
    if (brand) brandsByPath.get(path).add(brand);
  }
  const byPath = new Map();
  const decide = (path) => {
    if (!byPath.has(path)) {
      const info = classifySupplierPath(path, { brands: [...(brandsByPath.get(path) || [])], brandValues });
      byPath.set(path, { info, verdict: rankCandidates(path, leaves, { limit, minScore, margin, pathInfo: info }) });
    }
    return byPath.get(path);
  };
  const rows = [];
  for (const product of products) {
    const path = String(product.categoryPath || '');
    const { info, verdict } = decide(path);
    const best = verdict.status === 'candidate' ? verdict.candidates[0] : null;
    rows.push({
      cgiId: product.cgiId,
      categoryPath: path,
      pathKind: info.kind,
      status: verdict.status,
      reason: verdict.reason,
      leafScore: best ? best.score : '',
      leafEvidence: best ? best.evidence.join(';') : '',
      proposedLeafCategoryName: best ? best.name : '',
      proposedWholeCategoryName: best ? best.wholeCategoryName : '',
      proposedLeafCategoryId: best ? best.id : '',
      confirmed: false,
    });
  }
  const productsPerPath = new Map();
  for (const row of rows) productsPerPath.set(row.categoryPath, (productsPerPath.get(row.categoryPath) || 0) + 1);
  const paths = [...byPath.entries()].map(([path, { info, verdict }]) => ({
    path,
    leaf: info.leaf,
    kind: info.kind,
    distinctBrands: (brandsByPath.get(path) || new Set()).size,
    brandDisagrees: info.brandDisagrees === true,
    products: productsPerPath.get(path) || 0,
    status: verdict.status,
    reason: verdict.reason,
    candidates: verdict.candidates.map((c) => ({ id: c.id, name: c.name, wholeCategoryName: c.wholeCategoryName, score: c.score, evidence: c.evidence.join(';') })),
  })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tally = (key) => rows.reduce((out, row) => { out[row[key]] = (out[row[key]] || 0) + 1; return out; }, {});
  const tallyPaths = (key) => paths.reduce((out, row) => { out[row[key]] = (out[row[key]] || 0) + 1; return out; }, {});
  const rowsPerKind = paths.reduce((out, row) => { out[row.kind] = (out[row.kind] || 0) + row.products; return out; }, {});
  return {
    rows,
    paths,
    census: {
      products: rows.length,
      distinct_supplier_paths: byPath.size,
      corpus_present: leaves.length > 0,
      corpus_leaves: leaves.length,
      paths_by_kind: tallyPaths('kind'),
      products_by_kind: rowsPerKind,
      products_by_status: tally('status'),
      products_by_reason: tally('reason'),
      paths_by_reason: paths.reduce((out, row) => { out[row.reason || 'none'] = (out[row.reason || 'none'] || 0) + 1; return out; }, {}),
      proposed_products: rows.filter((row) => row.proposedLeafCategoryId).length,
      confirmed_products: rows.filter((row) => row.confirmed === true).length,
      invented_leaf_category_ids: rows.filter((row) => row.proposedLeafCategoryId && !leaves.some((leaf) => leaf.id === row.proposedLeafCategoryId)).length,
    },
  };
}
