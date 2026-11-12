// Issue #209 A1~A5 회귀 계약 — 쇼핑몰 구매 흐름.
//
//   A1  주문 화면 주 버튼에 btn-primary
//   A2  장바구니 주 버튼 하나(가격 확정 → 결제가 주, 가격 문의 → 견적이 주),
//       휴대폰에서 주 버튼은 담은 상품 바로 아래
//   A3  상세 표에서 공급처 배송비·소비자가·원산지 제거 + CGI 배송 안내,
//       주문 화면에 상품 합계·배송비·총액(서버 설정값)
//   A4  머리말 장바구니 아이콘(개수) 항상 표시, 담기 안내는 고정 바 위 + 화면 전환 시 지움
//   A5  기본 정렬 추천순(대표 상품 우선), 홈 추천은 일정 가격 이상 대표 상품,
//       상품명 앞 공급처 문구·SCM 코드는 화면용 이름에서만 제거
//
//   node --test site/test/cgi-flow-209.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const orderJs = read('site/assets/js/cgi-order.js');
const catalogJs = read('site/assets/js/cgi-catalog.js');
const css = read('site/assets/css/cgi-catalog.css');
const indexHtml = read('site/index.html');
const workerJs = read('backend/worker.js');
const catalog = JSON.parse(read('site/data/catalog.json'));
const full = JSON.parse(read('site/data/products.json'));

/* ------------------------------- A1 ------------------------------- */

test('A1: 주문 흐름의 주 동작 버튼은 btn-primary를 가진다', () => {
  for (const marker of [
    '주문 생성 후 결제</button>',
    '견적 요청으로 접수하기',
    '결제 다시 진행',
    'id="repayNicepayPayBtn"',
    'id="payBtn"',
  ]) {
    const at = orderJs.indexOf(marker);
    assert.ok(at !== -1, '버튼이 존재해야 한다: ' + marker);
    // 버튼 마크업 안(앞 200자)에 btn-primary 클래스가 있어야 한다.
    const before = orderJs.slice(Math.max(0, at - 200), at);
    assert.match(before, /btn-primary/, '주 버튼에 btn-primary: ' + marker);
  }
  // 취소·상품 더 담기·나중에 하기 같은 보조 동작은 secondary로 남는다.
  assert.match(orderJs, /class="btn btn-secondary" href="#\/products">상품 더 담기/);
  assert.match(orderJs, /class="btn btn-secondary" href="#\/quote-cart">취소/);
});

/* ------------------------------- A2 ------------------------------- */

