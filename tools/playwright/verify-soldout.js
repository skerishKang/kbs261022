'use strict';
/**
 * Verifies how the storefront SHOWS a sold-out product (Task 7).
 *
 * Three things are checked for every product:
 *   1. the detail page    -> `품절` badge visibility, buy-box `SOLD OUT` notice,
 *                            JSON-LD `availability`
 *   2. the LIST page      -> whether the card carries any sold-out marker at all
 *                            (measured answer: it does NOT)
 *   3. the price-on-inquiry case -> `판매완료` / `가격 문의` style markers
 *
 * The badge trap: the skin renders TWO badges, one of them with the server side
 * template class `soldout_{$productNo}` which can never match a real product id
 * and is always `display:none`. Only the badge's computed visibility is meaningful.
 *
 * Usage: node verify-soldout.js [productNo ...]
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, shotPath, ROOT } = require('./lib/browser');

const OUT = path.join(ROOT, 'reports', 'evidence');
const SOLD_OUT = [4385, 4115, 1119, 1304, 3184, 4056];
const LIST_CATEGORIES = [24, 42, 84, 366, 379];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { browser, context } = await launch({ headless: true });
  const page = await context.newPage();
  const out = { details: [], lists: [] };

  /* ---------------- detail pages ---------------- */
  for (const pno of SOLD_OUT) {
    await page.goto(`https://www.samamusic.co.kr/product/detail.html?product_no=${pno}&cate_no=42&display_group=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2200);
    const d = await page.evaluate(() => {
      const t = (el) => (el ? (el.innerText || el.textContent).replace(/\s+/g, ' ').trim() : '');
      const spec = {};
      document.querySelectorAll('table').forEach((tb) => {
        const cap = (tb.querySelector('caption')?.textContent || '').trim();
        if (!cap.includes('기본 정보')) return;
        tb.querySelectorAll('tr').forEach((tr) => {
          const th = tr.querySelector('th'); const td = tr.querySelector('td');
          if (th && td) spec[(th.textContent || '').trim()] = (td.textContent || '').replace(/\s+/g, ' ').trim();
        });
      });
      const badges = [...document.querySelectorAll('img[alt="품절"], [class*=soldout i]')].map((e) => ({
        tag: e.tagName,
        class: e.className,
        alt: e.getAttribute('alt'),
        inline_style: e.getAttribute('style'),
        computed_display: window.getComputedStyle(e).display,
        visible: !!e.offsetParent,
        is_template_leftover: /\{\$/.test(e.className || ''),
      }));
      const jl = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } }).filter(Boolean);
      const prod = jl.find((j) => j && (j['@type'] === 'Product' || j['@type'] === 'ProductGroup'));
      return {
        spec,
        sold_out_badges: badges,
        visible_sold_out_badge: badges.some((b) => b.visible && !b.is_template_leftover),
        template_leftover_badge: badges.some((b) => b.is_template_leftover),
        buy_box_says_sold_out: /SOLD\s*OUT/i.test((document.querySelector('.buy-box, .buy-scroll-box') || {}).textContent || ''),
        jsonld_type: prod ? prod['@type'] : null,
        jsonld_availability: prod && prod.offers ? prod.offers.availability : null,
        jsonld_price: prod && prod.offers ? prod.offers.price : null,
        price_text: t(document.querySelector('#span_product_price_text, .quantity_price')),
      };
    });
    out.details.push({ product_no: String(pno), ...d });
    await page.screenshot({ path: shotPath(`soldout-detail-${pno}`), fullPage: false });
    await sleep(400);
  }

  /* ---------------- list pages ---------------- */
  for (const cate of LIST_CATEGORIES) {
    await page.goto(`https://www.samamusic.co.kr/product/list.html?cate_no=${cate}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2200);
    const d = await page.evaluate(() => {
      const t = (el) => (el ? (el.innerText || el.textContent).replace(/\s+/g, ' ').trim() : '');
      const cards = [...document.querySelectorAll('li[id^=anchorBoxId_]')];
      return {
        card_count: cards.length,
        cards: cards.map((c) => ({
          product_no: c.id.replace('anchorBoxId_', ''),
          badges: [...c.querySelectorAll('img,span,div')]
            .filter((e) => /soldout|sold_out/i.test(e.className || '') || /품절/.test(e.getAttribute('alt') || ''))
            .map((e) => ({ class: e.className, alt: e.getAttribute('alt'), visible: !!e.offsetParent })),
          visible_sold_out_badge: [...c.querySelectorAll('img[alt="품절"], [class*=soldout i]')]
            .some((e) => !!e.offsetParent && !/\{\$/.test(e.className || '')),
          card_text: t(c).slice(0, 200),
        })),
      };
    });
    out.lists.push({ cate_no: String(cate), ...d });
    await page.screenshot({ path: shotPath(`soldout-list-cate-${cate}`), fullPage: false });
    await sleep(400);
  }

  fs.writeFileSync(path.join(OUT, 'soldout-render.json'), JSON.stringify(out, null, 2), 'utf8');

  const detailSoldOut = out.details.filter((d) => d.visible_sold_out_badge).length;
  const listSoldOut = out.lists.reduce((a, l) => a + l.cards.filter((c) => c.visible_sold_out_badge).length, 0);
  console.log(`detail pages with a visible 품절 badge: ${detailSoldOut}/${out.details.length}`);
  console.log(`list cards with a visible 품절 badge  : ${listSoldOut}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
