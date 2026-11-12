// 이슈 #216 G2·G3 회귀 — 중복 상품 병합과 대분류 정리.
//
//   G2  같은 상품 두 번 나오지 않는다. 남긴 쪽은 가격 공개 상품(id·이름·가격·사진 그대로),
//       없어진 id 주소는 남긴 상품으로 이동한다.
//   G3  케이블 규칙의 넓은 키워드(디지털·파워)를 정확한 분류명으로 바꾸고,
//       넓은 분류에 남는 상품은 상품명 보조 규칙으로 나눈다.
//
//   node --test site/test/cgi-merge-216.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const catalog = JSON.parse(read('site/data/catalog.json'));
const catalogJs = read('site/assets/js/cgi-catalog.js');
const indexHtml = read('site/index.html');
const mapSource = read('site/data/category_map.js');

const mergeWin = {};
new Function('window', read('site/data/product_merge.js'))(mergeWin);
const MERGE = mergeWin.CGI_PRODUCT_MERGE || {};

const mapWin = {};
new Function('window', mapSource)(mapWin);
const map = mapWin.CGI_CATEGORY_MAP;

const modelKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const byId = new Map(catalog.products.map((p) => [p.id, p]));
const priced = catalog.products.filter((p) => p.price && p.price.state === 'public');
const inquiry = catalog.products.filter((p) => !p.price || p.price.state !== 'public');

/* --------------------------------- G2 --------------------------------- */

test('G2: 병합 치환표의 쌍은 유효하다(없어진 id 는 목록에, 남긴 id 는 가격 공개)', () => {
  assert.ok(Object.keys(MERGE).length > 500, '병합이 실제로 적용됐다');
  for (const [removed, kept] of Object.entries(MERGE)) {
    assert.equal(byId.get(removed), undefined, `병합됐는데 목록에 남았다: ${removed}`);
    const keptProduct = byId.get(kept);
    assert.ok(keptProduct, `남긴 상품이 목록에 없다: ${kept}`);
    assert.equal(keptProduct.price.state, 'public', `남긴 상품이 가격 공개가 아니다: ${kept}`);
  }
});

test('G2: 전체 상품 수와 가격 공개 수', () => {
  assert.equal(catalog.products.length, 4026, '4546 − 병합 520');
  assert.equal(priced.length, 2088, '가격 공개 상품 수는 병합 전후 같다');
});

test('G2: 남은 상품 중 규칙에 걸리는 병합 가능 쌍은 더 없다(고정점)', () => {
  // 빌더와 같은 규칙을 원본(products.json)에 다시 적용했을 때 새로 병합될 쌍이
  // 없어야 한다 — 후보가 둘 이상이거나 상태 태그가 있으면 애초에 병합하지 않는다.
  const products = JSON.parse(read('site/data/products.json'));
  const CONDITION = new Set(['박스손상', '리퍼비쉬', '전시상품', '전시제품', '전시/단종 클리어런스',
    '단순개봉', '교환상품', '미세흠집', '입고후발송', '커버 무료증정']);
  const tagged = (p) => {
    const m = String(p.name || '').trim().match(/^\[([^\]]+)\]/);
    return !!(m && CONDITION.has(m[1].trim()));
  };
  const consumed = new Set(Object.keys(MERGE));
  const inquiryIndex = new Map();
  for (const q of products) {
    if (q.price && q.price.state === 'public') continue;
    if (consumed.has(q.id)) continue;
    const brand = (q.brand_norm || '').trim();
    const key = modelKey(q.name);
    if (!brand || key.length < 4) continue;
    const k = brand + '|' + key;
    if (!inquiryIndex.has(k)) inquiryIndex.set(k, []);
    inquiryIndex.get(k).push(q);
  }
  let mergeable = 0;
  for (const p of products) {
    if (!p.price || p.price.state !== 'public') continue;
    if (consumed.has(p.id)) continue; // 남긴 쪽은 catalog.json 에 있다
    const brand = (p.brand_norm || '').trim();
    const key = modelKey(p.model);
    if (!brand || key.length < 4 || tagged(p)) continue;
    if (inquiryIndex.get(brand + '|' + key)?.length === 1) mergeable++;
  }
  assert.equal(mergeable, 0, '병합 규칙에 걸리는 쌍이 남아 있다');
});

test('G2: 상태 태그가 붙은 상품은 병합하지 않았다', () => {
  const products = JSON.parse(read('site/data/products.json'));
  const byIdFull = new Map(products.map((p) => [p.id, p]));
  const CONDITION = new Set(['박스손상', '리퍼비쉬', '전시상품', '전시제품', '전시/단종 클리어런스',
    '단순개봉', '교환상품', '미세흠집', '입고후발송', '커버 무료증정']);
  const tagged = (id) => {
    const p = byIdFull.get(id);
    if (!p) return false;
    const m = String(p.name || '').trim().match(/^\[([^\]]+)\]/);
    return !!(m && CONDITION.has(m[1].trim()));
  };
  for (const removed of Object.keys(MERGE)) {
    assert.ok(!tagged(removed), `상태 태그 상품이 병합됐다: ${removed}`);
  }
});

test('G2: 없어진 id 주소는 남긴 상품으로 이동한다', () => {
  assert.match(indexHtml, /<script src="data\/product_merge\.js\?v=[0-9a-z]+"><\/script>/);
  assert.match(catalogJs, /var mergeMap = window\.CGI_PRODUCT_MERGE \|\| \{\};/);
  assert.match(catalogJs, /location\.replace\('#\/product\/' \+ encodeURIComponent\(keptId\)\)/);
  // 견적 목록 등 다른 경로도 남긴 상품으로 해석된다.
  assert.match(catalogJs, /var keptId = mergeMap\[id\];/);
  assert.match(catalogJs, /병합으로 없어진 id 는 남긴 상품으로 대신한다/);
});

