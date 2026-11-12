// 이슈 #213 D1~D4 회귀 — 정렬·목록 탐색·상세 수량·브랜드 표기.
//
//   D1  추천순 정렬 키: 고정 추천(featured.json) → 대표 상품 → 브랜드 안 순번(가격 높은 순)
//       → 대분류 우선순위 → 브랜드 상품 수 → 이름. 실제 정렬 함수를 실행해
//       첫 24개에 같은 브랜드 2개 이하를 고정한다.
//   D2  한 쪽 24개, 처음·끝 이동, "현재 쪽 / 전체 쪽" 표시.
//   D3  상세 담기 버튼 위 수량(−/＋, 기본 1) — 담기·견적 요청이 같은 값을 쓴다.
//   D4  브랜드 별칭 합침(K&M·AGS·TUTTLE GUITARS), 비브랜드 값은 "기타"로 묶어 맨 아래.
//
//   node --test site/test/cgi-catalog2-213.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const SRC = read('site/assets/js/cgi-catalog.js');
const catalog = JSON.parse(read('site/data/catalog.json'));
const brandsJson = JSON.parse(read('site/data/brands.json'));
const featured = JSON.parse(read('site/data/featured.json'));

/* ------------------------- 부트(실제 함수 실행) ------------------------- */

function stubElement() {
  const el = {
    hidden: false, disabled: false, value: '', checked: false, className: '',
    attrs: {}, listeners: {}, innerHTML: '', textContent: '', style: {},
    addEventListener() {}, dispatch() {}, getAttribute() { return null; },
    setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
    querySelector() { return stubElement(); }, querySelectorAll() { return []; },
    appendChild() {}, removeChild() {}, closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    scrollIntoView() {}, focus() {}, remove() {},
  };
  return el;
}

