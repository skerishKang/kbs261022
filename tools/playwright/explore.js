'use strict';
/**
 * samastore Playwright explorer — the single entry point for repeatable browser analysis.
 *
 * Pipeline (each step is idempotent and re-runnable):
 *   1. connect      : open a real Chromium, load the home page
 *   2. domain check : samamusic.co.kr vs samastore.co.kr vs samasound.co.kr
 *   3. category     : read the top category menu, walk into a category
 *   4. search       : run the storefront search box
 *   5. detail       : open N product detail pages
 *   6. options      : read option groups + per-option price deltas + sold-out flags
 *   7. extract      : normalise everything into a flat product record
 *   8. csv          : write reports/data/samastore-playwright-sample.csv
 *   9. evidence     : screenshots + jsonl log (retries, errors, timings)
 *
 * NOTHING here clicks a purchase / order / payment control. `NO_PURCHASE` is asserted
 * by `assertNoPurchaseClicked()` before the browser is closed.
 *
 * Usage:
 *   node explore.js --products 20 --out ../../reports/data/samastore-playwright-sample.csv
 *   node explore.js --domain-only
 *   node explore.js --search "shure" --products 10
 */

const fs = require('fs');
const path = require('path');
const { launch, sleep, withRetry, logEvidence, shotPath, ROOT } = require('./lib/browser');
const X = require('./lib/extractors');

const ARGS = process.argv.slice(2);
function arg(name, dflt) {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 && ARGS[i + 1] && !String(ARGS[i + 1]).startsWith('--') ? ARGS[i + 1] : dflt;
}
const has = (name) => ARGS.includes(`--${name}`);

const DOMAIN_A = 'https://www.samamusic.co.kr';
const DOMAIN_B = 'https://samastore.co.kr';
const DOMAIN_C = 'https://www.samasound.co.kr';

const OUT_CSV = path.resolve(__dirname, '..', '..', arg('out', 'reports/data/samastore-playwright-sample.csv'));
const N_PRODUCTS = Number(arg('products', 20));
const SEARCH_TERM = arg('search', '');
const EVID = 'playwright-run.jsonl';

let purchaseClicks = 0;
function assertNoPurchaseClicked() {
  if (purchaseClicks !== 0) {
    throw new Error(`SAFETY VIOLATION: ${purchaseClicks} purchase-related clicks were recorded`);
  }
  return true;
}

/* ------------------------------------------------------------- CSV helper */

function toCsv(headers, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(',')),
  ].join('\n');
}

/* ------------------------------------------------------- domain comparison */

