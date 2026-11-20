// 운영센터 정렬 화면 계약 — 러브트리 운영센터(src/admin-view.js)와 같은 탭·칩·이름.
// 순수 조각(cgi-ops-view.js)은 vm 으로 실제 동작을 검사한다.
//
//   node --test site/test/ops-center-align.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const VIEW_JS = read('site/assets/js/cgi-ops-view.js');
const OPS_JS = read('site/assets/js/cgi-ops.js');
const FEEDBACK_JS = read('site/assets/js/cgi-feedback.js');
const CATALOG = read('site/assets/js/cgi-catalog.js');
const INDEX = read('site/index.html');
const HOME = read('website/index.html');
const HOME_JS = read('website/assets/main.js');

const box = { URLSearchParams };
vm.runInNewContext(VIEW_JS, box);
const V = box.CGI_OPS_VIEW;
const plain = (x) => JSON.parse(JSON.stringify(x));

const ROWS = [
  { id: 'A', kind: 'bug', status: 'received', created_at: '2026-11-18T00:00:00Z' },
  { id: 'B', kind: 'inconvenient', status: 'reviewing', created_at: '2026-11-17T00:00:00Z', has_reply: true },
  { id: 'C', kind: 'feature', status: 'received', created_at: '2026-11-16T00:00:00Z' },
  { id: 'D', kind: 'product', status: 'fixed', created_at: '2026-11-15T00:00:00Z', issue_ref: '#12' },
  { id: 'E', kind: 'other', status: 'later', created_at: '2026-11-14T00:00:00Z' },
  { id: 'F', kind: 'bug', status: 'closed', created_at: '2026-11-13T00:00:00Z', issue_ref: '12' },
  { id: 'G', kind: 'feature', status: 'reviewing', created_at: '2026-11-12T00:00:00Z', issue_ref: '#30' },
];

test('menu tabs follow the lovetree ops center (+ CGI 새 소식)', () => {
  assert.deepEqual(plain(V.MENU_TABS).map((t) => t.label), ['한눈에', '고객', '의견', '사용 일지', '고치는 일', '새 소식']);
  assert.deepEqual(plain(V.STATUS_ORDER), ['received', 'reviewing', 'fixed', 'later', 'closed']);
  assert.equal(V.STATUS_LABEL.received, '새 글', '운영센터에서는 받음을 새 글로 부른다');
  assert.deepEqual(plain(V.BOARD_STATUS_TABS).map((t) => t.label), ['할 일', '고침', '더 보기 ▾']);
  assert.deepEqual(plain(V.BOARD_CAT_TABS).map((t) => t.label), ['전체', '고장·불편', '요청', '상품·가격']);
});

test('의견 탭: 고장·불편·요청 × 할 일·고침·더 보기', () => {
  const ids = (rows) => plain(rows).map((r) => r.id);
  assert.deepEqual(ids(V.filterBoardRows(ROWS, {})), ['A', 'B', 'C', 'G'], '기본은 할 일(새 글+확인 중)');
  assert.deepEqual(ids(V.filterBoardRows(ROWS, { cat: 'issue' })), ['A', 'B']);
  assert.deepEqual(ids(V.filterBoardRows(ROWS, { cat: 'request' })), ['C', 'G']);
  assert.deepEqual(ids(V.filterBoardRows(ROWS, { status: 'fixed' })), ['D']);
  assert.deepEqual(ids(V.filterBoardRows(ROWS, { status: 'more' })), ['D', 'E', 'F', 'G'], '더 보기: 다음에·닫음·이슈 있는 글');
  assert.deepEqual(ids(V.filterBoardRows(ROWS, { cat: 'product', status: 'all' })), ['D']);
  assert.deepEqual(plain(V.boardStatusTabs(ROWS, 'issue')).map((t) => t.count), [2, 0, 2]);
  assert.deepEqual(plain(V.boardCatTabs(ROWS, 'pending')).map((t) => t.count), [4, 2, 2, 0]);
  assert.equal(V.menuReceivedCounts(ROWS).opinion, 2);
});

test('고치는 일: 연결된 이슈 번호별 묶음, 번호 내림차순, GitHub 링크', () => {
  const groups = plain(V.linkedIssueGroups(ROWS));
  assert.deepEqual(groups.map((g) => g.number), ['30', '12']);
  assert.equal(groups[1].total, 2);
  assert.equal(groups[1].done, 2);
  assert.equal(groups[0].url, 'https://github.com/skerishKang/kbs261022/issues/30');
  assert.equal(V.normalizeIssueNumber('#584'), '584');
  assert.equal(V.normalizeIssueNumber('abc'), '');
});

test('사용 일지 탭: 고객별 단계·점수 흐름·떠남 위험, 오늘 요약', () => {
  const J = [
    { id: 1, member_id: 7, customer: 'AI 명예회원 리모네', journal_date: '2026-11-18', score: 2 },
    { id: 2, member_id: 7, customer: 'AI 명예회원 리모네', journal_date: '2026-11-19', score: 1 },
    { id: 3, member_id: 8, customer: 'AI 명예회원 가람', journal_date: '2026-11-19', score: 5 },
  ];
  const people = plain(V.journalRowsByCustomer(J));
  const limone = people.find((p) => p.member_id === 7);
  assert.equal(limone.stage, '꾸준');
  assert.equal(limone.atRisk, true, '이틀 연속 2 이하');
  assert.deepEqual(limone.flow.map((f) => f.score), [2, 1]);
  assert.deepEqual(plain(V.journalsSummary(J, '2026-11-19')), { activeCustomers: 2, journalCount: 2, avgScore: 3, atRisk: 1 });
  assert.deepEqual(plain(V.journalCustomerOptions(V.journalListRows(J))).map((o) => o.name), ['AI 명예회원 가람', 'AI 명예회원 리모네']);
});

