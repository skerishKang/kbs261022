// Shared E2E helpers: drive the Worker's fetch handler in-process.

import worker from '../worker.js';
import { openD1 } from '../d1-shim.mjs';
import { PRICE_INDEX } from '../data/price_index.mjs';

export const ORIGIN = 'https://skerishkang.github.io';
export const EVIL_ORIGIN = 'http://evil.example.com';
export const ADMIN_TOKEN = 'example-admin-token';

export function makeEnv(overrides = {}) {
  return {
    DB: openD1(),
    ADMIN_TOKEN,
    PG_PROVIDER_MODE: 'mock',
    ERP_LIVE_WRITE: 'NO',
    ERP_MODE: 'test',
    SHIPPING_FEE_DEFAULT: '0',
    ...overrides,
  };
}

/** Find a product id that has a confirmed public price, optionally by price. */
export function pricedProductIds(count = 2) {
  return Object.entries(PRICE_INDEX)
    .filter(([, entry]) => Number.isFinite(entry.p) && entry.p > 0)
    .slice(0, count)
    .map(([id]) => id);
}

/** Find a product id whose price is not confirmed (inquiry). */
export function inquiryProductId(allIds) {
  const known = new Set(Object.keys(PRICE_INDEX));
  for (const id of allIds || ['samasound.co.kr:3836', 'unknown-product']) {
    if (!known.has(id)) return id;
  }
  return '__no_price__';
}

export async function call(env, method, path, body, headers = {}) {
  const init = { method, headers: { Origin: ORIGIN, ...headers } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, init), env);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });
  return { status: response.status, json, text, headers: responseHeaders };
}

export function auth(headers = {}) {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, ...headers };
}

export const CUSTOMER = {
  company: '[E2E] 테스트 회사',
  name: '[E2E] 김테스트',
  phone: '010-1234-5678',
  email: 'e2e@example.com',
  addr: '광주광역시 광산구 테스트로 1',
  addr_detail: '101호',
  note: 'E2E 자동화 테스트 주문입니다.',
};

/** Default purchasable cart (all items have confirmed public prices). */
export function purchaseCart(overrides = {}) {
  const [a, b] = pricedProductIds(2);
  return { items: [{ product_id: a, qty: 2 }, { product_id: b, qty: 1 }], ...overrides };
}

/** Cart containing at least one price-unconfirmed product. */
export function mixedCart() {
  const [a] = pricedProductIds(1);
  return { items: [{ product_id: a, qty: 1 }, { product_id: inquiryProductId(), qty: 1 }] };
}
