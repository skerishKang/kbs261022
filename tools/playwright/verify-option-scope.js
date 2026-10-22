'use strict';
/**
 * Proves the OPTION SCOPE rule that the whole collection depends on:
 *
 *   select id `product_option_id<N>`            -> the option group of THIS product
 *   select id `addproduct_option_id_<pid>_<N>` -> the option group of a DIFFERENT
 *                                                  product (<pid>) that is offered
 *                                                  as a cross-sell add-on
 *
 * Mixing the two silently attributes another product's option prices and
 * sold-out flags to the product being collected.
 *
 * Output: reports/evidence/option-scope.json
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, ROOT } = require('./lib/browser');

const TARGETS = process.argv.slice(2).map(Number).filter(Boolean);
const targets = TARGETS.length ? TARGETS : [4167, 1118, 5685, 4558];

(async () => {
  fs.mkdirSync(path.join(ROOT, 'reports', 'evidence'), { recursive: true });
  const { browser, context } = await launch({ headless: true });
  const page = await context.newPage();
  const out = [];

  for (const pno of targets) {
    await page.goto(`https://www.samamusic.co.kr/product/detail.html?product_no=${pno}&cate_no=42&display_group=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    const data = await page.evaluate(() => {
      const t = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
      const own = [];
      const cross = [];
      const sections = [];

      document.querySelectorAll('select[id^=product_option_id]').forEach((s) => {
        own.push({
          id: s.id,
          options: [...s.options].map((o) => o.textContent.replace(/\s+/g, ' ').trim()),
        });
      });

      document.querySelectorAll('select[id^=addproduct_option_id]').forEach((s) => {
        // find the product card the select belongs to
        let el = s;
        let owner = null;
        for (let i = 0; i < 12 && el; i += 1) {
          const a = el.querySelector && el.querySelector('a[href*="product_no="]');
          if (a && el !== s) {
            owner = {
              product_no: (a.getAttribute('href').match(/product_no=(\d+)/) || [])[1] || null,
              name: t(el.querySelector('.name, .prd_name, [class*=name]')),
            };
            break;
          }
          el = el.parentElement;
        }
        cross.push({
          id: s.id,
          inferred_owner_product_no: owner ? owner.product_no : null,
          inferred_owner_name: owner ? owner.name : null,
          options: [...s.options].map((o) => o.textContent.replace(/\s+/g, ' ').trim()),
        });
      });

      document.querySelectorAll('table').forEach((tb) => {
        const cap = (tb.querySelector('caption')?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/옵션/.test(cap)) return;
        let el = tb.parentElement;
        let head = null;
        for (let i = 0; i < 8 && el; i += 1) {
          const h = el.querySelector(':scope > h2, :scope > h3, :scope > .title');
          if (h) { head = t(h); break; }
          el = el.parentElement;
        }
        sections.push({
          caption: cap,
          section_heading: head,
          select_ids: [...tb.querySelectorAll('select')].map((s) => s.id),
          rows: [...tb.querySelectorAll('tr')].map((tr) => {
            const th = tr.querySelector('th');
            const td = tr.querySelector('td');
            return th ? { label: t(th), value: t(td).slice(0, 200) } : null;
          }).filter(Boolean).slice(0, 5),
        });
      });

      return { own_option_selects: own, cross_sell_selects: cross, option_tables: sections };
    });

    out.push({
      product_no: String(pno),
      url: `https://www.samamusic.co.kr/product/detail.html?product_no=${pno}&cate_no=42&display_group=1`,
      ...data,
    });
  }

  fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'option-scope.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(`wrote reports/evidence/option-scope.json (${out.length} products)`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
