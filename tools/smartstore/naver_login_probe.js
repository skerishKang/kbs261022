'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

(async () => {
  const id = requireEnv('NAVER_ID');
  const pw = requireEnv('NAVER_PW');
  if (process.argv.includes('--check-env')) {
    console.log('NAVER_ENV=OK');
    return;
  }

  const outDir = process.env.NAVER_EVIDENCE_DIR || path.join(__dirname, '..', '..', 'reports', 'data', 'smartstore', 'live');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'networkidle' });
  await page.fill('#id', id);
  await page.fill('#pw', pw);
  await page.press('#pw', 'Enter');
  await page.waitForTimeout(8000);

  const finalUrl = page.url();
  const loggedIn = !/nidlogin\.login/i.test(finalUrl);
  console.log('NAVER_LOGIN=' + (loggedIn ? 'PASS' : 'CHECK'));
  console.log('URL_PATH=' + finalUrl.split(/[?#]/)[0]);
  await page.screenshot({ path: path.join(outDir, 'naver_after_login.png'), fullPage: true });
  await browser.close();
})().catch((e) => {
  console.error('NAVER_PROBE_ERROR', e && e.message ? e.message : String(e));
  process.exit(1);
});