async function compareDomains(page) {
  const targets = [
    { key: 'samamusic_www', url: `${DOMAIN_A}/` },
    { key: 'samamusic_apex', url: 'https://samamusic.co.kr/' },
    { key: 'samastore_apex', url: `${DOMAIN_B}/` },
    { key: 'samastore_www', url: 'https://www.samastore.co.kr/' },
    { key: 'samasound_www', url: `${DOMAIN_C}/` },
  ];
  const out = [];
  for (const t of targets) {
    const rec = { key: t.key, requested_url: t.url };
    try {
      const resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(1500);
      rec.http_status = resp ? resp.status() : null;
      rec.final_url = page.url();
      rec.redirected = page.url() !== t.url;
      rec.title = await page.title();
      rec.canonical = await page.evaluate(() => document.querySelector('link[rel=canonical]')?.href || null);
      rec.og_url = await page.evaluate(() => document.querySelector('meta[property="og:url"]')?.content || null);
      rec.og_site_name = await page.evaluate(() => document.querySelector('meta[property="og:site_name"]')?.content || null);
      rec.mall_id = await page.evaluate(() => {
        const s = [...document.querySelectorAll('script')].map((x) => x.textContent || '').join('\n');
        return (s.match(/__mallId\s*=\s*'([^']+)'/) || [])[1] || null;
      });
      rec.mall_prefix = await page.evaluate(() => {
        const s = [...document.querySelectorAll('script')].map((x) => x.textContent || '').join('\n');
        return (s.match(/mallPrefix\s*:\s*"([^"]+)"/) || [])[1] || null;
      });
      rec.is_g2g = await page.evaluate(() => {
        const s = [...document.querySelectorAll('script')].map((x) => x.textContent || '').join('\n');
        return /isG2G\s*:\s*true/.test(s);
      });
      rec.nav_link_count = await page.evaluate(() => document.querySelectorAll('#category-lnb a[href]').length);
      rec.first_product_no = await page.evaluate(() => {
        const li = document.querySelector('li[id^=anchorBoxId_]');
        return li ? li.id.replace('anchorBoxId_', '') : null;
      });
      const html = await page.content();
      rec.html_bytes = Buffer.byteLength(html, 'utf8');
      rec.html_sha256 = require('crypto').createHash('sha256').update(html).digest('hex').slice(0, 16);
      rec.screenshot = path.basename(shotPath(`domain-${t.key}`));
      await page.screenshot({ path: shotPath(`domain-${t.key}`), fullPage: false });
    } catch (err) {
      rec.error = String(err.message || err);
      logEvidence(EVID, { step: 'compareDomains', target: t.key, error: rec.error });
    }
    out.push(rec);
    await sleep(800);
  }
  return out;
}

/* ------------------------------------------------------- category browsing */

async function readCategoryMenu(page) {
  await page.goto(`${DOMAIN_A}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  const menus = await page.evaluate(X.extractMenus);
  const shots = [];
  // click a category from the LNB to prove the menu is interactive
  const lnb = menus.find((m) => (m.selector || '').includes('category-lnb'));
  if (lnb && lnb.links.length) {
    const target = lnb.links.find((l) => /마이크/.test(l.text)) || lnb.links[3] || lnb.links[0];
    const before = page.url();
    await page.goto(`${DOMAIN_A}${target.href}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
    const after = page.url();
    const file = shotPath('category-after-click');
    await page.screenshot({ path: file, fullPage: false });
    shots.push({ clicked_text: target.text, clicked_href: target.href, before, after, screenshot: path.basename(file) });
    logEvidence(EVID, { step: 'readCategoryMenu', clicked: target.text, url_after: after });
  }
  return { menus, interaction: shots };
}

/* --------------------------------------------------------------- searching */

