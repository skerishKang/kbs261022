'use strict';
/**
 * Captures the REAL network traffic the storefront generates while the search
 * page is used in a browser.
 *
 * This is how the correct public JSON endpoint was discovered:
 *   POST https://api.dalue.io:10806/dcse/query   (apiKey / mallId / mallType are
 *   values the storefront publishes inside its own pages)
 * The previously assumed endpoint `/api/search` answers
 *   {"header":{"code":-7,"message":"권한이 없습니다"}}
 * and returns nothing.
 *
 * Output: reports/evidence/search-network-capture.json
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, ROOT } = require('./lib/browser');

const OUT = path.join(ROOT, 'reports', 'evidence');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { browser, context } = await launch({ headless: true });
  const page = await context.newPage();

  const captured = [];
  page.on('request', (req) => {
    if (/api\.dalue\.io:10806/.test(req.url())) {
      captured.push({
        phase: 'request',
        method: req.method(),
        url: req.url(),
        content_type: req.headers['content-type'],
        origin: req.headers.origin,
        referer: req.headers.referer,
        post_data: req.postData(),
      });
    }
  });
  page.on('response', async (res) => {
    if (!/api\.dalue\.io:10806/.test(res.url())) return;
    let body = null;
    try { body = (await res.text()).slice(0, 1200); } catch { body = '<unavailable>'; }
    captured.push({ phase: 'response', status: res.status(), url: res.url(), body });
  });

  // open the search page and let the storefront issue its own API calls
  await page.goto('https://www.samamusic.co.kr/shopSearch/search.html?keyword=shure', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(7000);

  // list the visible search inputs (several hidden placeholders exist)
  const inputs = await page.evaluate(() => [...document.querySelectorAll('input')]
    .map((i) => ({ id: i.id, name: i.name, type: i.type, cls: i.className, visible: !!i.offsetParent })));
  captured.push({ phase: 'meta', inputs, url: page.url(), title: await page.title() });

  fs.writeFileSync(path.join(OUT, 'search-network-capture.json'), JSON.stringify(captured, null, 2), 'utf8');
  console.log(`captured ${captured.length} records -> reports/evidence/search-network-capture.json`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
