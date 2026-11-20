// 카탈로그 데이터 정리 2차(2026-11-20) 회귀 시험:
//   - "브랜드 미확인"으로 바뀌어 있던 노르웨이 스피커 브랜드 NNNN 복원
//   - search_text 에서 공급처 기간 할인 문구(할인판매가·할인 기간) 제외
//   - 상품 수가 줄어 남은 옛 상세 분할 파일 정리
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const catalog = JSON.parse(read('site/data/catalog.json'));
const products = JSON.parse(read('site/data/products.json'));
const brands = JSON.parse(read('site/data/brands.json'));
const builder = read('tools/build_catalog_data.py');

const NNNN_IDS = ['samasound.co.kr:2609', 'samasound.co.kr:2610', 'samamusic.co.kr:4443', 'samamusic.co.kr:4545'];

test('NNNN 스피커 4건은 브랜드 NNNN 이고, "브랜드 미확인" 값은 원본·생성물 어디에도 없다', () => {
  for (const id of NNNN_IDS) {
    const src = products.find((p) => p.id === id);
    const light = catalog.products.find((p) => p.id === id);
    assert.ok(src && light, `상품 없음: ${id}`);
    for (const p of [src, light]) {
      assert.equal(p.brand, 'NNNN', id);
      assert.equal(p.brand_raw, 'NNNN', id);
      assert.equal(p.brand_norm, 'NNNN', id);
    }
    assert.match(light.search_text, /NNNN/);
  }
  assert.ok(!JSON.stringify(products).includes('브랜드 미확인'));
  assert.ok(!JSON.stringify(catalog.products).includes('브랜드 미확인'));
  const nnnn = brands.brands.find((b) => b.name === 'NNNN');
  assert.equal(nnnn && nnnn.count, 4);
});

test('NNNN 상품은 대분류 스피커로 묶인다', () => {
  const catalogJs = read('site/assets/js/cgi-catalog.js');
  const grab = (name) => {
    const s = catalogJs.indexOf(`function ${name}(`);
    let d = 0, i = catalogJs.indexOf('{', s);
    for (; i < catalogJs.length; i++) { if (catalogJs[i] === '{') d++; else if (catalogJs[i] === '}' && --d === 0) break; }
    return catalogJs.slice(s, i + 1);
  };
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('site/data/category_map.js'), ctx);
  vm.runInContext(`var CAT_MAP = window.CGI_CATEGORY_MAP; ${grab('categoryLabel')}\n${grab('mapCategory')}\nthis.cat = function (p) { return mapCategory(categoryLabel(p), p.name); };`, ctx);
  for (const id of NNNN_IDS) {
    assert.equal(ctx.cat(catalog.products.find((p) => p.id === id)), '스피커', id);
  }
});

test('search_text 에 공급처 기간 할인 문구가 없다(상품명·모델·브랜드·분류는 그대로)', () => {
  const noisy = catalog.products.filter((p) => /할인판매가|할인 기간|남은시간/.test(p.search_text));
  assert.deepEqual(noisy.map((p) => p.id), []);
  assert.match(builder, /SEARCH_NOISE_SPEC_LABELS = \{[^}]*"할인판매가"[^}]*"할인 기간"/);
  const srcById = new Map(products.map((p) => [p.id, p]));
  let withDiscountSpec = 0;
  for (const p of catalog.products) {
    const src = srcById.get(p.id);
    if ((src.specs || []).some((s) => s.label === '할인판매가')) {
      withDiscountSpec++;
      if (src.model) assert.ok(p.search_text.includes(src.model), `모델명 빠짐: ${p.id}`);
      if (src.brand) assert.ok(p.search_text.includes(src.brand), `브랜드 빠짐: ${p.id}`);
    }
    if (p.name) assert.ok(p.search_text.includes(src.name), `상품명 빠짐: ${p.id}`);
  }
  assert.ok(withDiscountSpec >= 80, `할인 사양 상품 수: ${withDiscountSpec}`);
});

test('상세 분할 파일은 catalog.meta.detail_parts 개뿐이고, 상품의 shard 가 모두 그 안에 있다', () => {
  const parts = readdirSync(join(ROOT, 'site/data/details')).filter((f) => /^part-\d{4}\.json$/.test(f)).sort();
  const n = catalog.meta.detail_parts;
  assert.equal(parts.length, n);
  assert.deepEqual(parts, Array.from({ length: n }, (_, i) => `part-${String(i + 1).padStart(4, '0')}.json`));
  assert.ok(catalog.products.every((p) => p.shard >= 1 && p.shard <= n));
  assert.match(builder, /stale\.unlink\(\)/);
});
