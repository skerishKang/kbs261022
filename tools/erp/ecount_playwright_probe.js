const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

(async () => {
  const comCode = requireEnv('ECOUNT_COM_CODE');
  const userId = requireEnv('ECOUNT_USER_ID');
  const password = requireEnv('ECOUNT_PASSWORD');
  const outDir = process.env.ERP_EVIDENCE_DIR || path.join(__dirname, '..', '..', 'reports', 'data', 'erp', 'live');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://login.ecount.com/Login?lan_type=ko-KR', { waitUntil: 'networkidle' });
  await page.fill('#com_code', comCode);
  await page.fill('#id', userId);
  await page.fill('#passwd', password);
  await page.click('#save');
  await page.waitForTimeout(8000);
  console.log('URL after login:', page.url().replace(/ec_req_sid=[^&]*/gi, 'ec_req_sid=REDACTED'));
  await page.screenshot({ path: path.join(outDir, 'ecount_after_login.png'), fullPage: true });

  try {
    await page.fill('#inputFavMSearch', '품목');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(outDir, 'ecount_menu_search.png'), fullPage: true });
  } catch (e) {
    console.log('menu search error', e.message);
  }

  await browser.close();
})();
