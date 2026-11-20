#!/usr/bin/env node
// 첫 화면 '추천 상품' 자동 선정 → site/data/featured.json (상품 id 배열).
//
// 학교·교회·관공서 설치 고객이 찾는 대표 품목(무선마이크, PA·설치 스피커, 믹서, 앰프,
// 회의용 마이크) 그룹마다 아래 조건을 통과한 상품 중 상위 몇 개를 고른다.
//   - 가격 공개(10만 원 이상), 사진 있음, 상품명에 리퍼·박스손상·전시·단종·클리어런스 없음
//   - 재고 있음: 재고를 관리하는 상품은 표시 재고 1개 이상, 재고를 관리하지 않는
//     상품(공급처 '재고미관리')은 주문 가능으로 본다. 재고 정보가 없으면 제외.
//   - 정렬: 재고 수량이 표시된 상품 먼저 → 가격 높은 순. 그룹마다 브랜드당 하나 또는
//     기본 모델('/' 앞)당 하나만.
// 사이트는 featured.json 의 id 를 그 순서대로 첫 화면에 보여 주고, 파일이 비어 있으면
// 기존 규칙(pickFeatured)을 쓴다. 담당자가 이 파일을 직접 고쳐도 된다.
//
//   node tools/build_featured.mjs            # site/data/featured.json 을 다시 쓴다
//   node tools/build_featured.mjs --check    # 쓰지 않고 선정 결과만 출력
//
// 대분류는 사이트와 똑같이 site/data/category_map.js + cgi-catalog.js 의 mapCategory 로 계산한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

export const DEMOTE_RE = /리퍼|박스손상|전시|단종|클리어런스/;
/** 대표 품목만: 부속품이 섞이지 않게 10만 원 이상 */
export const MIN_PRICE = 100000;

/** 그룹 정의: 대분류 + 상품명 용도어, 부속품 제외. quota = 이 그룹에서 고를 수. */
export const GROUPS = [
  {
    id: 'wireless-mic', label: '무선마이크', quota: 3, distinct: 'model',
    cats: ['마이크·무선'],
    include: /무선\s?마이크.*(세트|시스템)/,  // 완성 세트(송·수신기 함께)만
    // MoveMic 은 스마트폰·크리에이터용(설치 고객 대상 아님), 송신기·수신기 단품은 세트가 아니라 뺀다.
    exclude: /커버|윈드|배터리|케이블|어댑터|안테나|충전|케이스|그릴|클립|마운트|핸들|MoveMic|단품|송신기만|수신기만/,
  },
  {
    id: 'pa-speaker', label: 'PA·설치 스피커', quota: 3, distinct: 'brand',
    cats: ['스피커'],
    include: /라우드|PA|설치|인스톨|컬럼|라인어레이|포터블|실링|천장|월 스피커|서피스/,
    exclude: /스탠드|커버|케이블|브라켓|브래킷|마운트|리깅|프레임|홈 오디오|앰프|루퍼|기타/,
  },
  {
    id: 'mixer', label: '믹서', quota: 2, distinct: 'brand',
    cats: ['믹서·프로세서'],
    include: /믹서/,
    exclude: /퍼스널|커버|케이스|가방/,
  },
  {
    id: 'amplifier', label: '앰프', quota: 2, distinct: 'brand',
    cats: ['스피커', '믹서·프로세서', '네트워크·회의영상', '액세서리·소모품'],
    include: /파워\s?앰프|Power Amplifier|믹싱\s?앰프|방송용\s?앰프/i,
    exclude: /케이블|커버|랙 날개/,
  },
  {
    id: 'conference-mic', label: '회의용 마이크', quota: 2, distinct: 'model',
    cats: ['마이크·무선', '네트워크·회의영상'],
    include: /회의|구즈넥|바운더리|Microflex|MXA/i,
    exclude: /악기|케이블|커버|윈드|배터리|마운트|어댑터|브라켓|세트, \d+MM/,
  },
];

