// 약관 줄(전자상거래법 필수 표기) 회귀 테스트.
//
// 값이 확정된 항목만 표기하고, 비어 있는 항목은 "확인 예정" 같은 자리 문구 없이
// 그 항목 자체를 만들지 않는다. 사업자등록번호가 두 번 찍히던 중복 문구를 막는다.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-catalog.js'), 'utf8');

const cfgSandbox = createContext({ window: {} });
runInContext(readFileSync(join(HERE, '..', 'config.js'), 'utf8'), cfgSandbox);
const CFG = cfgSandbox.window.CGI_SITE_CONFIG;

/* 최소 DOM 스텁 — 부팅이 조용히 끝나고 약관 줄 요소만 잡히면 충분하다. */
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

function boot(legalEl) {
  const window = {
    addEventListener() {}, scrollTo() {}, setTimeout, clearTimeout,
    location: { hash: '', search: '', href: 'https://skerishkang.github.io/site/index.html' },
  };
  const document = {
    readyState: 'loading',
    getElementById() { return stubElement(); },
    createElement() { return stubElement(); },
    querySelector(sel) { return sel === '[data-legal-info]' ? legalEl : stubElement(); },
    querySelectorAll() { return []; },
    body: stubElement(),
    addEventListener() {},
  };
  new Function('window', 'document', 'localStorage', 'fetch', 'location', 'setTimeout', 'requestAnimationFrame', SRC)(
    window, document,
    { getItem() { return null; }, setItem() {}, removeItem() {} },
    () => Promise.reject(new Error('no fetch in test')),
    window.location, setTimeout, (fn) => { fn(); });
  assert.ok(window.cgiDebug && window.cgiDebug.renderLegalInfo, 'renderLegalInfo 노출이 필요하다');
  return window.cgiDebug;
}

function legalLine(cfg) {
  const el = stubElement();
  boot(el).renderLegalInfo(cfg);
  return el.innerHTML;
}

test('약관 줄은 확정된 사업자등록번호를 한 번만 표기하고 확인 예정 문구를 쓰지 않는다', () => {
  assert.equal(CFG.legal.bizRegNo, '410-86-46283', 'config 의 사업자등록번호가 사이트 값과 같아야 한다');
  assert.equal(CFG.legal.mailOrderNo, '2025-전남장성-94', '대표가 확인한 신고번호를 사용해야 한다');
  const line = legalLine(CFG);
  assert.equal((line.match(/410-86-46283/g) || []).length, 1, '사업자등록번호는 한 번만 나와야 한다');
  assert.equal((line.match(/통신판매업신고 2025-전남장성-94/g) || []).length, 1, '신고번호는 한 번만 나와야 한다');
  assert.doesNotMatch(line, /개인정보보호책임자/, '확정되지 않은 책임자는 표시하지 않는다');
  assert.doesNotMatch(line, /확인 예정/, '미확정 자리 문구가 약관 줄에 남아 있다');
  assert.doesNotMatch(line, /사업자등록번호 확인/, '사업자등록번호 뒤에 기본 문구가 붙는다');
  assert.match(line, /© 주식회사 시지아이/);
  assert.match(line, /이용약관/);
});

test('값이 비어 있는 항목은 약관 줄에서 만들지 않는다', () => {
  const line = legalLine({ legal: {} });
  assert.doesNotMatch(line, /확인 예정/);
  assert.doesNotMatch(line, /사업자등록번호/);
  assert.doesNotMatch(line, /통신판매업신고/);
  assert.doesNotMatch(line, /개인정보보호책임자/);
  assert.match(line, /© 주식회사 시지아이/);
});

test('확정된 신고번호와 책임자는 값이 있을 때 한 번만 표기된다', () => {
  const line = legalLine({
    legal: {
      bizRegNo: '410-86-46283',
      mailOrderNo: '제2026-0001호',
      privacyOfficerName: '홍길동',
      privacyOfficerEmail: 'privacy@example.com',
    },
  });
  assert.equal((line.match(/제2026-0001호/g) || []).length, 1);
  assert.match(line, /개인정보보호책임자 홍길동 \(privacy@example\.com\)/);
});
