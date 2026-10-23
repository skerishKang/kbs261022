const { chromium } = require('D:/1022/1022-2/kbs261022/tools/playwright/node_modules/playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const comCode = process.env.ECOUNT_COM_CODE || '54134';
  const userId = process.env.ECOUNT_USER_ID || 'cgiinc';
  const password = process.env.ECOUNT_PASSWORD || 'ecount-0722!';

  await page.goto('https://login.ecount.com/Login?lan_type=ko-KR', { waitUntil: 'networkidle' });
  await page.fill('#com_code', comCode);
  await page.fill('#id', userId);
  await page.fill('#passwd', password);
  await page.click('#save');
  await page.waitForTimeout(8000);

  // menu search 품목
  await page.fill('#inputFavMSearch', '');
  await page.type('#inputFavMSearch', '품목', { delay: 60 });
  await page.waitForTimeout(2500);
  const el = await page.$('.ui-menu-item a:has-text("품목등록")');
  if (el) await el.click();
  await page.waitForTimeout(8000);

  // click Excel export
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  // try button with text Excel
  let clicked = false;
  for (const sel of ['button:has-text("Excel")', 'a:has-text("Excel")', 'text=Excel']) {
    const b = await page.$(sel);
    if (b) { await b.click(); clicked = true; break; }
  }
  console.log('Excel clicked:', clicked);
  const download = await downloadPromise;
  const savePath = 'D:/1022/wt-g2b/reports/data/erp/ecount_item_export.xlsx';
  await download.saveAs(savePath);
  console.log('Saved:', savePath);
  console.log('Suggested filename:', download.suggestedFilename());

  await browser.close();
})();
