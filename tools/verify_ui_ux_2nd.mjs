/**
 * verify_ui_ux_2nd.mjs -- UI/UX 2차 개선 종합 검증
 *
 * 검증 범위
 *  - 390 / 820 / 1440 / 1920 px: 홈·목록·상세·장바구니·관리자 화면
 *  - 모바일 가로 오버플로 0, 깨진 이미지 0, JS 오류 0
 *  - 장바구니 카드형 레이아웃에서 상품명/수량/삭제/가격 조작
 *  - 폼 입력값 보존(삭제 후), 빈 장바구니 폼 숨김
 *  - 견적 제출 payload 계약 유지 (Worker 는 라우팅 가로채기로 모의)
 *
 * 실행: node tools/verify_ui_ux_2nd.mjs --base http://127.0.0.1:8848/site
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

const BASE = arg('base', 'http://127.0.0.1:8848/site').replace(/\/$/, '');
const OUT = resolve(REPO_ROOT, arg('out', 'docs/screenshots/ui-ux-2nd'));
const REPORT = resolve(REPO_ROOT, arg('report', 'docs/UI_UX_2ND_TESTLOG.json'));
const EXECUTABLE = arg('chrome', join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe'));
const WORKER = 'https://cgi-quote-api.charliekant.workers.dev';

mkdirSync(OUT, { recursive: true });

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) failures += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined && detail !== null ? ' :: ' + JSON.stringify(detail) : ''}`);
}

const apiCalls = [];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-max-age': '600',
};

async function mockWorker(route) {
  const req = route.request();
  let url;
  try { url = new URL(req.url()); } catch (_) { return route.abort(); }
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
  if (url.pathname === '/api/quotes' && req.method() === 'POST') {
    let body = null;
    try { body = req.postDataJSON(); } catch (_) {}
    apiCalls.push({ method: 'POST', url: req.url(), body });
    return route.fulfill({
      status: 201,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'Q-UITEST-' + Date.now(), ok: true, stored: true }),
    });
  }
  if (url.pathname === '/api/quotes' && req.method() === 'GET') {
    const auth = (req.headers()['authorization'] || '');
    if (/BOGUS/i.test(auth)) return route.fulfill({ status: 401, headers: CORS, body: '{"error":"unauthorized"}' });
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"items":[]}' });
  }
  return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '{}' });
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });

async function settle(page) {
  await page.evaluate(async () => {
    const step = Math.max(320, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 70));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(900);
}

async function auditPage(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.images);
    const broken = imgs.filter((i) => i.complete && i.currentSrc && i.naturalWidth === 0);
    return {
      vw: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      imgTotal: imgs.length,
      brokenImages: broken.length,
      brokenSample: broken.slice(0, 5).map((i) => i.currentSrc),
      fallbacks: document.querySelectorAll('.no-image').length,
    };
  });
}

async function capture(page, name) {
  await page.evaluate(() => {
    const toast = document.getElementById('cgiToast');
    if (toast) toast.classList.remove('is-on');
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, name), fullPage: true, timeout: 45000 }).catch(async () => {
    await page.screenshot({ path: join(OUT, name), fullPage: false, timeout: 45000 });
  });
  console.log('   shot -> ' + name);
}

async function openApp(page) {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-cgi-ready="1"]', { timeout: 45000 });
}

async function hashTo(page, hash, selector) {
  await page.evaluate((h) => {
    if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = h;
  }, hash);
  if (selector) await page.waitForSelector(selector, { timeout: 30000 });
  await page.waitForTimeout(300);
}

const viewports = [
  { w: 390, h: 844, mobile: true },
  { w: 820, h: 1180, mobile: true },
  { w: 1440, h: 1000, mobile: false },
  { w: 1920, h: 1080, mobile: false },
];

for (const vp of viewports) {
  const W = vp.w;
  console.log(`\n===== ${W}px =====`);
  const ctx = await browser.newContext({
    viewport: { width: W, height: vp.h },
    deviceScaleFactor: 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    locale: 'ko-KR',
  });
  await ctx.route(WORKER + '/**', mockWorker);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  const resourceErrors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource|net::ERR|favicon/i.test(text)) resourceErrors.push(text);
    else errors.push('console: ' + text);
  });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  /* ---------------------------------------------------------------- HOME */
  await openApp(page);
  const firstView = await page.evaluate(() => {
    const search = document.querySelector('.hero-search');
    const hero = document.querySelector('.hero');
    const featured = document.querySelector('.section');
    const stats = document.querySelector('.stat-row');
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const sr = rect(search);
    const fr = rect(featured);
    const tr = rect(stats);
    return {
      heroH1: (document.querySelector('.hero h1') || {}).textContent || '',
      heroSearchVisible: !!sr && sr.width > 0 && sr.bottom <= window.innerHeight + 1,
      featuredBeforeStats: !!fr && !!tr && fr.top < tr.top,
      featuredCards: document.querySelectorAll('.section .product-card').length,
      chipsTop: Array.from(document.querySelectorAll('.chip-row .chip')).filter((el) => !el.closest('details.chip-more')).length,
      chipMore: document.querySelectorAll('details.chip-more').length,
      statCards: document.querySelectorAll('.stat-card').length,
      hasPhonelink: !!document.querySelector('a[href^="tel:"]'),
    };
  });
  await settle(page);
  const homeAudit = await auditPage(page);
  check(`[${W}] 홈: 첫 화면에 검색+추천`, firstView.heroH1.includes('CGI') && firstView.heroSearchVisible && firstView.featuredBeforeStats && firstView.featuredCards >= 4, firstView);
  check(`[${W}] 홈: 통계·칩 접기`, firstView.statCards === 4 && firstView.chipMore >= 1 && firstView.chipsTop <= 24, { statCards: firstView.statCards, chipMore: firstView.chipMore, chipsTop: firstView.chipsTop });
  check(`[${W}] 홈: 가로 오버플로 없음`, !homeAudit.overflowX, homeAudit);
  check(`[${W}] 홈: 깨진 이미지 없음`, homeAudit.brokenImages === 0, { broken: homeAudit.brokenImages, fallbacks: homeAudit.fallbacks, total: homeAudit.imgTotal });
  await capture(page, `home-${W}-after.png`);

  /* 칩 펼치기 (데스크톱에서만 상호작용 확인) */
  if (W >= 1440) {
    const visibleChips = () => page.evaluate(() => Array.from(document.querySelectorAll('.chip-row .chip')).filter((el) => (el.checkVisibility ? el.checkVisibility() : el.getBoundingClientRect().height > 0)).length);
    const before = await visibleChips();
    const more = await page.locator('details.chip-more').first();
    if (await more.count()) {
      await more.locator('summary').click();
      const after = await visibleChips();
      check(`[${W}] 홈: 칩 전체 보기 펼침`, after > before, { before, after });
      await more.locator('summary').click();
    } else {
      check(`[${W}] 홈: 칩 전체 보기 펼침`, false, 'no details.chip-more');
    }
  }

  /* ---------------------------------------------------------------- LIST */
  await hashTo(page, '#/products', '.list-layout');
  await settle(page);
  const listAudit = await auditPage(page);
  const listInfo = await page.evaluate(() => ({
    cards: document.querySelectorAll('.product-card').length,
    facets: document.querySelectorAll('.filter-group').length,
    panelHidden: (document.querySelector('#filterPanel') || {}).hidden === true,
    toggleVisible: (() => {
      const t = document.querySelector('[data-action="toggle-filters"]');
      if (!t) return false;
      return getComputedStyle(t).display !== 'none';
    })(),
  }));
  const mobileFilterExpected = W < 900;
  check(`[${W}] 목록: 카드·패싯`, listInfo.cards > 0 && listInfo.facets >= 3, listInfo);
  check(`[${W}] 목록: 필터 표시/접힘`, mobileFilterExpected ? (listInfo.toggleVisible && listInfo.panelHidden) : !listInfo.panelHidden, listInfo);
  check(`[${W}] 목록: 가로 오버플로 없음`, !listAudit.overflowX, listAudit);
  check(`[${W}] 목록: 깨진 이미지 없음`, listAudit.brokenImages === 0, { broken: listAudit.brokenImages, fallbacks: listAudit.fallbacks, total: listAudit.imgTotal });
  await capture(page, `catalog-${W}-after.png`);

  if (mobileFilterExpected) {
    await page.locator('[data-action="toggle-filters"]').click();
    const opened = await page.evaluate(() => !(document.querySelector('#filterPanel') || {}).hidden);
    check(`[${W}] 목록: 모바일 필터 열기`, opened, { opened });
    await page.locator('[data-action="toggle-filters"]').click();
  }

  /* -------------------------------------------------------------- DETAIL */
  const pid = await page.evaluate(() => {
    const list = window.CGI_PRODUCTS || [];
    const p = list.find((x) => x.images && x.images.length && x.price && x.price.state === 'public') || list[0];
    return p && p.id;
  });
  await hashTo(page, '#/product/' + encodeURIComponent(pid), '.detail-grid');
  await settle(page);
  const detailAudit = await auditPage(page);
  const detailInfo = await page.evaluate(() => {
    const srcs = Array.from(document.querySelectorAll('.gallery-thumbs img')).map((i) => i.getAttribute('src') || '');
    const main = document.querySelector('#galleryMain');
    const mainSrc = main && main.getAttribute('src') || '';
    const all = srcs.concat(mainSrc ? [mainSrc] : []);
    const mobileCta = document.querySelector('.mobile-cta');
    const mobileStyle = mobileCta ? getComputedStyle(mobileCta) : null;
    const primary = document.querySelector('.detail-cta .btn-primary');
    const ctaButtons = Array.from(document.querySelectorAll('.detail-cta .btn'));
    return {
      title: (document.querySelector('.detail-title') || {}).textContent || '',
      thumbs: srcs.length,
      galleryBannerFree: !all.some((s) => /banner|events?/i.test(s)),
      galleryProductShots: all.length > 0 && all.every((s) => /\/web\/product\//.test(s)),
      primaryCta: !!primary && /견적 요청/.test(primary.textContent),
      secondaryCta: ctaButtons.length >= 2 && /견적 목록에 추가/.test(ctaButtons[1].textContent),
      mobileCtaVisible: !!mobileStyle && mobileStyle.display !== 'none' && mobileStyle.position === 'fixed',
      sourceBox: !!document.querySelector('.source-box a[href^="http"]'),
      internalLeak: /data_origin|supplier_catalog_totals|debug/i.test(document.body.innerText),
    };
  });
  check(`[${W}] 상세: 갤러리 정리`, detailInfo.thumbs > 0 && detailInfo.galleryBannerFree && detailInfo.galleryProductShots, detailInfo);
  check(`[${W}] 상세: CTA 위계`, detailInfo.primaryCta && detailInfo.secondaryCta, detailInfo);
  check(`[${W}] 상세: 모바일 CTA`, W <= 899 ? detailInfo.mobileCtaVisible : !detailInfo.mobileCtaVisible, { width: W, visible: detailInfo.mobileCtaVisible });
  check(`[${W}] 상세: 내부정보 미노출`, !detailInfo.internalLeak && detailInfo.sourceBox, { internalLeak: detailInfo.internalLeak, sourceBox: detailInfo.sourceBox });
  check(`[${W}] 상세: 가로 오버플로 없음`, !detailAudit.overflowX, detailAudit);
  check(`[${W}] 상세: 깨진 이미지 없음`, detailAudit.brokenImages === 0, { broken: detailAudit.brokenImages, fallbacks: detailAudit.fallbacks, total: detailAudit.imgTotal });
  await capture(page, `detail-${W}-after.png`);

  /* --------------------------------------------------------- CART EMPTY */
  await page.evaluate(() => { localStorage.removeItem('cgiQuoteCart'); });
  await hashTo(page, '#/quote-cart', '.empty-state');
  const empty = await page.evaluate(() => ({
    emptyState: !!document.querySelector('.empty-state'),
    form: !!document.getElementById('quoteCartForm'),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check(`[${W}] 장바구니(빈): 폼 숨김`, empty.emptyState && !empty.form && !empty.overflowX, empty);
  await capture(page, `cart-empty-${W}-after.png`);

  /* --------------------------------------------------------- CART FILLED */
  const ids = await page.evaluate(() => (window.CGI_PRODUCTS || []).slice(0, 2).map((p) => p.id));
  await page.evaluate((list) => {
    list.forEach((id) => window.cgiAddToQuoteCart(id, 1, true));
  }, ids);
  await hashTo(page, '#/quote-cart', '.cart-table');
  await settle(page);
  const cartAudit = await auditPage(page);
  const cartInfo = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cart-row'));
    const inView = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= window.innerWidth + 1;
    };
    const row = rows[0];
    return {
      rows: rows.length,
      nameInView: row ? inView(row.querySelector('.cart-name')) : false,
      priceInView: row ? inView(row.querySelector('.c-price')) : false,
      qtyInView: row ? inView(row.querySelector('.qty-stepper')) : false,
      removeInView: row ? inView(row.querySelector('.cart-remove')) : false,
      form: !!document.getElementById('quoteCartForm'),
    };
  });
  check(`[${W}] 장바구니: 상품명/가격/수량/삭제 조작 가능`, cartInfo.rows === 2 && cartInfo.nameInView && cartInfo.priceInView && cartInfo.qtyInView && cartInfo.removeInView && cartInfo.form, cartInfo);
  check(`[${W}] 장바구니: 가로 오버플로 없음`, !cartAudit.overflowX, cartAudit);
  check(`[${W}] 장바구니: 깨진 이미지 없음`, cartAudit.brokenImages === 0, { broken: cartAudit.brokenImages, fallbacks: cartAudit.fallbacks, total: cartAudit.imgTotal });
  await capture(page, `cart-${W}-after.png`);

  /* ---------------------------------------------- CART INTERACTIONS @390 */
  if (W === 390) {
    const qtyBefore = await page.locator('input[data-qty-id]').first().inputValue();
    await page.locator('[data-qty-step="1"]').first().click();
    await page.waitForTimeout(200);
    const qtyAfter = await page.locator('input[data-qty-id]').first().inputValue();
    const storedQty = await page.evaluate((id) => {
      try { return (JSON.parse(localStorage.getItem('cgiQuoteCart') || '[]').find((x) => x.id === id) || {}).qty; } catch (e) { return null; }
    }, ids[0]);
    check('[390] 장바구니: 수량 증가 반영', Number(qtyAfter) === Number(qtyBefore) + 1 && Number(storedQty) === Number(qtyAfter), { qtyBefore, qtyAfter, storedQty });

    await page.evaluate(() => {
      const f = document.getElementById('quoteCartForm');
      const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
      set('company', 'UIUX검증상사'); set('name', '검증담당'); set('phone', '010-1111-2222');
      set('email', 'uiux@example.invalid'); set('location', '광주'); set('note', '2차 UI 검증');
    });
    await page.locator('[data-remove-id]').nth(1).click();
    await page.waitForTimeout(300);
    const afterDelete = await page.evaluate(() => {
      const f = document.getElementById('quoteCartForm');
      return {
        rows: document.querySelectorAll('.cart-row').length,
        companyPreserved: f ? f.querySelector('[name="company"]').value : null,
        phonePreserved: f ? f.querySelector('[name="phone"]').value : null,
      };
    });
    check('[390] 장바구니: 삭제 후 폼 입력값 보존', afterDelete.rows === 1 && afterDelete.companyPreserved === 'UIUX검증상사' && afterDelete.phonePreserved === '010-1111-2222', afterDelete);

    await page.locator('[data-remove-id]').first().click();
    await page.waitForSelector('.empty-state', { timeout: 10000 });
    const emptied = await page.evaluate(() => ({ empty: !!document.querySelector('.empty-state'), form: !!document.getElementById('quoteCartForm') }));
    check('[390] 장바구니: 마지막 삭제 시 폼 숨김', emptied.empty && !emptied.form, emptied);

    /* ------------------------------------------- QUOTE SUBMIT + PAYLOAD */
    const beforeCalls = apiCalls.length;
    await page.evaluate((id) => { window.cgiAddToQuoteCart(id); window.cgiAddToQuoteCart(id); }, ids[0]);
    await hashTo(page, '#/quote-cart', '.cart-table');
    await page.evaluate(() => {
      const f = document.getElementById('quoteCartForm');
      const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
      set('company', 'UIUX E2E 상사'); set('name', '홍길동'); set('phone', '010-0000-0000');
      set('email', 'e2e@example.invalid'); set('location', '광주'); set('note', '2차 UI 검증 요청');
    });
    const svc = page.locator('input[data-cart-service]').first();
    if (await svc.count()) await svc.check();
    await page.evaluate(() => document.getElementById('quoteCartForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const resultOk = await page.waitForFunction(() => {
      const r = document.getElementById('quoteCartResult');
      return r && /접수번호/.test(r.innerText) && !/실패|임시 저장/.test(r.innerText);
    }, null, { timeout: 20000 }).then(() => true).catch(() => false);
    const resultText = await page.evaluate(() => (document.getElementById('quoteCartResult') || {}).innerText || '');
    const call = apiCalls.slice(beforeCalls).find((c) => c.method === 'POST');
    const body = call && call.body;
    const payloadOk = !!body
      && Array.isArray(body.items) && body.items.length === 1
      && typeof body.items[0].id === 'string'
      && typeof body.items[0].name === 'string'
      && typeof body.items[0].brand === 'string'
      && typeof body.items[0].category === 'string'
      && body.items[0].qty === 2
      && ('publicPrice' in body.items[0])
      && Array.isArray(body.services)
      && body.company === 'UIUX E2E 상사'
      && /^Q-/.test(body.id || '');
    check('[390] 견적 제출: 성공 응답 표시', resultOk && /접수번호/.test(resultText), { resultText });
    check('[390] 견적 제출: Worker payload 계약 유지', payloadOk, body && {
      id: body.id, company: body.company, services: body.services,
      items: body.items && body.items.map((i) => ({ id: i.id, qty: i.qty, keys: Object.keys(i) })),
    });
    await capture(page, 'cart-submitted-390-after.png');

    /* 모바일 상세 고정 CTA */
    await page.evaluate(() => { localStorage.removeItem('cgiQuoteCart'); });
    await hashTo(page, '#/product/' + encodeURIComponent(pid), '.detail-grid');
    const mcta = await page.evaluate(() => {
      const el = document.querySelector('.mobile-cta .btn-primary');
      if (!el) return { visible: false };
      const r = el.getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0, bottom: Math.round(r.bottom), innerH: window.innerHeight, text: el.textContent };
    });
    check('[390] 상세: 고정 CTA 노출', mcta.visible && mcta.bottom <= mcta.innerH + 1, mcta);
    await page.locator('.mobile-cta .btn-primary').click();
    await page.waitForSelector('.cart-table', { timeout: 15000 });
    const ctaNav = await page.evaluate(() => ({ hash: location.hash, rows: document.querySelectorAll('.cart-row').length }));
    check('[390] 상세: CTA -> 견적 목록 이동', ctaNav.hash.indexOf('#/quote-cart') === 0 && ctaNav.rows >= 1, ctaNav);

    /* 갤러리 깨진 이미지 폴백 */
    await hashTo(page, '#/product/' + encodeURIComponent(pid), '.detail-grid');
    const galleryFallback = await page.evaluate(async () => {
      const main = document.getElementById('galleryMain');
      if (!main) return { skipped: true };
      main.setAttribute('src', 'https://example.invalid/gone.jpg');
      await new Promise((r) => setTimeout(r, 1200));
      const now = document.getElementById('galleryMain');
      return { mainExists: !!now, src: now ? now.getAttribute('src') : null, fallback: !!document.querySelector('.gallery-main .no-image') };
    });
    check('[390] 상세: 갤러리 오류 폴백', galleryFallback.skipped || galleryFallback.fallback || (galleryFallback.src && galleryFallback.src !== 'https://example.invalid/gone.jpg'), galleryFallback);
  }

  /* --------------------------------------------------------------- STAFF */
  await page.evaluate((productId) => {
    localStorage.setItem('cgiQuoteRequests', JSON.stringify([{
      id: 'Q-UIUX-STAFF-1', createdAt: new Date().toISOString(), company: '관리자검증상사',
      name: '담당자', phone: '010-0000-0000', email: 'staff@example.invalid', location: '광주',
      note: '관리자 모바일 레이아웃 검증', services: ['install'],
      items: [{ id: productId, name: '검증 상품', brand: '검증브랜드', category: '검증카테고리', qty: 2, publicPrice: '100,000원' }],
      status: 'received'
    }]));
    localStorage.removeItem('cgiAdminToken');
  }, pid);
  await page.goto(BASE + '/staff.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#requestList .request-card', { timeout: 30000 });
  await settle(page);
  const staffAudit = await auditPage(page);
  const staffInfo = await page.evaluate(() => ({
    cards: document.querySelectorAll('.request-card').length,
    id: (document.querySelector('.request-id') || {}).textContent || '',
    company: (document.querySelector('.request-company') || {}).textContent || '',
    tools: !!document.querySelector('.staff-toolbar'),
  }));
  check(`[${W}] 관리자: 요청 목록 렌더`, staffInfo.cards >= 1 && staffInfo.id === 'Q-UIUX-STAFF-1' && staffInfo.tools, staffInfo);
  check(`[${W}] 관리자: 가로 오버플로 없음`, !staffAudit.overflowX, staffAudit);
  check(`[${W}] 관리자: 깨진 이미지 없음`, staffAudit.brokenImages === 0, { broken: staffAudit.brokenImages });
  await capture(page, `staff-${W}-after.png`);

  await page.locator('button[data-open]').first().click();
  await page.waitForSelector('#requestDetail .table-scroll', { timeout: 10000 });
  const detailStaff = await page.evaluate(() => ({
    tableScroll: !!document.querySelector('#requestDetail .table-scroll'),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    hasItems: document.querySelectorAll('#requestDetail .spec-table tbody tr').length,
  }));
  check(`[${W}] 관리자: 상세 표 스크롤`, detailStaff.tableScroll && detailStaff.hasItems >= 1 && !detailStaff.overflowX, detailStaff);
  await capture(page, `staff-detail-${W}-after.png`);

  check(`[${W}] JS 오류 없음`, errors.length === 0, errors.slice(0, 5));
  console.log(`   resource errors (image 404 등): ${resourceErrors.length}`);

  await ctx.close();
}

await browser.close();

const summary = {
  base: BASE,
  at: new Date().toISOString(),
  total: results.length,
  failed: failures,
  mockApiPosts: apiCalls.length,
  results,
};
writeFileSync(REPORT, JSON.stringify(summary, null, 2), 'utf8');
console.log('\n=== 요약 ===');
console.log(`total=${summary.total} failed=${summary.failed} mockApiPosts=${summary.mockApiPosts}`);
console.log('report -> ' + REPORT);
process.exit(failures ? 1 : 0);
