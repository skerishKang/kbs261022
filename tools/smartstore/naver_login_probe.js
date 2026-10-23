const { chromium } = require('D:/1022/1022-2/kbs261022/tools/playwright/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const id = process.env.NAVER_ID || 'kbs45882';
  const pw = process.env.NAVER_PW || 'ccmkbs-54134?';
  await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'networkidle' });
  await page.fill('#id', id);
  await page.fill('#pw', pw);
  await page.press('#pw', 'Enter');
  await page.waitForTimeout(8000);
  console.log('URL:', page.url());
  await page.screenshot({ path: 'D:/1022/wt-g2b/reports/data/smartstore/naver_after_login.png', fullPage: true });
  const text = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('TEXT:', text.replace(/\n/g, ' ').slice(0, 500));
  await browser.close();
})();