function boot() {
  const window = {
    addEventListener() {}, scrollTo() {}, setTimeout, clearTimeout,
    location: { hash: '', search: '', href: 'https://skerishkang.github.io/site/index.html' },
  };
  const document = {
    readyState: 'loading',
    getElementById() { return stubElement(); },
    createElement() { return stubElement(); },
    querySelector() { return stubElement(); },
    querySelectorAll() { return []; },
    body: stubElement(),
    addEventListener() {},
  };
  new Function('window', 'document', 'localStorage', 'fetch', 'location', 'setTimeout', 'requestAnimationFrame', SRC)(
    window, document,
    { getItem() { return null; }, setItem() {}, removeItem() {} },
    () => Promise.reject(new Error('no fetch in test')),
    window.location, setTimeout, (fn) => { fn(); });
  window.cgiDebug.__window = window;
  return window.cgiDebug;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

/* --------------------------------- D1 --------------------------------- */

test('D1: featured.json은 상품 id 배열이고 지금은 비어 있다', () => {
  assert.ok(Array.isArray(featured));
});

test('D1: 실제 추천순 정렬에서 첫 24개에 같은 브랜드는 2개 이하다', async () => {
  const dbg = boot();
  await settle();
  dbg.applyCatalog(catalog);
  await settle();
  const prepared = dbg.__window.CGI_PRODUCTS; // prepare() 가 _brandSeq 를 매글 복사본
  const sorted = prepared.slice().sort(dbg.featuredCompare);
  const first24 = sorted.slice(0, 24);
  const counts = {};
  first24.forEach((p) => {
    counts[p._brand] = (counts[p._brand] || 0) + 1;
  });
  const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  assert.ok(worst[1] <= 2, '같은 브랜드 ' + worst[1] + '개(' + worst[0] + ')가 첫 쪽에 몰린다');
});

test('D1: 상태 태그·무가격 상품은 추천순 뒤로 밀린다', async () => {
  const dbg = boot();
  await settle();
  dbg.applyCatalog(catalog);
  await settle();
  const prepared = dbg.__window.CGI_PRODUCTS;
  const sorted = prepared.slice().sort(dbg.featuredCompare);
  const head = sorted.slice(0, 24).map((p) => p.name);
  assert.ok(!head.some((n) => /\[(리퍼비쉬|단순개봉|전시상품|박스손상)\]/.test(n)),
    '상태 태그 상품이 첫 쪽에 나온다');
  assert.ok(sorted.slice(0, 24).every((p) => p.price && p.price.state === 'public' && p.images.length),
    '첫 쪽은 이미지·공개가가 있는 대표 상품이다');
});

test('D1: 대분류 우선순위는 스피커가 첫이고 13개 대분류 순서를 그대로 가진다', async () => {
  const dbg = boot();
  await settle();
  assert.equal(dbg.CATEGORY_ORDER[0], '스피커');
  assert.equal(dbg.CATEGORY_ORDER.length, 13);
});

test('D1: 홈 카테고리 칩·필터는 대분류 우선순위 순서로 나열된다', async () => {
  const dbg = boot();
  await settle();
  dbg.applyCatalog(catalog);
  await settle();
  const counts = {};
  catalog.products.forEach((p) => {
    // prepare() 가 매기는 대분류는 mapCategory 결과다 — 여기서는 카테고리명 기준으로만 확인.
    const c = p.category && p.category.name;
    if (c) counts[c] = (counts[c] || 0) + 1;
  });
  const ordered = dbg.orderedCategoryValues(counts, []);
  const orders = ordered.map((c) => dbg.CATEGORY_ORDER.indexOf(c));
  const known = orders.filter((i) => i !== -1);
  assert.deepEqual(known, known.slice().sort((a, b) => a - b),
    '대분류 우선순위 순서가 깨졌다: ' + ordered.join(', '));
});

/* --------------------------------- D2 --------------------------------- */

test('D2: 한 쪽은 24개고 처음·끝 이동과 쪽 표시가 있다', () => {
  assert.match(SRC, /var PER_PAGE = 24;/);
  assert.match(SRC, /aria-label="첫 쪽"/);
  assert.match(SRC, /aria-label="끝 쪽"/);
  assert.match(SRC, /page-indicator/);
  assert.match(SRC, /\+ total \+ '쪽/);
});

/* --------------------------------- D3 --------------------------------- */

test('D3: 상세 담기 버튼 위에 수량 스테퍼가 있고 담기·견적 요청이 그 값을 쓴다', () => {
  assert.match(SRC, /id="detailQty" value="1"/);
  assert.match(SRC, /data-action="qty-step" data-detail-qty-step="-1"/);
  assert.match(SRC, /data-action="qty-step" data-detail-qty-step="1"/);
  // 수량 행이 CTA 버튼들보다 먼저 나온다.
  assert.ok(SRC.indexOf('qty-row') < SRC.indexOf('견적 요청하기'), '수량 행은 담기 버튼 위다');
  assert.match(SRC, /addToQuoteCart\(productId, readDetailQty\(\)\)/);
  assert.match(SRC, /addToQuoteCart\(productId, readDetailQty\(\), true\)/);
  assert.match(SRC, /Math\.min\(999, Math\.max\(1,/);
});

/* --------------------------------- D4 --------------------------------- */

const FORBIDDEN_BRANDS = ['K&M', 'AGS', 'TUTTLE GUITARS', '자체제작', '브랜드 미확인', '안전사', '자체브랜드'];

test('D4: catalog.json 브랜드는 별칭이 합쳐지고 비브랜드 값이 없다', () => {
  const set = new Set(catalog.products.map((p) => (p.brand_norm || '').trim()).filter(Boolean));
  for (const bad of FORBIDDEN_BRANDS) {
    assert.ok(!set.has(bad), '브랜드 필터에 남아 있다: ' + bad);
  }
  assert.ok(set.has('KÖNIG & MEYER'), 'K&M 은 KÖNIG & MEYER 로 합쳐진다');
  assert.ok(set.has('ACOUSTIC GROVE SYSTEM'), 'AGS 는 ACOUSTIC GROVE SYSTEM 으로 합쳐진다');
  assert.ok(set.has('MICHAEL TUTTLE GUITARS'), 'TUTTLE GUITARS 는 MICHAEL TUTTLE GUITARS 로 합쳐진다');
  assert.ok(set.has('기타'), '비브랜드 값은 기타로 묶인다');
});

test('D4: brands.json은 catalog.json 브랜드 집합과 같고 기타는 맨 아래다', () => {
  const catSet = new Set(catalog.products.map((p) => (p.brand_norm || '').trim()).filter(Boolean));
  const fileSet = new Set(brandsJson.brands.map((b) => b.name));
  assert.equal(brandsJson.brands.length, catSet.size);
  for (const name of catSet) assert.ok(fileSet.has(name), 'brands.json에 없다: ' + name);
  assert.equal(brandsJson.brands[brandsJson.brands.length - 1].name, '기타');
});

test('D4: 쇼핑몰 통계와 홈페이지 브랜드 수가 같다(기타 제외)', () => {
  const realBrands = new Set(catalog.products.map((p) => (p.brand_norm || '').trim()).filter((b) => b && b !== '기타'));
  // 홈페이지: brands.json(기타 제외) + config 정적 목록(마스터에 없는 것만 추가)
  const cfgSrc = read('website/assets/config.js');
  const win = {};
  new Function('window', cfgSrc)(win);
  const CFG = win.CGI_CONFIG || win.CFG;
  const staticMissing = CFG.brands.filter((s) => !realBrands.has(s.toUpperCase()));
  assert.equal(realBrands.size, brandsJson.brands.length - 1, 'brands.json은 기타 1개를 더 가진다');
  assert.equal(staticMissing.length, 0, '정적 브랜드 목록에 마스터에 없는 이름이 있다: ' + staticMissing.join(', '));
  assert.equal(realBrands.size, 55, '쇼핑몰·홈페이지 공통 브랜드 수 (#216 G1 로 57 → 55)');
});

test('D4: 원본 products.json 은 불변이고 별칭 원래 값이 남아 있다', () => {
  const original = JSON.parse(read('site/data/products.json'));
  const km = original.filter((p) => (p.brand_norm || '') === 'K&M' || (p.brand || '').toUpperCase() === 'K&M');
  assert.ok(km.length > 0, '원본 products.json 의 K&M 표기가 남아 있어야 한다');
});
