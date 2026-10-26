// Unit tests for the Naver category lane. Everything here is pure — no file is
// read and no request is made, because the category tree cannot be fetched in
// this lane at all. The tests therefore pin the two things that ARE knowable
// offline: what the transcribed contract states, and which supplier paths carry
// a product meaning that a corpus could ever be matched against.
//
//   node --test test/unit/naver-categories.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { NCOM_ENDPOINTS } from '../../lib/ncommerce.mjs';
import {
  NAVER_CATEGORY_DOC, NAVER_EXCEPTIONAL_CATEGORIES, NAVER_EXCEPTIONAL_CATEGORY_ENUM,
  NAVER_EXCEPTIONAL_CATEGORY_NAMES_ONLY, NAVER_CERTIFICATION_KIND_ENUM,
  SUPPLIER_NAVIGATION_SEGMENTS, classifySupplierPath, supplierSegments, leafOf,
  loadOfficialCorpus, rankCandidates, mapSupplierCategories,
} from '../../lib/naver-categories.mjs';

const CORPUS = [
  { id: '50005167', name: '이어폰', wholeCategoryName: '디지털 > 음향기기 > 이어폰', last: true },
  { id: '50005168', name: '헤드폰', wholeCategoryName: '디지털 > 음향기기 > 헤드폰', last: true },
  { id: '50005200', name: '모니터링 스피커', wholeCategoryName: '디지털 > 음향기기 > 스피커 > 모니터링 스피커', last: true },
  { id: '50005201', name: '스피커', wholeCategoryName: '디지털 > 음향기기 > 스피커', last: true },
  { id: '50000001', name: '음향기기', wholeCategoryName: '디지털 > 음향기기', last: false },
];
const LEAVES = CORPUS.filter((row) => row.last);
const BRANDS = new Set(['apogee', 'klotz', 'shure', 'allenheath']);

