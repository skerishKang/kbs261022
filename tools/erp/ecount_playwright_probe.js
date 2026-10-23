const { chromium } = require('D:/1022/1022-2/kbs261022/tools/playwright/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const comCode = process.env.ECOUNT_COM_CODE || '54134';
  const userId = process.env.ECOUNT_USER_ID || 'cgiinc';
  const password = process.env.ECOUNT_PASSWORD || 'ecount-0722!';

  await page.goto('https://login.ecount.com/Login?lan_type=ko-KR', { waitUntil: 'networkidle' });
  await page.fill('#com_code', comCode);
  await page.fill('#id', userId);
  await page.fill('#passwd', password);
  await page.click('#save');
  await page.waitForTimeout(8000);
  console.log('URL after login:', page.url());
  await page.screenshot({ path: 'D:/1022/wt-g2b/reports/data/erp/ecount_after_login.png', fullPage: true });

  // try menu search for 품목
  try {
    await page.fill('#inputFavMSearch', '품목');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'D:/1022/wt-g2b/reports/data/erp/ecount_menu_search.png', fullPage: true });
  } catch (e) { console.log('menu search error', e.message); }

  await browser.close();
})();
