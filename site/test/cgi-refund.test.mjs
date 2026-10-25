// Regression tests for the admin refund helper (작업 A).
//
// cgi-refund.js is deliberately DOM-free so it can be loaded here and driven with
// the exact strings a <input type=number> produces.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'assets', 'js', 'cgi-refund.js');

// Classic script (no ESM syntax), so Node loads it as CommonJS and its IIFE
// publishes CGI_REFUND on globalThis.
await import(pathToFileURL(SRC).href);
const CGI_REFUND = globalThis.CGI_REFUND;
assert.ok(CGI_REFUND && typeof CGI_REFUND.buildRefundRequest === 'function', 'cgi-refund.js did not expose CGI_REFUND.buildRefundRequest');

const build = CGI_REFUND.buildRefundRequest;
const FLOOR = CGI_REFUND.MIN_PARTIAL_REFUND;

test('the helper floor is the server floor', () => {
  const worker = readFileSync(join(HERE, '..', '..', 'backend', 'worker.js'), 'utf8');
  const declared = worker.match(/^const MIN_PARTIAL_REFUND = (\d+);$/m);
  assert.ok(declared, 'backend no longer declares MIN_PARTIAL_REFUND the way the parity test expects');
  assert.equal(FLOOR, Number(declared[1]), 'the console must not invent its own refund minimum');
});

test('an empty amount box means a full refund and sends no amount', () => {
  for (const raw of ['', '   ', null, undefined]) {
    const res = build(raw, 340, '고객 요청');
    assert.equal(res.ok, true, JSON.stringify(raw));
    assert.equal(res.mode, 'full');
    assert.equal('cancelAmount' in res.body, false, 'a full refund must NOT send cancelAmount');
    assert.equal(res.body.cancelReason, '고객 요청');
  }
});

test('typing the exact balance is a full refund, not a blocked partial', () => {
  const res = build('340', 340, '전액 입력');
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'full');
  assert.equal('cancelAmount' in res.body, false);
});

test('a sub-floor order can always be refunded in full', () => {
  const res = build('', 340, '1,000원 미만 주문');
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'full');

  const blockedPartial = build('500', 5000, '부분');
  assert.equal(blockedPartial.ok, false, 'the partial minimum is still enforced');
  assert.equal(blockedPartial.min, FLOOR);
  assert.match(blockedPartial.error, /1,000원 이상/);
});

test('a valid partial keeps its amount and mode', () => {
  for (const raw of ['1000', ' 1000 ', 1000, 2500]) {
    const res = build(raw, 5000, '일부 환불');
    assert.equal(res.ok, true, JSON.stringify(raw));
    assert.equal(res.mode, 'partial');
    assert.equal(res.body.cancelAmount, Number(String(raw).trim()), 'the amount is normalised to a number');
  }
});

test('garbage input is refused before it reaches the API', () => {
  const cases = [
    ['0', 5000], ['-1', 5000], ['abc', 5000], ['10.5', 5000], ['Infinity', 5000],
  ];
  for (const [raw, balance] of cases) {
    const res = build(raw, balance, '사유');
    assert.equal(res.ok, false, `${raw} should be rejected`);
    assert.match(res.error, /정수|1원 이상/);
  }
});

test('HTML number-input exponent notation normalises to the same integer', () => {
  // <input type=number> accepts "1e3" as a valid value, so it must reach the API
  // as the number it means rather than being string-passed or refused.
  const res = build('1e3', 5000, '지수 표기');
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'partial');
  assert.equal(res.body.cancelAmount, 1000);
});

test('an amount above the balance is refused with the real maximum', () => {
  const res = build('6000', 5000, '과액');
  assert.equal(res.ok, false);
  assert.equal(res.max, 5000);
  assert.equal('cancelAmount' in (res.body || {}), false);
});

test('nothing can be refunded when the balance is zero or unknown', () => {
  for (const balance of [0, -1, null, undefined, NaN, 'abc']) {
    const res = build('', balance, '사유');
    assert.equal(res.ok, false, String(balance));
    assert.match(res.error, /환불 가능 잔액/);
  }
});

test('a blank reason falls back to the documented default', () => {
  const res = build('', 340, '   ');
  assert.equal(res.ok, true);
  assert.equal(res.body.cancelReason, '고객 요청 취소/환불');
});
