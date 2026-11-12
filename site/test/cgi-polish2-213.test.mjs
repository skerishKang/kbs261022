// 이슈 #213 E1~E9·F1~F3 회귀 — 화면 다듬기·회원·안내.
//
//   E1  휴대폰 공지줄 점은 글자 첫 줄과 같은 줄
//   E2  PC 머리글 검색칸 안내 문구가 잘리지 않는다(단축 문구)
//   E3  홈 통계 "가격" → "가격 공개 상품"
//   E4  홈 초록 배너 칩 개수 대비 확보
//   E5  휴대폰 견적 목록 결제 상자가 다른 카드와 같은 폭
//   E6  주문 내역 상품명과 브랜드는 다른 줄
//   E7  PC 견적 목록 삭제 버튼 안쪽 여백
//   E8  category_map 'SM' 정확 일치(KEN SMITH 는 악기·앰프)
//   E9  남은 작은 글씨 12px 이상
//   F1  회원가입 화면 Google 버튼(로그인 화면과 같은 흐름)
//   F2  이용 안내에 카드 주문 흐름 추가(업체 이름 없음)
//   F3  견적 목록 미리보기는 "복사"만 남긴다
//
//   node --test site/test/cgi-polish2-213.test.mjs

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
const mapSource = read('site/data/category_map.js');

/* --------------------------------- E1 --------------------------------- */

test('E1: 휴대폰 공지줄 점이 글자 첫 줄에 붙는다', () => {
  assert.match(css, /\/\* 휴대폰에서 점이 글자 윗줄로 떨어지지 않게 같은 줄에 붙인다 \(#213 E1\) \*\//);
  assert.match(css, /\.notice-bar \{ display: flex; align-items: flex-start; justify-content: center; \}/);
  assert.match(css, /\.notice-dot \{ flex: 0 0 auto; margin-top: 5px; \}/);
});

/* --------------------------------- E2 --------------------------------- */

test('E2: 머리글 검색칸 안내 문구가 잘리지 않게 단축돼 있다', () => {
  assert.match(indexHtml, /placeholder="상품 검색"/);
  assert.doesNotMatch(indexHtml, /상품명·모델명·브랜드 검색/);
});

/* --------------------------------- E3 --------------------------------- */

test('E3: 홈 통계 카드 라벨이 "가격 공개 상품"이다', () => {
  assert.match(catalogJs, /<dt>가격 공개 상품<\/dt>/);
  assert.doesNotMatch(catalogJs, /<dt>가격<\/dt>/);
});

/* --------------------------------- E4 --------------------------------- */

test('E4: 홈 초록 배너 칩 개수에 대비를 준다', () => {
  assert.match(css, /\.hero-quicklinks \.chip \.cnt \{ color: #eaf6ee; font-weight: 700; \}/);
});

/* --------------------------------- E5 --------------------------------- */

test('E5: 휴대폰 견적 목록 결제 상자가 카드 폭과 같아진다', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 1099px)'));
  assert.match(mobile, /\.cart-layout \{ display: flex; flex-direction: column; align-items: stretch; \}/);
});

/* --------------------------------- E6 --------------------------------- */

test('E6: 주문 내역 상품명과 브랜드는 다른 줄이다', () => {
  assert.match(css, /\.order-items small \{ display: block;/);
  assert.doesNotMatch(css, /\.order-items small \{ display: inline; \}/);
});

/* --------------------------------- E7 --------------------------------- */

test('E7: 견적 목록 삭제 칸에 안쪽 여백이 있다', () => {
  assert.match(css, /\.cart-table th:last-child, \.cart-table td:last-child \{ padding-right: 16px; \}/);
});

/* --------------------------------- E8 --------------------------------- */

const mapWin = {};
new Function('window', mapSource)(mapWin);
const map = mapWin.CGI_CATEGORY_MAP;

function mapCategory(name) {
  if (map.exact && Object.prototype.hasOwnProperty.call(map.exact, name)) return map.exact[name];
  for (const rule of map.rules) {
    for (const kw of rule.keywords || []) {
      if (name.includes(kw)) return rule.group;
    }
    for (const kw of rule.exactKeywords || []) {
      if (name === kw) return rule.group;
    }
  }
  return map.fallback;
}

test('E8: SM 은 정확 일치만 마이크·무선으로 분류한다', () => {
  assert.equal(mapCategory('SM'), '마이크·무선');
  assert.equal(mapCategory('SM 시리즈'), '마이크·무선');
  assert.equal(mapCategory('KEN SMITH'), '악기·앰프');
  const micRule = map.rules.find((r) => r.group === '마이크·무선');
  assert.ok(!micRule.keywords.includes('SM'), '부분 문자열 키워드 SM 이 남아 있다');
  assert.ok(micRule.exactKeywords.includes('SM'));
});

/* --------------------------------- E9 --------------------------------- */

test('E9: 쇼핑몰 CSS에 12px 미만 글씨가 없다', () => {
  const small = [...css.matchAll(/font-size: ([\d.]+)px/g)]
    .filter((m) => Number(m[1]) < 12)
    .map((m) => m[0]);
  assert.deepEqual(small, [], '12px 미만 글씨: ' + small.join(', '));
});

/* --------------------------------- F1 --------------------------------- */

test('F1: 회원가입 화면에도 Google 버튼이 있다', () => {
  const signup = catalogJs.match(/function renderSignup\(app\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.ok(signup, 'renderSignup 을 찾았다');
  assert.match(signup, /data-auth-submit="google"/);
  assert.match(signup, /Google로 계속하기/);
  assert.match(signup, /rebindGoogle\(app\)/);
});

/* --------------------------------- F2 --------------------------------- */

test('F2: 이용 안내에 카드 주문 흐름이 있고 업체 이름은 없다', () => {
  const about = catalogJs.match(/function renderAbout\(\) \{[\s\S]*?about-actions/)?.[0] || '';
  assert.ok(about, 'renderAbout 을 찾았다');
  assert.match(about, /바로 구매 \(가격 공개 상품\)/);
  assert.match(about, /담기 → 결제 주문 → 결제/);
  assert.match(about, /결제 주문으로 계속/);
  assert.ok(!/NICEPAY|나이스페이|PayApp|토스/i.test(about), '안내에 업체 이름이 없다');
});

/* --------------------------------- F3 --------------------------------- */

test('F3: 견적 목록 미리보기는 복사만 남긴다', () => {
  assert.match(catalogJs, /요청 내용 미리보기 · 복사</);
  assert.doesNotMatch(catalogJs, /data-action="download-json"/);
  assert.doesNotMatch(catalogJs, /data-action="download-csv"/);
  assert.doesNotMatch(catalogJs, /cgiDownloadQuoteCart/);
  assert.match(catalogJs, /data-action="copy-cart">요약 복사</);
  // 접수번호 복사 같은 다른 복사 기능은 그대로다.
  assert.match(catalogJs, /data-action="copy-receipt"/);
});
