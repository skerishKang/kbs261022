/**
 * verify_website_profile.mjs — 이슈 #97 회사 홈페이지 실반영 검증
 *
 * 검증 범위 (data 가 아니라 렌더된 DOM 을 본다)
 *  - 데스크톱 1440 / 모바일 390: JS 오류 0, 깨진 이미지 0, 가로 오버플로 0
 *  - 지명원 기반 섹션이 실제로 채워지는지 개수로 확인 (조직도·연혁·키워드·사업분야·
 *    레퍼런스·실적·유지보수·인증·대리점·브랜드)
 *  - REFERENCE 탭 전환이 실제로 패널을 보여주는지, 브랜드 좁히기 입력이 동작하는지
 *  - 게시되면 안 되는 구(舊) 주소가 렌더 텍스트에 없는지
 *
 * 실행:
 *   python -m http.server 8849 --directory .      # 별도 터미널(리포지토리 루트)
 *   node tools/verify_website_profile.mjs --base http://127.0.0.1:8849
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = arg('base', 'http://127.0.0.1:8849').replace(/\/$/, '');
const OUT = resolve(REPO_ROOT, arg('out', 'docs/screenshots/issue97'));
const REPORT = resolve(REPO_ROOT, arg('report', 'docs/CGI_ISSUE97_PROFILE_TESTLOG.json'));
const EXECUTABLE = arg('chrome', join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe'));
const HOME_URL = `${BASE}/website/index.html`;
const MALL_URL = `${BASE}/site/index.html`;

const results = [];
let failed = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) { failed++; console.log(`FAIL  ${name}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); }
  else { console.log(`ok    ${name}${detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : ''}`); }
}

const VIEWS = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'mobile', width: 390, height: 844 }
];

const COUNTS = [
  ['조직도 부서', '#orgChart .org-branch', 2],
  ['조직도 팀/직무', '#orgChart .org-sub > li', 4],
  ['연혁 연도行', '#historyList .tl-row', 10],
  ['주요사업 키워드', '#bizKeywords .kw', 12],
  ['사업분야 카드', '#bizGrid .biz-card', 10],
  ['취급 브랜드', '#brandGrid li', 31],
  ['시공 레퍼런스', '#refGrid .ref-card', 12],
  ['연도별 실적', '#recordList .rec-year', 5],
  ['유지보수 사례', '#maintList li', 4],
  ['인증·제증명 그룹', '#credList .cred-group', 3],
  ['대리점 지정', '#agencyList li', 2]
];

const REQUIRED_TEXT = [
  ['장성 주소', '전라남도 장성군 남면 나노산단로 102'],
  ['우편번호', '57248'],
  ['대표전화 1', '062) 576-8100'],
  ['대표전화 2', '061) 801-8100'],
  ['팩스', '062) 576-8181'],
  ['사업자번호', '410-86-46283'],
  ['설립', '2011년 1월'],
  ['기준연도 라벨', '2025년 지명원 기준'],
  ['유효성 주의', '현재 유효성은 별도 확인이 필요합니다'],
  ['대표 레퍼런스', '새순교회'],
  ['정보통신공사업', '정보통신공사업']
];

const FORBIDDEN_TEXT = ['하남산단천변좌로', '광주드림파크', '오선동', '010-9226-4351', 'detach', 'anchor'];

async function survey(page) {
  return page.evaluate((sels) => {
    const out = { counts: {}, overflow: 0, broken: [], visible: {} };
    for (const [label, sel] of sels) { out.counts[label] = document.querySelectorAll(sel).length; }
    const de = document.documentElement;
    out.overflow = Math.max(0, de.scrollWidth - de.clientWidth);
    for (const img of document.querySelectorAll('img')) {
      if (img.complete && img.naturalWidth === 0) { out.broken.push(img.getAttribute('src')); }
    }
    const txt = (document.body.innerText || '');
    out.text = txt;
    return out;
  }, COUNTS.map((c) => [c[0], c[1]]));
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const log = { base: BASE, ranAt: new Date().toISOString(), views: {}, console: [], requests: [] };
  const shots = [];

  for (const view of VIEWS) {
    const ctx = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      deviceScaleFactor: 1
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') { errors.push('console: ' + m.text()); log.console.push(m.text()); } });
    page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
    page.on('response', (r) => {
      if (r.status() >= 400) { errors.push(`http ${r.status()}: ${r.url()}`); log.requests.push({ status: r.status(), url: r.url() }); }
    });

    await page.goto(HOME_URL, { waitUntil: 'load' });
    await page.waitForSelector('#bizGrid .biz-card', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#brandGrid li').length > 0, null, { timeout: 15000 });
    await page.waitForTimeout(400);

    const s = await survey(page);
    log.views[view.id] = { counts: s.counts, overflow: s.overflow, broken: s.broken, errors };

    check(`[${view.id}] 런타임 오류 0`, errors.length === 0, errors.slice(0, 4));
    check(`[${view.id}] 깨진 이미지 0`, s.broken.length === 0, s.broken);
    check(`[${view.id}] 가로 오버플로 0`, s.overflow <= 1, s.overflow);

    for (const [label, sel, min] of COUNTS) {
      check(`[${view.id}] ${label} >= ${min}`, s.counts[label] >= min, { sel, got: s.counts[label] });
    }
    for (const [label, needle] of REQUIRED_TEXT) {
      check(`[${view.id}] 게시됨: ${label}`, s.text.includes(needle), needle);
    }
    for (const needle of FORBIDDEN_TEXT) {
      check(`[${view.id}] 비게시: ${needle}`, !s.text.includes(needle), needle);
    }

    // tel 링크가 데이터 값으로 실제로 조립되었는지
    const tels = await page.$$eval('a[href^="tel:"]', (as) => as.map((a) => a.getAttribute('href')));
    check(`[${view.id}] tel 링크 두 회선`, ['0625768100', '0618018100'].every((d) => tels.includes('tel:' + d)), tels);

    // 지도 링크가 로드명 주소로 조립되었는지
    const maps = await page.$$eval('a[href*="map.naver.com"], a[href*="google.com/maps"]', (as) => as.map((a) => a.href));
    check(`[${view.id}] 지도 링크 2종`, maps.length >= 2 && maps.every((h) => decodeURIComponent(h).includes('장성군')), maps.length);

    if (view.id === 'desktop') {
      await page.screenshot({ path: join(OUT, 'home-top.png') });
      shots.push('home-top.png');
      // REFERENCE 탭 전환 실동작
      await page.locator('#reference').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(OUT, 'reference-install.png') });
      shots.push('reference-install.png');
      const tabState = [];
      for (const tab of ['tabInstall', 'tabRecords', 'tabMaint']) {
        await page.click(`#${tab}`);
        await page.waitForTimeout(250);
        const vis = await page.evaluate((id) => {
          const tabs = Array.from(document.querySelectorAll('.ref-tabs [role=tab]'));
          return tabs.map((t) => {
            const p = document.getElementById(t.getAttribute('aria-controls'));
            return {
              tab: t.id,
              selected: t.getAttribute('aria-selected'),
              panel: p ? p.id : null,
              hidden: p ? p.hasAttribute('hidden') : null,
              rows: p ? p.querySelectorAll('li').length : -1
            };
          });
        }, tab);
        tabState.push({ tab, vis });
      }
      const shown = tabState.map((t) => t.vis.find((p) => p.tab === t.tab));
      check('[desktop] 탭 클릭 시 해당 패널 노출 + 행 보유', shown.every((p) => p && p.hidden === false && p.rows > 0 && p.selected === 'true'), tabState);
      const othersHidden = tabState.every((t) => t.vis.filter((p) => p.tab !== t.tab).every((p) => p.hidden === true));
      check('[desktop] 미선택 탭 패널은 숨김', othersHidden, tabState.map((t) => t.vis));
      await page.screenshot({ path: join(OUT, 'reference-records.png') });
      shots.push('reference-records.png');

      // 사업분야/브랜드 섹션 캡처
      await page.locator('#business').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(OUT, 'business.png') });
      shots.push('business.png');

      // 브랜드 좁히기 실동작
      await page.locator('#products').scrollIntoViewIfNeeded();
      const before = await page.$$eval('#brandGrid li', (ls) => ls.filter((l) => l.style.display !== 'none').length);
      await page.fill('#brandFilter', 'shure');
      await page.waitForTimeout(200);
      const after = await page.$$eval('#brandGrid li', (ls) => ls.filter((l) => l.style.display !== 'none').length);
      check('[desktop] 브랜드 좁히기 감소', after > 0 && after < before, { before, after });
      await page.fill('#brandFilter', '없는브랜드zzz');
      await page.waitForTimeout(200);
      const none = await page.$$eval('#brandGrid li', (ls) => ls.filter((l) => l.style.display !== 'none').length);
      const emptyMsgVisible = await page.evaluate(() => {
        const e = document.getElementById('brandEmpty');
        return !!e && !e.hasAttribute('hidden');
      });
      check('[desktop] 브랜드 0건 시 안내 노출', none === 0 && emptyMsgVisible, { none, emptyMsgVisible });
      await page.fill('#brandFilter', '');
    } else {
      await page.screenshot({ path: join(OUT, 'home-mobile.png') });
      shots.push('home-mobile.png');
      // 모바일 메뉴 토글 실동작
      const navVisibleBefore = await page.evaluate(() => document.getElementById('primaryNav').classList.contains('open'));
      await page.click('#navToggle');
      await page.waitForTimeout(250);
      const navVisibleAfter = await page.evaluate(() => document.getElementById('primaryNav').classList.contains('open'));
      check('[mobile] 메뉴 토글', navVisibleBefore === false && navVisibleAfter === true, { navVisibleBefore, navVisibleAfter });
      await page.screenshot({ path: join(OUT, 'menu-mobile.png') });
      shots.push('menu-mobile.png');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const closed = await page.evaluate(() => !document.getElementById('primaryNav').classList.contains('open'));
      check('[mobile] Esc 로 메뉴 닫힘', closed);
    }
    await ctx.close();
  }

  // 쇼핑몰: 회사정보 정본 연동 + 상품 데이터 무결성
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('response', (r) => {
      if (r.status() >= 400) { errors.push(`http ${r.status()}: ${r.url()}`); log.requests.push({ status: r.status(), url: r.url() }); }
    });
    await page.goto(MALL_URL + '#/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.hasAttribute('data-cgi-ready'), null, { timeout: 20000 });
    const mall = await page.evaluate(() => ({
      company: !!window.CGI_COMPANY,
      products: Array.isArray(window.CGI_PRODUCTS) ? window.CGI_PRODUCTS.length : -1,
      footerText: (document.querySelector('.footer-contact') || {}).innerText || '',
      ready: document.body.getAttribute('data-cgi-ready')
    }));
    log.mall = { ...mall, errors };
    check('[mall] 런타임 오류 0', errors.length === 0, errors.slice(0, 4));
    check('[mall] company.js 연동', mall.company === true);
    check('[mall] 상품 4,575건 유지', mall.products === 4575, mall.products);
    check('[mall] 푸터 장성 주소', mall.footerText.includes('장성'), mall.footerText.slice(0, 80));

    // about 페이지 문의 안내가 데이터에서 조립되는지
    await page.goto(MALL_URL + '#/about', { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const about = await page.evaluate(() => document.body.innerText);
    check('[mall/about] 두 대표전화 게시', about.includes('062) 576-8100') && about.includes('061) 801-8100'));
    check('[mall/about] 장성 본사', about.includes('전라남도 장성군'));
    check('[mall/about] 구 주소 없음', !about.includes('하남산단천변좌로'));
    await page.screenshot({ path: join(OUT, 'mall-about.png') });
    shots.push('mall-about.png');

    // 목록 라우팅 회귀 (브랜드 필터 링크 포함)
    await page.goto(MALL_URL + '#/products?brand=SHURE', { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const list = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-product-card], .product-card, li.card, .card').length,
      text: document.body.innerText.slice(0, 400)
    }));
    check('[mall] 브랜드 필터 라우팅 작동', list.cards > 0, { cards: list.cards });
    await ctx.close();
  }

  await browser.close();
  log.results = results;
  log.screenshots = shots;
  log.summary = { total: results.length, failed };
  writeFileSync(REPORT, JSON.stringify(log, null, 2), 'utf8');
  console.log(`\n${results.length - failed}/${results.length} 통과 — 리포트: ${REPORT}`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
