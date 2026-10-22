'use strict';
/**
 * Unit tests for the pure parsing helpers in lib/extractors.js.
 * These helpers are the ones that silently corrupted data during development
 * (a wrong Unicode code point made every price-inquiry product look like it had
 * a price of 0), so they are covered by explicit tests.
 *
 * Run: node test-extractors.js
 */
const assert = require('assert');
const X = require('./lib/extractors');

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('parseKrw');
t('parses plain KRW string', () => assert.strictEqual(X.parseKrw('219,000원'), 219000));
t('parses bare number', () => assert.strictEqual(X.parseKrw('1290000'), 1290000));
t('parses spaced number', () => assert.strictEqual(X.parseKrw('1,290,000 원'), 1290000));
t('returns null for non-numeric', () => assert.strictEqual(X.parseKrw('가격 문의'), null));
t('returns null for empty', () => assert.strictEqual(X.parseKrw(''), null));
t('returns null for undefined', () => assert.strictEqual(X.parseKrw(undefined), null));

console.log('parseDataPrice');
t('strips the CAFE24 discount caret', () => assert.strictEqual(X.parseDataPrice('^219000'), 219000));
t('strips commas', () => assert.strictEqual(X.parseDataPrice('^1,050,000'), 1050000));
t('returns null for empty', () => assert.strictEqual(X.parseDataPrice(''), null));
t('returns null for null', () => assert.strictEqual(X.parseDataPrice(null), null));

console.log('parseOptionLabel');
t('reads a positive delta', () => {
  const r = X.parseOptionLabel('2m (+3,000원)');
  assert.strictEqual(r.delta, 3000);
  assert.strictEqual(r.soldOut, false);
});
t('reads delta and sold-out together', () => {
  const r = X.parseOptionLabel('5m [품절] (+14,000원)');
  assert.strictEqual(r.delta, 14000);
  assert.strictEqual(r.soldOut, true);
});
t('reads a delta with a space before the currency', () => {
  assert.strictEqual(X.parseOptionLabel('3m (+6,000 원)').delta, 6000);
});
t('reads sold-out without a delta', () => {
  const r = X.parseOptionLabel('3m [품절]');
  assert.strictEqual(r.delta, null);
  assert.strictEqual(r.soldOut, true);
});
t('plain label has no delta and is not sold out', () => {
  const r = X.parseOptionLabel('블랙');
  assert.strictEqual(r.delta, null);
  assert.strictEqual(r.soldOut, false);
});
t('detects the English sold-out marker', () => {
  assert.strictEqual(X.parseOptionLabel('1m Sold Out').soldOut, true);
});

console.log('isPriceInquiry');
t('detects "가격 문의"', () => assert.strictEqual(X.isPriceInquiry('가격 문의'), true));
t('detects "가격문의"', () => assert.strictEqual(X.isPriceInquiry('가격문의'), true));
t('detects "전화 문의"', () => assert.strictEqual(X.isPriceInquiry('전화 문의'), true));
t('detects "전화문의"', () => assert.strictEqual(X.isPriceInquiry('전화문의'), true));
t('detects "판매문의"', () => assert.strictEqual(X.isPriceInquiry('판매문의'), true));
t('detects "판매완료"', () => assert.strictEqual(X.isPriceInquiry('판매완료'), true));
t('detects "판매 완료"', () => assert.strictEqual(X.isPriceInquiry('판매 완료'), true));
t('detects a mixed price + inquiry string', () => assert.strictEqual(X.isPriceInquiry('219,000 전화문의'), true));
t('a normal price is not an inquiry', () => assert.strictEqual(X.isPriceInquiry('219,000원'), false));
t('empty is not an inquiry', () => assert.strictEqual(X.isPriceInquiry(''), false));

console.log('classifyPrice');
t('numeric price', () => {
  const r = X.classifyPrice('219,000원');
  assert.strictEqual(r.kind, 'numeric');
  assert.strictEqual(r.numeric, 219000);
});
t('price inquiry', () => {
  const r = X.classifyPrice('가격 문의');
  assert.strictEqual(r.kind, 'inquiry');
  assert.strictEqual(r.numeric, null);
});
t('sale closed', () => {
  const r = X.classifyPrice('판매완료');
  assert.strictEqual(r.kind, 'sale_closed');
  assert.strictEqual(r.numeric, null);
});
t('sale closed with a space', () => {
  assert.strictEqual(X.classifyPrice('판매 완료').kind, 'sale_closed');
});
t('missing price', () => {
  const r = X.classifyPrice('');
  assert.strictEqual(r.kind, 'missing');
  assert.strictEqual(r.numeric, null);
});
t('unknown non-numeric text', () => {
  assert.strictEqual(X.classifyPrice('별도 문의').kind, 'inquiry');
});

console.log('constants');
t('the inquiry code point matches the literal', () => assert.strictEqual(X.INQUIRY_WORD, '문의'));
t('the sale-closed code point matches the literal', () => assert.strictEqual(X.CLOSED_WORD, '완료'));
t('the sold-out code point matches the literal', () => assert.strictEqual(X.SOLD_OUT_WORD, '품절'));
t('the currency code point matches the literal', () => assert.strictEqual(X.KWON, '원'));

console.log(`\n${passed} assertions groups passed`);
