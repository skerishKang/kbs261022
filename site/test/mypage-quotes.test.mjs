// Round-3 contract: my page "내 견적" tab (front-end only, reuses GET /api/me/quotes).
//
//   node --test site/test/mypage-quotes.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-catalog.js'), 'utf8');
const AUTH = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-auth.js'), 'utf8');
const CSS = readFileSync(join(HERE, '..', 'assets', 'css', 'cgi-catalog.css'), 'utf8');
const SHELL = readFileSync(join(HERE, '..', 'index.html'), 'utf8');

test('my page exposes the 내 견적 tab and routes it', () => {
  assert.match(CATALOG, /\['quotes', '내 견적'\]/, '탭 항목이 있어야 한다');
  assert.match(CATALOG, /'profile', 'addresses', 'orders', 'quotes'/, '허용 탭 목록에 quotes가 있어야 한다');
  assert.match(CATALOG, /allowed === 'quotes'\) renderMyQuotes/, '탭 렌더로 연결되어야 한다');
});

test('quotes wrapper reuses the existing member API (no new endpoint)', () => {
  assert.match(AUTH, /api\('GET', '\/api\/me\/quotes'\)/, '기존 GET /api/me/quotes를 사용해야 한다');
  assert.match(AUTH, /quotes: quotes/, 'CGI_AUTH로 노출되어야 한다');
  assert.ok(!/\/api\/quotes\/mine|quotes-new/.test(AUTH), '신규 엔드포인트를 만들면 안 된다');
});

test('list shows number, date, status, item summary and amount', () => {
  for (const token of ['quote-id', 'quote-status', 'quote-meta', 'order-total', 'quoteStatusLabel']) {
    assert.match(CATALOG, new RegExp(token), `${token} 렌더가 필요하다`);
  }
  assert.match(CATALOG, /received: '접수'[\s\S]*quoted: '견적 발송'[\s\S]*completed: '완료'[\s\S]*cancelled: '취소'/, '상태 4종 라벨');
});

test('empty, loading, error and detail states exist', () => {
  assert.match(CATALOG, /data-quotes-loading/, '로딩 상태');
  assert.match(CATALOG, /아직 요청한 견적이 없습니다/, '빈 상태');
  assert.match(CATALOG, /견적 내역을 불러오지 못했습니다/, '오류 상태');
  assert.match(CATALOG, /data-action="reload-quotes"/, '재시도 버튼');
  assert.match(CATALOG, /toggleQuoteDetail/, '상세 토글');
  assert.match(CATALOG, /quote-detail-meta/, '상세 메타');
});

test('styles reuse existing tokens and shell version is bumped', () => {
  assert.match(CSS, /\.quote-status\.received \{ background: var\(--cgi-warn-soft\)/, '기존 토큰 재사용');
  assert.match(SHELL, /cgi-catalog\.js\?v=79a/, '카탈로그 스크립트 버전 79a');
  assert.match(SHELL, /cgi-auth\.js\?v=79a/, '인증 스크립트 버전 79a');
});
