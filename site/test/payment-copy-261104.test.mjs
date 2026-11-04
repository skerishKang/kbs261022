// 결제를 언급하는 업체 이름이 사용자 화면 문구에 남아 있지 않아야 한다(2026-11-04 대표 결정).
// 결제 업체 이름이 남아도 되는 곳: 개인정보처리방침 위탁 목록, 결제 화면 TEST 배지.
// 홈페이지는 결제 이야기를 하지 않으며, 쇼핑몰 버튼은 업체 이름 없이 "결제창 열기"다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, '..', '..', rel), 'utf8');

function visibleHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

test('홈페이지는 결제를 언급하지 않는다', () => {
  const html = read('website/index.html');
  assert.doesNotMatch(visibleHtml(html), /결제/);
  assert.doesNotMatch(html, /토스페이먼츠/);
  assert.doesNotMatch(html, /결제는 토스/);
  assert.doesNotMatch(html, /결제.*확인 단계/);
});

test('쇼핑몰 화면 문구에는 결제 업체 이름이 없다', () => {
  const html = read('site/index.html');
  assert.doesNotMatch(visibleHtml(html), /토스페이먼츠|나이스페이|NICEPAY/);
  const order = read('site/assets/js/cgi-order.js');
  assert.doesNotMatch(order, />[^<\n]*토스페이먼츠[^<\n]*</);
  assert.doesNotMatch(order, />[^<\n]*NICEPAY[^<\n]*</);
  assert.doesNotMatch(order, />[^<\n]*나이스페이[^<\n]*</);
  assert.match(order, /TEST 결제 — 테스트 환경 \(실제 청구 없음\)/);
  assert.match(order, /payload\.consent_at = new Date\(\)\.toISOString\(\)/);
});

test('개인정보처리방침 위탁 목록은 NICEPAY를 그대로 둔다', () => {
  const privacy = read('site/privacy.html');
  assert.match(privacy, /NICEPAY\(나이스페이\)/);
});
