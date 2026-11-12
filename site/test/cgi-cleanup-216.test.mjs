// 이슈 #216 G1·G4·H1~H6 회귀 — 카탈로그 데이터 정리와 화면 다듬기.
//
//   G1  결제창·잔금·계약금 페이지 29건은 카탈로그에서 뺐다
//   G4  search_text 에 구매방법·배송주기 값이 없다 ("할인" 검색 잡음 제거)
//   H1  PC 머리글 검색칸 200px 이상 (홈 메뉴 제거·영문 부제 정리)
//   H2  홈페이지 "대리점" 영역의 작업 메모 문구 삭제
//   H3  브랜드 개수는 '기타'를 뺀 수로 통일, 묶음 상품 브랜드 줄은 빈칸, 필터명 "그 외"
//   H4  홈 통계 카드 3칸 한 줄
//   H5  휴대폰 공지줄 글자를 점 바로 뒤 왼쪽 정렬
//   H6  홈페이지 12px 미만 글씨 없음
//
//   node --test site/test/cgi-cleanup-216.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const catalog = JSON.parse(read('site/data/catalog.json'));
const brands = JSON.parse(read('site/data/brands.json'));
const catalogJs = read('site/assets/js/cgi-catalog.js');
const css = read('site/assets/css/cgi-catalog.css');
const indexHtml = read('site/index.html');
const companyJs = read('website/assets/company.js');
const configJs = read('website/assets/config.js');
const webCss = read('website/assets/style.css');

/* --------------------------------- G1 --------------------------------- */

test('G1: 결제창·잔금·계약금 페이지는 카탈로그에 없다', () => {
  const bad = catalog.products.filter((p) => /결제창|잔금|계약금/.test(p.name));
  assert.deepEqual(bad.map((p) => p.id), []);
  assert.equal(catalog.products.length, 4546, '전체 상품 수 4575 → 4546');
});

test('G1: 가격 공개 상품은 2,088건이다', () => {
  const priced = catalog.products.filter((p) => p.price && p.price.state === 'public');
  assert.equal(priced.length, 2088, '가격 공개 2117 → 2088');
});

/* --------------------------------- G4 --------------------------------- */

test('G4: search_text 에 구매방법·배송주기 값이 없다', () => {
  const noisy = catalog.products.filter((p) => /구매방법|배송주기/.test(p.search_text || ''));
  assert.deepEqual(noisy.map((p) => p.id), []);
  const periodic = catalog.products.filter((p) => /정기배송/.test(p.search_text || ''));
  assert.equal(periodic.length, 0, '"정기배송" 검색으로 전 상품이 나오면 안 된다');
});

/* --------------------------------- H1 --------------------------------- */

test('H1: 검색칸은 200px 이상이고 로고 겹침 메뉴·영문 부제를 정리했다', () => {
  assert.match(css, /\.search-form input \{\n  flex: 1 1 auto; min-width: 200px;/);
  assert.doesNotMatch(indexHtml, /data-nav="home"/, '로고와 겹치는 "홈" 메뉴는 뺐다');
  assert.doesNotMatch(indexHtml, /<small>B2B QUOTE CATALOG<\/small>/, '영문 부제는 정리했다');
  assert.doesNotMatch(css, /\.brand-text small \{/, '부제 스타일도 남겨 두지 않는다');
});

/* --------------------------------- H2 --------------------------------- */

test('H2: 홈페이지 대리점 영역의 작업 메모 문구는 삭제됐다', () => {
  assert.doesNotMatch(companyJs, /실측해 확정/);
  assert.doesNotMatch(companyJs, /31종/);
  assert.doesNotMatch(configJs, /실측해 확정/);
  assert.doesNotMatch(configJs, /31개/);
});

/* --------------------------------- H3 --------------------------------- */

test('H3: 묶음 상품은 브랜드 줄을 비우고 필터 이름은 "그 외"다', () => {
  assert.match(catalogJs, /function brandDisplay\(product\) \{\n    var b = displayBrand\(product\);\n    return b === '기타' \? '' : b;/);
  assert.match(catalogJs, /function brandLabel\(value\) \{\n    return value === '기타' \? '그 외' : value;/);
  assert.match(catalogJs, /esc\(brandDisplay\(product\)\)/, '카드·상세 브랜드 줄은 brandDisplay 를 쓴다');
  assert.doesNotMatch(catalogJs, /'<span class="card-brand">' \+ esc\(displayBrand\(product\)\)/);
});

test('H3: 브랜드 개수는 "기타"를 뺀 값이다', () => {
  const realBrands = brands.brands.filter((b) => b.name !== '기타');
  assert.equal(brands.brands.length - 1, realBrands.length);
  // 홈 통계는 '기타'를 뺀다 (#213 D4 규칙 유지) — 데이터와 화면이 같은 값을 가리키는지.
  assert.match(catalogJs, /brands\.filter\(function \(b\) \{ return b !== '기타'; \}\)\.length/);
});

/* --------------------------------- H4 --------------------------------- */

test('H4: 홈 통계 카드는 3칸 한 줄이다', () => {
  assert.match(css, /\.stat-row \{\n  display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  const tablet = css.slice(css.indexOf('@media (max-width: 1099px)'), css.indexOf('@media (max-width: 899px)'));
  assert.match(tablet, /\.stat-row \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  const small = css.slice(css.indexOf('@media (max-width: 399px)'));
  assert.match(small, /\.stat-row \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
});

/* --------------------------------- H5 --------------------------------- */

test('H5: 휴대폰 공지줄 글자는 점 바로 뒤 왼쪽 정렬이다', () => {
  assert.match(css, /\.notice-bar \{ display: flex; align-items: flex-start; justify-content: flex-start; text-align: left; \}/);
});

/* --------------------------------- H6 --------------------------------- */

test('H6: 홈페이지 CSS에 12px 미만 글씨가 없다', () => {
  const small = [...webCss.matchAll(/font-size: ([\d.]+)px/g)]
    .filter((m) => Number(m[1]) < 12)
    .map((m) => m[0]);
  assert.deepEqual(small, [], '12px 미만 글씨: ' + small.join(', '));
});
