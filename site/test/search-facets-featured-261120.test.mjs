// 검색 결과 기준 필터 숫자, 0건 검색 안내(추천 검색어·관련 카테고리·전화), 첫 화면 추천(featured.json).
// 실제 cgi-catalog.js 함수를 전체 catalog.json 위에서 돌려 확인한다.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const SRC = read('site/assets/js/cgi-catalog.js');
const catalog = JSON.parse(read('site/data/catalog.json'));
const synonyms = JSON.parse(read('site/data/search_synonyms.json'));
const featuredIds = JSON.parse(read('site/data/featured.json'));
const COMPANY_SRC = read('website/assets/company.js');
const MAP_SRC = read('site/data/category_map.js');

function stub() {
  const el = {
    hidden: false, value: '', innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
    querySelector() { return stub(); }, querySelectorAll() { return []; }, appendChild() {}, removeChild() {}, closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }, scrollIntoView() {}, focus() {}, remove() {},
  };
  return el;
}
function boot() {
  const window = { addEventListener() {}, scrollTo() {}, setTimeout, clearTimeout, location: { hash: '', search: '', href: 'https://example.test/site/index.html' } };
  new Function('window', COMPANY_SRC)(window);
  new Function('window', MAP_SRC)(window);
  const document = { readyState: 'loading', getElementById() { return stub(); }, createElement() { return stub(); }, querySelector() { return stub(); }, querySelectorAll() { return []; }, body: stub(), addEventListener() {} };
  new Function('window', 'document', 'localStorage', 'fetch', 'location', 'setTimeout', 'requestAnimationFrame', SRC)(
    window, document, { getItem() { return null; }, setItem() {}, removeItem() {} },
    () => Promise.reject(new Error('no fetch in test')), window.location, setTimeout, (fn) => { fn(); });
  return window.cgiDebug;
}
const settle = () => new Promise((r) => setTimeout(r, 10));
async function ready() {
  const dbg = boot();
  await settle();
  dbg.applyCatalog(catalog);
  dbg.setState('searchSynonyms', synonyms);
  return dbg;
}
const route = (over) => ({ view: 'list', q: '', brands: [], cats: [], sites: [], sort: 'featured', page: 1, id: null, ...over });

test('1. 검색어가 있으면 필터 숫자는 검색 결과 기준, 합은 결과 건수와 같고 0건 항목은 없다', async () => {
  const dbg = await ready();
  const r = route({ q: '무선마이크' });
  dbg.setState('route', r);
  const list = dbg.filteredProducts();
  const f = dbg.facetCounts(r);
  assert.equal(f.scoped, true);
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(sum(f.brand), list.length, '브랜드 숫자 합 = 검색 결과 수');
  assert.equal(sum(f.cat), list.length, '카테고리 숫자 합 = 검색 결과 수');
  assert.ok(list.length > 20 && list.length < 400, `검색 결과 ${list.length}`);
  assert.ok(Object.values(f.brand).every((n) => n > 0), '0건 브랜드는 숨김');
  assert.ok(Object.keys(f.cat).length < 13, '관계없는 대분류는 빠진다');
  // 전체 기준과 비교: SHURE 는 전체 1,000건대이지만 검색 결과 기준은 그보다 훨씬 작다
  const all = dbg.facetCounts(route({}));
  assert.equal(all.scoped, false);
  assert.ok(f.brand.SHURE < all.brand.SHURE);
});

test('1. 고른 카테고리는 브랜드 숫자를, 고른 브랜드는 카테고리 숫자를 줄이고, 고른 항목은 0건이어도 남는다', async () => {
  const dbg = await ready();
  const base = dbg.facetCounts(route({ q: '무선마이크' }));
  const withCat = dbg.facetCounts(route({ q: '무선마이크', cats: ['마이크·무선'] }));
  assert.ok(Object.values(withCat.brand).reduce((a, b) => a + b, 0) <= Object.values(base.brand).reduce((a, b) => a + b, 0));
  assert.deepEqual(withCat.cat, base.cat, '카테고리 숫자는 자기 선택에 줄지 않는다');
  const odd = dbg.facetCounts(route({ q: '무선마이크', brands: ['존재하지않는브랜드'] }));
  assert.equal(odd.brand['존재하지않는브랜드'], 0, '고른 항목은 0으로 남아 해제할 수 있다');
});

test('2. "강당 스피커"는 0건이고, 추천 검색어는 결과가 있는 3~5개("스피커"·"PA 스피커" 포함)', async () => {
  const dbg = await ready();
  dbg.setState('route', route({ q: '강당 스피커' }));
  assert.equal(dbg.filteredProducts().length, 0);
  const sug = dbg.suggestQueries('강당 스피커');
  const qs = sug.map((s) => s.q);
  assert.ok(sug.length >= 3 && sug.length <= 5, qs.join(','));
  assert.equal(qs[0], '스피커', '용도어를 뺀 검색어가 먼저');
  assert.ok(qs.includes('PA 스피커'));
  assert.ok(sug.every((s) => s.count > 0));
  // 붙여 쓴 경우도
  assert.equal(dbg.suggestQueries('강당스피커')[0].q, '스피커');
  // 동의어: 핀마이크 → 라발리에
  assert.ok(dbg.suggestQueries('핀마이크 추천').some((s) => /라발리/.test(s.q)));
  // 어떤 추천도 결과가 없으면 빈 배열
  assert.deepEqual(dbg.suggestQueries('ㅁㄴㅇㄹ'), []);
});

