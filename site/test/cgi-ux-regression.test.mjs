import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const html = read('site/index.html');
const js = read('site/assets/js/cgi-catalog.js');
const css = read('site/assets/css/cgi-catalog.css');

test('home and list cards share image selection, dimensions, fit, and failure fallback', () => {
  assert.match(js, /function cardHtml\(product, priority\)[\s\S]*imageHtml\(product, 'card-img', priority\)/);
  assert.match(js, /function renderHome\(\)[\s\S]*?gridHtml\(featured, true\)/);
  assert.match(js, /function renderList\(\)[\s\S]*?gridHtml\(pageItems\)/);
  assert.match(js, /function imageHtml\(product, className, priority\)[\s\S]*?width="400" height="400"[\s\S]*?onerror="window\.cgiHandleImageError\(this\)"/);
  assert.match(css, /\.card-img\s*\{[^}]*object-fit:\s*contain/);
  assert.match(js, /window\.cgiHandleImageError[\s\S]*replaceChild/);
});

test('home has one search field and the green hero offers category and brand shortcuts', () => {
  assert.equal((html.match(/type="search"/g) || []).length, 1);
  assert.doesNotMatch(js, /class="hero-search"/);
  assert.match(js, /hero-quicklinks/);
  assert.match(js, /quickCategories/);
  assert.match(js, /quickBrands/);
});

test('product condition and fulfillment prefixes are rendered as small badges', () => {
  assert.match(js, /'입고후발송'/);
  assert.match(js, /'커버 무료증정'/);
  assert.match(js, /\|\\\(\(\[\^\)\]\+\)\\\)\)/);
});

test('cards keep useful inquiry badges and omit the public-sale badge', () => {
  assert.match(js, /badge inquiry/);
  assert.doesNotMatch(js, /class="badge">공개 판매가/);
});

test('seller footer shows confirmed company facts and the configured mail-order number', () => {
  const seller = html.match(/<section class="footer-seller"[\s\S]*?<\/section>/)?.[0] || '';
  for (const value of ['주식회사 시지아이', '김범신, 백정아', '410-86-46283', '전라남도 장성군 남면 나노산단로 102', '062) 576-8100']) {
    assert.ok(seller.includes(value), '판매자 정보에 누락: ' + value);
  }
  assert.match(seller, /<div data-mail-order-row hidden><dt>통신판매업신고<\/dt><dd data-mail-order-no><\/dd><\/div>/);
  assert.match(js, /mailOrderEl\.textContent = mailOrderNo/);
  assert.match(js, /mailOrderRow\.hidden = !mailOrderNo/);
});

test('seller footer no longer contains the stale hidden disclosure placeholder', () => {
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(visible, /\[대표 결정\]/, '미확정 값이 화면에 노출된다');
  assert.doesNotMatch(html, /<!--[\s\S]*통신판매업 신고번호[\s\S]*-->/, '지난 신고번호 숨김 주석이 남아 있다');
  assert.doesNotMatch(js, /\[대표 결정\]/);
  assert.match(js, /if \(mailOrderNo\) parts\.push\('통신판매업신고 ' \+ esc\(mailOrderNo\)\)/,
    '신고번호는 값이 확정된 경우에만 표기해야 한다');
});
