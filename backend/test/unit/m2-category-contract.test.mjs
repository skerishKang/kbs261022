// M2 사전개발 — 카테고리 매핑 계약 테스트 (mock 코퍼스, 네트워크 없음).
//
// 계약의 핵심은 "확인되지 않은 리프 ID 는 절대 나오지 않는다" 이다. 실제 코퍼스는
// 판매자 토큰이 있어야만 얻을 수 있고(GET /v1/categories), 이 레인은 인증이 금지돼
// 있으므로 테스트는 공식 응답 '형태'를 흉내 낸 mock 코퍼스로 고정한다:
//
//   1. 코퍼스 로드 — 감싼 응답({data:[...]}) 해제, last=true 만 리프, 비숫자 id 는
//      버리지 않고 표시, 중복 id 는 건너뛴다.
//   2. 구조 판정 — 브랜드/프로모션/내비게이션 경로는 코퍼스가 있어도 매핑하지 않는다.
//   3. 후보 판정 — 상품 분류 경로만 점수화되고, 후보 id 는 코퍼스에서 복사된다
//      (invented=0), 근소한 2위는 사람에게 넘긴다(ambiguous), 바닥 점수 미달은
//      후보를 보여주되 매핑하지 않는다.
//   4. 확정 — 어떤 행도 confirmed=true 가 될 수 없다(운영자 확인 전).
//
//   node --test test/unit/m2-category-contract.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NAVER_CATEGORY_DOC,
  classifySupplierPath,
  loadOfficialCorpus,
  mapSupplierCategories,
  rankCandidates,
} from '../../lib/naver-categories.mjs';
import { NCOM_ENDPOINTS } from '../../lib/ncommerce.mjs';

// GET /v1/categories 가 돌려주는 '형태'의 mock 코퍼스. 값은 오디오 카테고리의
// 모양을 흉내 낸 것이며 실제 네이버 분류체계의 인용이 아니다 — 이 테스트가
// 고정하는 것은 id·경로·last 의 계약이지 특정 id 의 실재가 아니다.
const MOCK_CATEGORIES = [
  { id: '50000000', wholeCategoryName: '홈 > 음악기기 > 음향기기 > 헤드폰', name: '헤드폰', last: true },
  { id: '50000001', wholeCategoryName: '홈 > 음악기기 > 음향기기 > 이어폰', name: '이어폰', last: true },
  { id: '50000002', wholeCategoryName: '홈 > 음악기기 > 음향기기 > 스피커', name: '스피커', last: true },
  { id: '50000003', wholeCategoryName: '홈 > 음악기기 > 음향기기 > 스피커 > 모니터링 스피커', name: '모니터링 스피커', last: true },
  { id: '50000004', wholeCategoryName: '홈 > 음악기기 > 악기 > 기타', name: '기타', last: true },
  { id: '50000009', wholeCategoryName: '홈 > 음악기기 > 음향기기', name: '음향기기', last: false },
];

const PRODUCTS = [
  { cgiId: 'mock:0001', categoryPath: '이어폰', brand: 'SHURE' },
  { cgiId: 'mock:0002', categoryPath: '홈 > 제품분류별 보기 > 스피커 > 모니터링 스피커', brand: 'APOGEE' },
  { cgiId: 'mock:0003', categoryPath: '홈 > 브랜드별 보기 > H-K > KLOTZ', brand: 'KLOTZ' },
  { cgiId: 'mock:0004', categoryPath: '10% 할인 상품', brand: 'SHURE' },
  { cgiId: 'mock:0005', categoryPath: '전체', brand: 'SHURE' },
];

const loaded = (text, options) => loadOfficialCorpus(text, options);

