// 관리자 견적서 화면(quotes.html): 공용 검색(cgi-search.js) = 카탈로그 검색, 화면 계산 = 서버 계산,
// 정식 견적서 출력, 머리글 탭·페이지 구조, 이카운트 버튼 자리(비활성).
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const catalog = JSON.parse(read('site/data/catalog.json'));

function loadModules() {
  const window = {};
  const ctx = vm.createContext({ window });
  for (const f of ['website/assets/company.js', 'site/assets/js/cgi-search.js', 'site/assets/js/cgi-quote-print.js', 'site/assets/js/cgi-admin-quotes-view.js']) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  return window;
}
const W = loadModules();
const S = W.CGI_SEARCH;
const V = W.CGI_ADMIN_QUOTES_VIEW;
const QP = W.CGI_QUOTE_PRINT;

function stub() {
  return {
    hidden: false, value: '', innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
    querySelector() { return stub(); }, querySelectorAll() { return []; }, appendChild() {}, removeChild() {}, closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }, scrollIntoView() {}, focus() {}, remove() {},
  };
}
function bootCatalog() {
  const window = { addEventListener() {}, scrollTo() {}, setTimeout, clearTimeout, location: { hash: '', search: '', href: 'https://example.test/site/index.html' } };
  new Function('window', read('website/assets/company.js'))(window);
  new Function('window', read('site/data/category_map.js'))(window);
  const document = { readyState: 'loading', getElementById() { return stub(); }, createElement() { return stub(); }, querySelector() { return stub(); }, querySelectorAll() { return []; }, body: stub(), addEventListener() {} };
  new Function('window', 'document', 'localStorage', 'fetch', 'location', 'setTimeout', 'requestAnimationFrame', read('site/assets/js/cgi-catalog.js'))(
    window, document, { getItem() { return null; }, setItem() {}, removeItem() {} },
    () => Promise.reject(new Error('no fetch in test')), window.location, setTimeout, (fn) => { fn(); });
  return window.cgiDebug;
}

test('1. 공용 검색은 카탈로그 화면 검색과 같은 상품을 찾는다(같은 정규화·검색어 묶음)', async () => {
  const dbg = bootCatalog();
  await new Promise((r) => setTimeout(r, 10));
  dbg.applyCatalog(catalog);
  const products = catalog.products.map((p) => ({ ...p }));
  for (const q of ['무선마이크', '무선 마이크', 'SM58', 'shure', '스피커', '믹서', 'RM32', 'PA 스피커', '구즈넥', '(케이블)']) {
    dbg.setState('route', { view: 'list', q, brands: [], cats: [], sites: [], sort: 'featured', page: 1, id: null });
    const shop = dbg.filteredProducts().map((p) => p.id).sort();
    const mine = Array.from(S.search(products, q), (p) => p.id).sort();
    assert.deepEqual(mine, shop, `“${q}” 결과가 같다 (${shop.length}건)`);
  }
  assert.equal(S.search(products, '   ').length, 0, '빈 검색어는 결과 없음');
  const top = S.search(products, 'SM58', { limit: 5 });
  assert.ok(top.length === 5 && /SM58/i.test(top[0].name + top[0].model), '모델 일치가 먼저');
});

test('2. 카탈로그 줄: 공개가는 고정, 가격 문의는 직접 입력; 서버에는 공개가 단가를 보내지 않는다', () => {
  const pub = catalog.products.find((p) => p.price && p.price.state === 'public');
  const inq = catalog.products.find((p) => p.price && p.price.state === 'inquiry');
  const a = V.lineFromProduct(pub);
  const b = V.lineFromProduct(inq);
  assert.equal(a.unit_source, 'catalog');
  assert.equal(a.unit_price, pub.price.value);
  assert.equal(b.unit_source, 'manual');
  assert.equal(b.unit_price, null);
  const c = V.customLine('설치비');
  assert.equal(c.kind, 'custom');
  const d = V.emptyDraft();
  d.recipient.company = '○○학교';
  b.unit_price = 1_200_000;
  c.unit_price = 300_000; c.discount_type = 'pct'; c.discount_value = 10;
  d.items = [a, b, c];
  const body = V.toApiBody(d);
  assert.equal(body.items[0].unit_price, null, '공개가 줄은 서버가 확정');
  assert.equal(body.items[1].unit_price, 1_200_000);
  assert.equal(body.items[2].discount_value, 10);
  assert.equal(body.valid_days, 14);
  assert.equal(V.validate(d).length, 0);
  const t = V.totals(d);
  assert.equal(t.total, pub.price.value + 1_200_000 + 270_000);
  assert.match(t.korean, /^금 .+원정$/);
});

