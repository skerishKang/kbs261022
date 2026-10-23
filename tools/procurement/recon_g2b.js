'use strict';
// One-shot reconnaissance of the real 나라장터 (G2B) public notice site.
// Bounded, staged logging. No infinite waits. Not a rerun of debug7.
const { chromium } = require('D:/1022/1022-2/kbs261022/tools/playwright/node_modules/playwright');

const TARGETS = [
  'https://www.g2b.go.kr/',
  'https://www.g2b.go.kr/bidselect/preinfo/PBSA0001.do',
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  for (const url of TARGETS) {
    console.log('\n===== TARGET', url, '=====');
    const t0 = Date.now();
    let resp;
    try {
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log('GOTO_FAIL', e.message);
      continue;
    }
    console.log('HTTP_STATUS', resp && resp.status());
    console.log('FINAL_URL', page.url());
    console.log('TITLES', JSON.stringify(await page.title()));
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 600) : 'NO_BODY');
    console.log('BODY_PREVIEW', JSON.stringify(bodyText));
    const anchors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).slice(0, 20).map(a => a.getAttribute('href')));
    console.log('ANCHOR_SAMPLE', JSON.stringify(anchors));
    console.log('ELAPSED_MS', Date.now() - t0);
  }
  if (errors.length) console.log('\nERRORS', JSON.stringify(errors.slice(0, 10)));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