test('A2: 장바구니는 상태에 따라 주 버튼 하나만 크게 보여 준다', () => {
  // cart-layout 에 상태 클래스가 붙는다.
  assert.ok(catalogJs.includes("(allPublicPrice(items) ? 'is-payable' : 'is-inquiry')"),
    'cart-layout 에 상태 클래스가 붙는다');
  // 가격 확정: 결제 CTA가 btn-primary, 견적은 작은 링크(버튼).
  assert.match(catalogJs, /btn btn-primary btn-block cart-pay-btn" href="#\/checkout">결제 주문으로 계속/);
  assert.match(catalogJs, /data-scroll-quote-form>견적 요청으로 접수</);
  // 가격 확정일 때 견적 폼 제출 버튼은 주 버튼(primary)이 아니라 링크형이다.
  assert.match(catalogJs, /allPublicPrice\(items\)\s*\?\s*'<button type="submit" class="btn btn-block cart-quote-submit">견적 요청으로 접수<\/button>'\s*:\s*'<button type="submit" class="btn btn-primary btn-block">견적 요청 보내기<\/button>'/);
  // 가격 문의: 견적 CTA에는 결제 버튼이 없다(안내만).
  const inquiryBlock = catalogJs.match(/cart-pay-cta cart-pay-inquiry">[\s\S]*?<\/div>'\)/)?.[0] || '';
  assert.ok(inquiryBlock, '가격 문의 CTA 블록이 존재한다');
  assert.doesNotMatch(inquiryBlock, /cart-pay-btn/);
  assert.match(inquiryBlock, /담당자 확인 후 안내/);
});

test('A2: 휴대폰에서 주 버튼은 담은 상품 바로 아래에 온다', () => {
  const tablet = css.slice(css.indexOf('@media (max-width: 1099px)'), css.indexOf('@media (max-width: 899px)'));
  assert.match(tablet, /\.cart-layout\.is-payable \.cart-pay-cta \{ order: 2; \}/);
  assert.match(tablet, /\.cart-layout\.is-inquiry \.cart-request \{ order: 2; \}/);
});

/* ------------------------------- A3 ------------------------------- */

test('A3: 상세 표에서 공급처 배송비·소비자가·원산지 줄을 제외한다', () => {
  assert.match(catalogJs, /SUPPLIER_SPEC_RE = \/\^\(배송비\|소비자가\|원산지\)\$\//);
  assert.match(catalogJs, /배송 안내<\/dt><dd>배송비·배송 일정은 CGI 기준으로 안내됩니다/);
});

test('A3: 주문 화면에 상품 합계·배송비·총액 줄이 있다', () => {
  assert.match(orderJs, /order-sum-line"><span>상품 합계/);
  assert.match(orderJs, /order-sum-line"><span>배송비/);
  assert.match(orderJs, /order-sum-total"><span>총액/);
  // 배송비는 서버 설정값(SHIPPING_FEE_DEFAULT)을 /api/shop/config 로 읽어 쓴다.
  assert.match(orderJs, /api\('GET', '\/api\/shop\/config'\)/);
  assert.match(workerJs, /shipping_fee_default: toNonNegInt\(env\.SHIPPING_FEE_DEFAULT, 0\)/);
  // 결제 화면도 서버가 계산한 배송비를 보여 준다.
  assert.match(orderJs, /money\(order\.totals\.shipping_fee\)/);
});

/* ------------------------------- A4 ------------------------------- */

test('A4: 머리말에 담은 개수 붙은 장바구니 아이콘이 항상 있다', () => {
  assert.match(indexHtml, /class="header-cart" href="#\/quote-cart"/);
  assert.match(indexHtml, /data-cart-count/);
  assert.match(catalogJs, /function updateHeaderCartCount\(\)/);
  assert.match(catalogJs, /loadQuoteCart\(\);\s*\n\s*loadQuoteCartServices\(\);\s*\n\s*updateHeaderCartCount\(\);/);
  // 라우트가 바뀔 때마다 개수를 다시 그린다.
  assert.match(catalogJs, /updateHeader\(\);\s*\n\s*updateHeaderCartCount\(\);/);
  // 아이콘은 모바일에서도 숨지 않는다(헤더 내비 안쪽에 두지 않았다).
  const headerStart = indexHtml.indexOf('<header class="site-header"');
  const headerEnd = indexHtml.indexOf('</header>');
  const header = indexHtml.slice(headerStart, headerEnd);
  const cartAt = header.indexOf('header-cart');
  const navAt = header.indexOf('<nav class="header-nav"');
  assert.ok(cartAt !== -1 && cartAt < navAt, '장바구니 아이콘은 접히는 내비 밖에 있다');
});

test('A4: 담기 안내는 "견적 목록 보기" 버튼을 포함하고 화면이 바뀌면 지워진다', () => {
  assert.match(catalogJs, /showToast\('견적 목록에 추가했습니다\.', \{ label: '견적 목록 보기', href: '#\/quote-cart' \}\)/);
  assert.match(catalogJs, /function hideToast\(\)/);
  assert.match(catalogJs, /hideToast\(\); \/\/ 화면이 바뀌면 담기 안내를 지운다/);
  // 상세 화면의 아래 고정 바 위로 안내를 올린다.
  assert.match(css, /body\[data-view="detail"\] \.toast \{ bottom: 88px; \}/);
  assert.match(css, /\.toast-action/);
});

/* ------------------------------- A5 ------------------------------- */

test('A5: 전체 상품 기본 정렬은 추천순이고 상태 태그 상품은 뒤로 간다', () => {
  assert.match(catalogJs, /sort: 'featured'/);
  assert.match(catalogJs, /route\.sort = params\.get\('sort'\) \|\| 'featured'/);
  assert.match(catalogJs, /<option value="featured"' \+ \(r\.sort === 'featured' \? ' selected' : ''\) \+ '>추천순<\/option>/);
  assert.match(catalogJs, /function featuredRank\(p\)/);
  assert.match(catalogJs, /function featuredCompare\(a, b\)/);
  assert.match(catalogJs, /if \(sort === 'featured'\) return featuredCompare\(a, b\);/);
  // 대표 상품 판정: 상태 태그 없음 + 이미지 + 공개가.
  assert.match(catalogJs, /if \(splitConditionTag\(p\.name\)\.tag\) return 1;/);
  assert.match(catalogJs, /if \(!p\.images\.length\) return 1;/);
  assert.match(catalogJs, /if \(!isPublicPriced\(p\)\) return 1;/);
});

test('A5: 홈 추천 상품은 일정 가격 이상 대표 상품에서만 뽑는다', () => {
  assert.match(catalogJs, /FEATURED_MIN_PRICE = \d+/);
  const floor = Number(catalogJs.match(/FEATURED_MIN_PRICE = (\d+)/)?.[1] || 0);
  assert.ok(floor >= 10000, '추천 하단 가격 기준이 있다(530원 부품 방지)');
  assert.match(catalogJs, /Number\(p\.price\.value\) >= FEATURED_MIN_PRICE/);
});

test('A5: catalog.json 이름에서 공급처 문구·SCM 코드가 빠지고 원본은 그대로다', () => {
  const CONDITION = new Set([
    '박스손상', '리퍼비쉬', '전시상품', '전시제품', '전시/단종 클리어런스',
    '단순개봉', '교환상품', '미세흠집', '입고후발송', '커버 무료증정',
  ]);
  const nonCondition = catalog.products.filter((p) => {
    const m = p.name.match(/^\[([^\]]+)\]/);
    return m && !CONDITION.has(m[1]);
  });
  assert.deepEqual(nonCondition.map((p) => p.name), [], '공급처 문구 접두사가 화면용 이름에 남아 있다');
  assert.equal(catalog.products.filter((p) => /SCM-\d+/i.test(p.name)).length, 1,
    'SCM 코드는 제품명의 일부인 경우만 남는다(SCM-505 미니 페달)');
  // 원본 products.json 은 불변 — 공급처 접두사·SCM 코드가 그대로 남아 있다.
  assert.ok(full.some((p) => /^\[MESA BOOGIE\]/.test(p.name)), '원본 name 은 그대로다');
  assert.ok(full.some((p) => /SCM-\d+/i.test(p.name)), '원본 name 의 SCM 코드는 그대로다');
  // 상태 태그 접두사는 배지 분리를 위해 남아 있다.
  assert.ok(catalog.products.some((p) => /^\[리퍼비쉬\]/.test(p.name)));
});
