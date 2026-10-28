// #126 상품 상태 태그 분리(splitConditionTag) 회귀 테스트.
//
// 상품 이름의 선두 [태그] 중 실제 상품 상태(박스손상/리퍼비쉬/전시상품 등)만
// 배지로 분리 표시한다. 브랜드명·한정판·마케팅 문구 접두사는 상품명에 그대로
// 남겨야 한다(원본 데이터 보존 원칙 — 표시만 분리).
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-catalog.js'), 'utf8');

/* 최소 DOM 스텁 — 부팅과 비동기 초기 렌더가 조용히 마무리되면 충분하다. */
function stubElement() {
  const el = {
    hidden: false, disabled: false, value: '', checked: false, className: '',
    attrs: {}, listeners: {}, innerHTML: '', textContent: '', style: {},
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    dispatch(type, event) { (el.listeners[type] || []).forEach((fn) => fn(event || { preventDefault() {} })); },
    getAttribute(n) { return n in el.attrs ? el.attrs[n] : null; },
    setAttribute(n, v) { el.attrs[n] = String(v); },
    removeAttribute(n) { delete el.attrs[n]; },
    hasAttribute() { return false; },
    querySelector() { return stubElement(); },
    querySelectorAll() { return []; },
    appendChild() {}, removeChild() {}, closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    scrollIntoView() {}, focus() {}, remove() {},
  };
  return el;
}

function boot() {
  const window = {
    addEventListener() {}, scrollTo() {}, setTimeout, clearTimeout,
    location: { hash: '', search: '', href: 'https://skerishkang.github.io/site/index.html' },
  };
  const document = {
    readyState: 'loading',
    getElementById() { return stubElement(); },
    createElement() { return stubElement(); },
    querySelector() { return stubElement(); },
    querySelectorAll() { return []; },
    body: stubElement(),
    addEventListener() {},
  };
  new Function('window', 'document', 'localStorage', 'fetch', 'location', 'setTimeout', 'requestAnimationFrame', SRC)(
    window, document,
    { getItem() { return null; }, setItem() {}, removeItem() {} },
    () => Promise.reject(new Error('no fetch in test')),
    window.location, setTimeout, (fn) => { fn(); });
  assert.ok(window.cgiDebug, 'window.cgiDebug 노출이 필요하다(테스트·디버깅 계약)');
  return window.cgiDebug;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('실제 상품 상태 접두사는 태그로 분리된다', async () => {
  const { splitConditionTag } = boot();
  await settle();
  const r = splitConditionTag('[박스손상] SHURE MoveMic 88+ 슈어 무선 마이크');
  assert.equal(r.tag, '박스손상');
  assert.equal(r.name, 'SHURE MoveMic 88+ 슈어 무선 마이크');
});

test('데이터에 관측된 8종 상태 태그를 모두 인정한다', async () => {
  const { splitConditionTag, CONDITION_TAGS } = boot();
  await settle();
  for (const tag of ['박스손상', '리퍼비쉬', '전시상품', '전시제품', '전시/단종 클리어런스', '단순개봉', '교환상품', '미세흠집']) {
    assert.ok(CONDITION_TAGS.includes(tag), 'CONDITION_TAGS에 ' + tag + ' 필요');
    const r = splitConditionTag('[' + tag + '] 본문 이름');
    assert.equal(r.tag, tag);
    assert.equal(r.name, '본문 이름');
  }
});

test('브랜드명·한정판 등 상태가 아닌 접두사는 상품명에 그대로 둔다', async () => {
  const { splitConditionTag } = boot();
  await settle();
  for (const name of ['[MESA BOOGIE] MESA/BOOGIE 앰프', '[KLOTZ] 케이블', '[한정판] 기타', '[Overloud] REmatrix']) {
    const r = splitConditionTag(name);
    assert.equal(r.tag, null, name + ' 은 상태 태그가 아니다');
    assert.equal(r.name, name);
  }
});

test('접두사가 없는 상품명은 그대로 반환된다', async () => {
  const { splitConditionTag } = boot();
  await settle();
  const r = splitConditionTag('NI Komplete 26 Ultimate S-Series Upgrade');
  assert.equal(r.tag, null);
  assert.equal(r.name, 'NI Komplete 26 Ultimate S-Series Upgrade');
});

test('카드·상세 렌더와 카테고리 그룹핑이 소스에 존재한다(문자열 계약)', () => {
  assert.ok(/cond\.tag \? '<div class="card-flags"/.test(SRC), '카드 조건 배지 필요');
  assert.ok(/detail-flags/.test(SRC), '상세 조건 배지 필요');
  assert.ok(/catGroupFn/.test(SRC), '카테고리 필터 그룹핑 필요');
  assert.ok(/filter-subhead/.test(SRC), '필터 그룹 헤더 필요');
});
