// 견적 목록 → 견적서 출력(가견적) 시험 (2026-11-20, AI 명예회원 1회차 최우선 요청).
// 계산 규칙은 주문 화면과 같아야 하므로 백엔드 pricing.mjs 의 splitTax / computeTotals 와
// 직접 비교한다.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { splitTax as backendSplitTax, computeTotals } from '../../backend/lib/pricing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');
const QP_SRC = read('assets/js/cgi-quote-print.js');
const COMPANY_SRC = readFileSync(join(HERE, '..', '..', 'website', 'assets', 'company.js'), 'utf8');

function load() {
  const window = {};
  const ctx = { window, globalThis: window, Math, Number, String, Date, JSON, Array, Object };
  vm.createContext(ctx);
  vm.runInContext(COMPANY_SRC, ctx);
  vm.runInContext(QP_SRC, ctx);
  return { qp: window.CGI_QUOTE_PRINT, company: window.CGI_COMPANY };
}
const { qp, company } = load();

const priced = (id, value, extra = {}) => ({ id, name: `상품 ${id}`, brand: 'BRAND', model: `M-${id}`, price: { state: 'public', value }, ...extra });
const inquiry = (id) => ({ id, name: `문의 ${id}`, brand: 'BRAND', price: { state: 'inquiry', value: null } });

test('부가세 분리는 주문 화면(백엔드 splitTax)과 1원 단위까지 같다', () => {
  for (let total = 0; total <= 30000; total += 7) {
    const a = qp.splitTax(total);
    const b = backendSplitTax(total);
    assert.equal(a.supplied, b.suppliedAmount, `공급가액 ${total}`);
    assert.equal(a.vat, b.vatAmount, `부가세 ${total}`);
  }
  for (const total of [919000, 2240000, 3159000, 1280000, 368001, 99999999]) {
    assert.equal(qp.splitTax(total).supplied, backendSplitTax(total).suppliedAmount);
  }
});

test('합계 줄은 주문 화면 합계(computeTotals)와 같고, 품목 열의 합은 합계 줄과 정확히 같다', () => {
  // 품목별로 반올림하면 열 합이 1~2원 어긋나는 조합(끝수 맞춤 필요)
  const items = [
    { qty: 1, product: priced('a', 1000) },
    { qty: 1, product: priced('b', 1005) },
    { qty: 1, product: priced('c', 1005) },
    { qty: 1, product: inquiry('x') },
  ];
  // 이 조합은 품목마다 반올림하면 공급가액 열 합이 합계 줄보다 1원 크다(끝수 맞춤이 실제로 일어남)
  const rawLineSum = [1000, 1005, 1005].reduce((s, v) => s + qp.splitTax(v).supplied, 0);
  assert.notEqual(rawLineSum, qp.splitTax(3010).supplied, '시험 조합이 끝수 차이를 만들어야 한다');
  const q = qp.computeQuote(items);
  const backend = computeTotals(items.map((x) => ({ qty: x.qty, unit_price: x.product.price.state === 'public' ? x.product.price.value : null })));
  assert.equal(q.total, backend.item_total, '총액');
  assert.equal(q.supplied, backend.supplied_amount, '공급가액 합 = 주문 화면');
  assert.equal(q.vat, backend.vat_amount, '부가세 합 = 주문 화면');
  const pricedLines = q.lines.filter((l) => l.priced);
  assert.equal(pricedLines.reduce((s, l) => s + l.supplied, 0), q.supplied, '공급가액 열 합');
  assert.equal(pricedLines.reduce((s, l) => s + l.vat, 0), q.vat, '부가세 열 합');
  for (const l of pricedLines) {
    assert.equal(l.supplied + l.vat, l.total, `줄 ${l.no}: 공급가액 + 부가세 = 합계`);
    assert.equal(l.total, l.unit * l.qty, `줄 ${l.no}: 단가 × 수량`);
  }
});

