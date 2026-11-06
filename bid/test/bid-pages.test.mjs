// CGI 입찰정보(bid/) 회귀시험 — 이슈 #188 3차.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const BID = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(BID, rel), 'utf8');
const pages = readdirSync(BID).filter((f) => f.endsWith('.html'));

function baseCtx(nowIso) {
  const win = nowIso ? { CGI_BID_NOW: nowIso } : {};
  const ctx = createContext({
    window: win, URLSearchParams,
    document: { documentElement: { dataset: {} } },
    location: { search: '' },
    localStorage: { getItem() { return ''; }, setItem() {} },
  });
  return { win, ctx };
}

function snapshotDate() {
  const { win, ctx } = baseCtx();
  runInContext(read('assets/data/bid-data.js'), ctx);
  return win.CGI_BID_DATA.snapshot;
}

function plusDays(iso, n) {
  const t = Date.parse((iso.length > 10 ? iso : iso + 'T00:00:00+09:00')) + n * 86400000;
  return new Date(t + 9 * 3600000).toISOString().slice(0, 10);
}

/* 기준 시각을 고정해 UI를 적재한다. 기본값은 수집일 13시(한국) — 기존 시험이 snapshot 기준
   D-day 계산을 그대로 검증하도록 두고, 11차 시험은 실제 오늘을 따로 주입한다. */
function loadUi(nowIso) {
  const { win, ctx } = baseCtx(nowIso || snapshotDate() + 'T13:00:00+09:00');
  for (const f of ['config.js', 'assets/data/bid-data.js', 'assets/data/result-data.js', 'assets/js/bid-ui.js', 'assets/js/bid-personal.js']) {
    runInContext(read(f), ctx);
  }
  return win.BID_UI;
}

test('잠금 칸에 예시 수치(가짜 금액·하한율)를 넣지 않는다', () => {
  for (const p of pages) {
    const html = read(p);
    assert.doesNotMatch(html, /1,295,850,000|542,113,000|552,480,000|502,905,000|약 21개사/, p);
    const locked = html.match(/class="lock-body[^"]*"[^>]*>[\s\S]*?<\/span>/g) || [];
    for (const l of locked) assert.doesNotMatch(l, /\d{1,3}(,\d{3})+원|\d+\.\d+%/, p + ' 잠금 칸 숫자');
  }
});