test('mock corpus: wrapped response is unwrapped, only last=true rows become leaves', () => {
  const corpus = loaded(JSON.stringify({ data: MOCK_CATEGORIES }));
  assert.equal(corpus.present, true);
  assert.equal(corpus.rows.length, 6);
  assert.equal(corpus.leaves.length, 5, '음향기기(last=false) 는 리프가 아니다');
  assert.equal(corpus.census.distinct_ids, 6);
  assert.equal(corpus.census.non_digit_ids, 0);
  assert.deepEqual(corpus.problems, []);
});

test('mock corpus: an id that is not digits is kept and flagged, never dropped', () => {
  const corpus = loaded(JSON.stringify([{ id: 'CAT-01', wholeCategoryName: '홈 > 테스트', name: '테스트', last: true }]));
  assert.equal(corpus.present, true);
  assert.equal(corpus.rows.length, 1, '리프가 아닌 id 형식 때문에 행을 버리면 코퍼스가 조용히 줄어든다');
  assert.deepEqual(corpus.problems, ['id_not_digits']);
});

test('mock corpus: duplicate ids are skipped and reported', () => {
  const corpus = loaded(JSON.stringify([
    { id: '50000001', name: '이어폰', last: true },
    { id: '50000001', name: '이어폰(중복)', last: true },
  ]));
  assert.equal(corpus.rows.length, 1);
  assert.deepEqual(corpus.problems, ['duplicate_id']);
});

test('mock corpus: absent corpus stays absent — the state of this repository today', () => {
  const corpus = loaded('');
  assert.equal(corpus.present, false);
  assert.equal(corpus.reason, 'corpus file absent or empty');
  assert.deepEqual(corpus.leaves, []);
});

test('structure beats corpus: brand, promotion and navigation paths never map, even with the tree in hand', () => {
  const cases = [
    ['홈 > 브랜드별 보기 > H-K > KLOTZ', 'KLOTZ', 'brand_index', 'brand_index_path'],
    ['10% 할인 상품', 'SHURE', 'promotion_page', 'promotion_page'],
    ['전체', 'SHURE', 'navigation_only', 'navigation_only_path'],
  ];
  for (const [path, brand, kind, reason] of cases) {
    const info = classifySupplierPath(path, { brands: [brand], brandValues: new Set([brand.toLowerCase()]) });
    assert.equal(info.kind, kind, path);
    const verdict = rankCandidates(path, loaded(JSON.stringify(MOCK_CATEGORIES)).leaves, { pathInfo: info });
    assert.equal(verdict.status, 'unresolved', path);
    assert.equal(verdict.reason, reason, path);
    assert.deepEqual(verdict.candidates, [], `${path}: 후보 자체를 만들지 않는다`);
  }
});

test('product paths get a candidate copied out of the corpus, with evidence, and stay unconfirmed', () => {
  const corpus = loaded(JSON.stringify({ data: MOCK_CATEGORIES }));
  const mapped = mapSupplierCategories({ products: PRODUCTS, corpus: corpus.rows });
  const byId = new Map(mapped.rows.map((row) => [row.cgiId, row]));

  const earphone = byId.get('mock:0001');
  assert.equal(earphone.status, 'candidate');
  assert.equal(earphone.proposedLeafCategoryId, '50000001');
  assert.match(earphone.leafEvidence, /leaf_name_exact/);
  assert.equal(earphone.confirmed, false, '운영자 확인 전에는 확정될 수 없다');

  const monitor = byId.get('mock:0002');
  assert.equal(monitor.status, 'candidate');
  assert.equal(monitor.proposedLeafCategoryId, '50000003');

  assert.equal(mapped.census.invented_leaf_category_ids, 0, '코퍼스에 없는 id 는 절대 제안되지 않는다');
  assert.equal(mapped.census.confirmed_products, 0);
  assert.ok(mapped.rows.every((row) => row.confirmed === false));
});

