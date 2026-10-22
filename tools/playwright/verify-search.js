'use strict';
/**
 * Verify that the on-page search really returns matching products (and that the
 * "검색결과가 없습니다" string is a hidden template leftover, not the real state).
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, shotPath, ROOT } = require('./lib/browser');

(async () => {
  const { browser, context } = await launch({ headless: true });
  const page = await context.newPage();
  const out = {};

  for (const term of ['shure', 'genelec', '존재하지않는상품명XYZ']) {
    await page.goto('https://www.samamusic.co.kr/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1800);
    // the page has several search inputs (some hidden placeholders) -> pick the
    // visible text input that actually belongs to the header search box
    const candidates = await page.evaluate(() => [...document.querySelectorAll('input[type=text], input[type=search], input:not([type])')]
      .map((i) => ({
        id: i.id, name: i.name, cls: i.className, type: i.type,
        placeholder: i.placeholder, visible: !!i.offsetParent,
        parent_id: i.parentElement ? i.parentElement.id : null,
        parent_cls: i.parentElement ? i.parentElement.className : null,
        form_action: i.form ? i.form.action : null,
      })));
    // eslint-disable-next-line no-console
    fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'search-inputs.json'), JSON.stringify(candidates, null, 2), 'utf8');

    const input = page.locator('input[type=text]:visible, input[type=search]:visible').first();
    await input.fill(term);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      input.press('Enter'),
    ]);
    await sleep(4000);
    const d = await page.evaluate(() => {
      const t = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
      const cards = [...document.querySelectorAll('li[id^=anchorBoxId_]')];
      // is the "no results" message visible?
      const noResult = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /검색결과가\s*없습니다/.test(e.textContent || ''));
      return {
        url: location.href,
        card_count: cards.length,
        visible_cards: cards.filter((c) => !!c.offsetParent).length,
        first_names: cards.slice(0, 6).map((c) => t(c.querySelector('.name, [class*=name]')).slice(0, 70)),
        first_prices: cards.slice(0, 6).map((c) => c.getAttribute('data-price')),
        no_result_message_visible: noResult ? !!noResult.offsetParent : false,
        no_result_message_text: noResult ? t(noResult) : null,
        pagination_text: t(document.querySelector('.dalue-search-order, [class*=pagination], .dalue_search_pagination')),
      };
    });
    out[term] = d;
    await page.screenshot({ path: shotPath(`verify-search-${term.replace(/[^\w]/g, '_')}`), fullPage: false });
    await sleep(400);
  }

  fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'search-verification.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('ok');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
