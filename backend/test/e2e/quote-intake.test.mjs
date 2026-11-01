// Quote intake gate (2026-11-01 audit): privacy consent is mandatory and the
// invoice / public-procurement fields persist on the quote row.
//
//   node --experimental-sqlite test/e2e/quote-intake.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';

const ADMIN_TOKEN = 'example-admin-token';

function env() {
  return {
    DB: openD1(),
    ADMIN_TOKEN,
    PG_PROVIDER_MODE: 'mock',
    ERP_LIVE_WRITE: 'NO',
    ERP_MODE: 'test',
    SHIPPING_FEE_DEFAULT: '0',
    MAIL_MODE: 'echo',
    AUTH_PBKDF2_ITERATIONS: '1000',
  };
}

async function call(environment, method, path, body, headers = {}) {
  const init = { method, headers: { Origin: 'https://cgishop.pages.dev', ...headers } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, init), environment);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: response.status, json, text };
}

const QUOTE = {
  items: [{ id: 'samasound.co.kr:3836', qty: 1 }],
  company: '[E2E] 기관', name: '[E2E] 담당', phone: '010-2222-3333',
};

test('quote without privacy consent is refused with a Korean detail', async () => {
  const environment = env();
  const res = await call(environment, 'POST', '/api/quotes', { ...QUOTE });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'privacy consent required');
  const rows = await environment.DB.prepare('SELECT COUNT(*) AS n FROM quote_requests').first();
  assert.equal(rows.n, 0, 'a refused intake writes nothing');
});

test('tax invoice requires a 10-digit biz number; consent + fields persist', async () => {
  const environment = env();
  const bad = await call(environment, 'POST', '/api/quotes', {
    ...QUOTE, privacy_consent: true, invoice_type: 'tax_invoice', biz_no: '12345',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /biz_no/);

  const ok = await call(environment, 'POST', '/api/quotes', {
    ...QUOTE, privacy_consent: true, invoice_type: 'tax_invoice', biz_no: '1234567890', agency_no: 'R-1101',
  });
  assert.equal(ok.status, 201, ok.text);

  const detail = await call(environment, 'GET', `/api/quotes/${ok.json.id}`, null, {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.privacy_consent, 1);
  assert.equal(detail.json.invoice_type, 'tax_invoice');
  assert.equal(detail.json.biz_no, '1234567890');
  assert.equal(detail.json.agency_no, 'R-1101');
});

test('unknown invoice_type is refused', async () => {
  const environment = env();
  const res = await call(environment, 'POST', '/api/quotes', {
    ...QUOTE, privacy_consent: true, invoice_type: 'gift_card',
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'invalid invoice_type');
});
