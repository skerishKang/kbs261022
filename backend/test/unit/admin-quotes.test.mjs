// 관리자 견적서 계산·검증 단위 시험.
// 서버 computeAdminQuote 와 화면 견적서 출력 모듈(site/assets/js/cgi-quote-print.js computeQuote)이
// 1원 단위까지 같은지 무작위 표본으로 확인한다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  computeAdminQuote,
  discountAmount,
  validateQuoteBody,
  duplicateBody,
  formatQuoteNo,
  quoteNoPrefix,
  seoulYmd,
  addDaysYmd,
  QUOTE_NO_RE,
  DEFAULT_VALID_DAYS,
} from '../../lib/admin-quotes.mjs';
import { PRICE_INDEX } from '../../data/price_index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(join(ROOT, 'site/assets/js/cgi-quote-print.js'), 'utf8'), sandbox);
const QP = sandbox.window.CGI_QUOTE_PRINT;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('server and screen calculations agree to the won on 3,000 random quotes', () => {
  const r = rng(20261120);
  for (let n = 0; n < 3000; n += 1) {
    const count = 1 + Math.floor(r() * 9);
    const lines = [];
    for (let i = 0; i < count; i += 1) {
      const roll = r();
      const unit = roll < 0.12 ? null : Math.floor(r() * (roll < 0.5 ? 200_000 : 9_000_000));
      const dt = r();
      const type = dt < 0.55 ? 'none' : dt < 0.8 ? 'pct' : 'amount';
      const qty = 1 + Math.floor(r() * 30);
      const value = type === 'pct' ? Math.round(r() * 1000) / 10 : type === 'amount' && unit != null ? Math.floor(r() * unit * qty) : 0;
      lines.push({ qty, unit, discount_type: type, discount_value: value });
    }
    const server = computeAdminQuote(lines);
    const screen = QP.computeQuote(lines.map((l) => ({ ...l, product: { name: 'x' } })));
    assert.equal(server.total, screen.total, `total #${n}`);
    assert.equal(server.supplied, screen.supplied, `supplied #${n}`);
    assert.equal(server.vat, screen.vat, `vat #${n}`);
    assert.equal(server.inquiryCount, screen.inquiryCount);
    server.lines.forEach((line, i) => {
      assert.equal(line.total, screen.lines[i].total, `line total #${n}.${i}`);
      assert.equal(line.supplied, screen.lines[i].supplied, `line supplied #${n}.${i}`);
      assert.equal(line.vat, screen.lines[i].vat, `line vat #${n}.${i}`);
      assert.equal(line.discount, screen.lines[i].discount, `line discount #${n}.${i}`);
    });
    const colSupplied = server.lines.filter((l) => l.priced).reduce((a, l) => a + l.supplied, 0);
    const colVat = server.lines.filter((l) => l.priced).reduce((a, l) => a + l.vat, 0);
    assert.equal(colSupplied, server.supplied, 'column sums match the total row');
    assert.equal(colVat, server.vat);
    assert.equal(server.supplied + server.vat, server.total);
  }
});

test('without discounts or manual prices the result is the shop quote print (#230) rule', () => {
  const priced = Object.entries(PRICE_INDEX).filter(([, e]) => e.p > 0).slice(0, 5);
  const lines = priced.map(([, e], i) => ({ qty: i + 1, unit: e.p }));
  const server = computeAdminQuote(lines);
  const shop = QP.computeQuote(priced.map(([id, e], i) => ({ qty: i + 1, product: { id, price: { state: 'public', value: e.p } } })));
  assert.equal(server.total, shop.total);
  assert.equal(server.supplied, shop.supplied);
  assert.equal(server.vat, shop.vat);
  assert.equal(QP.splitTax(1_100_000).supplied, 1_000_000);
});

test('discounts: amount is capped, percent rounds to the won', () => {
  assert.equal(discountAmount(10_000, 'amount', 2_500), 2_500);
  assert.equal(discountAmount(10_000, 'amount', 99_999), 10_000);
  assert.equal(discountAmount(33_333, 'pct', 10), 3_333);
  assert.equal(discountAmount(33_335, 'pct', 10), 3_334);
  assert.equal(discountAmount(10_000, 'pct', 150), 10_000);
  assert.equal(discountAmount(10_000, 'none', 50), 0);
  assert.equal(QP.discountAmount(33_335, 'pct', 10), 3_334);
});

