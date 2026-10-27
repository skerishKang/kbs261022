// Regression tests for the quote cart's quantity surfaces (index.html, #/quote-cart).
//
// The stepper and the qty input used to call refreshCartPreview(), which repainted
// only the 요청 내용 미리보기 <pre>. The page-head aggregate ("2개 상품 · 총 3점"),
// the 주문 금액 line and the rows kept whatever the last full render had put there,
// so a quantity change looked half-applied. These tests boot the real cgi-catalog.js
// against the real element ids and drive the real document handlers, so the proof is
// the painted screen rather than an internal helper.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-catalog.js'), 'utf8');
const SHELL = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
const API = 'https://cgi-quote-api.example.workers.dev';
const ORIGIN = 'https://skerishkang.github.io';

/** Ids the static page owns; anything else exists only once the app has rendered it. */
const SHELL_IDS = new Set([...SHELL.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const PRODUCT_A = {
  id: 'samamusic.co.kr:2574', name: 'SHURE RMCE-TW2', brand: 'SHURE', category: '이어폰',
  images: [], price: { state: 'public', value: 368000 },
};
const PRODUCT_B = {
  id: 'samamusic.co.kr:1001', name: 'RODE NT-USB Mini', brand: 'RODE', category: '마이크',
  images: [], price: { state: 'public', value: 249000 },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ------------------------------------------------------------ stub DOM */

function makeElement(id, host) {
  const listeners = {};
  const attrs = {};
  const element = {
    id,
    hidden: false,
    disabled: false,
    value: '',
    checked: false,
    className: '',
    listeners,
    elements: {},
    attrs,
    parentNode: null,
    get innerHTML() { return element.html; },
    set innerHTML(value) { host.render(id, String(value)); },
    get textContent() { return element.text; },
    set textContent(value) { host.text(id, String(value)); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) {
      const fns = listeners[type] || [];
      fns.forEach((fn) => fn(event || { preventDefault() {} }));
      return fns.length;
    },
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    setAttribute(name, value) { attrs[name] = String(value); },
    removeAttribute(name) { delete attrs[name]; },
    hasAttribute(name) { return name in attrs; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    removeChild() {},
    closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    html: '',
    text: '',
  };
  return element;
}

function makeDocument(host) {
  const listeners = {};
  return {
    title: '',
    body: makeElement('body', host),
    getElementById(id) { return host.lookup(id); },
    createElement(tag) { return makeElement('<' + tag + '>', host); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
  };
}

/**
 * Markup model: writing a container's innerHTML detaches every element it held, and
 * an id that no render has produced does not answer getElementById. Without those two
 * rules a test could read a node the page never painted — the exact way this defect
 * hid, because the preview <pre> was there but the header aggregate was not.
 */
function makeHost() {
  const elements = new Map();
  const rendered = new Map();   // id -> the container whose markup holds it
  const painted = new Map();    // id -> textContent written after the last render
  const host = {
    lookup(id) {
      if (!SHELL_IDS.has(id) && !rendered.has(id)) return null;
      if (!elements.has(id)) elements.set(id, makeElement(id, host));
      return elements.get(id);
    },
    render(containerId, html) {
      if (!elements.has(containerId)) elements.set(containerId, makeElement(containerId, host));
      Array.from(rendered.entries()).forEach(([kid, parent]) => {
        if (parent !== containerId) return;
        rendered.delete(kid);
        elements.delete(kid);
        painted.delete(kid);
      });
      elements.get(containerId).html = html;
      [...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].forEach((match) => {
        if (match[2] !== containerId) rendered.set(match[2], containerId);
      });
    },
    text(id, value) { painted.set(id, value); },
    markup(id) { const el = elements.get(id); return el ? el.html : ''; },
    screen(id) {
      if (painted.has(id)) return painted.get(id);
      const el = elements.get(id);
      return el ? el.text : '';
    },
  };
  return host;
}

/* ----------------------------------------------------------------- boot */

async function bootCart(cart) {
  const host = makeHost();
  const document = makeDocument(host);
  const storage = {
    data: { cgiQuoteCart: JSON.stringify(cart) },
    getItem(key) { return key in this.data ? this.data[key] : null; },
    setItem(key, value) { this.data[key] = String(value); },
    removeItem(key) { delete this.data[key]; },
  };
  const location = { hash: '#/quote-cart', search: '', href: ORIGIN + '/site/index.html#/quote-cart' };
  const window = {
    CGI_PRODUCTS: [PRODUCT_A, PRODUCT_B],
    CGI_SITE_CONFIG: { orderApiUrl: API },
    CGI_AUTH: { rewriteMailLink() {}, refresh: () => Promise.resolve(null), isLoggedIn: () => false, me: () => null },
    location,
    scrollTo() {},
    addEventListener() {},
  };
  new Function('window', 'document', 'localStorage', 'fetch', 'location', 'setTimeout', 'requestAnimationFrame', SRC)(
    window, document, storage, () => Promise.reject(new Error('the cart view fetches nothing')), location,
    setTimeout, (fn) => { fn(); });
  await tick();
  await tick();

  return {
    host, document, storage,
    markup: () => host.markup('app'),
    screen: (id) => host.screen(id),
    /** The − / + buttons: the shipped click handler resolves the row itself. */
    step: (productId, delta, current) => {
      const input = qtyField(current);
      const row = { getAttribute: () => productId, querySelector: () => input };
      const button = {
        hasAttribute: (name) => name === 'data-qty-step',
        getAttribute: (name) => (name === 'data-qty-step' ? String(delta) : null),
        closest: (selector) => (selector === '[data-cart-id]' ? row : button),
      };
      document.dispatch('click', { target: button });
      return input;
    },
    /** Typing a number into the qty field: the shipped change handler. */
    typeQty: (productId, value) => {
      const input = qtyField(value, { 'data-qty-id': productId });
      document.dispatch('change', { target: input });
      return input;
    },
  };
}

/** An INPUT's value is always a string, so the handlers' `el.value = 3` must read back '3'. */
function qtyField(value, attributes) {
  const attrs = attributes || {};
  let text = String(value);
  return {
    attrs,
    get value() { return text; },
    set value(next) { text = String(next); },
    hasAttribute: (name) => name in attrs,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
  };
}

/* ------------------------------------------------------- the painted screen */

test('a full render paints the quantity aggregate and the order amount', async () => {
  const env = await bootCart([{ id: PRODUCT_A.id, qty: 2 }, { id: PRODUCT_B.id, qty: 1 }]);
  const html = env.markup();

  assert.ok(html.includes('id="cartSummary"'), 'the page-head aggregate must be addressable');
  assert.ok(html.includes('id="cartTotalValue"'), 'the 주문 금액 line must be addressable');
  assert.match(html, /<p class="page-sub" id="cartSummary">2개 상품 · 총 3점<\/p>/);
  assert.match(html, /<strong id="cartTotalValue">985,000원<\/strong>/,
    '368,000×2 + 249,000×1 comes from the same cart state the rows use');
});

test('the stepper moves the header aggregate and the total, not only the preview', async () => {
  const env = await bootCart([{ id: PRODUCT_A.id, qty: 2 }, { id: PRODUCT_B.id, qty: 1 }]);
  const input = env.step(PRODUCT_A.id, 1, 2);

  assert.equal(input.value, '3', 'the field itself shows the stepped quantity');
  assert.equal(env.screen('cartSummary'), '2개 상품 · 총 4점', 'the header count moves with the stepper');
  assert.equal(env.screen('cartTotalValue'), '1,353,000원', 'and so does the order amount');
  assert.match(env.screen('quoteCartText'), /SHURE RMCE-TW2.*수량 3.*공개가 368,000원/,
    'the preview text reports the same quantity');
  assert.deepEqual(JSON.parse(env.storage.data.cgiQuoteCart), [{ id: PRODUCT_A.id, qty: 3 }, { id: PRODUCT_B.id, qty: 1 }],
    'the persisted cart matches what the screen says');
});

test('typing a quantity re-syncs every surface, and a zero falls back to one', async () => {
  const env = await bootCart([{ id: PRODUCT_A.id, qty: 5 }]);
  const input = env.typeQty(PRODUCT_A.id, 0);

  assert.equal(input.value, '1', 'a quantity below one is clamped in the field too');
  assert.equal(env.screen('cartSummary'), '1개 상품 · 총 1점');
  assert.equal(env.screen('cartTotalValue'), '368,000원');

  env.typeQty(PRODUCT_A.id, 12);
  assert.equal(env.screen('cartSummary'), '1개 상품 · 총 12점');
  assert.equal(env.screen('cartTotalValue'), '4,416,000원');
});

test('an empty cart renders no aggregate, so nothing can be painted into it', async () => {
  const env = await bootCart([]);

  assert.match(env.markup(), /견적 목록이 비어 있습니다/);
  assert.doesNotMatch(env.markup(), /id="cartSummary"/, 'the empty view must not claim a total');
  assert.equal(env.host.lookup('cartSummary'), null, 'the sync path may not invent the node');

  env.typeQty(PRODUCT_A.id, 4);
  assert.equal(env.screen('cartSummary'), '', 'a stray qty event cannot fabricate a header count');
});

test('the header line and the sync path share one summary builder', async () => {
  // Two independent copies of "N개 상품 · 총 M점" is how the two drifted apart, so the
  // render and the repaint must both ask one builder for the string.
  const render = SRC.match(/'<p class="page-sub" id="cartSummary">' \+ (\w+)\(items\)/);
  assert.ok(render, 'the header line must come from a helper, not be spelled out inline');
  const repaint = SRC.match(/summary\.textContent = (\w+)\(items\)/);
  assert.ok(repaint, 'refreshCartPreview must repaint the header through the same helper');
  assert.equal(repaint[1], render[1], 'one builder for the header aggregate');
});
