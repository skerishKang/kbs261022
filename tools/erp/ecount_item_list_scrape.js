const { chromium } = require('D:/1022/1022-2/kbs261022/tools/playwright/node_modules/playwright');
const fs = require('fs');

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

  // menu search
  await page.fill('#inputFavMSearch', '');
  await page.type('#inputFavMSearch', '품목', { delay: 60 });
  await page.waitForTimeout(2500);
  // list menu items
  const items = await page.evaluate(() => {
    return [...document.querySelectorAll('.ui-menu-item a')].map(a => a.innerText.trim()).filter(Boolean);
  });
  console.log('MENU ITEMS:', JSON.stringify(items));
  fs.writeFileSync('D:/1022/wt-g2b/reports/data/erp/ecount_menu_items.json', JSON.stringify(items, null, 2));

  // try click an item containing '품목등록' or '품목 조회' or '품목리스트'
  let clicked = null;
  for (const label of ['품목등록', '품목 조회', '품목리스트', '품목현황']) {
    const el = await page.$(`.ui-menu-item a:has-text("${label}")`);
    if (el) { await el.click(); clicked = label; break; }
  }
  if (!clicked) {
    // click first item containing '품목'
    const first = await page.$('.ui-menu-item a');
    if (first) { await first.click(); clicked = 'first'; }
  }
  console.log('CLICKED:', clicked);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'D:/1022/wt-g2b/reports/data/erp/ecount_item_screen.png', fullPage: true });

  // dump all table text
  const tables = await page.evaluate(() => {
    return [...document.querySelectorAll('table')].map(t => t.innerText).slice(0, 5);
  });
  fs.writeFileSync('D:/1022/wt-g2b/reports/data/erp/ecount_tables.json', JSON.stringify(tables, null, 2));
  console.log('TABLE COUNT:', tables.length);

  // dump body text (truncated)
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 5000));
  fs.writeFileSync('D:/1022/wt-g2b/reports/data/erp/ecount_body.txt', bodyText);

  await browser.close();
})();
