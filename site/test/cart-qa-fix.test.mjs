// Regression contract for the LOCAL3 independent-QA UI fixes (issue #126, PR #129 follow-up).
//
// The audit's P2/P3 defects were layout-measured in a real browser, so this file pins the
// structural decisions those measurements depend on, in the same read-the-source style the
// other contract tests use:
//
//   P2-A  the 결제/견적 요약 card must live inside the left column (.cart-left) so the PC
//         grid cannot stretch a gap between the cart panel and the summary (measured 186px → 16px);
//         on ≤1099px .cart-left dissolves with display:contents so the stacked order
//         담은 상품 → 견적 요청 → 결제 stays exactly as the round-2 rearrangement shipped it.
//   P2-B  the qty stepper and the cart 삭제 button reach 44px touch height on mobile.
//   P3    small green text uses the AA-passing dark green, and the header auth badge keeps
//         its own color/size against the white .auth-links-member a rule.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-catalog.js'), 'utf8');
const CSS = readFileSync(join(HERE, '..', 'assets', 'css', 'cgi-catalog.css'), 'utf8');
const WEB_CSS = readFileSync(join(HERE, '..', '..', 'website', 'assets', 'style.css'), 'utf8');

test('P2-A: the pay/quote summary card is rendered inside the left cart column', () => {
  const left = SRC.indexOf("'<div class=\"cart-left\">' +");
  const main = SRC.indexOf("'<div class=\"cart-main\">' +");
  const aside = SRC.indexOf("'<aside class=\"cart-request\">' +");
  const pay = SRC.indexOf("'<div class=\"cart-pay-cta\">' +");
  assert.ok(left !== -1, 'render must open .cart-left');
  assert.ok(left < main && main < pay && pay < aside,
    'order must be cart-left( cart-main, cart-pay-cta ) then cart-request — the summary may not sit in a second stretched grid row');
  assert.equal(SRC.split("'<div class=\"cart-pay-cta\">' +").length, 2,
    'exactly one pay CTA block — the old post-aside copy must not come back');
});

test('P2-A: mobile keeps the 담은 상품 → 견적 요청 → 결제 order via display:contents', () => {
  assert.match(CSS, /\.cart-left \{ display: contents; \}/,
    'the ≤1099px block must dissolve .cart-left so the flex orders stay on main/request/pay');
  const tabletBlock = CSS.slice(CSS.indexOf('@media (max-width: 1099px)'), CSS.indexOf('@media (max-width: 899px)'));
  assert.match(tabletBlock, /\.cart-main \{ order: 1; \}/);
  assert.match(tabletBlock, /\.cart-request \{ order: 2; position: static; \}/);
  assert.match(tabletBlock, /\.cart-pay-cta \{ order: 3; \}/);
});

test('P2-B: mobile qty stepper and 삭제 button reach the 44px touch size', () => {
  const mobileBlock = CSS.slice(CSS.indexOf('@media (max-width: 719px)'));
  assert.match(mobileBlock, /\.qty-stepper button \{ width: 44px; height: 44px; \}/);
  assert.match(mobileBlock, /\.qty-stepper input \{ width: 44px; height: 44px; \}/);
  assert.match(mobileBlock, /\.cart-remove \{ min-width: 44px; min-height: 44px;/,
    'the delete control is the QA-measured 31px offender');
});

test('P2-B: the desktop stepper still fits the fixed cart table column', () => {
  // 36 + 44 + 36 = 116px must fit the qty column content box (140px - 2×10px padding).
  const col = CSS.match(/\.cart-table th:nth-child\(3\) \{ width: (\d+)px; \}/);
  assert.ok(col, 'qty column width must stay declared');
  assert.ok(Number(col[1]) >= 136, 'column wide enough for the enlarged stepper (no overflow/overlap)');
});

test('P3: small green text uses the AA-passing dark green', () => {
  assert.match(CSS, /\.page-eyebrow \{\n  margin: 0 0 6px; color: var\(--cgi-primary-dark\);/,
    '11px eyebrow measured 3.79:1 with the base green');
  assert.match(CSS, /\.section-head \.more \{ color: var\(--cgi-primary-dark\);/);
  assert.match(WEB_CSS, /\.sec-no \{[^}]*color: var\(--cgi-green-dark\);/s);
});

test('P3: the header auth badge keeps its own color and size', () => {
  assert.match(CSS, /\.auth-links-member a\.auth-badge-unverified \{ color: #a04000; font-size: 10\.5px; \}/,
    'without this the white .auth-links-member a rule left 인증 대기 unreadable (1.1:1)');
  assert.match(CSS, /\.auth-links-member a\.auth-badge-verified \{ color: var\(--cgi-ok\); font-size: 10\.5px; \}/);
});
