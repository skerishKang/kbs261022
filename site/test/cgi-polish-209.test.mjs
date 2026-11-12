// Issue #209 B1~B6 회귀 계약 — 화면 다듬기.
//
//   B1  카테고리 211종 → 상위 10~15개 대분류(브랜드명 분류 제거), 매핑표 파일 고정
//   B2  홈 "가격 문의" 통계 카드 제거
//   B3  견적 양식: 세금계산서 선택칸 높이·모양 통일, 개인정보 동의 체크박스 같은 줄,
//       PC 삭제 버튼 한 줄
//   B4  주문 화면 필수 칸 표시 + 결제 수단 안내 한 줄(업체 이름 없음)
//   B5  브랜드명·모델명·뱃지 글씨 12px 이상
//   B6  휴대폰 공지줄 두 줄 허용(잘림 제거)
//
//   node --test site/test/cgi-polish-209.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const catalogJs = read('site/assets/js/cgi-catalog.js');
const orderJs = read('site/assets/js/cgi-order.js');
const css = read('site/assets/css/cgi-catalog.css');
const indexHtml = read('site/index.html');
const catalog = JSON.parse(read('site/data/catalog.json'));

/* ------------------------------- B1 ------------------------------- */

const mapSource = read('site/data/category_map.js');
const mapWin = {};
new Function('window', mapSource)(mapWin);
const map = mapWin.CGI_CATEGORY_MAP;

function mapCategory(name) {
  if (map.exact && Object.prototype.hasOwnProperty.call(map.exact, name)) return map.exact[name];
  for (const rule of map.rules) {
    for (const kw of rule.keywords) {
      if (name.includes(kw)) return rule.group;
    }
    for (const kw of rule.exactKeywords || []) {
      if (name === kw) return rule.group;
    }
  }
  return map.fallback;
}

test('B1: 대분류는 10~15개고 브랜드명 분류가 없다', () => {
  assert.ok(map.groups.length >= 10 && map.groups.length <= 15,
    '대분류 개수: ' + map.groups.length);
  for (const brand of ['KLOTZ', 'PRESONUS', 'NEUTRIK 커넥터&액세서리', 'JICO', 'APOGEE', 'ARTURIA', 'IK MULTIMEDIA', 'GENELEC', 'DYNAUDIO']) {
    assert.ok(!map.groups.includes(brand), '브랜드명이 대분류에 남아 있다: ' + brand);
  }
});

test('B1: catalog.json 의 모든 카테고리가 대분류로 매핑된다', () => {
  const cats = [...new Set(catalog.products.map((p) => p.category.name))];
  assert.equal(cats.length, 211);
  const groupSet = new Set(map.groups);
  for (const c of cats) {
    const g = mapCategory(c);
    assert.ok(groupSet.has(g), '매핑 결과가 대분류 목록에 없다: ' + c + ' → ' + g);
  }
  const used = new Set(cats.map((c) => mapCategory(c)));
  assert.equal(used.size, map.groups.length, '정의된 대분류를 모두 쓴다');
});

test('B1: 화면·필터는 대분류를 쓰고 검색 텍스트는 원본 분류를 유지한다', () => {
  assert.match(catalogJs, /p\._cat = mapCategory\(categoryLabel\(p\)\)/);
  assert.match(catalogJs, /var CAT_MAP = window\.CGI_CATEGORY_MAP \|\| null;/);
  assert.match(catalogJs, /function mapCategory\(label\)/);
  // 브랜드 코너 그룹핑은 더는 만들지 않는다.
  assert.match(catalogJs, /브랜드명 분류 코너는 더는 만들지 않는다/);
  // 매핑표는 페이지에서 읽는다.
  assert.match(indexHtml, /<script src="data\/category_map.js\?v=[0-9a-z]+"><\/script>/);
});

/* ------------------------------- B2 ------------------------------- */

test('B2: 홈 통계 카드에 "가격 문의" 카드가 없다', () => {
  assert.doesNotMatch(catalogJs, /<dt>가격 문의<\/dt>/);
  const home = catalogJs.match(/function renderHome\(\)[\s\S]*?home-cta/)?.[0] || '';
  assert.ok(home, 'renderHome 을 찾았다');
  assert.equal((home.match(/stat-card/g) || []).length, 3, '통계 카드는 3개');
});

/* ------------------------------- B3 ------------------------------- */

test('B3: 세금계산서 선택칸도 44px 높이로 다른 칸과 같다', () => {
  assert.match(css, /\.quote-form input, \.quote-form select \{ height: 44px; \}/);
  assert.match(css, /\.quote-form select \{ padding: 0 8px; \}/);
});

test('B3: 견적 양식의 개인정보 동의 체크박스는 문구와 같은 줄이다', () => {
  assert.match(css, /\.quote-form \.auth-check, \.order-consents \.auth-check \{ display: flex; \}/);
});

test('B3: 삭제 버튼은 한 줄이다', () => {
  const base = css.match(/\.cart-remove \{[^}]*\}/)?.[0] || '';
  assert.match(base, /min-width: 56px/);
  assert.match(base, /white-space: nowrap/);
});

/* ------------------------------- B4 ------------------------------- */

test('B4: 주문 화면에 필수 칸 표시가 있다', () => {
  assert.match(orderJs, /class="req-mark" aria-hidden="true">\*<\/b><input name="company" required/);
  assert.match(orderJs, /class="req-mark" aria-hidden="true">\*<\/b><input name="name" required/);
  assert.match(orderJs, /class="req-mark" aria-hidden="true">\*<\/b><input name="phone" required/);
  assert.match(orderJs, /표시는 필수 입력입니다/);
  assert.match(css, /\.order-form \.req-mark \{ color: var\(--cgi-danger\)/);
});

test('B4: 결제 수단 안내가 한 줄 있고 업체 이름은 쓰지 않는다', () => {
  assert.match(orderJs, /결제 수단은 카드·계좌이체·휴대폰이며, 주문 생성 후 결제창에서 선택합니다\./);
  const note = orderJs.match(/order-pay-note">([^<]+)</)?.[1] || '';
  assert.ok(!/NICEPAY|나이스|페이앱|PayApp/i.test(note), '안내 문구에 업체 이름이 없다');
});

/* ------------------------------- B5 ------------------------------- */

test('B5: 브랜드명·모델명·뱃지 글씨는 12px 이상이다', () => {
  const brand = css.match(/\.card-brand \{[^}]*\}/)?.[0] || '';
  const model = css.match(/\.card-model \{[^}]*\}/)?.[0] || '';
  const badge = css.match(/\.badge \{[^}]*\}/)?.[0] || '';
  for (const [name, rule] of [['card-brand', brand], ['card-model', model], ['badge', badge]]) {
    const m = rule.match(/font-size: ([\d.]+)px/);
    assert.ok(m && Number(m[1]) >= 12, name + ' 글씨 12px 이상: ' + (m && m[1]));
  }
});

/* ------------------------------- B6 ------------------------------- */

test('B6: 휴대폰 공지줄은 두 줄까지 허용해 잘리지 않는다', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 899px)'));
  assert.match(mobile, /\.notice-bar \{ white-space: normal; line-height: 1\.45; \}/);
  assert.match(mobile, /-webkit-line-clamp: 2/);
  assert.doesNotMatch(mobile, /\.notice-bar \{ white-space: nowrap/);
});