test('한눈에 숫자 카드: 전체·실제·AI 명예회원·시험 계정·7일 신규·새 의견, 이상한 값은 지어내지 않는다', () => {
  const ok = plain(V.statsCards({ accounts: { total: 5, real: 2, ai_member: 1, tester: 2, new7: { total: 4, real: 1, ai_member: 1, tester: 2 } }, feedback: { received: 1, pending: 2, new7: 2 } }));
  assert.equal(ok.error, false);
  assert.deepEqual(ok.cards.map((c) => [c.label, c.value]), [['전체 계정', 5], ['실제 고객', 2], ['AI 명예회원', 1], ['시험 계정', 2], ['7일 신규 가입', 4], ['새 의견', 1]]);
  assert.equal(V.statsCards(null).error, true);
  assert.equal(plain(V.statsCards({ accounts: { total: -1, real: 0, ai_member: 0, tester: 0 }, feedback: { received: 0 } })).error, true);
});

test('주소(해시) 왕복', () => {
  assert.deepEqual(plain(V.parseHash('')), { view: 'overview' });
  assert.deepEqual(plain(V.parseHash('#board?status=fixed&cat=request')), { view: 'board', status: 'fixed', cat: 'request' });
  assert.equal(V.viewHash('board', null, { status: 'pending', cat: '' }), '#board');
  assert.equal(V.viewHash('customer', 9), '#customer/9');
  assert.equal(V.viewToTab('feedback'), 'board');
  assert.equal(V.viewToTab('customer'), 'customers');
});

test('운영센터 화면: 고객 탭 역할 지정·열람 기록 90일, 일지 내부 메모, 덧붙임 표시', () => {
  assert.match(OPS_JS, /'\/api\/admin\/customers\/' \+ encodeURIComponent\(id\) \+ '\/role'/);
  assert.match(OPS_JS, /<option value="ai_member"/);
  assert.match(OPS_JS, /열어 본 기록이 90일 동안 남아요/);
  assert.match(OPS_JS, /'\/api\/admin\/ops\/stats'/);
  assert.match(OPS_JS, /'\/api\/admin\/journals\/' \+ encodeURIComponent/);
  assert.match(OPS_JS, /고객이 지움/);
  assert.match(OPS_JS, /일지는 알림을 보내지 않아요/);
});

test('마이페이지: 내 의견 덧붙이기·고치기·지우기, AI 명예회원만 사용 일지 탭', () => {
  assert.match(FEEDBACK_JS, /'\/api\/me\/feedback\/' \+ encodeURIComponent\(fid\) \+ '\/followup'/);
  assert.match(FEEDBACK_JS, /a\.api\('DELETE', path\(/);
  assert.match(FEEDBACK_JS, /a\.api\('PATCH', path\(/);
  assert.match(FEEDBACK_JS, /덧붙이면 다시 \\'확인 중\\'으로 열려요/);
  assert.match(FEEDBACK_JS, /'\/api\/me\/journal'/);
  assert.match(FEEDBACK_JS, /var JOURNAL_MAX = 8000;/);
  assert.match(FEEDBACK_JS, /같은 날 다시 쓰면 오늘 일지 아래에 덧붙여요/);
  assert.match(FEEDBACK_JS, /이메일·전화번호는 자동으로 가려져요/);
  assert.match(FEEDBACK_JS, /\[1, 2, 3, 4, 5\]/, '다시 올 점수 1~5');
  assert.match(CATALOG, /concat\(isAiMember \? \['journal'\] : \[\]\)/, '사용 일지 탭은 AI 명예회원만');
  assert.match(CATALOG, /if \(isAiMember\) tabs\.push\(\['journal', '사용 일지'\]\)/);
  assert.match(CATALOG, /window\.CGI_FEEDBACK\.renderJournal\(body\)/);
});

test('공개 화면: AI 명예회원 계정이면 머리글에 표시', () => {
  assert.match(INDEX, /<span class="ai-member-badge" data-auth-ai-badge hidden>AI 명예회원<\/span>/);
  assert.match(CATALOG, /aiBadges\[ab\]\.hidden = !isAiMember/);
  // display 를 준 배지도 hidden 이면 숨겨야 일반 회원 머리글에 보이지 않는다(캡처로 찾은 문제).
  assert.match(read('site/assets/css/cgi-feedback.css'), /\.ai-member-badge\[hidden\] \{ display: none !important; \}/);
  assert.match(read('site/assets/css/cgi-feedback.css'), /\.fb-status-reviewing \{/, '확인 중 배지 스타일');
});

test('회사 홈페이지: 푸터·연락처의 의견 보내기 → 쇼핑몰 의견 폼, 출처는 홈페이지 주소', () => {
  const foot = HOME.match(/<footer[\s\S]*?<\/footer>/)[0];
  assert.match(foot, /<a href="\.\.\/site\/feedback\.html" data-feedback-link>의견 보내기<\/a>/);
  const contact = HOME.match(/data-cgi-contact[\s\S]*?<\/ul>/)[0];
  assert.match(contact, /<a href="\.\.\/site\/feedback\.html" data-feedback-link>의견 보내기<\/a>/);
  assert.match(HOME_JS, /function initFeedbackLinks\(\)/);
  assert.match(HOME_JS, /base \+ '\?from=' \+ encodeURIComponent\(window\.location\.href\)/);
  assert.match(HOME_JS, /initFeedbackLinks\(\);/);
});