test('G2: 병합으로 얻은 구체 분류 경로와 상품요약정보를 채택했다', () => {
  const products = JSON.parse(read('site/data/products.json'));
  const byIdFull = new Map(products.map((p) => [p.id, p]));
  let adoptedPath = 0, adoptedSummary = 0;
  for (const [removed, kept] of Object.entries(MERGE)) {
    const dup = byIdFull.get(removed);
    const keptProduct = byId.get(kept);
    const dupPath = (dup.category_path || []);
    if (dupPath.length >= 3 && dupPath[1] === '제품분류별 보기') {
      assert.equal(keptProduct.category.name, dup.category.name,
        `남긴 상품의 분류가 가격 문의 쪽 경로를 따르지 않는다: ${kept}`);
      adoptedPath++;
    }
    const dupSummary = (dup.specs || []).find((s) => String(s.label || '').trim() === '상품요약정보' && String(s.value || '').trim());
    if (dupSummary && !(byIdFull.get(kept).specs || []).some((s) => String(s.label || '').trim() === '상품요약정보')) {
      const detailShard = JSON.parse(read(`site/data/details/part-${String(keptProduct.shard).padStart(4, '0')}.json`));
      const detail = (detailShard.products || []).find((row) => row.id === kept);
      assert.ok(detail, `상세 분할에 남긴 상품이 없다: ${kept}`);
      assert.ok((detail.specs || []).some((s) => String(s.label || '').trim() === '상품요약정보'),
        `상품요약정보가 채택되지 않았다: ${kept}`);
      adoptedSummary++;
    }
  }
  assert.ok(adoptedPath > 400, '분류 경로 채택 건수가 비정상적으로 적다');
  assert.ok(adoptedSummary > 50, '상품요약정보 채택 건수가 비정상적으로 적다');
});

/* --------------------------------- G3 --------------------------------- */

function mapCategory(label, productName) {
  if (map.exact && Object.prototype.hasOwnProperty.call(map.exact, label)) return map.exact[label];
  const broad = map.broadCategories || [];
  if (broad.includes(label) && productName) {
    for (const rule of map.broadRules || []) {
      for (const kw of rule.keywords || []) {
        if (String(productName).includes(kw)) return rule.group;
      }
    }
  }
  for (const rule of map.rules) {
    for (const kw of rule.keywords || []) {
      if (label.includes(kw)) return rule.group;
    }
    for (const kw of rule.exactKeywords || []) {
      if (label === kw) return rule.group;
    }
  }
  return map.fallback;
}

test('G3: "디지털 믹서" 분류 상품은 믹서·프로세서다', () => {
  const digitalMixers = catalog.products.filter((p) => p.category.name === '디지털 믹서');
  assert.equal(digitalMixers.length, 32);
  for (const p of digitalMixers) {
    assert.equal(mapCategory(p.category.name, p.name), '믹서·프로세서', p.id);
  }
});

test('G3: 케이블 규칙의 넓은 키워드는 정확한 분류명으로 바뀌었다', () => {
  const cableRule = map.rules.find((r) => r.group === '케이블·커넥터');
  assert.ok(!cableRule.keywords.includes('디지털'), '넓은 키워드 디지털 이 남아 있다');
  assert.ok(!cableRule.keywords.includes('파워'), '넓은 키워드 파워 가 남아 있다');
  assert.deepEqual(cableRule.exactKeywords, ['파워', '디지털']);
});

test('G3: 넓은 분류에 남는 상품은 상품명 보조 규칙으로 나뉜다', () => {
  assert.deepEqual(map.broadCategories, ['레코딩', '레코딩/음향', '악기/앰프', '액세서리', '스피커', '마이크']);
  assert.ok((map.broadRules || []).length >= 5, '보조 규칙이 있다');
  // 보조 규칙 예: 레코딩 분류의 플러그인은 소프트웨어·플러그인으로
  assert.equal(mapCategory('레코딩', 'TH-U 오버라우드 플러그인 (전자배송)'), '소프트웨어·플러그인');
  // 보조 규칙 예: 액세서리 분류의 믹서 랙 날개는 스탠드·거치로(랙 날개가 믹서보다 먼저)
  assert.equal(mapCategory('액세서리', 'PreSonus StudioLive AR8 믹서 전용 랙 날개'), '스탠드·거치');
  // 보조 규칙 예: 마이크 분류의 마이크 스탠드는 스탠드·거치로(#216 이슈 예시)
  assert.equal(mapCategory('마이크', 'K&M 마이크 스탠드'), '스탠드·거치');
  // 보조 규칙에 걸리지 않으면 기존 규칙 그대로
  assert.equal(mapCategory('레코딩', '오디오 인터페이스 2채널'), '레코딩·인터페이스');
  assert.equal(mapCategory('악기/앰프', '메사부기 기타 앰프'), '악기·앰프');
});

test('G3: 화면은 상품명 보조 규칙까지 쓴다', () => {
  assert.match(catalogJs, /function mapCategory\(label, productName\)/);
  assert.match(catalogJs, /CAT_MAP\.broadCategories/);
  assert.match(catalogJs, /CAT_MAP\.broadRules/);
  assert.match(catalogJs, /p\._cat = mapCategory\(categoryLabel\(p\), p\.name\)/);
});