test('2. 화면 합계는 서버 계산(backend/lib/admin-quotes.mjs)과 1원 단위까지 같다', async () => {
  const { computeAdminQuote } = await import(pathToFileURL(join(ROOT, 'backend/lib/admin-quotes.mjs')).href);
  const pubs = catalog.products.filter((p) => p.price && p.price.state === 'public').slice(0, 300);
  for (let n = 0; n < 200; n += 1) {
    const d = V.emptyDraft();
    for (let i = 0; i < 1 + (n % 6); i += 1) {
      const line = V.lineFromProduct(pubs[(n * 37 + i * 11) % pubs.length]);
      line.qty = 1 + ((n + i) % 7);
      if ((n + i) % 3 === 0) { line.discount_type = 'pct'; line.discount_value = ((n * 7 + i) % 300) / 10; }
      if ((n + i) % 5 === 0) { line.discount_type = 'amount'; line.discount_value = (n * 1013) % 50_000; }
      d.items.push(line);
    }
    const custom = V.customLine('공사비'); custom.unit_price = (n * 33_331) % 2_000_000; d.items.push(custom);
    const screen = V.totals(d);
    const server = computeAdminQuote(V.toPrintItems(d).map((x) => ({ qty: x.qty, unit: x.unit, discount_type: x.discount_type, discount_value: x.discount_value })));
    assert.equal(screen.total, server.total);
    assert.equal(screen.supplied, server.supplied);
    assert.equal(screen.vat, server.vat);
  }
});

test('2. 저장 전 검사는 고칠 곳을 알려 준다', () => {
  const d = V.emptyDraft();
  const e1 = V.validate(d).map((e) => e.field);
  assert.ok(e1.includes('company') && e1.includes('items'));
  d.recipient.company = 'x'; d.recipient.email = 'bad';
  const l = V.customLine(''); l.qty = 0; l.unit_price = NaN; d.items = [l];
  const texts = V.validate(d).map((e) => e.text).join(' ');
  assert.match(texts, /이메일/); assert.match(texts, /품명/); assert.match(texts, /수량/); assert.match(texts, /단가/);
  assert.equal(V.parseMoney('1,234,000원'), 1234000);
  assert.equal(V.parseMoney(''), null);
  assert.ok(Number.isNaN(V.parseMoney('12.5')));
});

