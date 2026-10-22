'use strict';
/**
 * Proves that the Dalue SEARCH RESULT page carries static, wrong attributes:
 *
 *   card `id`          -> always `anchorBoxId_4558`  (the template row, cloned by JS)
 *   `data-price`       -> always `^1,050,000`       (the template row's value)
 *   real price         -> only in `#dprice_<productNo>` (filled by JS from the API)
 *   real product id    -> only in the anchor `href` (`product_no=`)
 *
 * Consequence: an HTTP-only scrape of the search page reads EVERY product as
 * product 4558 priced at 1,050,000 KRW. The browser is required to get it right.
 *
 * Output: reports/evidence/search-price-defect.json
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, shotPath, ROOT } = require('./lib/browser');

(async () => {
  fs.mkdirSync(path.join(ROOT, 'reports', 'evidence'), { recursive: true });
  const { browser, context } = await launch({ headless: true });
  const page = await context.newPage();
  const out = {};

  await page.goto('https://www.samamusic.co.kr/shopSearch/search.html?query=genelec&begin=1&size=40', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  out.search_cards = await page.evaluate(() => {
    const t = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
    const cards = [...document.querySelectorAll('li[id^=anchorBoxId_]')].filter((c) => !!c.offsetParent);
    return {
      url: location.href,
      card_count_visible: cards.length,
      cards: cards.slice(0, 12).map((c) => {
        const priceEl = c.querySelector('[id^=dprice_], [id^=price_], .price, [class*=price]');
        const a = c.querySelector('a[href*="product_no="]');
        return {
          card_id: c.id,
          href_product_no: a ? (a.getAttribute('href').match(/product_no=(\d+)/) || [])[1] : null,
          dprice_element_id: priceEl ? priceEl.id : null,
          rendered_price_text: t(c.querySelector('[id^=dprice_]')),
          data_price_attr: c.getAttribute('data-price'),
          card_price_numbers: (t(c).match(/[\d,]{3,10}\s*원/g) || []),
        };
      }),
    };
  });
  await page.screenshot({ path: shotPath('verify-search-price-defect'), fullPage: false });

  // the same product family on a normal category list page -> attributes are correct there
  await page.goto('https://www.samamusic.co.kr/product/list.html?cate_no=42', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  out.category_cards = await page.evaluate(() => {
    const t = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
    const cards = [...document.querySelectorAll('li[id^=anchorBoxId_]')].filter((c) => !!c.offsetParent);
    return {
      card_count_visible: cards.length,
      cards: cards.slice(0, 12).map((c) => ({
        card_id: c.id,
        data_price_attr: c.getAttribute('data-price'),
        card_price_numbers: (t(c).match(/[\d,]{3,10}\s*원/g) || []),
      })),
    };
  });

  fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'search-price-defect.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('wrote reports/evidence/search-price-defect.json');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
