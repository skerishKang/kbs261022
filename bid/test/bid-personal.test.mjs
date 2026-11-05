// CGI 입찰정보(bid/) 개인화 회귀시험 — 이슈 #188 7차.
// 맞춤 조건 저장·제외 발주처·관심공고·CSV·캘린더 날짜 계산(모두 localStorage만 사용).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BID = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(BID, rel), 'utf8');

function makeStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

function loadPers({ search = '' } = {}) {
  const win = {};
  const store = makeStore();
  const ctx = createContext({
    window: win, URLSearchParams,
    document: { documentElement: { dataset: {} }, body: null, createElement: () => ({ click() {}, remove() {}, setAttribute() {}, appendChild() {} }) },
    location: { search },
    localStorage: store,
    Blob: class {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  });
  ctx.localStorage = store;
  for (const f of ['config.js', 'assets/data/bid-data.js', 'assets/data/result-data.js', 'assets/js/bid-ui.js', 'assets/js/bid-personal.js']) {
    runInContext(read(f), ctx);
  }
  return { win, P: win.BID_PERS, U: win.BID_UI, store };
}

test('맞춤 조건: 저장·불러오기·삭제, 중복 이름 거부, 최대 10개', () => {
  const { P } = loadPers();
  for (let i = 1; i <= 10; i++) {
    assert.equal(P.saveFilter('조건' + i, { cat: '구매', q: 'v' + i }).ok, true);
  }
  assert.equal(P.listFilters().length, 10);
  assert.equal(P.saveFilter('조건11', {}).ok, false, '최대 10개 초과는 거부');
  assert.equal(P.saveFilter('조건1', {}).ok, false, '중복 이름은 거부');
  assert.equal(P.saveFilter('', {}).ok, false, '빈 이름은 거부');
  const cond = P.getFilter('조건3');
  assert.equal(cond.cat, '구매');
  assert.equal(cond.q, 'v3');
  assert.equal(P.deleteFilter('조건3'), true);
  assert.equal(P.getFilter('조건3'), null);
  assert.equal(P.listFilters().length, 9);
  assert.equal(P.saveFilter('조건11', {}).ok, true, '삭제하면 다시 저장할 수 있다');
});

// vm 컨텍스트 안에서 만든 배열은 프로토타입이 달라 deepEqual이 실패하므로 값으로 비교한다.
const sameVals = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

test('제외 발주처: 부분일치 제외와 제외 건수 표시용 집계', () => {
  const { P, U } = loadPers();
  assert.equal(P.addExclude(''), false, '빈 값은 저장하지 않는다');
  assert.equal(P.addExclude('학교'), true);
  assert.equal(P.addExclude('학교'), true, '같은 값 재추가는 멱등');
  assert.equal(P.addExclude('도로공사'), true);
  sameVals(P.getExcludes(), ['학교', '도로공사']);
  const act = U.activeBids();
  const before = act.length;
  const kept = P.applyExcludes(act);
  assert.ok(kept.length <= before);
  assert.equal(P.countExcluded(act), before - kept.length);
  assert.ok(kept.every((b) => !P.isExcluded(b.a)), '남은 공고는 제외 대상이 아니어야 한다');
  assert.equal(P.removeExclude('학교'), true);
  sameVals(P.getExcludes(), ['도로공사']);
  P.removeExclude('도로공사');
  assert.equal(P.countExcluded(act), 0);
});

test('관심공고: 별표 토글, 상태 4종, 메모 200자 제한', () => {
  const { P, U } = loadPers();
  const no = U.activeBids()[0].no;
  assert.equal(P.isStarred(no), false);
  const r1 = P.toggleStar(no);
  assert.equal(r1.starred, true);
  assert.deepEqual(P.getStar(no).state, '검토중', '기본 상태는 검토중');
  assert.equal(P.setStar(no, { state: '투찰예정', memo: '가격 검토' }), true);
  assert.equal(P.getStar(no).state, '투찰예정');
  sameVals(P.STAR_STATES, ['검토중', '투찰예정', '투찰완료', '포기']);
  assert.equal(P.setStar(no, { state: '없는상태', memo: '' }), true, '모르는 상태는 무시하고 이전 값을 유지');
  assert.equal(P.getStar(no).state, '투찰예정');
  const long = '가'.repeat(250);
  P.setStar(no, { memo: long });
  assert.equal(P.getStar(no).memo.length, 200, '메모는 200자로 잘린다');
  const r2 = P.toggleStar(no);
  assert.equal(r2.starred, false);
  assert.equal(P.isStarred(no), false);
});

test('별표 버튼: cardHtml에 렌더되고 클릭으로 저장/해제된다(이벤트 위임)', () => {
  const { P, U, win } = loadPers();
  const b = U.DATA.bids[0];
  const html = U.cardHtml(b);
  assert.match(html, /class="star-btn/, '카드에 별표 버튼이 있다');
  assert.match(html, new RegExp('data-no="' + b.no));
  if (b.cgi_match) assert.match(html, /mk-chip/, 'CGI 매칭 공고에는 키워드 칩이 있다');
  else assert.doesNotMatch(html, /mk-chip/);
  // 가상 컨테이너로 위임 클릭 검증
  const clicks = [];
  const fakeRoot = {
    listeners: [],
    __persBound: false,
    addEventListener(type, fn) { this.listeners.push(fn); },
    querySelectorAll() { return []; },
  };
  P.bindStars(fakeRoot, (no, starred) => clicks.push([no, starred]));
  const btn = { dataset: { no: b.no }, classList: { toggle() {} }, setAttribute() {}, textContent: '' };
  fakeRoot.listeners[0]({ target: { closest: () => btn }, preventDefault() {} });
  assert.deepEqual(clicks, [[b.no, true]]);
  assert.equal(P.isStarred(b.no), true);
});

test('CSV: UTF-8 BOM + 헤더 + 따옴표 이스케이프 + CRLF', () => {
  const { P } = loadPers();
  const csv = P.toCsv(['공고번호', '공고명'], [['R1-001', '따옴표 "포함" 제목'], ['R1-002', '쉼표, 포함']]);
  assert.equal(csv.charCodeAt(0), 0xfeff, '첫 바이트가 UTF-8 BOM');
  const body = csv.slice(1);
  assert.match(body, /^공고번호,공고명\r\n/);
  assert.match(body, /"따옴표 ""포함"" 제목"/, '따옴표는 두 번으로 이스케이프');
  assert.match(body, /"쉼표, 포함"/, '쉼표가 있으면 통째로 인용');
  assert.match(body, /\r\n$/, '줄끝은 CRLF');
  const lines = body.trim().split('\r\n');
  assert.equal(lines.length, 3, '헤더 + 2행');
  assert.equal(P.csvCell(null), '');
  assert.equal(P.csvCell('평범'), '평범');
});

test('CSV 내보내기 칸: 공고번호·공고명·발주기관·금액·마감·원문 링크가 담긴다', () => {
  const { P, U } = loadPers();
  const b = U.activeBids().find((x) => x.ep != null);
  const headers = ['공고번호', '공고명', '발주기관', '분류', '추정가격(원)', '예산금액(원)', '투찰마감일시', '개찰일시', '상태', '원문링크'];
  const row = [b.no, b.t, b.a, b.c, b.ep, b.ab == null ? '' : b.ab, b.cd || '', b.od || '', b.s, b.cu || ''];
  const csv = P.toCsv(headers, [row]).slice(1);
  const cells = csv.split('\r\n')[1].split(',').map((c) => c.replace(/^"|"$/g, ''));
  assert.equal(cells[0], b.no);
  assert.equal(cells[1], b.t);
  assert.equal(cells[2], b.a);
  assert.equal(cells[4], String(b.ep));
  assert.equal(cells[9], b.cu || '');
});

test('캘린더 날짜: 데이터 일시는 한국시간 기준으로 날짜를 만든다', () => {
  const { P } = loadPers();
  assert.equal(P.kstDate('2026-11-06'), '2026-11-06');
  assert.equal(P.kstDate('2026-11-06 08:00:00'), '2026-11-06');
  assert.equal(P.kstDate('2026-11-06 23:30:00'), '2026-11-06');
  assert.equal(P.kstDate(''), null);
  assert.equal(P.kstDate('잘못된 값'), null);
});

test('캘린더 일정: 6차 규칙 — 장기 접수는 제외, 마감 없는 공고는 개찰만', () => {
  const { P, U } = loadPers();
  const lt = U.DATA.bids.find((b) => b.lt);
  if (lt) assert.equal(P.calEvents(lt).length, 0, '상시 접수 공고는 달력에 놓지 않는다');
  const noClose = U.DATA.bids.find((b) => !b.lt && !b.cd && b.od);
  if (noClose) {
    const kinds = P.calEvents(noClose).map((e) => e.kind);
    assert.ok(!kinds.includes('투찰마감'), '마감 미공개 공고는 투찰마감 일정을 만들지 않는다');
    assert.ok(kinds.includes('개찰'));
  }
  const normal = U.DATA.bids.find((b) => !b.lt && b.cd);
  if (normal) {
    const evs = P.calEvents(normal);
    assert.ok(evs.some((e) => e.kind === '투찰마감'));
    for (const e of evs) assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});