test('가격 문의 품목은 합계에서 빠지고 건수로 센다', () => {
  const q = qp.computeQuote([
    { qty: 2, product: priced('a', 368000) },
    { qty: 1, product: inquiry('x') },
    { qty: 5, product: inquiry('y') },
  ]);
  assert.equal(q.total, 736000);
  assert.equal(q.pricedCount, 1);
  assert.equal(q.inquiryCount, 2);
  const x = q.lines.find((l) => !l.priced);
  assert.equal(x.unit, null);
  assert.equal(x.total, null);
  // 모두 가격 문의면 합계 0
  const none = qp.computeQuote([{ qty: 1, product: inquiry('z') }]);
  assert.deepEqual([none.total, none.supplied, none.vat, none.inquiryCount], [0, 0, 0, 1]);
});

test('한글 금액: 금 ○○원정', () => {
  const cases = [
    [0, '영'], [1, '일'], [10, '일십'], [11, '일십일'], [20, '이십'], [100, '일백'], [1000, '일천'],
    [10000, '일만'], [10010, '일만일십'], [100000, '일십만'], [1280000, '일백이십팔만'],
    [2240000, '이백이십사만'], [919000, '구십일만구천'], [1000010, '일백만일십'],
    [100000000, '일억'], [100000001, '일억일'], [123456789, '일억이천삼백사십오만육천칠백팔십구'],
    [3159000, '삼백일십오만구천'], [1000000000000, '일조'],
  ];
  for (const [n, ko] of cases) assert.equal(qp.koreanNumber(n), ko, String(n));
  assert.equal(qp.koreanAmount(1280000), '금 일백이십팔만원정');
  assert.equal(qp.koreanAmount(0), '금 영원정');
});

test('임시 견적번호 Q-YYMMDD-xxxx, 유효기간 견적일+14일(월 넘김 포함)', () => {
  const day = new Date(2026, 10, 20, 15, 30);
  let i = 0;
  const seq = [0, 0.5, 0.99, 0.25];
  assert.match(qp.quoteNumber(day, () => seq[i++ % 4]), /^Q-261120-[A-Z2-9]{4}$/);
  assert.match(qp.quoteNumber(day), /^Q-261120-[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}$/);
  assert.equal(qp.ymd(qp.addDays(day, 14)), '2026-12-04');
  assert.equal(qp.ymd(qp.addDays(new Date(2026, 11, 25), 14)), '2027-01-08');
  assert.equal(qp.koreanDate(day), '2026년 11월 20일');
});

test('공급자 정보는 회사 정보 단일 출처(company.js)에서 오고, 사이트 푸터 판매자 정보와 같다', () => {
  const s = qp.supplierFrom(company);
  const footer = read('index.html').match(/<section class="footer-seller"[\s\S]*?<\/section>/)[0];
  for (const v of [s.name, s.ceo, s.bizRegNo, s.address.replace(/^\[(\d+)\] /, '[$1] ')]) assert.ok(footer.includes(v), '푸터에 없음: ' + v);
  for (const tel of s.tels) assert.ok(footer.includes(tel), '푸터 전화: ' + tel);
  assert.equal(s.email, company.legal.privacyOfficer.email);
  // 견적서 모듈 안에 회사 값이 따로 박혀 있지 않다
  for (const v of ['410-86-46283', '시지아이', '576-8100', '나노산단로', 'cgiinc@']) assert.ok(!QP_SRC.includes(v), '하드코딩: ' + v);
});

