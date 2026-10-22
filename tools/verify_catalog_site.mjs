/**
 * verify_catalog_site.mjs -- CGI 상품 카탈로그 사이트 브라우저 검증 (이슈 #11)
 *
 * 실행
 *   1) 정적 서버 기동:  python -m http.server 8848 --directory site
 *   2) 검증 실행:      node tools/verify_catalog_site.mjs
 *
 * 검증 항목(이슈 #11 §7 최소 테스트)
 *   1. 메인 페이지 표시
 *   2. 상품 검색
 *   3. 브랜드 필터
 *   4. 카테고리 필터
 *   5. 실제 상품 이미지 표시
 *   6. 상품 상세페이지 이동
 *   7. 모바일 화면(390px)
 *   8. 빈 검색 결과
 *   9. 잘못된 이미지 URL 처리
 *  10. 가격 미확인 상품 처리
 *
 * 결과는 JSON 으로 stdout 에 출력되고, 스크린샷은 --out 디렉터리에 저장된다.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:8848');
const OUT = resolve(REPO_ROOT, arg('out', 'docs/screenshots/issue-11'));
const EXECUTABLE = arg('chrome', join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe'));
const REPORT = resolve(REPO_ROOT, arg('report', 'docs/CGI_CATALOG_SITE_TESTLOG.json'));

mkdirSync(OUT, { recursive: true });

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail !== undefined && detail !== null ? ' :: ' + JSON.stringify(detail) : ''}`);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const loc = (m.location && m.location() && m.location().url) || '';
  consoleErrors.push('console: ' + m.text() + ' @ ' + loc);
});

async function ready() {
  await page.waitForSelector('body[data-cgi-ready="1"]', { timeout: 20000 });
}
async function shot(name) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.screenshot({ path: join(OUT, name), fullPage: false, timeout: 30000 });
  console.log('   screenshot -> ' + name);
}

try {
  /* ---------------------------------------------------- 1. 메인 페이지 */
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await ready();
  const home = await page.evaluate(() => ({
    h1: (document.querySelector('.hero h1') || {}).textContent || '',
    statCount: document.querySelectorAll('.stat-card').length,
    cards: document.querySelectorAll('.product-card').length,
    chips: document.querySelectorAll('.chip-row .chip').length,
    notice: (document.querySelector('#noticeText') || {}).textContent || '',
  }));
  check('1. 메인 페이지 표시', home.h1.includes('CGI') && home.statCount >= 3 && home.cards > 0, home);
  await shot('01-home-desktop-1440.png');

  /* ------------------------------------------------- 1b. 전체 상품 목록 */
  await page.goto(BASE + '/index.html#/products', { waitUntil: 'domcontentloaded' });
  await ready();
  const listView = await page.evaluate(() => ({
    cards: document.querySelectorAll('.product-card').length,
    result: (document.querySelector('.result-count') || {}).textContent || '',
    facetGroups: document.querySelectorAll('.filter-group').length,
  }));
  check('1b. 전체 상품 목록 표시', listView.cards > 0 && listView.facetGroups >= 2, listView);
  await shot('02-list-desktop-1440.png');

  /* ------------------------------------------------ 5. 실제 상품 이미지 */
  const imageInfo = await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('.card-img'));
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
    const real = imgs.filter((i) => i.tagName === 'IMG' && i.naturalWidth > 0);
    return { total: imgs.length, loaded: real.length, sample: real.slice(0, 3).map((i) => i.currentSrc || i.src) };
  });
  check('5. 실제 상품 이미지 표시', imageInfo.loaded > 0, imageInfo);

  /* ------------------------------------------------------- 2. 상품 검색 */
  const totalProducts = await page.evaluate(() => window.CGI_PRODUCTS.length);
  await page.fill('#headerSearch', 'SHURE');
  await page.press('#headerSearch', 'Enter');
  await page.waitForSelector('.list-layout', { timeout: 15000 });
  await ready();
  const searchState = await page.evaluate(() => ({
    hash: location.hash,
    count: (document.querySelector('.result-count') || {}).textContent || '',
    cards: document.querySelectorAll('.product-card').length,
    allShure: Array.from(document.querySelectorAll('.card-brand')).every((e) => e.textContent.trim().toUpperCase().includes('SHURE')),
  }));
  check('2. 상품 검색', searchState.cards > 0 && searchState.allShure && searchState.cards < totalProducts, { totalProducts, ...searchState });
  await shot('03-search-shure-desktop-1440.png');

  /* -------------------------------------------- 3. 브랜드 필터 (체크박스) */
  await page.goto(BASE + '/index.html#/products', { waitUntil: 'domcontentloaded' });
  await ready();
  const brandBox = page.locator('[data-facet="brand"]').first();
  const brandValue = await brandBox.getAttribute('value');
  await brandBox.check();
  await page.waitForFunction((v) => {
    const q = (location.hash.split('?')[1] || '');
    return (new URLSearchParams(q).get('brand') || '').split(',').includes(v);
  }, brandValue, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.active-filter').length === 1, null, { timeout: 10000 });
  const brandState = await page.evaluate(() => ({
    hash: location.hash,
    cards: document.querySelectorAll('.product-card').length,
    chips: document.querySelectorAll('.active-filter').length,
  }));
  check('3. 브랜드 필터', brandState.chips === 1 && brandState.cards > 0, { brand: brandValue, ...brandState });
  await shot('04-brand-filter-desktop-1440.png');

  /* -------------------------------------------- 4. 카테고리 필터 */
  await page.goto(BASE + '/index.html#/products', { waitUntil: 'domcontentloaded' });
  await ready();
  const catBox = page.locator('[data-facet="cat"]').first();
  const catValue = await catBox.getAttribute('value');
  await catBox.check();
  await page.waitForFunction((v) => {
    const q = (location.hash.split('?')[1] || '');
    return (new URLSearchParams(q).get('cat') || '').split(',').includes(v);
  }, catValue, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.active-filter').length === 1, null, { timeout: 10000 });
  const catState = await page.evaluate(() => ({
    hash: location.hash,
    cards: document.querySelectorAll('.product-card').length,
    chips: document.querySelectorAll('.active-filter').length,
  }));
  check('4. 카테고리 필터', catState.chips === 1 && catState.cards > 0, { cat: catValue, ...catState });
  await shot('05-category-filter-desktop-1440.png');

  /* ------------------------------------------- 6. 상품 상세페이지 이동 */
  await page.goto(BASE + '/index.html#/products', { waitUntil: 'domcontentloaded' });
  await ready();
  const cardName = await page.locator('.card-name').first().textContent();
  await page.locator('.product-card').first().click();
  await page.waitForSelector('.detail-grid', { timeout: 15000 });
  const detail = await page.evaluate(() => ({
    hash: location.hash,
    title: (document.querySelector('.detail-title') || {}).textContent || '',
    price: (document.querySelector('.detail-price') || {}).textContent || '',
    specRows: document.querySelectorAll('.spec-table tr').length,
    thumbs: document.querySelectorAll('.gallery-thumbs button').length,
    sourceLink: !!document.querySelector('.source-box a[href^="http"]'),
    backLink: !!document.querySelector('.back-link'),
  }));
  check('6. 상품 상세페이지 이동', detail.title.length > 0 && detail.specRows > 0 && detail.sourceLink && detail.backLink, { cardName, ...detail });
  await shot('06-detail-desktop-1440.png');

  /* 상세 -> 목록 복귀 */
  await page.click('.back-link');
  await page.waitForSelector('.list-layout', { timeout: 10000 });
  check('6b. 상세에서 목록으로 돌아가기', (await page.locator('.list-layout').count()) === 1, { hash: page.url().split('#')[1] });

  /* ---------------------------------------- 10. 가격 미확인 상품 처리 */
  const inquiryProduct = await page.evaluate(() => {
    const p = (window.CGI_PRODUCTS || []).find((x) => x.price && x.price.state === 'inquiry');
    return p ? { id: p.id, name: p.name, text: p.price.text } : null;
  });
  let priceState = { inquiry: 0, public: 0, inquiryText: '', firstPrice: '' };
  if (inquiryProduct) {
    await page.goto(BASE + '/index.html#/product/' + encodeURIComponent(inquiryProduct.id), { waitUntil: 'domcontentloaded' });
    await ready();
    const detailPrice = await page.evaluate(() => ({
      text: (document.querySelector('.detail-price') || {}).textContent || '',
      isInquiry: !!document.querySelector('.detail-price.inquiry'),
      note: (document.querySelector('.detail-price-note') || {}).textContent || '',
    }));
    priceState.inquiry = 1;
    priceState.inquiryText = detailPrice.text;
    check('10. 가격 미확인 상품 처리', detailPrice.isInquiry && /문의/.test(detailPrice.text), { inquiryProduct, detailPrice });
    await shot('14-inquiry-price-detail-desktop-1440.png');
  } else {
    check('10. 가격 미확인 상품 처리', false, { reason: 'no inquiry product in dataset' });
  }
  const publicOnList = await page.evaluate(() => {
    const rows = (window.CGI_PRODUCTS || []).filter((p) => p.price && p.price.state === 'public').length;
    return { publicProducts: rows };
  });
  check('10b. 공개 판매가 상품 병존', publicOnList.publicProducts > 0, publicOnList);

  /* --------------------------------------------- 8. 빈 검색 결과 */
  await page.goto(BASE + '/index.html#/products?q=' + encodeURIComponent('zzz-not-exist-product-zzz'), { waitUntil: 'domcontentloaded' });
  await ready();
  const empty = await page.evaluate(() => ({
    hasEmpty: !!document.querySelector('.empty-state'),
    heading: (document.querySelector('.empty-state h3') || {}).textContent || '',
    cards: document.querySelectorAll('.product-card').length,
  }));
  check('8. 빈 검색 결과', empty.hasEmpty && empty.cards === 0, empty);
  await shot('07-empty-result-desktop-1440.png');

  /* ---------------------------------------- 9. 잘못된 이미지 URL 처리 */
  await page.goto(BASE + '/index.html#/products', { waitUntil: 'domcontentloaded' });
  await ready();
  const broken = await page.evaluate(async () => {
    const img = document.querySelector('.card-img');
    if (!img || img.tagName !== 'IMG') return { skipped: true };
    img.setAttribute('src', 'https://example.invalid/does-not-exist.jpg');
    await new Promise((r) => setTimeout(r, 1200));
    return {
      placeholderShown: !!document.querySelector('.thumb .no-image'),
      brokenNatural: document.querySelector('img.card-img') ? document.querySelector('img.card-img').naturalWidth : -1,
    };
  });
  check('9. 잘못된 이미지 URL 처리', broken.skipped || broken.placeholderShown, broken);
  await shot('08-broken-image-desktop-1440.png');

  /* ----------------------------------------------- 7. 모바일 화면(390) */
  const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' });
  const mpage = await mobileCtx.newPage();
  mpage.on('pageerror', (e) => consoleErrors.push('mobile: ' + String(e.message)));
  await mpage.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await mpage.waitForSelector('body[data-cgi-ready="1"]', { timeout: 20000 });
  const mHome = await mpage.evaluate(() => ({
    vw: window.innerWidth,
    searchVisible: !!document.querySelector('#headerSearch'),
    cards: document.querySelectorAll('.product-card').length,
    gridCols: getComputedStyle(document.querySelector('.product-grid')).gridTemplateColumns.split(' ').length,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check('7a. 모바일 메인(390px)', mHome.searchVisible && mHome.cards > 0 && !mHome.overflowX, mHome);
  await mpage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await mpage.screenshot({ path: join(OUT, '09-home-mobile-390.png'), timeout: 30000 });

  await mpage.goto(BASE + '/index.html#/products', { waitUntil: 'domcontentloaded' });
  await mpage.waitForSelector('body[data-cgi-ready="1"]', { timeout: 20000 });
  const filterToggle = mpage.locator('[data-action="toggle-filters"]');
  const toggleVisible = await filterToggle.isVisible();
  if (toggleVisible) { await filterToggle.click(); }
  const mList = await mpage.evaluate(() => ({
    vw: window.innerWidth,
    filterPanelVisible: !!document.querySelector('#filterPanel:not([hidden])'),
    facets: document.querySelectorAll('[data-facet="brand"]').length,
    cards: document.querySelectorAll('.product-card').length,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check('7b. 모바일 필터/목록', mList.filterPanelVisible && mList.facets > 0 && mList.cards > 0 && !mList.overflowX, { toggleVisible, ...mList });
  await mpage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await mpage.screenshot({ path: join(OUT, '10-list-mobile-390.png'), timeout: 30000 });

  await mpage.goto(BASE + '/index.html#/products?q=SHURE', { waitUntil: 'domcontentloaded' });
  await mpage.waitForSelector('body[data-cgi-ready="1"]', { timeout: 20000 });
  const mSearch = await mpage.evaluate(() => ({
    cards: document.querySelectorAll('.product-card').length,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check('7c. 모바일 검색', mSearch.cards > 0 && !mSearch.overflowX, mSearch);
  await mpage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await mpage.screenshot({ path: join(OUT, '11-search-mobile-390.png'), timeout: 30000 });

  await mpage.locator('.product-card').first().click();
  await mpage.waitForSelector('.detail-grid', { timeout: 15000 });
  const mDetail = await mpage.evaluate(() => ({
    title: (document.querySelector('.detail-title') || {}).textContent || '',
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    specRows: document.querySelectorAll('.spec-table tr').length,
  }));
  check('7d. 모바일 상세페이지', mDetail.title.length > 0 && !mDetail.overflowX, mDetail);
  await mpage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await mpage.screenshot({ path: join(OUT, '12-detail-mobile-390.png'), timeout: 30000 });
  await mobileCtx.close();

  /* ----------------------------------------- 12. 태블릿(820) 확인 */
  const tabCtx = await browser.newContext({ viewport: { width: 820, height: 1180 }, locale: 'ko-KR' });
  const tpage = await tabCtx.newPage();
  await tpage.goto(BASE + '/index.html#/products', { waitUntil: 'domcontentloaded' });
  await tpage.waitForSelector('body[data-cgi-ready="1"]', { timeout: 20000 });
  const tablet = await tpage.evaluate(() => ({
    vw: window.innerWidth,
    gridCols: getComputedStyle(document.querySelector('.product-grid')).gridTemplateColumns.split(' ').length,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check('12. 태블릿(820px) 레이아웃', !tablet.overflowX, tablet);
  await tpage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await tpage.screenshot({ path: join(OUT, '13-list-tablet-820.png'), timeout: 30000 });
  await tabCtx.close();

  // 의도적으로 발생시킨 오류(깨진 이미지 테스트)와 favicon 404 는 제외
  const realErrors = consoleErrors.filter((m) => !/example\.invalid|favicon/i.test(m));
  check('13. 콘솔 JS 오류 없음', realErrors.length === 0, realErrors.slice(0, 5));
} finally {
  await browser.close();
}

const summary = { base: BASE, at: new Date().toISOString(), total: results.length, failed: failures, results };
writeFileSync(resolve(REPORT), JSON.stringify(summary, null, 2), 'utf8');
console.log('\n=== 요약 ===');
console.log(`total=${summary.total} failed=${summary.failed}`);
console.log('report -> ' + REPORT);
process.exit(failures ? 1 : 0);
