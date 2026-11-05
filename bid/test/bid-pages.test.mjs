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

function loadUi() {
  const win = {};
  const ctx = createContext({
    window: win, URLSearchParams,
    document: { documentElement: { dataset: {} } },
    location: { search: '' },
    localStorage: { getItem() { return ''; }, setItem() {} },
  });
  for (const f of ['config.js', 'assets/data/bid-data.js', 'assets/data/result-data.js', 'assets/js/bid-ui.js']) {
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