/** 재고: 'in'(표시 재고 ≥1) | 'untracked'(재고 미관리, 주문 가능) | 'out' | null(정보 없음) */
export function stockState(product) {
  let a;
  try { a = JSON.parse(product.availability || ''); } catch { return null; }
  if (!a || typeof a !== 'object') return null;
  if (a.use_stock === true) return Number(a.stock_number_displayed || 0) > 0 ? 'in' : 'out';
  if (a.use_stock === false) return 'untracked';
  return null;
}

export function eligible(product) {
  const st = stockState(product);
  return !!(product.price && product.price.state === 'public' && typeof product.price.value === 'number' && product.price.value >= MIN_PRICE &&
    product.images && product.images.length && !DEMOTE_RE.test(product.name || '') && (st === 'in' || st === 'untracked'));
}

/** 그룹 안에서 겹치지 않게 할 기준: 'brand'(브랜드당 하나) 또는 'model'(기본 모델당 하나, '/' 앞). */
export function distinctKey(product, mode) {
  const brand = product.brand_norm || product.brand || '';
  if (mode === 'brand') return brand;
  const model = String(product.model || product.name || '').toUpperCase().split('/')[0].replace(/\s+/g, '');
  return brand + '|' + model;
}

export function loadMapCategory() {
  const src = read('site/assets/js/cgi-catalog.js');
  const grab = (name) => {
    const s = src.indexOf(`function ${name}(`);
    let d = 0, i = src.indexOf('{', s);
    for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
    return src.slice(s, i + 1);
  };
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('site/data/category_map.js'), ctx);
  vm.runInContext(`var CAT_MAP = window.CGI_CATEGORY_MAP; ${grab('categoryLabel')}\n${grab('mapCategory')}\nthis.cat = function (p) { return mapCategory(categoryLabel(p), p.name); };`, ctx);
  return ctx.cat;
}

export function selectFeatured(products, catOf) {
  const out = [];
  const used = new Set();
  for (const g of GROUPS) {
    const pool = products.filter((p) => g.cats.includes(catOf(p)) && g.include.test(p.name || '') && !g.exclude.test(p.name || ''));
    const ok = pool.filter(eligible).sort((a, b) => {
      const sa = stockState(a) === 'in' ? 0 : 1, sb = stockState(b) === 'in' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (b.price.value !== a.price.value) return b.price.value - a.price.value;
      return String(a.id).localeCompare(String(b.id));
    });
    const seen = new Set();
    const picks = [];
    for (const p of ok) {
      if (picks.length >= g.quota) break;
      const key = distinctKey(p, g.distinct);
      if (seen.has(key) || used.has(p.id)) continue;
      seen.add(key); used.add(p.id); picks.push(p);
    }
    out.push({ group: g, poolSize: pool.length, eligibleCount: ok.length, picks });
  }
  return out;
}

/** 그룹을 번갈아 늘어놓는다(무선마이크·스피커·믹서·무선마이크…) — 같은 브랜드가 연달아 나오지 않게.
    featured.json 의 id 는 추천순 목록 맨 앞에도 고정되므로(#213 D1) 순서가 화면 순서다. */
export function interleave(result) {
  const ids = [];
  const max = Math.max(0, ...result.map((r) => r.picks.length));
  for (let i = 0; i < max; i++) for (const r of result) if (r.picks[i]) ids.push(r.picks[i].id);
  return ids;
}

function main() {
  const check = process.argv.includes('--check');
  const catalog = JSON.parse(read('site/data/catalog.json'));
  const catOf = loadMapCategory();
  const result = selectFeatured(catalog.products, catOf);
  for (const r of result) {
    console.log(`## ${r.group.label} — 해당 ${r.poolSize}건, 조건 통과 ${r.eligibleCount}건, 선정 ${r.picks.length}/${r.group.quota}`);
    for (const p of r.picks) console.log(`  ${p.id}\t${p.price.value.toLocaleString('ko-KR')}원\t${stockState(p)}\t${p.name}`);
  }
  const ids = interleave(result);
  console.log('표시 순서: ' + ids.join(', '));
  if (!check) {
    writeFileSync(join(ROOT, 'site/data/featured.json'), JSON.stringify(ids, null, 1) + '\n');
    console.log(`wrote site/data/featured.json (${ids.length} ids)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