test('3. 정식 견적서 출력: 서버 번호, 가견적 표시 없음, 유효기간·연락처·납기·결제, 할인·메모 줄', () => {
  const quote = {
    id: 3, quote_no: 'Q-261120-003', status: 'draft', quote_date: '2026-11-20', valid_days: 30, valid_until: '2026-12-20',
    recipient: { company: '전남○○군청 총무과', name: '이주무관', phone: '062-000-0000', email: 'a@example.com', memo: '내부 메모' },
    delivery_terms: '발주 후 3주 이내 설치', payment_terms: '설치 완료 후 30일 이내', total_amount: 2_650_000,
    items: [
      { kind: 'product', product_id: 'p', name: 'A&H CQ-18T', brand: 'ALLEN&HEATH', spec: '', qty: 1, unit_price: 1_910_000, unit_source: 'catalog', discount_type: 'none', discount_value: 0, memo: '' },
      { kind: 'custom', product_id: null, name: '공사비', brand: '', spec: '배관·배선', qty: 1, unit_price: 1_000_000, unit_source: 'manual', discount_type: 'amount', discount_value: 260_000, memo: '현장 확인 후 확정' },
      { kind: 'custom', product_id: null, name: '출장비', brand: '', spec: '', qty: 1, unit_price: null, unit_source: 'manual', discount_type: 'none', discount_value: 0, memo: '' },
    ],
  };
  const opts = V.printOptions(quote, { company: W.CGI_COMPANY });
  const html = QP.renderHtml(opts);
  assert.match(html, /data-quote-no>Q-261120-003</);
  assert.doesNotMatch(html, /가견적/);
  assert.doesNotMatch(html, /qp-tag/);
  assert.match(html, /2026년 12월 20일까지 \(견적일로부터 30일\)/);
  assert.match(html, /062-000-0000 · a@example\.com/);
  assert.match(html, /<th>납기<\/th><td>발주 후 3주 이내 설치/);
  assert.match(html, /<th>결제 조건<\/th>/);
  assert.match(html, /할인 −260,000원 \(정가 1,000,000원\)/);
  assert.match(html, /현장 확인 후 확정/);
  assert.match(html, /별도 협의/);
  assert.doesNotMatch(html, /내부 메모/, '받는 곳 메모는 견적서에 나오지 않는다');
  assert.match(html, /data-quote-total>2,650,000</);
  assert.match(html, /금 이백육십오만원정/);
  assert.equal(QP.computeQuote(opts.items).total, quote.total_amount);
});

test('4. 주소(#)와 날짜 도우미', () => {
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(V.parseHash('#/q/12/print')), { view: 'print', id: 12 });
  assert.deepEqual(plain(V.parseHash('#/q/12')), { view: 'edit', id: 12 });
  assert.deepEqual(plain(V.parseHash('#/new')), { view: 'new' });
  assert.deepEqual(plain(V.parseHash('')), { view: 'list' });
  assert.equal(V.addDaysText('2026-12-25', 14), '2027-01-08');
  assert.deepEqual(Array.from(V.STATUS_TABS, (t) => t.label), ['전체', '작성 중', '발송', '수주', '취소']);
});

test('5. quotes.html: 관리자 머리글의 견적서 탭, 스크립트 순서, 인쇄 때 숨길 것, 이카운트 버튼 자리', () => {
  const html = read('site/quotes.html');
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<a href="quotes\.html" class="is-active" aria-current="page">견적서<\/a>/);
  const order = ['company.js', 'config.js', 'cgi-auth.js', 'cgi-search.js', 'cgi-quote-print.js', 'cgi-admin-quotes-view.js', 'cgi-admin-quotes.js'];
  const at = order.map((name) => html.indexOf(name));
  assert.ok(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1])), `순서 ${at}`);
  assert.match(html, /cgi-quote-print\.js\?v=2a/);
  assert.match(read('site/index.html'), /cgi-quote-print\.js\?v=2a/, '쇼핑몰도 같은 판을 받는다');
  assert.match(html, /class="page-head no-print"/);
  assert.match(html, /class="site-footer no-print"/);
  for (const page of ['staff.html', 'orders.html', 'ops.html']) {
    assert.match(read(`site/${page}`), /<a href="quotes\.html">견적서<\/a>/, `${page} 머리글에 견적서 탭`);
  }
  const js = read('site/assets/js/cgi-admin-quotes.js');
  assert.match(js, /aq-ecount" disabled aria-disabled="true"[^>]*>이카운트로 보내기 <small>준비 중<\/small>/);
  assert.doesNotMatch(js, /\/api\/erp|ecount\/|SaveSaleOrder/i, '이카운트로 아무것도 보내지 않는다');
  assert.match(js, /'\/api\/admin\/quotes/);
  assert.match(js, /setAttribute\('data-view', 'quote-print'\)/, '출력 화면은 #230 인쇄 규칙(body[data-view=quote-print])을 쓴다');
});

test('5. 견적서 화면 글씨는 12px 이상', () => {
  const css = read('site/assets/css/cgi-admin-quotes.css');
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 10);
  assert.ok(sizes.every((n) => n >= 12), `작은 글씨 ${sizes.filter((n) => n < 12)}`);
});
