'use strict';
/*
 * #39 견적 백엔드 운영 E2E — 병합된 origin/main frontend(배포 github.io 오리진) + 실배포 Worker.
 * 실제 고객 플로우/직원 화면을 브라우저로 구동한다. 무한대기 금지, HTTP/DOM/network 기반 검증,
 * 위조 없음(실 worker 응답만 사용). ADMIN_TOKEN 없이는 인증 목록/수행을 강요하지 않는다.
 */
const PW = 'D:/1022/1022-2/kbs261022/tools/playwright/node_modules/playwright';
const { chromium } = require(PW);
const siteArgIdx = process.argv.indexOf('--site');
const SITE = (siteArgIdx !== -1 && process.argv[siteArgIdx + 1])
  ? process.argv[siteArgIdx + 1].replace(/\/$/, '')
  : 'https://skerishkang.github.io/kbs261022/site';
const WORKER = 'https://cgi-quote-api.charliekant.workers.dev';
const WAIT = 20000;
const R = {};
const stage = (k, v) => { R[k] = v; console.log('[E2E]', k, JSON.stringify(v)); };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 Chrome/124 e2e' });
  const page = await ctx.newPage();
  const perr = [];
  page.on('pageerror', (e) => perr.push(String(e.message)));
  page.on('dialog', (d) => d.dismiss().catch(() => {})); // auto-dismiss add/alert + admin prompt

  // ===== 1) CUSTOMER INTAKE: real UI flow product -> cart -> submit -> worker POST =====
  await page.goto(SITE + '/index.html', { waitUntil: 'domcontentloaded', timeout: WAIT });
  await page.waitForFunction(() => window.CGI_PRODUCTS && window.CGI_PRODUCTS.length > 0, null, { timeout: WAIT });
  stage('config_quoteApiUrl', await page.evaluate(() => window.CGI_SITE_CONFIG && window.CGI_SITE_CONFIG.quoteApiUrl));
  const pid = await page.evaluate(() => window.CGI_PRODUCTS[0].id);
  stage('product_id', pid);

  let postStatus = null, postId = null;
  page.on('response', async (res) => {
    if (res.url().replace(/\/$/, '') === WORKER + '/api/quotes' && res.request().method() === 'POST') {
      postStatus = res.status();
      try { const j = await res.json(); postId = j && j.id; } catch (_) {}
    }
  });

  // add via the exposed app function (real add-to-quote path), then open the cart view
  await page.evaluate((id) => { window.cgiAddToQuoteCart(id); }, pid);
  await page.evaluate(() => { location.hash = '#/quote-cart'; });
  const itemRow = await page.waitForSelector('#quoteCartForm ~ * table, .spec-table', { timeout: WAIT })
    .then(() => true).catch(() => false);
  const cartItemCount = await page.evaluate(() => document.querySelectorAll('input[data-qty-id]').length);
  stage('cart_row_rendered', itemRow);
  stage('cart_item_count', cartItemCount);

  await page.waitForSelector('#quoteCartForm', { timeout: WAIT });
  await page.evaluate(() => {
    const f = document.getElementById('quoteCartForm');
    const set = (n, v) => { const el = f.querySelector('[name=' + n + ']'); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('company', '[E2E-UI]테스트상사'); set('name', '홍길동'); set('phone', '010-0000-0000');
    set('email', 'e2e-ui@example.invalid'); set('location', '광주'); set('note', '#39 운영 E2E UI (실고객 아님)');
  });
  await page.evaluate(() => document.getElementById('quoteCartForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const ok = await page.waitForFunction(() => {
    const r = document.getElementById('quoteCartResult');
    return r && /접수번호|Q-/.test(r.innerText) && !/실패/.test(r.innerText);
  }, null, { timeout: WAIT }).then(() => true).catch(() => false);
  stage('ui_submit_success', ok);
  stage('ui_result_text', await page.evaluate(() => (document.getElementById('quoteCartResult') || {}).innerText));
  stage('worker_post_status', postStatus);
  stage('worker_post_returned_id', postId);
  stage('intake_backed_by_server_id', !!(postId && /^Q-/.test(postId)));

  // ===== 2) STAFF ADMIN SCREEN: boot + auth-gate fallback behavior =====
  // (a) no token -> graceful local mode; (b) bogus token -> server list blocked, UI handles it.
  await page.goto(SITE + '/staff.html', { waitUntil: 'domcontentloaded', timeout: WAIT });
  await page.waitForTimeout(1200);
  stage('staff_boots_no_token', await page.evaluate(() => document.body.innerText.length > 20));

  let staffListStatus = null;
  const onRes = (res) => { if (res.url() === WORKER + '/api/quotes' && res.request().method() === 'GET') staffListStatus = res.status(); };
  page.on('response', onRes);
  // supply a bogus admin token in the app's own storage slot, then reload staff page
  await page.evaluate(() => localStorage.setItem('cgiAdminToken', 'BOGUS-e2e-token'));
  await page.goto(SITE + '/staff.html', { waitUntil: 'domcontentloaded', timeout: WAIT });
  await page.waitForTimeout(1500);
  stage('staff_server_list_status_bogus_token', staffListStatus); // expect 401 (blocked), no crash
  stage('staff_survives_401', await page.evaluate(() => !!document.body && document.body.innerText.length > 20));
  page.removeListener('response', onRes);
  await page.evaluate(() => localStorage.removeItem('cgiAdminToken'));

  // ===== 3) authenticated endpoints require a real ADMIN_TOKEN (unavailable) =====
  const adminRoundTrip = await page.evaluate(async (W) => {
    const s = async (u, o) => { try { const r = await fetch(u, o); return { status: r.status }; } catch (e) { return { err: e.message }; } };
    return { get_list_missing_token: await s(W + '/api/quotes', { headers: { Authorization: 'Bearer MISSING' } }) };
  }, WORKER);
  stage('admin_requires_token', adminRoundTrip);

  stage('page_errors', perr.slice(0, 8));

  const intakeE2E = ok === true && postStatus === 201 && R.intake_backed_by_server_id === true;
  stage('VERDICT', {
    intake_e2e: intakeE2E ? 'PASS' : 'CHECK',
    admin_gate_enforced: staffListStatus === 401,
    admin_full_loop: 'BLOCKED_NO_TOKEN',
  });
  console.log('[E2E] SUMMARY ' + JSON.stringify({ intakeE2E, postStatus, postId, staffListStatus }));
  await browser.close();
})().catch((e) => { console.error('[E2E] FATAL', (e && e.stack) || e); process.exit(1); });
