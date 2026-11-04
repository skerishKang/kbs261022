// 2026-11-04 대표 확정: 개인정보처리방침·이용약관 확정 초안, 보호책임자, 주문 전 필수 동의.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');
const privacy = read('privacy.html');
const terms = read('terms.html');
const orderJs = read('assets/js/cgi-order.js');

test('개인정보처리방침·이용약관에는 자리표시자와 초안 표시가 없다', () => {
  for (const [name, html] of [['privacy.html', privacy], ['terms.html', terms]]) {
    assert.doesNotMatch(html, /\[[^\]]*\]/, `${name}에 자리표시자가 남아 있다`);
    assert.doesNotMatch(html, /초안/, `${name}에 초안 표시가 남아 있다`);
    assert.doesNotMatch(html, /draft-/i, `${name}에 draft 버전 표시가 남아 있다`);
    assert.match(html, /2026년 11월 4일/, `${name} 시행일`);
  }
});

test('개인정보처리방침은 보유 기간·파기·위탁·책임자를 담는다', () => {
  assert.match(privacy, /개인정보처리방침/);
  for (const period of ['5년', '3년', '6개월', '3개월']) assert.match(privacy, new RegExp(period));
  assert.match(privacy, /문의 처리 완료 후 1년/);
  assert.match(privacy, /복구할 수 없는 방법으로 삭제/);
  assert.match(privacy, /분쇄하거나 소각/);
  assert.match(privacy, /Cloudflare, Inc\./);
  assert.match(privacy, /NICEPAY/);
  assert.match(privacy, /Resend/);
  assert.match(privacy, /Google LLC/);
  assert.match(privacy, /ECOUNT/);
  assert.match(privacy, /김범신/);
  assert.match(privacy, /062-576-8100/);
  assert.match(privacy, /cgiinc@naver\.com/);
});

test('이용약관은 만 14세·손해배상·7일 청약철회를 담는다', () => {
  assert.match(terms, /만 14세/);
  assert.match(terms, /고의 또는 중대한 과실/);
  assert.match(terms, /불가항력/);
  assert.match(terms, /7일 이내/);
  assert.match(terms, /returns\.html/);
});

test('체크아웃은 두 필수 동의 전에는 주문 버튼이 비활성이다', () => {
  assert.match(orderJs, /name="terms_consent"/);
  assert.match(orderJs, /name="privacy_consent"/);
  assert.match(orderJs, /개인정보처리방침<\/a>/);
  assert.match(orderJs, /button type="submit" class="btn" disabled/);
  assert.match(orderJs, /function syncConsent\(\)/);
  assert.match(orderJs, /submitBtn\.disabled = !\(termsEl\.checked && privacyEl\.checked\)/);
  assert.match(orderJs, /payload\.terms_consent = c\.terms === true/);
  assert.match(orderJs, /payload\.privacy_consent = c\.privacy === true/);
  assert.match(orderJs, /orderPayload\(customer, \{ terms: termsEl\.checked, privacy: privacyEl\.checked \}\)/);
});
