import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitTax,
  toNonNegInt,
  hash32,
  cartHash,
  computeTotals,
  decideKind,
  nextOrderId,
  isValidPgOrderId,
  ORDER_ID_ALPHABET,
} from '../../lib/pricing.mjs';

test('toNonNegInt coerces and clamps', () => {
  assert.equal(toNonNegInt('368,000'), 368000);
  assert.equal(toNonNegInt(368000.4), 368000);
  assert.equal(toNonNegInt(-5), 0);
  assert.equal(toNonNegInt(undefined), 0);
  assert.equal(toNonNegInt('abc', 7), 7);
});

test('splitTax splits a VAT-inclusive total', () => {
  assert.deepEqual(splitTax(11000), { suppliedAmount: 10000, vatAmount: 1000 });
  assert.deepEqual(splitTax(1000), { suppliedAmount: 909, vatAmount: 91 });
  assert.deepEqual(splitTax(111), { suppliedAmount: 101, vatAmount: 10 });
  assert.deepEqual(splitTax(0), { suppliedAmount: 0, vatAmount: 0 });
  // supplied + vat always equals the total
  for (const total of [1, 7, 999, 1000, 5000, 123456, 9999999]) {
    const { suppliedAmount, vatAmount } = splitTax(total);
    assert.equal(suppliedAmount + vatAmount, total, `total=${total}`);
  }
});

test('hash32 is deterministic and case sensitive', () => {
  assert.equal(hash32('a|1;b|2'), hash32('a|1;b|2'));
  assert.notEqual(hash32('a'), hash32('b'));
  assert.match(hash32('anything'), /^[0-9a-f]{8}$/);
});

test('cartHash is order independent and qty sensitive', () => {
  const a = cartHash([{ product_id: 'p1', qty: 2 }, { product_id: 'p2', qty: 1 }]);
  const b = cartHash([{ product_id: 'p2', qty: 1 }, { product_id: 'p1', qty: 2 }]);
  assert.equal(a, b);
  assert.notEqual(a, cartHash([{ product_id: 'p1', qty: 3 }, { product_id: 'p2', qty: 1 }]));
  assert.notEqual(a, cartHash([{ product_id: 'p1', qty: 2 }]));
});

test('computeTotals only counts confirmed prices and reports payable', () => {
  const totals = computeTotals(
    [
      { qty: 2, unit_price: 10000 },
      { qty: 5, unit_price: null },
      { qty: 1, unit_price: 1100 },
    ],
    { shippingFee: 5000 }
  );
  assert.equal(totals.item_total, 21100);
  assert.equal(totals.shipping_fee, 5000);
  assert.equal(totals.total_amount, 26100);
  assert.equal(totals.supplied_amount, 23727);
  assert.equal(totals.vat_amount, 2373);
  assert.equal(totals.payable, false);
  assert.deepEqual(totals.lines.map((l) => l.payable), [true, false, true]);
  assert.deepEqual(totals.lines.map((l) => l.line_total), [20000, 0, 1100]);
  assert.deepEqual(totals.lines.map((l) => l.seq), [1, 2, 3]);
});

test('computeTotals is payable when every item has a confirmed price', () => {
  const totals = computeTotals([{ qty: 3, unit_price: 368000 }], { shippingFee: 0 });
  assert.equal(totals.payable, true);
  assert.equal(totals.total_amount, 1104000);
});

test('computeTotals guards against absurd input', () => {
  const totals = computeTotals([{ qty: 0, unit_price: 'not-a-number' }], { shippingFee: -100 });
  assert.equal(totals.lines[0].qty, 1);
  assert.equal(totals.lines[0].unit_price, 0);
  assert.equal(totals.shipping_fee, 0);
  assert.equal(totals.total_amount, 0);
  assert.equal(totals.payable, true, 'the line has a (zero) price, so it is priced');
  assert.equal(decideKind([{ qty: 1, unit_price: 0 }]), 'quote', 'but a zero total is never payable');
});

test('decideKind returns purchase only for fully priced carts', () => {
  assert.equal(decideKind([{ qty: 1, unit_price: 100 }]), 'purchase');
  assert.equal(decideKind([{ qty: 1, unit_price: null }]), 'quote');
  assert.equal(decideKind([{ qty: 1, unit_price: 100 }, { qty: 1, unit_price: null }]), 'quote');
  assert.equal(decideKind([]), 'quote');
  assert.equal(decideKind([{ qty: 1, unit_price: 0 }]), 'quote', 'zero priced item is not payable');
});

test('nextOrderId satisfies the PG orderId contract', () => {
  const seed = [9, 10, 11, 12, 13];
  const fake = () => new Uint8Array(seed);
  const id = nextOrderId(new Date(Date.UTC(2026, 9, 25, 4, 3, 2)), fake);
  assert.equal(id, 'ORD-20261025-' + seed.map((n) => ORDER_ID_ALPHABET[n]).join(''));
  assert.match(id, /^ORD-\d{8}-[A-Z2-9]{5}$/);
  assert.equal(id.length, 18);
  assert.ok(!/[IO01]/.test(id.slice(-5)), 'ambiguous characters are excluded from the random part');
  assert.ok(isValidPgOrderId(id), 'must be a valid Toss orderId');
});

test('isValidPgOrderId enforces Toss rules', () => {
  assert.ok(isValidPgOrderId('ORD-20261025-ABCDE'));
  assert.ok(isValidPgOrderId('abc-123'));
  assert.ok(!isValidPgOrderId('short'));
  assert.ok(!isValidPgOrderId('a'.repeat(65)));
  assert.ok(!isValidPgOrderId('has space'));
  assert.ok(!isValidPgOrderId('has.dot'));
  assert.ok(!isValidPgOrderId(''));
  assert.ok(!isValidPgOrderId(null));
});
