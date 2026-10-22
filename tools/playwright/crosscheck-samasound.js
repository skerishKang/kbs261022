'use strict';
/**
 * Cross-check target: samasound.co.kr (B2B). Verify for ourselves — rather than
 * trusting another model's report — whether prices are public there.
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, shotPath, ROOT } = require('./lib/browser');

(async () => {
  const { browser, context } = await launch({ headless: true });
  const page = await context.newPage();
  const out = { list: null, details: [] };

  // category list
  await page.goto('https://www.samasound.co.kr/product/list.html?cate_no=23', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  out.list = await page.evaluate(() => {
    const t = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
    const cards = [...document.querySelectorAll('.product_list li, li[id^=anchorBoxId_], .prd_item')];
    const body = document.body.innerText || '';
    return {
      url: location.href,
      card_count: cards.length,
      card_sample: cards.slice(0, 5).map((c) => t(c).slice(0, 160)),
      body_price_strings: [...new Set(body.match(/[\d,]{3,10}\s*원/g) || [])].slice(0, 20),
      has_price_inquiry: /가격\s*문의/.test(body),
      jsonld_types: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
        try { const j = JSON.parse(s.textContent); return { type: j['@type'], price: j.offers && j.offers.price, availability: j.offers && j.offers.availability }; } catch { return null; }
      }).filter(Boolean),
    };
  });
  await page.screenshot({ path: shotPath('crosscheck-samasound-list'), fullPage: false });

  // a few detail pages
  for (const pno of [3826, 3887, 3842]) {
    await page.goto(`https://www.samasound.co.kr/product/detail.html?product_no=${pno}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2200);
    const d = await page.evaluate(() => {
      const spec = {};
      document.querySelectorAll('table').forEach((tb) => {
        const cap = (tb.querySelector('caption')?.textContent || '').trim();
        if (!cap.includes('기본 정보')) return;
        tb.querySelectorAll('tr').forEach((tr) => {
          const th = tr.querySelector('th'); const td = tr.querySelector('td');
          if (th && td) spec[(th.textContent || '').trim()] = (td.textContent || '').replace(/\s+/g, ' ').trim();
        });
      });
      const body = document.body.innerText || '';
      return {
        spec,
        body_price_strings: [...new Set(body.match(/[\d,]{3,10}\s*원/g) || [])].slice(0, 15),
        has_price_inquiry: /가격\s*문의/.test(body),
        jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
          try { const j = JSON.parse(s.textContent); return { type: j['@type'], price: j.offers && j.offers.price, sku: j.sku, brand: j.brand && j.brand.name }; } catch { return null; }
        }).filter(Boolean),
      };
    });
    out.details.push({ product_no: pno, ...d });
    await page.screenshot({ path: shotPath(`crosscheck-samasound-${pno}`), fullPage: false });
  }

  fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'crosscheck-samasound.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('ok');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