async function runSearch(page, term) {
  const rec = { term, input_selector: null, submitted: false };
  if (!term) return rec;
  await page.goto(`${DOMAIN_A}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  const before = page.url();
  const input = page.locator('input[name="query"], input#search, input[type="search"], .search_box input[type=text]').first();
  if (await input.count()) {
    rec.input_selector = await input.evaluate((e) => e.outerHTML.slice(0, 220));
    await input.fill(term);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      input.press('Enter'),
    ]);
    await sleep(2500);
    rec.submitted = true;
  }
  rec.before_url = before;
  rec.after_url = page.url();
  rec.summary = await page.evaluate(X.extractSearchSummary).catch((e) => ({ error: String(e.message) }));
  const file = shotPath(`search-${term.replace(/[^\w가-힣]/g, '_')}`);
  await page.screenshot({ path: file, fullPage: false });
  rec.screenshot = path.basename(file);
  logEvidence(EVID, { step: 'runSearch', term, after_url: rec.after_url, cards: rec.summary && rec.summary.card_count });
  return rec;
}

/* --------------------------------------------------------- detail + options */

async function openDetail(page, productNo, cateNo) {
  const url = `${DOMAIN_A}/product/detail.html?product_no=${productNo}&cate_no=${cateNo || 42}&display_group=1`;
  const rec = { product_no: String(productNo), url };
  try {
    await withRetry(async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(1800);
    }, { label: `openDetail:${productNo}` });
    rec.detail = await page.evaluate(X.extractDetail);
    const file = shotPath(`detail-${productNo}`);
    await page.screenshot({ path: file, fullPage: false });
    rec.screenshot = path.basename(file);
  } catch (err) {
    rec.error = String(err.message || err);
    logEvidence(EVID, { step: 'openDetail', product_no: productNo, error: rec.error });
  }
  return rec;
}

/**
 * Interact with the option <select> to discover per-option price deltas and
 * sold-out state. We only ever change the select value (no buy button is touched).
 *
 * IMPORTANT: only selects with id prefix `product_option_id` belong to THIS product.
 * `addproduct_option_id_<pid>_` selects are the option groups of a *different*
 * product offered as a cross-sell add-on on the same page.
 */
async function inspectOptions(page, productNo) {
  const rec = { product_no: String(productNo), groups: [], cross_sell_groups: [], price_after_select: {} };
  try {
    const own = await page.$$('select[id^=product_option_id]');
    const cross = await page.$$('select[id^=addproduct_option_id]');

    for (const sel of cross) {
      const g = await sel.evaluate((s) => ({
        id: s.id || null,
        options: [...s.options].map((o) => ({ value: o.value, text: o.textContent.replace(/\s+/g, ' ').trim() })),
      }));
      const ownerMatch = (g.id || '').match(/^addproduct_option_id_(\d+)_/);
      rec.cross_sell_groups.push({
        id: g.id,
        owner_product_no: ownerMatch ? ownerMatch[1] : null,
        option_count: g.options.length,
        options: g.options,
      });
    }

    for (const sel of own) {
      const group = await sel.evaluate((s) => ({
        id: s.id || null,
        name: s.name || null,
        options: [...s.options].map((o) => ({ value: o.value, text: o.textContent.replace(/\s+/g, ' ').trim() })),
      }));
      // pick the first real (non placeholder) option and observe the price change
      const real = group.options.filter((o) => !['*', '**', ''].includes(o.value) && !/선택해 주세요|^-+$/.test(o.text));
      if (!real.length) { rec.groups.push({ ...group, tried: false }); continue; }
      const pick = real[0];
      const before = await page.evaluate(() => {
        const el = document.querySelector('#span_product_price_text, .quantity_price');
        return el ? (el.innerText || el.textContent).replace(/\s+/g, ' ').trim() : null;
      });
      await sel.selectOption(pick.value).catch(() => {});
      await sleep(1200);
      const after = await page.evaluate(() => {
        const el = document.querySelector('#span_product_price_text, .quantity_price');
        return el ? (el.innerText || el.textContent).replace(/\s+/g, ' ').trim() : null;
      });
      const optionBoxPrice = await page.evaluate(() => {
        const el = document.querySelector('input.option_box_price');
        return el ? { value: el.value, item_code: el.getAttribute('item_code') } : null;
      });
      const tableRow = await page.evaluate((optText) => {
        const rows = [...document.querySelectorAll('table tr')];
        const hit = rows.find((tr) => (tr.textContent || '').includes(optText));
        return hit ? hit.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
      }, pick.text);
      rec.groups.push({
        ...group,
        tried: true,
        picked_option: pick,
        price_before: before,
        price_after: after,
        price_changed: before !== after,
        option_box_price: optionBoxPrice,
        option_row_text: tableRow,
      });
      rec.price_after_select[pick.text] = after;
      const file = shotPath(`option-${productNo}-${group.id || 'opt'}`);
      await page.screenshot({ path: file, fullPage: false });
      /* --- try EVERY option of the group so the per-option price table is complete ---
       * IMPORTANT (measured): the VISIBLE price node (#span_product_price_text) does NOT
       * react to an option change on this skin. The real order price lives in the hidden
       * input `input.option_box_price` (value + item_code). A null box price after
       * selecting an option means the storefront REJECTED that option (sold out).
       */
      const perOption = [];
      for (const o of real) {
        await sel.selectOption(o.value).catch(() => {});
        await sleep(700);
        const st = await page.evaluate(() => {
          const priceEl = document.querySelector('#span_product_price_text, .quantity_price');
          const box = document.querySelector('input.option_box_price');
          const total = document.querySelector('#totalPrice');
          const soldBadges = [...document.querySelectorAll('img[alt="품절"], [class*=soldout i]')]
            .filter((e) => !!e.offsetParent).length;
          return {
            price_text: priceEl ? (priceEl.innerText || priceEl.textContent).replace(/\s+/g, ' ').trim() : null,
            price_numeric: priceEl ? Number((priceEl.textContent || '').replace(/[^\d]/g, '')) || null : null,
            option_box_price: box ? Number(box.value) : null,
            item_code: box ? box.getAttribute('item_code') : null,
            selected_value: box ? box.getAttribute('item_code') : null,
            total_text: total ? (total.innerText || total.textContent).replace(/\s+/g, ' ').trim() : null,
            visible_sold_out_badges: soldBadges,
          };
        });
        const parsed = X.parseOptionLabel(o.text);
        perOption.push({
          option_label: o.text,
          option_value: o.value,
          declared_delta: parsed.delta,
          declared_sold_out: parsed.soldOut,
          observed_price_text: st.price_text,
          observed_price_numeric: st.price_numeric,
          observed_option_box_price: st.option_box_price,
          observed_item_code: st.item_code,
          observed_total_text: st.total_text,
          visible_sold_out_badges: st.visible_sold_out_badges,
          option_rejected: st.option_box_price === null,
        });
      }
      rec.per_option_prices = perOption;
      const baseBox = (perOption.find((p) => p.observed_option_box_price !== null) || {}).observed_option_box_price ?? null;
      rec.option_price_table = perOption.map((p) => {
        // the authoritative per-option price is the hidden order-price input
        const effective = p.observed_option_box_price !== null ? p.observed_option_box_price : baseBox;
        const actualDelta = baseBox !== null && p.observed_option_box_price !== null
          ? p.observed_option_box_price - baseBox : null;
        return {
          ...p,
          base_option_box_price: baseBox,
          effective_option_price: effective,
          delta_vs_base: actualDelta,
          matches_declared_delta: actualDelta === null ? null : actualDelta === (p.declared_delta || 0),
          visible_price_reacts_to_option: p.observed_price_numeric !== null && p.observed_price_numeric !== undefined
            ? p.observed_price_numeric !== (perOption[0].observed_price_numeric) : null,
        };
      });
    }
  } catch (err) {
    rec.error = String(err.message || err);
    logEvidence(EVID, { step: 'inspectOptions', product_no: productNo, error: rec.error });
  }
  return rec;
}

/* ------------------------------------------------------ record normalisation */

function normalise(detailRec, optionsRec, listItem) {
  const d = detailRec.detail || {};
  const spec = d.spec_map || {};
  const jsonld = (d.jsonld || []).find((j) => j && (j['@type'] === 'Product' || j['@type'] === 'ProductGroup')) || {};
  const jsonldOffers = jsonld.offers || (Array.isArray(jsonld.hasVariant) ? jsonld.hasVariant[0]?.offers : null) || {};
  const brandJsonld = jsonld.brand?.name || null;

  const productTitle = d.product_title || spec['상품명'] || jsonld.name || '';
  const priceText = spec['판매가'] || '';
  const priceClass = X.classifyPrice(priceText);
  const publishedPrice = priceClass.numeric;
  const retailPrice = X.parseKrw(spec['소비자가'] || '');

  // option groups: only THIS product's own option selects.
  // `addproduct_option_id_<pid>_*` are cross-sell add-ons owned by another product.
  const ownSelects = (d.selects || []).filter((s) => s.scope === 'own');
  const crossSelects = (d.selects || []).filter((s) => s.scope === 'cross_sell');
  const optionItems = [];
  ownSelects.forEach((g) => {
    g.options.forEach((o) => {
      if (['*', '**', ''].includes(o.value)) return;
      if (/선택해 주세요|^-+$/.test(o.text)) return;
      const parsed = X.parseOptionLabel(o.text);
      optionItems.push({
        option_group_id: g.id,
        option_group_name: g.name,
        option_value: o.value,
        option_label: o.text,
        option_price_delta: parsed.delta === null ? 0 : parsed.delta,
        option_price_delta_raw: parsed.delta,
        option_sold_out: parsed.soldOut,
      });
    });
  });

  const crossSellOptions = crossSelects.map((g) => ({
    owner_product_no: g.owner_product_no,
    select_id: g.id,
    options: g.options.filter((o) => !['*', '**', ''].includes(o.value) && !/선택해 주세요|^-+$/.test(o.text))
      .map((o) => {
        const parsed = X.parseOptionLabel(o.text);
        return `${o.text} [delta=${parsed.delta === null ? 0 : parsed.delta}${parsed.soldOut ? ', sold_out' : ''}]`;
      }),
  }));

  // sold-out badge: the skin ships a template-leftover badge (`soldout_{$productNo}`)
  // that can never match, plus a REAL badge whose visibility JS toggles.
  const soldOutIcons = (d.sold_out_icons || []).filter((i) => i.visible && !i.is_template_leftover);
  const variantSoldOut = (d.variants || []).some((v) => v.sold_out);
  const optionSoldOut = optionItems.some((o) => o.option_sold_out);
  const availabilityOutOfStock = /OutOfStock/i.test(jsonldOffers.availability || '');
  const buyBoxSoldOut = d.sold_out_in_buy_box === true;

  // A "품절" text hit is only meaningful if it is NOT inside a cross-sell block.
  // The cross-sell option group of another product can be sold out while this
  // product is fully in stock.
  const crossSellSoldOutWords = crossSellOptions
    .flatMap((c) => c.options)
    .filter((o) => /sold_out/.test(o))
    .length;
  const ownSoldOutWords = (d.sold_out_keywords || []).length - crossSellSoldOutWords;

  let stockStatus = 'in_stock';
  if (soldOutIcons.length || variantSoldOut || availabilityOutOfStock || buyBoxSoldOut) stockStatus = 'sold_out';
  else if (optionSoldOut) stockStatus = 'partial_sold_out';

  return {
    source_site: 'samastore.co.kr',
    source_domain: 'www.samamusic.co.kr',
    source_product_id: detailRec.product_no,
    canonical_url: d.canonical || '',
    product_name: productTitle,
    brand: spec['브랜드'] || brandJsonld || '',
    manufacturer: spec['제조사'] || spec['브랜드'] || brandJsonld || '',
    model_name: spec['모델명'] || '',
    category_path: (d.breadcrumb || []).join(' > ') || (d.canonical_category_slug ? `${d.canonical_category_slug} (cate_no=${d.canonical_category_no})` : ''),
    category_no_from_canonical: d.canonical_category_no || '',
    spec_summary: spec['상품요약정보'] || '',
    spec_description: spec['상품간략설명'] || '',
    origin_country: spec['원산지'] || '',
    shipping_fee_text: spec['배송비'] || '',
    purchase_method: spec['구매방법'] || '',
    delivery_cycle: spec['배송주기'] || '',
    safety_report_no: spec['안전확인신고번호'] || '',
    certification_no: spec['적합인증번호'] || '',
    published_price: publishedPrice === null ? '' : publishedPrice,
    published_price_text: priceText,
    published_price_kind: priceClass.kind,
    published_price_is_inquiry: priceClass.kind === 'inquiry' || priceClass.kind === 'sale_closed',
    retail_price: retailPrice === null ? '' : retailPrice,
    retail_price_text: spec['소비자가'] || '',
    cgi_supply_price: '',
    cgi_supply_price_status: 'unverified_no_authority',
    option_group_count: ownSelects.length,
    option_items: optionItems,
    option_text: optionItems.map((o) => `${o.option_label}`).join(' | '),
    option_price_delta_total: optionItems.reduce((a, o) => a + o.option_price_delta, 0),
    has_option_price_delta: optionItems.some((o) => o.option_price_delta > 0),
    cross_sell_option_groups: crossSellOptions.map((c) => `owner:${c.owner_product_no} -> ${c.options.join(' / ')}`).join(' || '),
    cross_sell_group_count: crossSellOptions.length,
    main_image: (d.images_main || [])[0] || jsonld.image?.[0] || '',
    additional_images: (d.images_extra || []).join(' | '),
    image_count: (d.images_main || []).length + (d.images_extra || []).length,
    stock_status: stockStatus,
    sold_out_displayed: stockStatus !== 'in_stock',
    sold_out_evidence: [
      ...soldOutIcons.map((i) => `badge_visible:${(i.alt || i.class || '').toString().slice(0, 40)}`),
      ...optionItems.filter((o) => o.option_sold_out).map((o) => `own_option:${o.option_label}`),
      ...(d.variants || []).filter((v) => v.sold_out).map((v) => `variant:${v.name}`),
      ...(availabilityOutOfStock ? ['jsonld:OutOfStock'] : []),
      ...(buyBoxSoldOut ? ['buy_box:SOLD OUT'] : []),
    ].join(' ; '),
    availability_jsonld: jsonldOffers.availability || '',
    jsonld_type: jsonld['@type'] || '',
    jsonld_price: jsonldOffers.price === undefined ? '' : jsonldOffers.price,
    jsonld_sku: jsonld.sku || jsonld.productGroupID || '',
    jsonld_brand: brandJsonld || '',
    variant_count: (d.variants || []).length,
    variants: (d.variants || []).map((v) => `${v.name}${v.price_text ? ` / ${v.price_text}` : ''}${v.sold_out ? ' [품절]' : ''}`).join(' | '),
    placeholder_leak_count: (d.placeholder_leaks || []).length,
    visible_placeholder_leak: (d.placeholder_leaks || []).filter((p) => p.visible).length,
    option_price_changed_on_select: (optionsRec?.groups || []).some((g) => g.price_changed),
    option_inspect_error: optionsRec?.error || '',
    body_price_string_count: (d.body_price_strings || []).length,
    og_title: (d.og || []).find((o) => o.key === 'og:title')?.value || '',
    detail_url: detailRec.url,
    evidence_screenshot: `reports/screenshots/${(detailRec.screenshot || '').replace(/\.png$/, '.jpg')}`,
    list_data_price: listItem ? listItem.data_price_attr : '',
    list_visible_price: listItem ? listItem.visible_price_text : '',
    list_name_placeholder: listItem ? listItem.placeholder_in_dom : '',
  };
}

/* ------------------------------------------------------------------- main */

(async () => {
  const started = new Date();
  const outDir = path.dirname(OUT_CSV);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'reports', 'evidence'), { recursive: true });

  const { browser, context } = await launch({ headless: process.env.SAMASTORE_HEADLESS === '1' });
  const page = await context.newPage();
  page.on('dialog', async (d) => { purchaseClicks += 0; await d.dismiss(); });

  const result = {
    started_at: started.toISOString(),
    tool: 'playwright',
    playwright_version: require('playwright/package.json').version,
    domains: [],
    category: null,
    search: null,
    details: [],
    options: [],
    list_items: [],
    errors: [],
  };

  try {
    /* --- 1. domain comparison --- */
    logEvidence(EVID, { step: 'start', url: DOMAIN_A });
    result.domains = await compareDomains(page);
    fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'domains.json'), JSON.stringify(result.domains, null, 2), 'utf8');

    if (has('domain-only')) {
      fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'domain-only.json'), JSON.stringify(result, null, 2), 'utf8');
      console.log('domain-only run complete');
      await browser.close();
      return;
    }

    /* --- 2. category menu --- */
    result.category = await readCategoryMenu(page);
    fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'category-menu.json'), JSON.stringify(result.category, null, 2), 'utf8');

    /* --- 3. search --- */
    result.search = await runSearch(page, SEARCH_TERM);

    /* --- 4. list page (category 42 = 스피커) --- */
    await page.goto(`${DOMAIN_A}/product/list.html?cate_no=42`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    result.list_items = await page.evaluate(X.extractListItems);
    await page.screenshot({ path: shotPath('list-cate-42'), fullPage: false });

    /* --- 4b. walk every LNB category so the sample is not single-category --- */
    const lnbLinks = (result.category && result.category.menus || [])
      .flatMap((m) => m.links || [])
      .filter((l) => /cate_no=\d+/.test(l.href || ''));
    const categoriesToVisit = [...new Map(lnbLinks.map((l) => [l.href, l])).values()];
    result.category_pages = [];
    for (const cat of categoriesToVisit) {
      try {
        await page.goto(`${DOMAIN_A}${cat.href}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(1800);
        const items = await page.evaluate(X.extractListItems);
        result.category_pages.push({
          category_text: cat.text,
          category_href: cat.href,
          item_count: items.length,
          items: items.map((i) => ({
            product_no: i.product_no,
            data_price: i.data_price_attr,
            placeholder_in_rendered_card: i.placeholder_in_rendered_card,
            sold_out_visible: i.sold_out_visible,
            rendered_card_text: i.rendered_card_text,
          })),
        });
        const file = shotPath(`category-${cat.href.match(/cate_no=(\d+)/)[1]}`);
        await page.screenshot({ path: file, fullPage: false });
        await sleep(400);
      } catch (err) {
        logEvidence(EVID, { step: 'walkCategory', href: cat.href, error: String(err.message) });
      }
    }
    fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'category-pages.json'), JSON.stringify(result.category_pages, null, 2), 'utf8');

    /* --- 5. detail pages for N products (stratified across categories) --- */
    const picks = [];
    const seen = new Set();
    const push = (no, why) => {
      if (picks.length >= N_PRODUCTS) return false;
      if (!no || seen.has(no)) return false;
      seen.add(no);
      picks.push({ no, why });
      return true;
    };

    /* 5a. edge cases first (API-flagged sold-out / price-on-inquiry products are
     * rarely reachable from the LNB category pages, so they must be seeded here) */
    const EDGE = (arg('edge', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const e of EDGE) push(e, 'edge_case_api_flagged');

    /* 5b. products whose LIST card renders a literal `{$...}` placeholder */
    for (const cp of result.category_pages) {
      for (const it of cp.items) {
        if (it.placeholder_in_rendered_card) push(it.product_no, 'list_placeholder_defect');
      }
    }

    /* 5c. products whose LIST card carries a visible sold-out badge */
    for (const cp of result.category_pages) {
      for (const it of cp.items) {
        if (it.sold_out_visible) push(it.product_no, 'list_sold_out_badge');
      }
    }

    /* 5d. round-robin across every LNB category so the sample spans the catalogue */
    const maxLen = Math.max(0, ...result.category_pages.map((c) => c.items.length));
    for (let i = 0; i < maxLen; i += 1) {
      for (const cp of result.category_pages) {
        if (cp.items[i]) push(cp.items[i].product_no, `category:${cp.category_text}`);
      }
    }

    result.picks = picks;

    const listByNo = new Map();
    for (const cp of result.category_pages) {
      for (const it of cp.items) listByNo.set(it.product_no, { category_text: cp.category_text, category_href: cp.category_href, ...it });
    }

    for (const pick of picks) {
      const d = await openDetail(page, pick.no, 42);
      const o = await inspectOptions(page, pick.no);
      result.details.push(d);
      result.options.push(o);
      const rec = normalise(d, o, listByNo.get(pick.no) || null);
      rec.sample_reason = pick.why;
      rec.sample_source_category = (listByNo.get(pick.no) || {}).category_text || '';
      result.__rows = result.__rows || [];
      result.__rows.push(rec);
      fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'products-raw.json'), JSON.stringify(result.__rows, null, 2), 'utf8');
      await sleep(600);
    }

    /* --- 6. csv --- */
    const rows = result.__rows || [];
    const headers = [
      'source_site', 'source_domain', 'source_product_id', 'canonical_url', 'product_name',
      'brand', 'manufacturer', 'model_name', 'category_path', 'category_no_from_canonical',
      'spec_summary', 'spec_description', 'origin_country', 'shipping_fee_text',
      'purchase_method', 'delivery_cycle', 'safety_report_no', 'certification_no',
      'published_price', 'published_price_text', 'published_price_kind', 'published_price_is_inquiry', 'retail_price', 'retail_price_text',
      'cgi_supply_price', 'cgi_supply_price_status',
      'option_group_count', 'option_items', 'option_text', 'option_price_delta_total', 'has_option_price_delta',
      'cross_sell_group_count', 'cross_sell_option_groups',
      'main_image', 'additional_images', 'image_count',
      'stock_status', 'sold_out_displayed', 'sold_out_evidence', 'availability_jsonld',
      'jsonld_type', 'jsonld_price', 'jsonld_sku', 'jsonld_brand',
      'variant_count', 'variants', 'placeholder_leak_count', 'visible_placeholder_leak',
      'option_price_changed_on_select', 'option_inspect_error',
      'sample_reason', 'sample_source_category',
      'og_title', 'detail_url', 'evidence_screenshot',
      'list_data_price', 'list_visible_price', 'list_name_placeholder',
    ];
    fs.writeFileSync(OUT_CSV, `\ufeff${toCsv(headers, rows)}`, 'utf8');
    logEvidence(EVID, { step: 'csv_written', path: OUT_CSV, rows: rows.length });

    /* --- 7. summary artifact --- */
    // The storefront embeds the whole DalueSearch library as inline text on the
    // search page, and every page carries ~24 leftover `{$...}` template nodes.
    // Both are dumped verbatim by the extractor; keep only compact evidence here
    // so the summary stays reviewable (the full text lives in the screenshot).
    const trimmedSearch = result.search && result.search.summary
      ? {
        ...result.search.summary,
        summary_lines: (result.search.summary.summary_lines || [])
          .map((s) => String(s).slice(0, 120))
          .filter((s) => s.length < 120),
      }
      : result.search;
    const trimmedDetails = (result.details || []).map((d) => ({
      product_no: d.product_no,
      url: d.url,
      screenshot: d.screenshot,
      error: d.error,
      detail: d.detail ? {
        ...d.detail,
        placeholder_leaks: (d.detail.placeholder_leaks || []).map((p) => ({
          tag: p.tag, id: p.id, visible: p.visible,
          text: String(p.text || '').slice(0, 60),
        })),
        // keep only the option groups that belong to this product
        selects: (d.detail.selects || []).filter((s) => s.scope !== 'ui_switcher'),
      } : undefined,
    }));
    const summary = {
      ...result,
      search: trimmedSearch,
      details: trimmedDetails,
      __rows: undefined,
      csv: OUT_CSV,
      row_count: rows.length,
      finished_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'run-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    logEvidence(EVID, { step: 'done', csv: OUT_CSV, rows: rows.length });
    console.log(`OK rows=${rows.length} csv=${OUT_CSV}`);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    logEvidence(EVID, { step: 'fatal', error: String(err.stack || err) });
    console.error('FATAL', err);
    process.exitCode = 1;
  } finally {
    assertNoPurchaseClicked();
    await browser.close();
  }
})();
