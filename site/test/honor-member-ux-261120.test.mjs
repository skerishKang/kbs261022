// AI 명예회원(학교 방송실 교사) 1회차에서 나온 화면 문제 회귀 시험 (2026-11-20).
// 실제 화면 확인(폭별 겹침 측정·Enter·한글 조합·메뉴 닫힘)은 브라우저 캡처
// docs/screenshots/honor-member-ux-261120/results.json 에 남겼고, 여기서는 그 동작을
// 만드는 코드가 빠지지 않게 묶어 둔다.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');
const css = read('assets/css/cgi-catalog.css');
const catalogJs = read('assets/js/cgi-catalog.js');
const orderJs = read('assets/js/cgi-order.js');
const headerJs = read('assets/js/cgi-header.js');
const index = read('index.html');
const returns = read('returns.html');

function mediaBlock(query) {
  const start = css.indexOf(`@media ${query} {`);
  assert.ok(start >= 0, `미디어 블록 없음: ${query}`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  return '';
}

test('1. PC 머리글: 검색칸은 내용 폭 아래로 줄지 않고, 안 들어가면 겹치는 대신 줄바꿈', () => {
  const pc = mediaBlock('(min-width: 900px)');
  assert.match(pc, /\.header-inner \{ flex-wrap: wrap;/);
  assert.match(pc, /\.search-form \{ flex: 1 1 240px; min-width: 240px; \}/);
  const narrow = mediaBlock('(min-width: 900px) and (max-width: 1259px)');
  assert.match(narrow, /\.has-search \.header-nav \{ flex: 1 1 100%;/, '900~1259px 는 메뉴가 아랫줄(검색칸 있는 머리글만)');
  assert.match(index, /<div class="header-inner has-search">/);
});

test('2. 검색: Enter 는 form submit 으로, 같은 검색어 재검색도 다시 그린다', () => {
  assert.match(index, /<form class="search-form" id="searchForm" role="search">/);
  assert.match(index, /<button type="submit" class="btn-search"/);
  assert.match(index, /id="headerSearch"[^>]*enterkeyhint="search"/, '휴대폰 자판에 검색 키');
  const run = catalogJs.slice(catalogJs.indexOf('function runSearch'), catalogJs.indexOf("document.addEventListener('submit'"));
  assert.match(run, /if \(location\.hash === target\) \{\s*render\(\);\s*window\.scrollTo\(0, 0\);/);
  // keydown 으로 Enter 를 가로채지 않는다(한글 조합 확정 전에 실행되는 일을 막기 위해)
  assert.doesNotMatch(catalogJs, /key(?:down|up|press)[\s\S]{0,80}Enter[\s\S]{0,80}headerSearch|headerSearch[\s\S]{0,200}addEventListener\('key/);
});

test('3. 주문 접수 화면 금액 안내는 고객용 문구', () => {
  assert.doesNotMatch(orderJs, /재계산됩니다|무시됩니다/);
  assert.match(orderJs, /표시된 금액은 결제할 때 다시 확인됩니다\./);
});

test('4. 견적 목록·주문 화면 금액 옆 "부가세 포함", 결제 화면 공급가·부가세 분리는 유지', () => {
  const cart = catalogJs.slice(catalogJs.indexOf('var rows = items.map'), catalogJs.indexOf("'<aside class=\"cart-request\">'"));
  assert.match(cart, /<span class="vat-note">부가세 포함<\/span>/);
  assert.match(cart, /주문 금액 <small class="vat-note">부가세 포함<\/small>/);
  assert.match(orderJs, /상품 합계 <small class="vat-note">부가세 포함<\/small>/);
  assert.match(orderJs, /총액 <small class="vat-note">부가세 포함<\/small>/);
  assert.match(orderJs, /' \(공급가 ' \+ money\(order\.totals\.supplied_amount\) \+ ' \+ 부가세 ' \+ money\(order\.totals\.vat_amount\) \+ ' 포함\)<\/p>'/);
  assert.match(css, /\.vat-note \{[^}]*font-size: 12px/);
});

test('5. 휴대폰 메뉴: 검색·머리글 링크·화면 전환 때 닫힘 / 견적 목록 상품명은 삭제 버튼과 겹치지 않음', () => {
  assert.match(headerJs, /header\.addEventListener\('submit', close\)/);
  assert.match(headerJs, /window\.addEventListener\('hashchange', close\)/);
  assert.match(headerJs, /header\.addEventListener\('click', function \(event\) \{\s*if \(event\.target\.closest\('a'\)\) close\(\);/);
  const mobile = mediaBlock('(max-width: 719px)');
  assert.match(mobile, /grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(mobile, /grid-template-areas: "prod prod remove" "price qty qty";/, '삭제 버튼 칸만 상품명 옆, 수량은 아랫줄');
  assert.doesNotMatch(mobile, /\.c-remove \{[^}]*position: absolute/);
});

test('5. cgi-header.js 를 실제로 돌려 보면 검색·hashchange·장바구니 링크에서 닫힌다', () => {
  const listeners = { header: {}, window: {}, document: {}, nav: {}, toggle: {} };
  const classes = new Set();
  const on = (bucket) => (type, fn) => { (listeners[bucket][type] = listeners[bucket][type] || []).push(fn); };
  const toggle = { addEventListener: on('toggle'), setAttribute() {} };
  const nav = { addEventListener: on('nav') };
  const header = {
    classList: { remove: (c) => classes.delete(c), toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)) },
    querySelector: (sel) => (sel === '#siteNav' ? nav : toggle),
    addEventListener: on('header'),
  };
  const context = {
    document: { getElementById: () => header, addEventListener: on('document') },
    window: { addEventListener: on('window'), innerWidth: 390 },
  };
  vm.createContext(context);
  vm.runInContext(headerJs, context);
  const fire = (bucket, type, ev = {}) => (listeners[bucket][type] || []).forEach((fn) => fn(ev));
  const open = () => { classes.clear(); fire('toggle', 'click'); assert.ok(classes.has('nav-open')); };
  open(); fire('header', 'submit'); assert.ok(!classes.has('nav-open'), '검색 후 닫힘');
  open(); fire('window', 'hashchange'); assert.ok(!classes.has('nav-open'), '화면 전환 후 닫힘');
  open(); fire('header', 'click', { target: { closest: (s) => (s === 'a' ? {} : null) } }); assert.ok(!classes.has('nav-open'), '장바구니·로고 링크 후 닫힘');
});

test('6. 문구 정리: "가격 가격 문의" 없음, 카드 가격 문의 한 번, 미확정 안내에는 미확정 상품만', () => {
  assert.doesNotMatch(catalogJs, /'\| 가격 ' \+ priceText\(p\)\)/);
  assert.match(catalogJs, /\(fmtPrice\(p\)\.inquiry \? '가격 문의' : '가격 ' \+ priceText\(p\) \+ '\(부가세 포함\)'\)/);
  const card = catalogJs.slice(catalogJs.indexOf('function cardHtml'), catalogJs.indexOf('function gridHtml'));
  assert.equal((card.match(/가격 문의/g) || []).length, 1, '카드 코드 안의 언급은 설명 주석 하나뿐');
  assert.match(card, /^\s*\/\/.*가격 문의/m);
  const branch = orderJs.slice(orderJs.indexOf('if (!cartPayable())'), orderJs.indexOf('<form id="orderForm"'));
  assert.match(branch, /var pending = items\.filter\(function \(x\) \{ return !isPublicPrice\(x\.product\); \}\);/);
  assert.match(branch, /pending\.map\(/);
  assert.doesNotMatch(branch, /\bitems\.map\(/, '미확정 표에 전체 상품을 나열하지 않는다');
});

test('7. 교환·반품·환불 안내는 메인 쇼핑몰 머리글·스타일을 쓴다', () => {
  assert.doesNotMatch(returns, /<style>/, '따로 놀던 인라인 스타일 제거');
  assert.match(returns, /<header class="site-header" id="siteHeader">/);
  assert.match(returns, /assets\/css\/cgi-catalog\.css\?v=[0-9a-z]+/);
  assert.match(returns, /assets\/js\/cgi-header\.js\?v=[0-9a-z]+/);
  assert.match(returns, /<article class="legal-article">/);
  for (const text of ['청약철회', '3영업일 이내', '062-576-8100', '전자상거래 등에서의 소비자보호에 관한 법률']) {
    assert.ok(returns.includes(text), '본문 유지: ' + text);
  }
});
