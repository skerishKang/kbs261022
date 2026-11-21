// 카탈로그 데이터 품질(2026-11-20, AI 명예회원 1회차: "같은 상품이 두 번", "스피커 추천순 맨 위가
// 리퍼·박스손상") 회귀 시험. 생성물(catalog.json·product_merge.js·category_map.js)을 직접 검사한다.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const catalog = JSON.parse(read('site/data/catalog.json'));
const products = JSON.parse(read('site/data/products.json'));
const catalogJs = read('site/assets/js/cgi-catalog.js');
const byId = new Map(catalog.products.map((p) => [p.id, p]));
const sourceById = new Map(products.map((p) => [p.id, p]));

const mergeWin = {};
new Function('window', read('site/data/product_merge.js'))(mergeWin);
const MERGE = mergeWin.CGI_PRODUCT_MERGE;

// 사이트의 실제 categoryLabel·mapCategory 를 그대로 떼어 와 쓴다.
function grab(name) {
  const s = catalogJs.indexOf(`function ${name}(`);
  let d = 0, i = catalogJs.indexOf('{', s);
  for (; i < catalogJs.length; i++) { if (catalogJs[i] === '{') d++; else if (catalogJs[i] === '}' && --d === 0) break; }
  return catalogJs.slice(s, i + 1);
}
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(read('site/data/category_map.js'), ctx);
vm.runInContext(`var CAT_MAP = window.CGI_CATEGORY_MAP; ${grab('categoryLabel')}\n${grab('mapCategory')}\nthis.cat = function (p) { return mapCategory(categoryLabel(p), p.name); }; this.label = categoryLabel;`, ctx);

const nameKey = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z가-힣]/g, '');
const CONDITION_WORD = /리퍼|전시|박스손상/;

test('남은 상품의 id·가격·이름·사진은 원본(products.json)과 같다 — 가격 변경 0건', () => {
  let checked = 0;
  for (const p of catalog.products) {
    const src = sourceById.get(p.id);
    assert.ok(src, `원본에 없는 id: ${p.id}`);
    assert.deepEqual(p.price, src.price, `가격이 바뀌었다: ${p.id}`);
    checked++;
  }
  assert.equal(checked, 4002);
  // 서버 결제 가격표도 원본 공개 가격과 같다
  const idx = read('backend/data/price_index.mjs').match(/export const PRICE_INDEX = (\{.*?\});\r?\n/s);
  const PRICE_INDEX = JSON.parse(idx[1]);
  for (const p of products) {
    if (p.price && p.price.state === 'public' && typeof p.price.value === 'number') {
      assert.equal(PRICE_INDEX[p.id] && PRICE_INDEX[p.id].p, p.price.value, `가격표 불일치: ${p.id}`);
    }
  }
});

test('병합: 544쌍(모델명 520 + 상품명 완전 일치 24), 없어진 상품은 모두 가격 문의였고 리퍼·전시·박스손상은 없다', () => {
  assert.equal(Object.keys(MERGE).length, 544);
  for (const [removed, kept] of Object.entries(MERGE)) {
    const r = sourceById.get(removed), k = byId.get(kept);
    assert.ok(r && k, `${removed} → ${kept}`);
    assert.notEqual(r.price.state, 'public', `가격 공개 상품이 없어졌다: ${removed}`);
    assert.equal(k.price.state, 'public', `남긴 쪽이 가격 공개가 아니다: ${kept}`);
    assert.ok(!CONDITION_WORD.test(r.name) && !CONDITION_WORD.test(sourceById.get(kept).name), `상태 표시 상품 병합: ${removed} → ${kept}`);
  }
  // 상품명 완전 일치로 합친 쌍(대표 예): 같은 이름이 두 공급처에 가격 공개·가격 문의로 따로 있었다
  const ksm40 = Object.entries(MERGE).find(([r]) => /KSM40C/.test(sourceById.get(r).name));
  assert.ok(ksm40, 'SHURE KSM40C 중복이 합쳐졌다');
  assert.equal(nameKey(sourceById.get(ksm40[0]).name), nameKey(sourceById.get(ksm40[1]).name));
  // 같은 정리 브랜드 + 같은 상품명(한글 포함)의 가격 공개 1·가격 문의 1 짝이 더 남아 있지 않다
  const pub = new Map(), inq = new Map();
  for (const p of catalog.products) {
    const key = (p.brand_norm || '') + '|' + nameKey(p.name);
    if (nameKey(p.name).length < 4 || !p.brand_norm || p.brand_norm === '기타') continue;
    const m = p.price.state === 'public' ? pub : inq;
    m.set(key, (m.get(key) || 0) + 1);
  }
  const left = [...inq.entries()].filter(([k, n]) => n === 1 && pub.get(k) === 1)
    .filter(([k]) => !catalog.products.some((p) => (p.brand_norm + '|' + nameKey(p.name)) === k && CONDITION_WORD.test(p.name)));
  assert.deepEqual(left, []);
});