test('모든 화면이 같은 버전의 스크립트·데이터를 읽고 파일이 존재한다', () => {
  const versions = new Map();
  for (const p of pages) {
    const html = read(p);
    for (const need of ['config.js', 'assets/data/bid-data.js', 'assets/data/result-data.js', 'assets/js/bid-ui.js']) {
      assert.ok(html.includes(need), p + ' 에 ' + need + ' 없음');
    }
    for (const m of html.matchAll(/(?:src|href)="([^"?#:]+)\?v=([0-9a-z]+)"/g)) {
      assert.ok(existsSync(resolve(BID, m[1])), p + ': 파일 없음 ' + m[1]);
      if (versions.has(m[1])) assert.equal(versions.get(m[1]), m[2], p + ': 버전 불일치 ' + m[1]);
      versions.set(m[1], m[2]);
    }
    assert.match(html, /rel="canonical"/, p + ' canonical');
    assert.match(html, /property="og:title"/, p + ' og:title');
  }
});

test('스크립트 순서: config → 데이터 → bid-ui', () => {
  for (const p of pages) {
    const html = read(p);
    const i = (s) => html.indexOf(s);
    assert.ok(i('config.js') < i('assets/data/bid-data.js') && i('assets/data/result-data.js') < i('assets/js/bid-ui.js'), p);
  }
});

test('장기 접수 공고는 상시 접수로 표시하고 마감 임박에 넣지 않는다', () => {
  const U = loadUi();
  const lt = U.DATA.bids.filter((b) => b.lt);
  assert.ok(lt.length >= 1);
  for (const b of lt) {
    const d = U.ddOf(b);
    assert.equal(d.label, '상시 접수');
    assert.equal(d.over, false);
  }
});

test('마감일이 없는 공고는 개찰일시로 상태를 정한다', () => {
  const U = loadUi();
  const base = U.SNAPSHOT;
  assert.equal(U.ddState(null, base.replace(/-\d\d$/, '-01') + ' 09:00:00').label.startsWith('개찰'), true);
  const future = new Date(new Date(base + 'T12:00:00Z').getTime() + 5 * 86400000).toISOString().slice(0, 10);
  const d = U.ddState(null, future + ' 10:00:00');
  assert.equal(d.label, '개찰 D-5');
  assert.equal(d.noClose, true);
  assert.equal(U.ddState(null, null).label, '마감일 미공개');
});

test('오전 마감도 한국 날짜 기준으로 D-day를 센다', () => {
  const U = loadUi();
  const next = new Date(new Date(U.SNAPSHOT + 'T12:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  assert.equal(U.ddState(next + ' 08:00:00', null).label, 'D-1');
  assert.equal(U.ddState(U.SNAPSHOT + ' 08:00:00', null).label, '오늘 마감');
});

test('수의계약은 배지로 구분하고 경쟁방식 목록을 낸다', () => {
  const U = loadUi();
  assert.match(U.methodBadge({ k: '수의계약' }), /수의\(견적\)/);
  assert.equal(U.methodBadge({ k: '일반경쟁' }), '');
  assert.ok(U.methodList().includes('수의계약'));
});

test('낙찰 데이터가 없으면 낙찰 결과 메뉴에 준비 중을 표시한다', () => {
  const U = loadUi();
  assert.equal(U.RESULTS_READY, false);
  assert.match(read('assets/data/result-data.js'), /window\.CGI_RESULT_DATA = null;/);
});

test('요금 화면에 사전 신청 영역과 개인정보 안내가 있다', () => {
  const html = read('pricing.html');
  assert.match(html, /id="signup"/);
  assert.match(html, /개인정보처리방침/);
  assert.doesNotMatch(html, /disabled>요금 확정 후 안내/);
});

test('사정율 통계: collected:false 빈 상태에는 숫자가 하나도 없다(8차)', () => {
  const U = loadUi();
  const empty = U.rateStatsPanel(false, null);
  assert.match(empty, /낙찰 데이터 수집 전/);
  assert.doesNotMatch(empty.replace(/&\w+;/g, ''), /\d/, '빈 상태에 숫자를 내보내지 않는다');
  const short = U.rateStatsPanel(true, null);
  assert.match(short, /표본 부족/);
  assert.doesNotMatch(short.replace(/&\w+;/g, ''), /\d/, '표본 부족에도 숫자를 내보내지 않는다');
});

test('사정율 통계: 실데이터 묶음이 있으면 히스토그램·평균·n·기간·묶음 이름을 표시한다', () => {
  const U = loadUi();
  const bundle = {
    bundle: '발주기관: 기관A', group: 'agency', n: 35, mean: 99.5, median: 99.5, stdev: 0.12,
    histogram: [
      { bucket_low: 99.4, bucket_high: 99.5, count: 8 },
      { bucket_low: 99.5, bucket_high: 99.6, count: 27 },
    ],
    first_open: '2026-10-01', last_open: '2026-10-30',
  };
  const html = U.rateStatsPanel(true, bundle);
  assert.match(html, /<svg/, '인라인 SVG 히스토그램');
  assert.match(html, /99\.5/);
  assert.match(html, /35/);
  assert.match(html, /발주기관: 기관A/);
  assert.match(html, /2026-10-01/);
});

test('rate-stats.js는 빌드 산출물로 존재하고 실데이터 전까지 통계를 내보내지 않는다', () => {
  const src = read('assets/data/rate-stats.js');
  assert.match(src, /window\.CGI_RATE_STATS = /);
  const data = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;$/, ''));
  assert.equal(data.collected, false);
  assert.deepEqual(Object.keys(data.bundles), []);
  // 통계 숫자 필드(mean/median/stdev/histogram/n)가 산출물 어디에도 없어야 한다(날짜는 예외)
  for (const key of ['"mean"', '"median"', '"stdev"', '"histogram"', '"bucket_low"']) {
    assert.doesNotMatch(src, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '통계 필드 없음: ' + key);
  }
});

test('CGI 등급 탭: 목록은 CGI 핵심·CGI 연관 2종이고 데이터에는 cgi_tier가 있다', () => {
  const html = read('bids.html');
  assert.match(html, /CGI 핵심/);
  assert.match(html, /CGI 연관/);
  assert.doesNotMatch(html, /CGI 관련/, '7차 단일 탭 표기는 남아 있으면 안 된다');
  const U = loadUi();
  const tiers = new Set(U.DATA.bids.map((b) => b.cgi_tier));
  for (const t of ['core', 'related', 'none']) assert.ok(tiers.has(t), '등급 ' + t + ' 데이터 존재');
  assert.ok(U.DATA.bids.some((b) => b.cgi_tier === 'core'), '핵심 표본 존재');
  assert.ok(U.DATA.bids.some((b) => b.cgi_tier === 'related'), '연관 표본 존재');
});

test('10차 업무형: 다크 모드가 없다(토글·인라인 테마 스크립트·CSS 변수)', () => {
  for (const p of pages) {
    assert.doesNotMatch(read(p), /bid-theme|themeToggle/, p + '에 다크 모드 흔적');
  }
  const css = read('assets/css/bid.css');
  assert.doesNotMatch(css, /data-theme/, 'CSS에 다크 테마 규칙 없음');
  assert.doesNotMatch(css, /bindThemeToggle/, 'CSS에 토글 흔적 없음');
  const ui = read('assets/js/bid-ui.js');
  assert.doesNotMatch(ui, /bindThemeToggle|themeToggle|paintThemeBtn/, 'bid-ui.js에 테마 전환 없음');
});

test('10차 업무형: 목록은 표가 기본 보기고 열 구성이 CTO 기준과 같다', () => {
  const html = read('bids.html');
  assert.match(html, /view: U\.param\("view"\) \|\| "table"/, '기본 보기는 표');
  for (const col of ['번호', '공고명 / 발주기관', '추정가격', '지역', '공고일', '마감일시', '개찰일시']) {
    assert.match(html, new RegExp('<th[^>]*>\\s*' + col), '표 헤더: ' + col);
  }
  assert.match(html, /id="fRelated"/, "'검토 후보 포함' 체크");
  assert.match(html, /PAGE_SIZE = 20/, '20건/페이지');
  const U = loadUi();
  const row = U.bizRowHtml(U.DATA.bids[0], 1, false);
  for (const col of ['t-no', 'badge-cat', 't-title', 't-sub', 't-region', 'chip-dd', 'star-btn']) {
    assert.match(row, new RegExp(col), '목록 행에 ' + col + ' 있음');
  }
  const mini = U.bizRowHtml(U.DATA.bids[0], 1, true);
  assert.doesNotMatch(mini, /t-no/, '메인 축약 행은 번호 칸이 없다');
});

test('10차 업무형: 메인은 3개 표 + 분류별 건수이고 히어로·숫자 카드·아이콘 카드가 없다', () => {
  const html = read('index.html');
  for (const title of ['CGI 핵심 공고', '마감 임박', '최근 공고']) assert.match(html, new RegExp(title));
  for (const gone of ['class="hero"', 'heroSearch', 'catGrid', 'statRow', 'CAT_ICONS', 'grid-cards']) {
    assert.doesNotMatch(html, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '메인에서 제거: ' + gone);
  }
  assert.match(html, /id="catCounts"/, '분류별 건수');
  assert.match(html, /main-grid/, '좌표 2칸 배치');
  assert.match(html, /sum-line/, '한 줄 요약');
});

test('10차 업무형: 탭에서 CGI 연관이 빠지고 검토 후보는 체크로만 본다', () => {
  const html = read('bids.html');
  assert.doesNotMatch(html, /CATS\.push\(CGI_RELATED\)/, '연관 탭 제거');
  assert.match(html, /fRelated/, '검토 후보 체크');
  assert.match(html, /st\.rel \? b\.cgi_match : b\.cgi_tier === "core"/, '핵심 탭 필터가 체크를 반영');
});

test('10차 업무형: 목록 행은 2줄 고정 — 1줄 제목+키워드 칩, 2줄 발주기관+공고번호', () => {
  const U = loadUi();
  const b = U.DATA.bids.find((x) => x.cgi_match && Array.isArray(x.mk) && x.mk.length) || U.DATA.bids[0];
  const row = U.bizRowHtml(b, 1, false);
  const main = row.indexOf('<span class="t-main">');
  const sub = row.indexOf('<span class="t-sub">');
  assert.ok(main > -1 && sub > main, '제목 줄(t-main) 아래 보조 줄(t-sub)');
  const chips = row.indexOf('class="mk-chips"');
  assert.ok(chips > main && chips < sub, '키워드 칩은 제목과 같은 줄(t-main) 안에 있다');
  assert.doesNotMatch(row.slice(sub), /mk-chips/, '보조 줄에는 칩이 없다(셋째 줄로 늘지 않게)');
  assert.match(row, /<td class="t-cat">/, '분류 칸은 한 줄 고정(t-cat)');
  assert.match(read('assets/js/bid-ui.js'), /mkChips\(b, mini \? 3 : 2\)/, '목록 행은 칩 2개까지');
  const css = read('assets/css/bid.css');
  assert.match(css, /\.bid-table \.t-main \.mk-chips \{[^}]*flex-wrap: nowrap/, '칩 줄바꿈 금지');
  assert.match(css, /\.bid-table \.t-sub \{[^}]*white-space: nowrap/, '보조 줄 한 줄 고정');
});

test('10차 업무형: 1440×900 첫 화면 표 행 8건 이상(행 높이 예산)', () => {
  const css = read('assets/css/bid.css');
  const pad = css.match(/\.bid-table tbody td \{ padding: (\d+)px \d+px; \}/);
  assert.ok(pad, '행 안쪽 여백 선언을 찾는다');
  const padY = Number(pad[1]);
  assert.ok(padY <= 3, '행 세로 여백 3px 이하(실측 44px 행): ' + padY);
  // 행 높이 상한 = 위아래 여백 + 구분선 + 2줄(제목 20px·보조 18px 상한)
  const rowBudget = padY * 2 + 1 + 38;
  const chrome = 460; // 2026-11-06 headless Chrome 실측: 1440×900에서 표 첫 행 top(458)의 예산
  assert.ok(chrome + 8 * rowBudget <= 900, '첫 화면 8행 예산: ' + (chrome + 8 * rowBudget) + 'px');
  assert.match(read('bids.html'), /PAGE_SIZE = 20/, '한 페이지 20건');
});

test('10차 업무형: 필터는 4열 셀 8개 + 보조 3줄이고 높이 예산 150px를 넘지 않는다', () => {
  const html = read('bids.html');
  const cells = (html.match(/class="f-cell"/g) || []).length;
  assert.equal(cells, 8, '조건 셀 8개');
  assert.equal((html.match(/class="f-row"/g) || []).length, 0, '이전 2쌍 행 구조가 남아 있지 않다');
  for (const cls of ['f-extra', 'pers-line', 'filter-actions']) {
    assert.equal((html.match(new RegExp('class="' + cls + '"', 'g')) || []).length, 1, cls + ' 한 줄');
  }
  const css = read('assets/css/bid.css');
  assert.match(css, /\.filter-grid2 \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/, '4열 격자');
  const ctrl = css.match(/\.f-cell select, \.f-cell input \{[^}]*height: (\d+)px/);
  assert.ok(ctrl, '필터 컨트롤 높이 선언');
  const ctrlH = Number(ctrl[1]);
  const budget = Math.ceil(cells / 4) * (ctrlH + 2) + 3 * (ctrlH + 2) + 8;
  assert.ok(budget <= 150, '필터 높이 예산 150px 이하(계산 ' + budget + 'px)');
  assert.match(html, /class="list-toolbar"[\s\S]*?id="sortSel"/, '정렬은 툴바 안에 있다');
  assert.doesNotMatch(css, /\.sortbar/, '별도 정렬 바 CSS가 없다');
});

test('10차: 모든 화면 스크립트의 getElementById 대상이 마크업 id로 존재한다', () => {
  const ui = read('assets/js/bid-ui.js');
  const generated = new Set([...ui.matchAll(/id="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));
  for (const p of pages) {
    const html = read(p);
    const ids = new Set([...html.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((m) => m[1]));
    for (const id of ids) {
      assert.ok(new RegExp('id="' + id + '"').test(html) || generated.has(id), p + ' → #' + id + ' 가 마크업에 없다');
    }
  }
});

test('10차: CSS·JS 버전 쿼리는 한 값으로 통일한다', () => {
  const versions = new Set();
  for (const p of pages) for (const m of read(p).matchAll(/\?v=([0-9a-z]+)/g)) versions.add(m[1]);
  assert.equal(versions.size, 1, '버전 값: ' + [...versions].join(', '));
});

test('10차: 메인의 분류 링크는 목록에 있는 탭만 가리키고, 목록은 없는 cat을 전체로 되돌린다', () => {
  const html = read('index.html');
  const allowed = new Set(['구매', '공사', '용역', '매각', 'CGI 핵심', '전체']);
  const catList = html.match(/var cats = \[([^\]]+)\]/);
  assert.ok(catList, '메인 분류 목록');
  for (const c of catList[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''))) {
    assert.ok(allowed.has(c), '없는 탭 링크: ' + c);
  }
  for (const m of html.matchAll(/bids\.html\?cat=' \+ encodeURIComponent\("([^"]+)"\)/g)) {
    assert.ok(allowed.has(m[1]), '없는 탭 링크: ' + m[1]);
  }
  assert.match(read('bids.html'), /if \(CATS\.indexOf\(st\.cat\) < 0\) st\.cat = "전체";/, '없는 cat 가드');
  assert.match(read('bids.html'), /<select id="fCat">\s*<option value="전체">전체<\/option>/, '분류 첫 값 = 전체');
});

test('11차: 상태·D-day 기준은 수집일이 아니라 실제 오늘이다', () => {
  const snap = snapshotDate();
  const onSnap = loadUi(snap + 'T13:00:00+09:00');
  assert.ok(onSnap.activeBids().some((b) => onSnap.ddOf(b).label === '오늘 마감'), '수집일 당일에는 오늘 마감 표본이 있다');
  const later = plusDays(snap, 14);
  const U = loadUi(later + 'T12:00:00+09:00');
  for (const b of U.activeBids()) {
    if (String(b.cd || '').slice(0, 10) !== later) {
      assert.notEqual(U.ddOf(b).label, '오늘 마감', b.no + ' 지난 공고에 오늘 마감');
    }
    if (String(b.od || '').slice(0, 10) !== later) {
      assert.notEqual(U.ddOf(b).label, '오늘 개찰', b.no + ' 지난 공고에 오늘 개찰');
    }
  }
});

test('11차: 개찰 단계도 실제 오늘로 판정한다', () => {
  const snap = snapshotDate();
  const today = plusDays(snap, 14);
  const U = loadUi(today + 'T12:00:00+09:00');
  const past = U.DATA.bids.find((b) => b.od && String(b.od).slice(0, 10) < today);
  assert.ok(past, '과거 개찰 표본');
  assert.equal(U.openPhase(past), '개찰 완료');
  const future = U.DATA.bids.find((b) => b.od && String(b.od).slice(0, 10) > today);
  if (future) assert.equal(U.openPhase(future), '개찰 대기');
});

test('11차: 수집일이 오늘보다 2일 이상 전이면 시범 데이터다', () => {
  const snap = snapshotDate();
  const age = (n) => loadUi(plusDays(snap, n) + 'T12:00:00+09:00');
  assert.equal(age(0).dataAgeDays(), 0);
  assert.equal(age(0).isTrialData(), false);
  assert.equal(age(1).isTrialData(), false, '어제 수집분은 실데이터');
  assert.equal(age(2).isTrialData(), true, '이틀 전 수집분부터 시범 데이터');
  assert.equal(age(14).dataAgeDays(), 14);
});

test('11차: 시범 데이터 띠는 모든 화면 머리말에 붙고 문구가 고정된다', () => {
  const snap = snapshotDate();
  const trial = loadUi(plusDays(snap, 14) + 'T12:00:00+09:00');
  const bar = trial.trialBarHtml();
  assert.match(bar, /class="trial-bar"/);
  assert.ok(bar.includes('시범 데이터'), '시범 데이터 표기');
  assert.ok(bar.includes(snap + ' 수집분입니다. 마감 여부는 나라장터 원문으로 확인하십시오.'), '문구 고정');
  assert.equal(loadUi().trialBarHtml(), '', '실데이터에는 띠가 없다');
  const ui = read('assets/js/bid-ui.js');
  assert.match(ui, /function renderHeader[\s\S]*?trialBarHtml\(\)/, '머리말이 띠를 렌더한다');
  for (const p of pages) assert.match(read(p), /U\.renderHeader\(/, p + ' 머리말 렌더');
});

test('11차: 시범 데이터면 메인이 오늘 마감·마감 임박을 숨기고 수집분 표만 보인다', () => {
  const html = read('index.html');
  assert.match(html, /id="soonSection"/);
  assert.match(html, /soonSection"\)\.hidden = true/);
  assert.match(html, /U\.SNAPSHOT\.slice\(5\) \+ " 수집 공고\(CGI 핵심\)"/, '수집일 제목');
  assert.match(html, /"최근 수집 공고"/, '최근 수집 공고 제목');
  assert.match(html, /var trial = U\.isTrialData\(\)/);
  assert.match(html, /오늘 마감 <strong>/, '실데이터 분기의 기존 숫자는 유지');
  assert.match(html, /if \(trial\) \{\s*coreSort\.sort\(/, '시범 데이터 핵심 표는 공고일 최신순');
  assert.match(read('assets/css/bid.css'), /\.panel\[hidden\] \{ display: none; \}/);
});

test('11차: 목록 기본 정렬은 시범 데이터일 때 공고일 최신순이다', () => {
  assert.match(read('bids.html'), /sort: U\.param\("sort"\) \|\| \(U\.isTrialData\(\) \? "new" : "close"\)/);
  assert.match(read('bids.html'), /<option value="new">최신공고순<\/option>/);
});

test('11차: 마감 필터는 실제 오늘 기준이고 빈 기간에는 빈 상태 문구를 낸다', () => {
  const snap = snapshotDate();
  const U = loadUi(plusDays(snap, 14) + 'T12:00:00+09:00');
  const sameDay = U.activeBids().filter((b) => String(b.cd || '').slice(0, 10) === snap);
  assert.ok(sameDay.length > 0, '수집일 마감 표본');
  for (const b of sameDay) assert.notEqual(U.ddOf(b).label, '오늘 마감', b.no);
  assert.match(read('bids.html'), /선택한 기간\(" \+ PERIOD_LABELS\[st\.period\] \+ "\)에 마감하는 공고가 없습니다/);
});

test('11차: canonical·og:url 은 같은 clean URL 이다', () => {
  for (const p of pages) {
    const html = read(p);
    const canon = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    const og = (html.match(/<meta property="og:url" content="([^"]+)"/) || [])[1];
    assert.ok(canon && og, p + ' canonical/og:url 존재');
    assert.equal(canon, og, p + ' canonical·og:url 불일치');
    assert.doesNotMatch(canon, /\.html$/, p + ' clean URL 아님: ' + canon);
    assert.match(canon, /^https:\/\/cgishop\.pages\.dev\/bid\//, p);
  }
  assert.match(read('bid.html'), /canonical" href="https:\/\/cgishop\.pages\.dev\/bid\/bid"/, '상세는 자기 주소');
});
