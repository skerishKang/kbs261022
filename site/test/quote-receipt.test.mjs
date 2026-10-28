// UI/UX round 2 — quote receipt block & mobile sticky CTA contract.
//
//   node --test site/test/quote-receipt.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-catalog.js'), 'utf8');
const CSS = readFileSync(join(HERE, '..', 'assets', 'css', 'cgi-catalog.css'), 'utf8');
const SHELL = readFileSync(join(HERE, '..', 'index.html'), 'utf8');

test('receipt block renders number, copy button and received time', () => {
  assert.match(SRC, /receipt-no/, '접수번호 블록이 있어야 한다');
  assert.match(SRC, /data-action="copy-receipt"/, '접수번호 복사 버튼이 있어야 한다');
  assert.match(SRC, /receipt-time/, '접수 시각이 표시되어야 한다');
  assert.match(SRC, /fmtDateTime\(request\.createdAt\)/, 'createdAt 기반 접수 시각 포맷을 사용해야 한다');
  assert.match(SRC, /receipt-note/, '담당자 안내 문구가 있어야 한다');
});

test('copy receipt handler is wired and reuses copyText', () => {
  assert.match(SRC, /window\.cgiCopyReceiptNumber = function/, '복사 핸들러가 정의되어야 한다');
  assert.match(SRC, /action === 'copy-receipt'.*cgiCopyReceiptNumber/, '액션 핸들러가 복사 버튼과 연결되어야 한다');
});

test('receipt styles reuse existing tokens', () => {
  assert.match(CSS, /\.quote-result \.receipt-no strong/, '접수번호 강조 스타일이 있어야 한다');
  assert.match(CSS, /font-size: 21px/, '접수번호는 본문보다 확실히 커야 한다');
  assert.match(CSS, /var\(--cgi-muted\)/, '기존 토큰을 재사용해야 한다');
});

test('mobile sticky quote CTA exists (detail only) and target is 899px', () => {
  assert.match(SRC, /class="mobile-cta"/, '상세 화면에 모바일 CTA 바가 있어야 한다');
  assert.match(SRC, /mobile-cta[\s\S]{0,400}data-action="quote-now"/, 'sticky CTA는 견적 요청 액션을 사용해야 한다');
  assert.match(CSS, /\.mobile-cta \{ display: none; \}/, '데스크톱에서는 숨겨야 한다');
  assert.match(CSS, /@media \(max-width: 899px\)[\s\S]*?\.mobile-cta \{[\s\S]*?position: fixed;/, '≤899px에서 고정 노출되어야 한다');
});

test('detail view keeps bottom padding for the fixed bar', () => {
  assert.match(CSS, /body\[data-view="detail"\] \.app \{ padding-bottom: 96px; \}/, '고정 바가 본문을 가리지 않도록 여백이 있어야 한다');
});

test('asset cache-busting version is bumped on the shell', () => {
  assert.match(SHELL, /cgi-catalog\.js\?v=79a/, '스크립트 버전이 79a로 갱신되어야 한다');
  assert.match(SHELL, /cgi-catalog\.css\?v=79a/, '스타일 버전이 79a로 갱신되어야 한다');
});