test('병합으로 없어진 주소는 남긴 상품으로 이동한다', () => {
  assert.match(catalogJs, /var mergeMap = window\.CGI_PRODUCT_MERGE \|\| \{\};/);
  for (const kept of Object.values(MERGE)) assert.ok(byId.has(kept));
});

test('대분류: 레코딩 분류의 소프트웨어 번들은 소프트웨어, 믹서·스피커 가방·커버는 액세서리', () => {
  const softwareBundles = catalog.products.filter((p) => ctx.label(p) === '레코딩' && /Bundle|번들|Suite|구독권|가상악기/.test(p.name));
  assert.ok(softwareBundles.length >= 40, '레코딩 분류에 섞인 번들이 시험 대상에 있다');
  for (const p of softwareBundles) assert.equal(ctx.cat(p), '소프트웨어·플러그인', p.name);
  for (const p of catalog.products.filter((x) => ctx.label(x) === '레코딩/음향' && /백팩|Backpack|숄더 백|소프트 케이스|용 커버/.test(x.name))) {
    assert.equal(ctx.cat(p), '액세서리·소모품', p.name);
  }
  // 범위 밖은 그대로: 다른 분류의 하드웨어 "번들", 커버 무료증정 믹서 본체, 디지털 믹서, 정확히 '디지털'(이더콘)
  const apogee = catalog.products.find((p) => /APOGEE 프리미엄 마이크 아포지 액세서리 번들/.test(p.name));
  if (apogee) assert.notEqual(ctx.cat(apogee), '소프트웨어·플러그인');
  const coverPromo = catalog.products.find((p) => /^\[커버 무료증정\] PreSonus StudioLive 16\.0\.2/.test(p.name));
  assert.ok(coverPromo); assert.equal(ctx.cat(coverPromo), '믹서·프로세서');
  for (const p of catalog.products.filter((x) => ctx.label(x) === '디지털 믹서')) assert.equal(ctx.cat(p), '믹서·프로세서', p.name);
  for (const p of catalog.products.filter((x) => ctx.label(x) === '디지털')) assert.equal(ctx.cat(p), '케이블·커넥터', p.name);
});

test('대분류별 건수(재생성 기준값)', () => {
  const counts = {};
  for (const p of catalog.products) { const c = ctx.cat(p); counts[c] = (counts[c] || 0) + 1; }
  assert.deepEqual(counts, {
    '마이크·무선': 498, '스피커': 550, '이어폰·헤드폰': 87, '케이블·커넥터': 609, '레코딩·인터페이스': 343,
    '소프트웨어·플러그인': 356, '믹서·프로세서': 101, '네트워크·회의영상': 79, '악기·앰프': 473,
    '스탠드·거치': 146, '액세서리·소모품': 604, '음향 튜닝·방음': 97, '특가·기획': 59,
  });
});

test('검색 잡음: search_text 에 구매방법·배송주기 문구가 없다', () => {
  const noise = catalog.products.filter((p) => /1회구매|정기배송|배송주기/.test(p.search_text));
  assert.deepEqual(noise.map((p) => p.id), []);
});

test('추천순: 리퍼·박스손상·전시·단종·클리어런스 상품은 같은 조건 상품 뒤로(검색 관련도순 포함)', () => {
  assert.match(catalogJs, /var DEMOTE_RE = \/리퍼\|박스손상\|전시\|단종\|클리어런스\/;/);
  assert.match(catalogJs, /p\._demoted = DEMOTE_RE\.test\(String\(p\.name \|\| ''\)\);/);
  const sortBlock = catalogJs.slice(catalogJs.indexOf('list.sort(function (a, b) {'));
  assert.match(sortBlock, /^list\.sort\(function \(a, b\) \{\s*\/\/[^\n]*\n\s*if \(sort === 'featured'\) \{\s*var dd = \(a\._demoted \? 1 : 0\) - \(b\._demoted \? 1 : 0\);\s*if \(dd\) return dd;/);
  assert.match(sortBlock, /return sort === 'featured' \? featuredCompare\(a, b\) : recentCompare\(a, b\);/, '관련도 동점은 추천순 기준');
  // 목록·검색에서는 빠지지 않는다(필터 단계에 _demoted 없음)
  const filter = catalogJs.slice(catalogJs.indexOf('function filteredProducts'), catalogJs.indexOf('list.sort(function (a, b) {'));
  assert.doesNotMatch(filter, /_demoted/);
});

test('상세 분할 파일은 목록 생성 시각을 붙여 받는다(재생성 후 옛 캐시와 섞이지 않게)', () => {
  assert.match(catalogJs, /key \+ stamp/);
  assert.equal(catalog.meta.detail_parts, 41);
  assert.ok(catalog.meta.generated_at);
});
