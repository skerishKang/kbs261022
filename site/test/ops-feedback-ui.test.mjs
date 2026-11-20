// 운영센터 화면 계약: 의견 보내기 링크·폼, 마이페이지 '내 의견', 새 소식, 관리자 운영센터.
//
//   node --test site/test/ops-feedback-ui.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const read = (p) => readFileSync(join(SITE, p), 'utf8');

const FEEDBACK_JS = read('assets/js/cgi-feedback.js');
const OPS_JS = read('assets/js/cgi-ops.js');
const CATALOG = read('assets/js/cgi-catalog.js');
const CSS = read('assets/css/cgi-feedback.css');
const FORM = read('feedback.html');
const NEWS = read('news.html');
const OPS = read('ops.html');

function navOf(html) {
  const m = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/);
  return m ? m[1] : '';
}
function footerOf(html) {
  const m = html.match(/<footer[\s\S]*?<\/footer>/);
  return m ? m[0] : '';
}

test('every customer page has a small header link and a footer link to 의견 보내기', () => {
  for (const page of ['index.html', 'privacy.html', 'terms.html', 'returns.html', 'feedback.html', 'news.html']) {
    const html = read(page);
    assert.match(navOf(html), /<a href="feedback\.html"[^>]*data-feedback-link[^>]*(?:>의견 보내기<\/a>|aria-label="의견 보내기")/, `${page} 헤더 메뉴`);
    assert.match(footerOf(html), /<a href="feedback\.html"[^>]*data-feedback-link[^>]*>의견 보내기<\/a>/, `${page} 푸터`);
    assert.match(html, /cgi-feedback\.js\?v=[0-9a-z]+/, `${page} 가 링크 스크립트를 싣는다`);
  }
  // 쇼핑몰 머리글은 검색칸·장바구니와 한 줄이라 넓은 화면에서는 '의견'으로 줄이고
  // 모바일 메뉴·접근 이름은 '의견 보내기' 전체를 쓴다(검색 버튼과 장바구니가 겹치지 않게).
  const indexNav = navOf(read('index.html'));
  assert.match(indexNav, /class="nav-feedback nav-feedback-compact" data-feedback-link aria-label="의견 보내기"/);
  assert.match(indexNav, /<span class="nav-feedback-short" aria-hidden="true">의견<\/span><span class="nav-feedback-full">의견 보내기<\/span>/);
  assert.match(CSS, /\.header-nav a\.nav-feedback \{ font-size: 12px/, '작은 글씨');
  assert.match(CSS, /@media \(max-width: 899px\) \{\n  \.header-nav a\.nav-feedback \.nav-feedback-short \{ display: none; \}/, '모바일은 전체 문구');
});

test('feedback form: 4 kinds, required 2,000-char body, auto page url, optional email', () => {
  for (const [value, label] of [['bug', '불편·오류'], ['idea', '기능 제안'], ['product', '상품·가격 문의'], ['other', '기타']]) {
    assert.match(FORM, new RegExp(`name="kind" value="${value}"[^>]*>\\s*<span>${label}</span>`), label);
  }
  assert.match(FORM, /<textarea id="fbBody" name="body"[^>]*maxlength="2000" required/);
  assert.match(FORM, /name="page_url" type="url" readonly/);
  assert.match(FORM, /name="contact_email" type="email"(?![^>]*required)/, '이메일은 선택');
  assert.match(FORM, /로그인하지 않아도 보낼 수 있어요/);
});

test('feedback script: posts to the Worker, member cookie only when signed in, link limit', () => {
  assert.match(FEEDBACK_JS, /'\/api\/feedback'/);
  assert.match(FEEDBACK_JS, /a\.api\('POST', '\/api\/feedback', payload\)/, '로그인 회원은 CSRF 래퍼로');
  assert.match(FEEDBACK_JS, /if \(a && a\.isLoggedIn && a\.isLoggedIn\(\)\)/);
  assert.ok(!/credentials: 'include'/.test(FEEDBACK_JS), '비회원 호출은 쿠키를 싣지 않는다');
  assert.match(FEEDBACK_JS, /var LINK_LIMIT = 3;/);
  assert.match(FEEDBACK_JS, /data-receipt-id/, '접수번호 표시');
  assert.match(FEEDBACK_JS, /form\.hidden = true;/, '접수 뒤 폼을 숨긴다');
  assert.match(CSS, /\.fb-form\[hidden\], \.fb-done\[hidden\]/, 'display:grid 폼도 hidden 이면 숨겨진다');
  assert.match(FEEDBACK_JS, /마이페이지 → 내 의견/);
});

test('feedback links carry the page the visitor was on; link counter matches the server', () => {
  const listeners = [];
  const sandbox = {
    window: { location: { href: 'https://cgishop.pages.dev/site/index.html#/product/abc', pathname: '/site/index.html', search: '' }, CGI_SITE_CONFIG: {} },
    document: { readyState: 'complete', addEventListener: (...a) => listeners.push(a), getElementById: () => null },
    URLSearchParams,
  };
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(FEEDBACK_JS, sandbox);
  const api = sandbox.window.CGI_FEEDBACK;
  assert.equal(api.feedbackHref('feedback.html'),
    'feedback.html?from=' + encodeURIComponent('https://cgishop.pages.dev/site/index.html#/product/abc'));
  assert.equal(api.countLinks('a https://a.com www.b.kr http://c.io'), 3);
  assert.equal(listeners.length, 1, '클릭 위임 한 번');
});

test('my page has the 내 의견 tab rendered by the feedback module', () => {
  assert.match(CATALOG, /\['feedback', '내 의견'\]/);
  assert.match(CATALOG, /'profile', 'addresses', 'orders', 'quotes', 'feedback'/);
  assert.match(CATALOG, /allowed === 'feedback'\) renderMyFeedback/);
  assert.match(CATALOG, /window\.CGI_FEEDBACK\.renderMine\(body\)/);
  assert.match(FEEDBACK_JS, /'\/api\/me\/feedback'/);
  for (const label of ["received: '접수'", "checking: '확인 중'", "fixed: '고침'", "answered: '답변 완료'", "on_hold: '보류'"]) {
    assert.ok(FEEDBACK_JS.includes(label), label);
  }
  assert.match(FEEDBACK_JS, /운영자 답글/);
  assert.ok(!/admin_note/.test(FEEDBACK_JS), '고객 화면은 내부 메모를 다루지 않는다');
});

test('news page shows only the grouped source, never who said it', () => {
  assert.match(NEWS, /id="newsList"/);
  assert.match(FEEDBACK_JS, /fetch\(API \+ '\/api\/news'\)/);
  assert.match(FEEDBACK_JS, /ai_member: 'AI 명예회원이 알려 준 것'/);
  assert.match(FEEDBACK_JS, /user_feedback: '사용자 의견으로 고친 것'/);
  const newsBlock = FEEDBACK_JS.slice(FEEDBACK_JS.indexOf('function initNews'), FEEDBACK_JS.indexOf('/* ------------------------------------------------ 부팅'));
  assert.ok(!/author|member|email/.test(newsBlock), '새 소식 화면에 사람 정보 없음');
  assert.match(read('index.html'), /<li><a href="news\.html">새 소식<\/a><\/li>/, '쇼핑몰 푸터에서 새 소식으로');
});

test('ops center: admin tabs, inbox filters, reply + internal note + issue + AI member', () => {
  for (const page of ['staff.html', 'orders.html', 'sync.html', 'ops.html']) {
    assert.match(navOf(read(page)), /<a href="ops\.html"[^>]*>운영센터<\/a>/, `${page} 운영센터 탭`);
  }
  assert.match(OPS, /data-ops-tab="inbox">의견 받은함/);
  assert.match(OPS, /data-ops-tab="news">새 소식/);
  for (const name of ['q', 'kind', 'status', 'ai']) assert.match(OPS, new RegExp(`name="${name}"`), `필터 ${name}`);
  assert.match(OPS, /<option value="only">AI 명예회원만<\/option>/);
  assert.match(OPS_JS, /'\/api\/admin\/feedback' \+ query\(\)/);
  assert.match(OPS_JS, /api\('PATCH', '\/api\/admin\/feedback\/'/);
  assert.match(OPS_JS, /고객에게 보이는 답글/);
  assert.match(OPS_JS, /내부 메모 \(고객에게 안 보임\)/);
  assert.match(OPS_JS, /GitHub 이슈/);
  assert.match(OPS_JS, /AI 명예회원 이름/);
  assert.match(OPS_JS, /member\.role === 'admin' \|\| member\.role === 'superadmin'/);
  assert.ok(!/localStorage|Bearer/.test(OPS_JS), '관리자 토큰을 브라우저에 두지 않는다');
  assert.match(OPS_JS, /'\/api\/admin\/news'/);
});

test('rendered values are escaped in every new screen', () => {
  for (const [name, src] of [['cgi-feedback.js', FEEDBACK_JS], ['cgi-ops.js', OPS_JS]]) {
    assert.match(src, /function esc\(s\)/, `${name} esc`);
    assert.ok(!/innerHTML = [^;]*\+ f\.body \+/.test(src), `${name} 본문을 그대로 넣지 않는다`);
  }
  assert.match(OPS_JS, /function safeHref/, '보던 화면 링크는 http(s)만');
});
