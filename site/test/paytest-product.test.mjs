import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));

const PAYTEST_ID = 'cgi:paytest-1000';
const catalog = readJson('site/data/catalog.json');
const brands = readJson('site/data/brands.json');
const products = readJson('site/data/products.json');
const paytest = readJson('site/data/paytest.json');

test('paytest definition is a single hidden public-priced product', () => {
  assert.equal(paytest.id, PAYTEST_ID);
  assert.equal(paytest.name, '결제 확인용 상품 · 구매 불가');
  assert.equal(paytest.price.state, 'public');
  assert.equal(paytest.price.value, 1000);
  assert.equal(paytest.max_qty, 1);
  assert.equal(paytest.hidden, true);
  assert.deepEqual(paytest.images, []);
  assert.equal(paytest.brand, '');
});

test('paytest is absent from listings, counts, brands, build inputs and detail shards', () => {
  assert.equal(catalog.products.some((p) => p.id === PAYTEST_ID), false);
  assert.equal(catalog.products.some((p) => /결제 확인용/.test(p.name)), false);
  assert.equal(products.some((p) => p.id === PAYTEST_ID), false, 'definition must not leak into products.json');
  assert.equal(brands.brands.some((b) => /결제 확인용/.test(b.name)), false);
  assert.equal(brands.product_count, catalog.products.length);

  const detailDir = join(ROOT, 'site', 'data', 'details');
  for (const name of readdirSync(detailDir).filter((entry) => entry.endsWith('.json'))) {
    const text = readFileSync(join(detailDir, name), 'utf8');
    assert.equal(text.includes(PAYTEST_ID), false, `detail shard ${name} exposes the hidden product`);
  }
});

test('G1 non-product payment pages stay excluded from every catalog source', () => {
  const nonProduct = /결제창|잔금|계약금/;
  for (const p of catalog.products) assert.equal(nonProduct.test(p.name), false, `catalog has ${p.id}`);
  for (const p of products) assert.equal(nonProduct.test(p.name), false, `products.json has ${p.id}`);
  assert.equal(catalog.products.length, 4026);
  assert.equal(catalog.products.filter((p) => p.price && p.price.state === 'public').length, 2088);
});

test('price index carries the hidden product at 1,000 KRW', () => {
  const source = readFileSync(join(ROOT, 'backend', 'data', 'price_index.mjs'), 'utf8');
  assert.match(source, /"cgi:paytest-1000":\{"p":1000/);
  assert.match(source, /hidden_paytest_product: cgi:paytest-1000/);
  assert.match(source, /products_with_price: 2089/);
});

test('runtime wiring exposes the hidden product only to detail and cart lookup', () => {
  const html = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
  assert.match(html, /data\/paytest\.js\?v=/);
  assert.ok(html.indexOf('data/paytest.js') < html.indexOf('cgi-catalog.js'));
  const runtime = readFileSync(join(ROOT, 'site', 'data', 'paytest.js'), 'utf8');
  assert.match(runtime, /window\.CGI_PAYTEST_PRODUCT =/);

  const catalogJs = readFileSync(join(ROOT, 'site', 'assets', 'js', 'cgi-catalog.js'), 'utf8');
  assert.match(catalogJs, /function hiddenProduct\(\)/);
  assert.match(catalogJs, /var hidden = hiddenProduct\(\);/);
  const orderJs = readFileSync(join(ROOT, 'site', 'assets', 'js', 'cgi-order.js'), 'utf8');
  assert.match(orderJs, /var hidden = window\.CGI_PAYTEST_PRODUCT;/);
});