test('every category path the library documents is in the adapter endpoint table', () => {
  const table = new Set(Object.values(NCOM_ENDPOINTS).map((endpoint) => endpoint.path));
  for (const endpoint of NAVER_CATEGORY_DOC.endpoints) {
    assert.ok(table.has(endpoint.path), `${endpoint.path} is cited as a contract path but the client cannot call it`);
    assert.equal(endpoint.method, 'GET', 'category reads are GETs; nothing in this lane writes');
    assert.equal(endpoint.auth, 'Bearer', 'the tree is not public — that is why the corpus is absent here');
    assert.match(endpoint.docUrl, /^https:\/\/apicenter\.commerce\.naver\.com\/docs\/commerce-api\/current\//);
  }
  assert.deepEqual(NAVER_CATEGORY_DOC.endpoints.map((e) => e.path).sort(),
    ['/v1/categories', '/v1/categories/{categoryId}', '/v1/categories/{categoryId}/sub-categories']);
  assert.equal(NAVER_CATEGORY_DOC.unconfirmed.length, 4, 'the four things this lane could not confirm stay named, not encoded as constants');
  assert.ok(NAVER_CATEGORY_DOC.unconfirmed.some((line) => line.startsWith('the category tree itself')));
});

test('the exceptional-category enum is the doc catalog, and glossed entries are a subset of it', () => {
  assert.equal(NAVER_EXCEPTIONAL_CATEGORY_ENUM.length, 34);
  assert.equal(new Set(NAVER_EXCEPTIONAL_CATEGORY_ENUM).size, 34, 'an enum value listed twice would hide a real gap');
  for (const key of Object.keys(NAVER_EXCEPTIONAL_CATEGORIES)) {
    assert.ok(NAVER_EXCEPTIONAL_CATEGORY_ENUM.includes(key), `${key} has a gloss but is not in the published enum`);
  }
  // The nine name-only values are the point: a leaf that returns one of them must
  // not be dropped, and nothing may claim a Korean label or an effect for them.
  assert.deepEqual(NAVER_EXCEPTIONAL_CATEGORY_NAMES_ONLY, ['ALCOHOL', 'BOOK_CHILD', 'VINTAGE_CITY', 'SEONE_AI_ASSISTANT_UNEXPOSE', 'GROUP_PRODUCT_MAX', 'DYNAMIC_PRICING_CONFIG', 'PREORDER_VALID_DATE', 'UNIT_PRICE', 'BUSINESSMALL_UNAVAILABLE']);
  assert.equal(NAVER_EXCEPTIONAL_CATEGORY_ENUM.length - NAVER_EXCEPTIONAL_CATEGORY_NAMES_ONLY.length, Object.keys(NAVER_EXCEPTIONAL_CATEGORIES).length);
  for (const value of NAVER_EXCEPTIONAL_CATEGORY_NAMES_ONLY) assert.ok(!(value in NAVER_EXCEPTIONAL_CATEGORIES));
  assert.deepEqual(NAVER_CERTIFICATION_KIND_ENUM, ['KC_CERTIFICATION', 'CHILD_CERTIFICATION', 'GREEN_PRODUCTS', 'CHEMICAL_CERTIFICATION', 'PARALLEL_IMPORT', 'OVERSEAS', 'ETC']);
});

test('a supplier path is classified from the catalogue, without a corpus', () => {
  const cases = [
    ['홈 > 브랜드별 보기 > H-K > KLOTZ', 'brand_index', 'brand_index_path'],
    ['APOGEE', 'brand_index', 'brand_index_path'],
    ['이어폰', 'product_classification', ''],
    ['홈 > 제품분류별 보기 > 프로 오디오 > 믹서', 'product_classification', ''],
    ['10% 할인 상품', 'promotion_page', 'promotion_page'],
    ['홈', 'navigation_only', 'navigation_only_path'],
    ['', 'navigation_only', 'navigation_only_path'],
  ];
  for (const [path, kind, reason] of cases) {
    const info = classifySupplierPath(path, { brands: ['shure'], brandValues: BRANDS });
    assert.equal(info.kind, kind, `${path} is a ${kind}`);
    assert.equal(info.reason, reason);
  }
  // A brand page reached through the PRODUCT index stays a product page: the
  // marker rule must not swallow `믹서` because some other path is a brand.
  assert.equal(classifySupplierPath('홈 > 제품분류별 보기 > 마이크 > Shure 마운트', { brandValues: BRANDS }).kind, 'product_classification');
  assert.equal(classifySupplierPath('HOME > 브랜드별 보기 > A-C > Allen&Heath', { brandValues: BRANDS }).leaf, 'Allen&Heath');
  assert.equal(supplierSegments('홈 > 제품분류별 보기 > 믹서').kept.join('>'), '믹서', 'navigation segments drop, product segments stay');
  assert.equal(leafOf('홈 > 프로 오디오 > 믹서'), '믹서');
  assert.ok(SUPPLIER_NAVIGATION_SEGMENTS.includes('홈'));
});

test('the corpus loader reads what the API prints and reports what it cannot use', () => {
  assert.deepEqual(loadOfficialCorpus('').rows, [], 'absent text is an empty corpus, not a crash');
  assert.equal(loadOfficialCorpus('').present, false);
  assert.equal(loadOfficialCorpus('').census.rows, 0, 'the census must exist even for an absent corpus');

  const json = loadOfficialCorpus(JSON.stringify(CORPUS));
  assert.equal(json.present, true);
  assert.equal(json.rows.length, 5);
  assert.equal(json.leaves.length, 4, 'only last=true rows can be chosen for registration');
  assert.deepEqual(json.census, { rows: 5, leaves: 4, distinct_ids: 5, non_digit_ids: 0 });

  // A pasted API response is wrapped; unwrapping it is not guessing at a shape.
  const wrapped = loadOfficialCorpus(JSON.stringify({ data: CORPUS, traceId: 'x' }));
  assert.equal(wrapped.rows.length, 5);
  assert.equal(loadOfficialCorpus(JSON.stringify({ message: 'no categories here' })).problems[0], 'corpus_shape_unrecognized');
  assert.equal(loadOfficialCorpus('{not json').problems[0], 'corpus_unparseable');

  const csv = loadOfficialCorpus(['id,wholeCategoryName,name,last', '50005167,디지털 > 이어폰,이어폰,true', '50000001,디지털,음향기기,false'].join('\n'));
  assert.equal(csv.rows.length, 2);
  assert.equal(csv.leaves.length, 1);

  const dirty = loadOfficialCorpus(JSON.stringify([
    { id: '', name: '이름만 있는 행', last: true },
    { id: '9001', name: '', last: true },
    { id: 'CAT-77', name: '문자 ID', last: true },
    { id: '9002', name: '이어폰', last: true },
    { id: '9002', name: '이어폰 중복', last: true },
  ]));
  assert.equal(dirty.rows.length, 2, 'rows with no id, no name, or a repeated id are out');
  assert.ok(dirty.problems.includes('row_without_id_or_name'));
  assert.ok(dirty.problems.includes('duplicate_id'));
  assert.ok(dirty.problems.includes('id_not_digits'));
  // The docs type `id` as string, so a non-digit id is kept and flagged rather than
  // silently dropped — dropping it would shrink the corpus the mapping claims to use.
  assert.ok(dirty.rows.some((row) => row.id === 'CAT-77'), 'a string id must survive the load');
  assert.equal(dirty.census.non_digit_ids, 1);
});

test('a leaf is only proposed when it clears the floor AND the margin over the runner-up', () => {
  const exact = rankCandidates('이어폰', LEAVES);
  assert.equal(exact.status, 'candidate');
  assert.equal(exact.candidates[0].id, '50005167');
  assert.ok(exact.candidates[0].evidence.includes('leaf_name_exact'));

  const twin = rankCandidates("이어폰", [...LEAVES, { id: "50005999", name: "이어폰", wholeCategoryName: "컴퓨터 > 이어폰", last: true }]);
  assert.equal(twin.status, 'ambiguous', 'two leaves that score alike must go to a human, not to the higher row');
  assert.equal(twin.reason, 'runner_up_within_margin');

  const weak = rankCandidates('3.5mm 커넥터', LEAVES);
  assert.equal(weak.status, 'unresolved');
  assert.ok(['best_below_min_score', 'no_lexical_overlap'].includes(weak.reason), `a connector is not an earphone: ${weak.reason}`);

  const noCorpus = rankCandidates('이어폰', []);
  assert.equal(noCorpus.status, 'unresolved');
  assert.equal(noCorpus.reason, 'corpus_absent');

  // The structural verdict outranks the corpus: fetching the tree must not be
  // presented as the thing that would have settled a brand page.
  const brandWithCorpus = rankCandidates('APOGEE', LEAVES, { pathInfo: classifySupplierPath('APOGEE', { brandValues: BRANDS }) });
  assert.equal(brandWithCorpus.reason, 'brand_index_path');
  assert.equal(brandWithCorpus.candidates.length, 0, 'a brand page gets no candidate even when candidates exist');
});

test('the catalogue map sums to the rows and cannot emit an id the corpus lacks', () => {
  const products = [
    { cgiId: 'P1', categoryPath: '이어폰', brand: 'SHURE' },
    { cgiId: 'P2', categoryPath: '홈 > 브랜드별 보기 > H-K > KLOTZ', brand: 'KLOTZ' },
    { cgiId: 'P3', categoryPath: '10% 할인 상품', brand: 'APOGEE' },
    { cgiId: 'P4', categoryPath: ' 믹서', brand: 'APOGEE' },
  ];
  const mapped = mapSupplierCategories({ products, corpus: CORPUS });
  assert.equal(mapped.census.products, 4);
  assert.equal(mapped.census.distinct_supplier_paths, 4);
  assert.equal(mapped.rows.length, products.length, 'every product keeps a row, resolved or not');
  assert.equal(mapped.census.invented_leaf_category_ids, 0);
  assert.equal(mapped.census.confirmed_products, 0, 'nothing in this lane may confirm a category');
  assert.equal(mapped.census.corpus_present, true);
  assert.equal(mapped.census.corpus_leaves, 4);
  assert.deepEqual(mapped.census.paths_by_kind, { product_classification: 2, brand_index: 1, promotion_page: 1 });
  assert.equal(mapped.census.products_by_kind.product_classification, 2);
  const byId = new Map(mapped.rows.map((row) => [row.cgiId, row]));
  assert.equal(byId.get('P1').proposedLeafCategoryId, '50005167');
  assert.equal(byId.get('P1').confirmed, false);
  for (const cgiId of ['P2', 'P3']) {
    assert.equal(byId.get(cgiId).status, 'unresolved');
    assert.equal(byId.get(cgiId).proposedLeafCategoryId, '', `${cgiId} is not a product classification, so it carries no id`);
  }
  assert.equal(byId.get('P4').status, 'unresolved', '믹서 overlaps no leaf in this corpus');
  // The path table and the product table must describe the same catalogue.
  const corpusIds = new Set(CORPUS.map((row) => row.id));
  for (const row of mapped.rows) if (row.proposedLeafCategoryId) assert.ok(corpusIds.has(row.proposedLeafCategoryId));
  assert.equal(mapped.paths.reduce((sum, row) => sum + row.products, 0), products.length);
  assert.deepEqual(mapped.paths.map((row) => row.path).sort(), products.map((row) => row.categoryPath).sort());

  const withoutCorpus = mapSupplierCategories({ products, corpus: [] });
  assert.equal(withoutCorpus.census.corpus_present, false);
  assert.equal(withoutCorpus.census.products_by_status.unresolved, 4);
  assert.deepEqual(withoutCorpus.census.paths_by_reason, { brand_index_path: 1, corpus_absent: 2, promotion_page: 1 },
    'the reason names what blocks each path, and only 2 of 4 were waiting on the corpus');
  assert.equal(withoutCorpus.census.proposed_products, 0);
});