test('견적서 HTML: 제목·가견적·별도 견적·추가 서비스·직인 칸·빈 받는 분', () => {
  const base = {
    items: [{ qty: 2, product: priced('a', 640000) }, { qty: 1, product: inquiry('x') }],
    services: [{ name: '설치·시공' }, { name: 'AS·유지보수' }],
    customer: {},
    now: new Date(2026, 10, 20),
    number: 'Q-261120-AB2C',
    company,
  };
  const html = qp.renderHtml(base);
  assert.match(html, /<h1 class="qp-title">견 적 서<\/h1>/);
  assert.match(html, /Q-261120-AB2C<\/strong> <span class="qp-tag">가견적<\/span>/);
  assert.match(html, /2026년 11월 20일/);
  assert.match(html, /2026년 12월 4일까지/);
  assert.match(html, /금 일백이십팔만원정/);
  assert.match(html, /data-quote-supplied>1,163,636</);
  assert.match(html, /data-quote-vat>116,364</);
  assert.match(html, /data-quote-total>1,280,000</);
  assert.match(html, /<td class="qp-c" colspan="4">별도 견적<\/td>/);
  assert.match(html, /별도 견적 품목 1건/);
  assert.equal((html.match(/추가 서비스: /g) || []).length, 2);
  assert.equal((html.match(/별도 협의<\/td>/g) || []).length, 2);
  assert.match(html, /본 견적은 쇼핑몰 표시 가격 기준 가견적이며, 재고·납기·최종 금액은 담당자 확인 후 확정됩니다\./);
  assert.match(html, /문의 062\) 576-8100/);
  assert.match(html, /<span class="qp-seal-empty" aria-label="직인 자리">\(인\)<\/span>/);
  assert.doesNotMatch(html, /undefined|null|NaN/);
  // 받는 분이 비어 있으면 빈 칸(손으로 쓰게), 있으면 그 값
  assert.match(html, /<th>받는 분<\/th><td class="qp-fill"> <span class="qp-honor">귀하<\/span><\/td>/);
  const filled = qp.renderHtml({ ...base, customer: { company: '○○초등학교 <방송실>', name: '김선생' }, sealImageUrl: 'assets/img/seal.png' });
  assert.match(filled, /○○초등학교 &lt;방송실&gt; <span class="qp-honor">귀하/);
  assert.match(filled, /<th>담당자<\/th><td class="qp-fill">김선생<\/td>/);
  assert.match(filled, /<img class="qp-seal-img" src="assets\/img\/seal\.png" alt="회사 직인">/);
  // 가격 문의 품목이 없으면 안내 문장도 없다
  assert.doesNotMatch(qp.renderHtml({ ...base, items: [base.items[0]], services: [] }), /별도 견적 품목|추가 서비스/);
});

test('견적 목록에 "견적서 출력" 버튼, #/quote-print 경로, 직인 설정 항목, 인쇄 스타일', () => {
  const catalog = read('assets/js/cgi-catalog.js');
  const css = read('assets/css/cgi-catalog.css');
  const config = read('config.js');
  const index = read('index.html');
  assert.match(catalog, /data-action="quote-print">견적서 출력<\/button>/);
  assert.match(catalog, /parts\[0\] === 'quote-print'/);
  assert.match(catalog, /if \(action === 'quote-print'\) \{ openQuotePrint\(\); return; \}/);
  assert.match(catalog, /navigate\('#\/quote-print\?print=1'\)/);
  assert.match(catalog, /setTimeout\(printQuote, 350\)/);
  assert.match(catalog, /window\.print\(\)/);
  // 로그인 요구 없음: 견적서 화면은 회원 API 를 부르지 않는다
  const view = catalog.slice(catalog.indexOf('function renderQuotePrint'), catalog.indexOf('function renderQuoteCart'));
  assert.doesNotMatch(view, /CGI_AUTH|isLoggedIn|\/api\//);
  assert.match(config, /quotePrint: \{\s*sealImageUrl: '',\s*\}/);
  assert.match(index, /<script src="assets\/js\/cgi-quote-print\.js\?v=[0-9a-z]+"><\/script>\s*<script src="assets\/js\/cgi-catalog\.js/);
  const print = css.slice(css.indexOf('@media print {\n  @page { size: A4 portrait;'));
  assert.match(print, /@page \{ size: A4 portrait;/);
  for (const sel of ['.site-header', '.site-footer', '.notice-bar', '.no-print', '.mobile-cta']) {
    assert.ok(print.includes(`body[data-view="quote-print"] ${sel}`), '인쇄에서 숨김: ' + sel);
  }
  assert.match(print, /\.qp-items thead \{ display: table-header-group; \}/);
  assert.match(print, /color: #000 !important/);
});