test('every proposed id is exactly one of the corpus ids (invented guard over the whole catalogue)', () => {
  const corpus = loaded(JSON.stringify({ data: MOCK_CATEGORIES }));
  const corpusIds = new Set(corpus.leaves.map((leaf) => leaf.id));
  const mapped = mapSupplierCategories({ products: PRODUCTS, corpus: corpus.rows });
  for (const row of mapped.rows) {
    if (row.proposedLeafCategoryId) assert.ok(corpusIds.has(row.proposedLeafCategoryId), row.cgiId);
  }
});

test('two leaves that score alike go to a human instead of a coin flip', () => {
  const corpus = loaded(JSON.stringify([
    { id: '60000001', wholeCategoryName: '스피커 스탠드', name: '스피커 스탠드', last: true },
    { id: '60000002', wholeCategoryName: '스피커 브래킷', name: '스피커 브래킷', last: true },
  ]));
  const verdict = rankCandidates('스피커', corpus.leaves, { pathInfo: classifySupplierPath('스피커') });
  assert.equal(verdict.status, 'ambiguous');
  assert.equal(verdict.reason, 'runner_up_within_margin');
  assert.equal(verdict.candidates.length, 2, '두 후보를 모두 보여주고 결정은 사람에게 넘긴다');
});

test('a weak lexical overlap stays below the floor and is reported with its candidates', () => {
  // '거치대' 는 경로 어느 곳에도 부분문자열이 아니고, 공유 토큰 '마이크' 하나뿐이라
  // 자카드 1/8 → 0.075 점. 바닥(0.5) 미달이지만 후보 자체는 보여준다.
  const corpus = loaded(JSON.stringify([
    { id: '60000010', wholeCategoryName: '마이크 거치대', name: '거치대', last: true },
  ]));
  const verdict = rankCandidates('홈 > 제품분류별 보기 > 프로 오디오 > 마이크 스탠드 액세서리', corpus.leaves);
  assert.equal(verdict.status, 'unresolved');
  assert.equal(verdict.reason, 'best_below_min_score');
  assert.equal(verdict.candidates.length, 1);
  assert.ok(verdict.candidates[0].score < 0.5);
});

test('no shared token is named as such, never as a low-confidence match', () => {
  const corpus = loaded(JSON.stringify(MOCK_CATEGORIES));
  const verdict = rankCandidates('케이블', corpus.leaves);
  assert.equal(verdict.status, 'unresolved');
  assert.equal(verdict.reason, 'no_lexical_overlap');
  assert.deepEqual(verdict.candidates, []);
});

test('minScore is honoured as a contract option, not hardcoded luck', () => {
  const corpus = loaded(JSON.stringify([
    { id: '60000010', wholeCategoryName: '마이크 거치대', name: '거치대', last: true },
  ]));
  const path = '홈 > 제품분류별 보기 > 프로 오디오 > 마이크 스탠드 액세서리';
  // 같은 점수(≈0.075)라도 옵션에 따라 판정이 달라진다 — 옵션이 계약의 일부라는 뜻.
  // margin 0.05 는 0점(후보 없음)과의 간격 0.075 보다 작아 후보로 통과한다.
  assert.equal(rankCandidates(path, corpus.leaves, { minScore: 0.05, margin: 0.05 }).status, 'candidate');
  const strict = rankCandidates(path, corpus.leaves, { minScore: 0.2 });
  assert.equal(strict.status, 'unresolved');
  assert.equal(strict.reason, 'best_below_min_score');
});

test('the category doc names the same three endpoints the client table can call', () => {
  for (const entry of NAVER_CATEGORY_DOC.endpoints) {
    const clientEntry = NCOM_ENDPOINTS[entry.id];
    assert.ok(clientEntry, `NCOM_ENDPOINTS.${entry.id} 가 없다`);
    assert.equal(clientEntry.path, entry.path);
    assert.equal(clientEntry.method, entry.method);
  }
  assert.equal(NAVER_CATEGORY_DOC.unconfirmed.length > 1, true);
  assert.match(NAVER_CATEGORY_DOC.unconfirmed.join(' '), /category tree itself/);
});