test('catalog lines use the public price index; screen-sent prices are ignored', () => {
  const [id, entry] = Object.entries(PRICE_INDEX).find(([, e]) => e.p > 10_000);
  const checked = validateQuoteBody({
    recipient: { company: '○○학교' },
    items: [
      { kind: 'product', product_id: id, qty: 2, unit_price: 1 },
      { kind: 'product', product_id: 'no-such-product:1', name: '가격 문의 상품', qty: 1, unit_price: '1,234,000' },
      { kind: 'product', product_id: 'no-such-product:2', name: '단가 미정', qty: 1 },
      { kind: 'custom', name: '설치비', qty: 1, unit_price: 300000, discount_type: 'amount', discount_value: 50000 },
    ],
  }, { priceIndex: PRICE_INDEX });
  assert.equal(checked.ok, true, checked.detail);
  const [a, b, c, d] = checked.items;
  assert.equal(a.unit_price, entry.p);
  assert.equal(a.unit_source, 'catalog');
  assert.equal(a.name, entry.n, 'catalog name filled from the index');
  assert.equal(b.unit_price, 1_234_000);
  assert.equal(b.unit_source, 'manual');
  assert.equal(c.unit_price, null);
  assert.equal(c.unit_source, 'inquiry');
  assert.equal(d.total_amount, 250_000);
  assert.equal(checked.quote.total_amount, entry.p * 2 + 1_234_000 + 250_000);
  assert.equal(checked.quote.inquiry_count, 1);
  assert.equal(checked.quote.valid_days, DEFAULT_VALID_DAYS);
});

test('validation explains what to fix in Korean', () => {
  const bad = (body, code) => {
    const r = validateQuoteBody(body, { priceIndex: PRICE_INDEX });
    assert.equal(r.ok, false);
    assert.equal(r.error, code);
    assert.match(r.detail, /[가-힣]/);
  };
  bad({ recipient: {} }, 'recipient_company_required');
  bad({ recipient: { company: 'x', email: 'not-mail' } }, 'recipient_email_invalid');
  bad({ recipient: { company: 'x' }, valid_days: 0 }, 'valid_days_invalid');
  bad({ recipient: { company: 'x' }, status: 'paid' }, 'status_invalid');
  bad({ recipient: { company: 'x' }, items: [{ kind: 'custom', name: '', qty: 1 }] }, 'item_name_required');
  bad({ recipient: { company: 'x' }, items: [{ kind: 'custom', name: 'a', qty: 0 }] }, 'qty_invalid');
  bad({ recipient: { company: 'x' }, items: [{ kind: 'custom', name: 'a', qty: 1, unit_price: -5 }] }, 'unit_price_invalid');
  bad({ recipient: { company: 'x' }, items: [{ kind: 'custom', name: 'a', qty: 1, unit_price: 100, discount_type: 'pct', discount_value: 101 }] }, 'discount_invalid');
  bad({ recipient: { company: 'x' }, items: [{ kind: 'custom', name: 'a', qty: 1, unit_price: 100, discount_type: 'amount', discount_value: 101 }] }, 'discount_invalid');
  bad({ recipient: { company: 'x' }, items: [{ kind: 'product', qty: 1 }] }, 'product_id_required');
  bad({ recipient: { company: 'x' }, items: Array.from({ length: 101 }, () => ({ kind: 'custom', name: 'a', qty: 1 })) }, 'too_many_items');
});

test('quote numbers are Q-YYMMDD-NNN on the Korean calendar day', () => {
  assert.equal(formatQuoteNo('2026-11-20', 7), 'Q-261120-007');
  assert.equal(formatQuoteNo('2026-11-20', 1234), 'Q-261120-1234');
  assert.equal(quoteNoPrefix('2026-01-05'), 'Q-260105-');
  assert.match('Q-261120-001', QUOTE_NO_RE);
  assert.doesNotMatch('Q-261120-AB3D', QUOTE_NO_RE, 'the shop provisional number is a different shape');
  // 2026-11-20 15:30 UTC = 2026-11-21 00:30 KST
  assert.equal(seoulYmd(Date.UTC(2026, 10, 20, 15, 30)), '2026-11-21');
  assert.equal(addDaysYmd('2026-12-25', 14), '2027-01-08');
});

test('a duplicate re-reads catalog prices and keeps manual ones', () => {
  const body = duplicateBody({
    recipient: { company: 'c', name: 'n', phone: '', email: '', memo: 'm' }, valid_days: 30, delivery_terms: 'd', payment_terms: 'p',
    items: [
      { kind: 'product', product_id: 'p1', name: 'A', brand: 'B', spec: '', qty: 2, unit_price: 999, unit_source: 'catalog', discount_type: 'none', discount_value: 0, memo: '' },
      { kind: 'custom', product_id: null, name: '설치비', brand: '', spec: '', qty: 1, unit_price: 5000, unit_source: 'manual', discount_type: 'pct', discount_value: 5, memo: 'x' },
    ],
  });
  assert.equal(body.status, 'draft');
  assert.equal(body.items[0].unit_price, null, 'catalog price is re-resolved by the server');
  assert.equal(body.items[1].unit_price, 5000);
  assert.equal(body.recipient.memo, 'm');
});