test('2. 0건 화면: 다른 검색어 안내 + 추천 검색어 + 관련 카테고리 + 회사 전화', async () => {
  const dbg = await ready();
  const html = dbg.emptySearchHtml(route({ q: '강당 스피커' }));
  assert.match(html, /“강당 스피커” 검색 결과가 없습니다/);
  assert.match(html, /다른 검색어를 써 보세요/);
  assert.match(html, /추천 검색어/);
  assert.match(html, /data-suggest-query href="#\/products\?q=%EC%8A%A4%ED%94%BC%EC%BB%A4"/);
  assert.match(html, /관련 카테고리/);
  assert.match(html, /data-suggest-cat href="#\/products\?cat=%EC%8A%A4%ED%94%BC%EC%BB%A4"/, '스피커 대분류 바로가기');
  assert.match(html, /href="tel:0625768100"><strong>062\) 576-8100<\/strong>/);
});

test('2. 동의어 표는 20개 안팎이고 요청한 항목을 담는다', () => {
  assert.ok(synonyms.synonyms.length >= 18 && synonyms.synonyms.length <= 24, String(synonyms.synonyms.length));
  const find = (t) => synonyms.synonyms.find((row) => row.terms.includes(t));
  for (const t of ['강당', '교회', '학교', '행사']) assert.ok(find(t).suggest.includes('PA 스피커'), t);
  assert.ok(find('무선마이크').suggest.includes('무선 마이크'));
  assert.ok(find('무선 마이크'));
  assert.ok(find('핀마이크').suggest.some((s) => /라발리/.test(s)));
});

test('3. 첫 화면 추천은 featured.json 순서대로, 비면 기존 규칙', async () => {
  const dbg = await ready();
  dbg.setState('featuredIds', featuredIds);
  const picked = dbg.featuredFromFile(8).map((p) => p.id);
  assert.deepEqual(picked, featuredIds.slice(0, 8));
  dbg.setState('featuredIds', []);
  const fallback = dbg.featuredFromFile(8);
  assert.equal(fallback.length, 8, '파일이 비면 기존 규칙(pickFeatured)');
  dbg.setState('featuredIds', ['없는-id', featuredIds[0]]);
  const partial = dbg.featuredFromFile(8);
  assert.equal(partial[0].id, featuredIds[0], '없는 id 는 건너뛴다');
  assert.equal(partial.length, 8, '모자라면 기존 규칙으로 채운다');
});

test('3. 자동 선정 규칙: 가격 공개·재고 있음·리퍼 아님·10만 원 이상, 그룹 번갈아, 파일과 같은 결과', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'tools', 'build_featured.mjs')).href);
  const result = mod.selectFeatured(catalog.products, mod.loadMapCategory());
  const ids = mod.interleave(result);
  assert.deepEqual(ids, featuredIds, 'featured.json 은 생성기 결과와 같다(손으로 고치면 이 시험을 갱신)');
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  for (const id of ids) {
    const p = byId.get(id);
    assert.ok(mod.eligible(p), id);
    assert.equal(p.price.state, 'public');
    assert.ok(p.price.value >= mod.MIN_PRICE);
    assert.ok(!mod.DEMOTE_RE.test(p.name));
    assert.ok(['in', 'untracked'].includes(mod.stockState(p)));
  }
  const byGroup = Object.fromEntries(result.map((r) => [r.group.id, r.picks.length]));
  assert.deepEqual(byGroup, { 'wireless-mic': 3, 'pa-speaker': 3, mixer: 2, amplifier: 0, 'conference-mic': 0 });
  // 재고 판정
  assert.equal(mod.stockState({ availability: '{"stock_number_displayed": "0", "use_stock": true}' }), 'out');
  assert.equal(mod.stockState({ availability: '{"stock_number_displayed": "3", "use_stock": true}' }), 'in');
  assert.equal(mod.stockState({ availability: '{"stock_number_displayed": "0", "use_stock": false}' }), 'untracked');
  assert.equal(mod.stockState({ availability: '{"stock_number_displayed": null, "use_stock": null}' }), null);
});

test('3. 고정 추천은 추천순 맨 앞에 featured.json 순서로, 그 뒤 첫 24개에 같은 브랜드가 더 끼지 않는다', async () => {
  const dbg = boot();
  await settle();
  dbg.setState('featuredIds', featuredIds);
  dbg.applyCatalog(catalog); // computeSortAux 가 고정 추천을 브랜드 앞 순번으로 센다
  const sorted = dbg.__products ? dbg.__products : null;
  const r = route({});
  dbg.setState('route', r);
  const list = dbg.filteredProducts();
  assert.deepEqual(list.slice(0, featuredIds.length).map((p) => p.id), featuredIds, '고정 추천이 맨 앞, 파일 순서');
  const first24 = list.slice(0, 24);
  const pinnedByBrand = {};
  first24.slice(0, featuredIds.length).forEach((p) => { pinnedByBrand[p._brand] = (pinnedByBrand[p._brand] || 0) + 1; });
  const counts = {};
  first24.forEach((p) => { counts[p._brand] = (counts[p._brand] || 0) + 1; });
  for (const [brand, n] of Object.entries(counts)) {
    assert.ok(n <= Math.max(2, pinnedByBrand[brand] || 0), `${brand} ${n}건 (고정 ${pinnedByBrand[brand] || 0})`);
  }
  void sorted;
});
