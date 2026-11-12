// 상품 데이터 분할(PR-3) 회귀: 목록용 경량 파일과 상세 분할 파일이 원본
// products.json 과 같은 값을 보여야 하고, 검색 인덱스도 전후가 같아야 한다.
//
//   node --test site/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const full = JSON.parse(readFileSync(join(DATA, 'products.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(DATA, 'catalog.json'), 'utf8'));
const brands = JSON.parse(readFileSync(join(DATA, 'brands.json'), 'utf8'));
const light = catalog.products || [];
const lightById = new Map(light.map((p) => [p.id, p]));
const fullById = new Map(full.map((p) => [p.id, p]));

/** cgi-catalog.js 의 norm() 과 같은 규칙. */
function norm(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[()[\]/,.·]/g, '');
}

function searchSource(p) {
  const category = (p.category && p.category.name) ||
    ((p.category_path && p.category_path.length) ? p.category_path[p.category_path.length - 1] : '미분류');
  return [p.name, p.model, p.brand, p.brand_raw, p.manufacturer, category,
    (p.category_path || []).join(' '),
    (p.specs || []).map((s) => s.label + ' ' + s.value).join(' ')].join(' ');
}

// catalog.json 의 name 은 화면용 이름이다 (#209 A5): 공급처 문구 접두사와 SCM 코드는
// 빠지고, 상품 상태 태그([리퍼비쉬] 등)는 배지 분리를 위해 남는다. 원본 products.json
// 의 name 은 그대로여야 한다. tools/build_catalog_data.py 의 display_name() 과 같은 규칙.
const CONDITION_TAGS = new Set([
  '박스손상', '리퍼비쉬', '전시상품', '전시제품', '전시/단종 클리어런스',
  '단순개봉', '교환상품', '미세흠집', '입고후발송', '커버 무료증정',
]);

function displayName(raw) {
  const original = String(raw || '').replace(/\s+/g, ' ').trim();
  let s = original.replace(/\bSCM[-_]?\s?\d+(?:\s*,\s*SCM[-_]?\s?\d+)*\b/gi, ' ');
  for (;;) {
    const m = s.match(/^(?:\[([^\]]+)\]|\(([^)]+)\))\s*/);
    if (!m) break;
    const tag = (m[1] || m[2] || '').trim();
    if (CONDITION_TAGS.has(tag)) break;
    s = s.slice(m[0].length).trim();
  }
  s = s.replace(/\s{2,}/g, ' ').replace(/^[-·,\s]+|[-·,\s]+$/g, '');
  return s || original;
}

test('catalog.json covers every product and keeps list fields identical', () => {
  assert.equal(light.length, full.length, 'product count is preserved');
  assert.deepEqual([...lightById.keys()].sort(), [...fullById.keys()].sort());

  const sample = full.filter((_, i) => i % Math.max(1, Math.floor(full.length / 12)) === 0).slice(0, 12);
  for (const source of sample) {
    const p = lightById.get(source.id);
    assert.ok(p, `missing light ${source.id}`);
    assert.equal(p.name, displayName(source.name), 'catalog name is the display name');
    assert.equal(p.brand, source.brand);
    assert.equal(p.brand_norm, source.brand_norm);
    assert.equal(p.model, source.model);
    assert.equal(p.manufacturer, source.manufacturer);
    assert.deepEqual(p.price, source.price);
    assert.equal(p.availability, source.availability);
    assert.equal((p.category || {}).name, (source.category || {}).name);
    assert.equal(p.images[0] || null, (source.images || [])[0] || null, 'one representative image');
    assert.equal(p.images.length, Math.min(1, (source.images || []).length));
  }
});

test('detail shards restore specs, options, all images and source URL', () => {
  const sample = full.filter((_, i) => i % Math.max(1, Math.floor(full.length / 12)) === 0).slice(0, 12);
  for (const source of sample) {
    const p = lightById.get(source.id);
    assert.ok(Number.isInteger(p.shard) && p.shard > 0, `${source.id} has a shard`);
    const file = join(DATA, 'details', `part-${String(p.shard).padStart(4, '0')}.json`);
    assert.ok(existsSync(file), `missing ${file}`);
    const part = JSON.parse(readFileSync(file, 'utf8'));
    const detail = (part.products || []).find((row) => row.id === source.id);
    assert.ok(detail, `${source.id} present in its shard`);
    assert.deepEqual(detail.specs, source.specs || []);
    assert.deepEqual(detail.options, source.options || []);
    assert.deepEqual(detail.images, source.images || []);
    assert.equal((detail.source || {}).url || '', (source.source || {}).url || '');
  }
});

test('search index is unchanged after the split (name/brand/model/category/spec text)', () => {
  const sample = full.filter((_, i) => i % Math.max(1, Math.floor(full.length / 40)) === 0);
  for (const source of sample) {
    const p = lightById.get(source.id);
    assert.equal(norm(p.search_text), norm(searchSource(source)), `${source.id} search text`);
  }
});

test('brands.json counts match the full master', () => {
  const counts = {};
  for (const p of full) {
    const key = (p.brand_norm || p.brand || '').trim();
    if (key) counts[key] = (counts[key] || 0) + 1;
  }
  assert.equal(brands.product_count, full.length);
  // Order is by count then name; compare as a set of (name, count) pairs so a
  // locale-specific tie order cannot make this brittle.
  assert.deepEqual(
    Object.fromEntries(brands.brands.map((b) => [b.name, b.count])),
    counts,
  );
  assert.equal(brands.brands.length, Object.keys(counts).length);
});

test('the list file is materially smaller than the full master', () => {
  const catalogBytes = readFileSync(join(DATA, 'catalog.json')).byteLength;
  const fullBytes = readFileSync(join(DATA, 'products.json')).byteLength;
  assert.ok(catalogBytes < fullBytes, 'catalog.json must be smaller');
  assert.ok(catalogBytes < fullBytes * 0.75, `catalog.json ${catalogBytes}B should be < 75% of ${fullBytes}B`);
});

test('pages no longer load the 11MB products.js synchronously', () => {
  for (const page of ['index.html', 'orders.html', 'staff.html', 'sync.html']) {
    const src = readFileSync(join(HERE, '..', page), 'utf8');
    assert.ok(!src.includes('data/products.js'), `${page} must not load products.js`);
  }
  const index = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
  assert.match(index, /assets\/js\/cgi-catalog\.js\?v=/);
});
