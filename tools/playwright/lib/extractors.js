'use strict';
/**
 * DOM extraction helpers for samastore.co.kr / samamusic.co.kr (CAFE24 Indi `_wg` G2G skin).
 *
 * Every function here runs *inside* the page (page.evaluate) so it operates on the
 * live, hydrated DOM rather than on raw HTML. That is the whole point of this tool:
 * we compare what a shopper actually SEES (visible text, computed styles) against
 * what the DOM literally contains (including un-rendered template leftovers).
 */

/* ------------------------------------------------------------------ helpers */

const VISIBLE_TEXT = `(el) => {
  if (!el) return '';
  const st = window.getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return '';
  return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
}`;

/** Parse "219,000원" / "1,290,000" -> 1290000 ; returns null when not a number. */
function parseKrw(text) {
  if (text === null || text === undefined) return null;
  const m = String(text).replace(/\s/g, '').match(/(\d[\d,]*)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * The storefront replaces the numeric selling price with a marker in three
 * observed shapes (verified on the live site):
 *   "가격 문의" / "가격문의"  -> price on inquiry   (U+BC1C U+C758 = 문의)
 *   "판매문의"               -> price on request   (same word)
 *   "판매완료" / "판매 완료" -> sale closed        (U+C644 U+B8CC = 완료)
 * In all three cases there is NO reliable public selling price, so the numeric
 * field must be left empty rather than guessed.
 */
const INQUIRY_WORD = '\uBB38\uC758';   // 문의
const CLOSED_WORD = '\uC644\uB8CC';    // 완료
function isPriceInquiry(text) {
  const s = String(text || '');
  return s.includes(INQUIRY_WORD) || s.includes(CLOSED_WORD);
}

/** Classify the 판매가 cell of the 기본 정보 table. */
function classifyPrice(text) {
  const s = String(text || '').trim();
  if (s === '') return { kind: 'missing', numeric: null };
  if (s.includes(CLOSED_WORD)) return { kind: 'sale_closed', numeric: null };
  if (s.includes(INQUIRY_WORD)) return { kind: 'inquiry', numeric: null };
  const n = parseKrw(s);
  if (n === null) return { kind: 'unknown', numeric: null };
  return { kind: 'numeric', numeric: n };
}

/** Strip the CAFE24 discount marker "^" that prefixes data-price values. */
function parseDataPrice(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[\^,]/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an option label such as `2m (+3,000원)` or `5m [품절] (+14,000원)`.
 * Returns { delta:Number|null, soldOut:boolean, label:String }.
 *
 * NOTE: the Korean currency word and the sold-out marker are matched by code point
 * instead of a literal so this function can never be broken by an encoding
 * round-trip of the source file (which already produced a silent parsing failure).
 */
const KWON = '\uC6D0';        // 원
const SOLD_OUT_WORD = '\uD488\uC808'; // 품절
function parseOptionLabel(text) {
  const s = String(text || '');
  const soldOut = s.includes(SOLD_OUT_WORD) || /sold\s*out/i.test(s);
  // (+3,000원) / (+3,000 원) / (+ 3,000원)
  const m = s.match(/\(\s*\+?\s*([\d,]+)\s*(?:\uC6D0)\s*\)/);
  let delta = null;
  if (m) delta = Number(m[1].replace(/,/g, ''));
  return { delta, soldOut, label: s };
}

/* ------------------------------------------------------- list page extraction */

/**
 * Runs in page context. Returns one record per product card in the current list page.
 * `visible` fields reflect what a shopper can actually see; `dom` fields reflect raw DOM.
 */
function extractListItems() {
  const t = (el) => {
    if (!el) return '';
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const rawText = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  const cards = [...document.querySelectorAll('li[id^=anchorBoxId_]')];
  return cards.map((li) => {
    const id = (li.id || '').replace('anchorBoxId_', '');
    const a = li.querySelector('a[href*="product_no="]');
    const href = a ? a.getAttribute('href') : null;
    const img = li.querySelector('img');
    const rawName = rawText(li.querySelector('.name, .product-name, .prd_name, .title, [class*=name]'));
    const visName = t(li.querySelector('.name, .product-name, .prd_name, .title, [class*=name]'));
    const priceEl = li.querySelector('[class*=price i]');
    const soldOutBadge = [...li.querySelectorAll('img,span,div')]
      .filter((e) => /soldout|sold_out|sold-out/i.test(e.className || '') || /품절/.test(e.getAttribute('alt') || ''))
      .map((e) => ({
        html: e.outerHTML.slice(0, 160),
        alt: e.getAttribute('alt'),
        visible: !!e.offsetParent,
        is_template_leftover: /\{\$/.test(e.className || ''),
      }));
    // The whole card's *rendered* text — used to detect the site's own SSR defect
    // where a card renders literal `{$productName}` placeholders instead of data.
    const cardText = t(li);
    return {
      product_no: id,
      href,
      // DOM (unfiltered) vs visible
      dom_name: rawName,
      visible_name: visName,
      placeholder_in_dom: /\{\$[a-zA-Z0-9_]+\}/.test(rawName),
      placeholder_in_rendered_card: /\{\$[a-zA-Z0-9_]+\}/.test(cardText),
      rendered_card_text: cardText.slice(0, 400),
      data_price_attr: li.getAttribute('data-price'),
      data_price_parsed: (() => {
        const s = (li.getAttribute('data-price') || '').replace(/[\^]/g, '');
        const n = Number(s.replace(/,/g, ''));
        return Number.isFinite(n) && s !== '' ? n : null;
      })(),
      visible_price_text: t(priceEl),
      visible_price_parsed: (() => {
        const m = t(priceEl).match(/([\d,]+)\s*원/);
        return m ? Number(m[1].replace(/,/g, '')) : null;
      })(),
      dom_price_text: rawText(priceEl),
      image: img ? (img.getAttribute('src') || img.getAttribute('data-src')) : null,
      image_alt: img ? img.getAttribute('alt') : null,
      like_count: rawText(li.querySelector('.likePrdCount')),
      sold_out_badges: soldOutBadge,
      sold_out_visible: soldOutBadge.some((b) => b.visible && !b.is_template_leftover),
      visible_card: !!li.offsetParent,
      raw_html_len: li.outerHTML.length,
    };
  });
}

/** Runs in page context. Returns the top navigation / category menu structure. */
function extractMenus() {
  const t = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const roots = [...document.querySelectorAll('#category-lnb, #gnb, #lnb, nav, [class*=gnb i], [class*=lnb i]')];
  const out = [];
  const seen = new Set();
  roots.forEach((root) => {
    if (seen.has(root)) return;
    seen.add(root);
    const links = [...root.querySelectorAll('a[href]')].map((a) => ({
      text: t(a),
      href: a.getAttribute('href'),
      absolute: a.href,
    }));
    if (links.length) out.push({ selector: `#${root.id || ''}.${root.className || ''}`, link_count: links.length, links });
  });
  return out;
}

/* ------------------------------------------------------ detail page extraction */

/**
 * Runs in page context. Extracts the full product record from a detail page.
 */
function extractDetail() {
  const t = (el) => {
    if (!el) return '';
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const raw = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  /* --- JSON-LD (may be Product or ProductGroup) --- */
  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => { try { return JSON.parse(s.textContent); } catch { return { parse_error: true, raw: s.textContent.slice(0, 200) }; } })
    .filter(Boolean);

  /* --- spec table (caption "기본 정보") --- */
  const specRows = [];
  [...document.querySelectorAll('table')].forEach((tb) => {
    const cap = raw(tb.querySelector('caption'));
    if (!cap.includes('기본 정보')) return;
    [...tb.querySelectorAll('tr')].forEach((tr) => {
      const th = tr.querySelector('th');
      const td = tr.querySelector('td');
      if (!th) return;
      specRows.push({ label: raw(th), value: raw(td), visible_value: t(td) });
    });
  });
  const specMap = {};
  specRows.forEach((r) => { if (!specMap[r.label]) specMap[r.label] = r.value; });

  /* --- option tables (caption "상품 옵션" / "옵션 정보") -----------------
   * IMPORTANT (verified by probing the live site):
   *   caption "상품 옵션"  -> the MAIN product's own option group(s)
   *   caption "옵션 정보"  -> CROSS-SELL ("추가구성상품") option groups that belong to a
   *                          DIFFERENT product (id prefix `addproduct_option_id_<pid>_`).
   * Mixing the two silently attributes another product's option prices to this product.
   */
  const optionRows = [];
  [...document.querySelectorAll('table')].forEach((tb) => {
    const cap = raw(tb.querySelector('caption'));
    if (!/상품 옵션|옵션 정보/.test(cap)) return;
    [...tb.querySelectorAll('tr')].forEach((tr) => {
      const th = tr.querySelector('th');
      const td = tr.querySelector('td');
      if (!th || !td) return;
      optionRows.push({
        caption: cap,
        scope: cap.includes('상품 옵션') ? 'main_product' : 'cross_sell',
        label: raw(th),
        value: raw(td),
        select_ids: [...tb.querySelectorAll('select')].map((s) => s.id),
      });
    });
  });

  /* --- <select> option groups -------------------------------------------
   * `own`      : select id starts with `product_option_id` -> belongs to THIS product
   * `crossSell`: select id starts with `addproduct_option_id_<pid>_` -> belongs to
   *              product <pid> which is only offered as an add-on on this page.
   */
  const selects = [...document.querySelectorAll('select')]
    .map((s) => {
      const id = s.id || '';
      const name = s.name || '';
      let scope = 'other';
      if (/^product_option_id/.test(id) || /^option\d+$/.test(name)) scope = 'own';
      else if (/^addproduct_option_id_/.test(id)) scope = 'cross_sell';
      else if (/shipping|language|country/i.test(id + ' ' + name)) scope = 'ui_switcher';
      const ownerMatch = id.match(/^addproduct_option_id_(\d+)_/);
      return {
        id: id || null,
        name: name || null,
        scope,
        owner_product_no: scope === 'cross_sell' && ownerMatch ? ownerMatch[1] : null,
        options: [...s.options].map((o) => ({
          value: o.value,
          text: o.textContent.replace(/\s+/g, ' ').trim(),
          selected: o.selected,
        })),
      };
    })
    .filter((s) => s.scope !== 'other' || s.options.length <= 5);

  /* --- variant table (caption "상품 목록") --- */
  const variants = [];
  [...document.querySelectorAll('table')].forEach((tb) => {
    const cap = raw(tb.querySelector('caption'));
    if (!cap.includes('상품 목록')) return;
    const rows = [...tb.querySelectorAll('tr')];
    rows.forEach((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      if (tds.length < 2) return;
      const name = raw(tds[0]);
      const rest = tds.slice(1).map((x) => raw(x));
      const priceCell = rest.find((x) => /[\d,]+\s*원/.test(x)) || '';
      const stockCell = rest.find((x) => /\(\s*-?\d+\s*\)/.test(x)) || '';
      const img = tr.querySelector('img');
      const link = tr.querySelector('a[href*="product_no="]');
      if (!name && !priceCell) return;
      variants.push({
        name,
        price_text: priceCell,
        stock_text: stockCell,
        image: img ? (img.getAttribute('src') || img.getAttribute('data-src')) : null,
        href: link ? link.getAttribute('href') : null,
        sold_out: /품절|판매\s*중단|미판매/.test(raw(tr)),
      });
    });
  });

  /* --- images --- */
  const images = [...document.querySelectorAll('img')]
    .map((e) => e.getAttribute('src') || e.getAttribute('data-src'))
    .filter((s) => s && /\/web\/product\//.test(s));
  const uniq = [...new Set(images)];
  const extraImages = uniq.filter((s) => /\/extra\//.test(s));
  const mainImages = uniq.filter((s) => !/\/extra\//.test(s));

  /* --- sold-out / discontinued detection ---
   * The skin ships TWO badges:
   *   <img class="icon_img" alt="품절">              -> the REAL badge (JS toggles it)
   *   <img class="icon_img soldout_{$productNo}">    -> server-side template leftover
   *                                                     (class can never match a real id,
   *                                                      always `display:none`)
   * We therefore select the badge by its `alt` text and use the COMPUTED visibility.
   */
  const bodyText = document.body.innerText || '';
  const soldOutIcon = [...document.querySelectorAll('img[alt="품절"], img.soldout, .icon_img.soldout, [class*=soldout i]')]
    .map((e) => ({
      html: e.outerHTML.slice(0, 200),
      alt: e.getAttribute('alt'),
      class: e.className,
      visible: !!e.offsetParent,
      computed_display: window.getComputedStyle(e).display,
      computed_visibility: window.getComputedStyle(e).visibility,
      is_template_leftover: /\{\$/.test(e.className || ''),
    }));
  const keywordHits = [];
  ['품절', '판매중지', '판매 중단', 'Sold Out', 'sold out', 'SOLD OUT', '접수판매', '입고문의', '재고없음'].forEach((k) => {
    const i = bodyText.indexOf(k);
    if (i >= 0) keywordHits.push({ keyword: k, context: bodyText.slice(Math.max(0, i - 80), i + 80).replace(/\s+/g, ' ').trim() });
  });
  // The buy box swaps the order button for a "SOLD OUT" notice when stock is 0.
  const soldOutInBuyBox = /SOLD\s*OUT/i.test((document.querySelector('.buy-box, .buy-scroll-box') || {}).textContent || '');

  /* --- the visible product title --- */
  const titleEl = document.querySelector('.xans_product_title, #productTitle, .product_view_title, h1.item_title, .title_area');
  const titleFallback = [...document.querySelectorAll('h1,h2,h3')]
    .map((e) => t(e))
    .filter((x) => x && x !== '상품상세 정보')[0] || null;

  /* --- rendered price nodes (what the shopper sees) --- */
  const priceNodes = [...document.querySelectorAll('#span_product_price_text, .quantity_price, #totalPrice, .delv_price_B, .mileage_price')]
    .map((e) => ({ id: e.id || null, cls: e.className || null, visible_text: t(e), dom_text: raw(e) }));

  /* --- template placeholder leakage visible on the page --- */
  const placeholderLeaks = [...document.querySelectorAll('*')]
    .filter((e) => e.children.length === 0 && /\{\$[a-zA-Z0-9_]+\}/.test(e.textContent || ''))
    .map((e) => ({ tag: e.tagName, id: e.id, cls: e.className, text: raw(e), visible: !!e.offsetParent }))
    .slice(0, 40);

  /* --- domain / language switcher (which domains point at the same mall) --- */
  const languageSwitch = [...document.querySelectorAll('select')]
    .map((s) => ({ id: s.id || null, options: [...s.options].map((o) => o.value) }))
    .find((s) => s.options.some((v) => /samamusic|samastore|cafe24/.test(v))) || null;

  /* --- breadcrumb --- */
  const breadcrumb = [];
  [...document.querySelectorAll('.xans-product-headcategory, [class*=breadcrumb i], [class*=headcategory i]')].forEach((e) => {
    const parts = [...e.querySelectorAll('a, span, li')]
      .map((x) => raw(x))
      .filter((x) => x && x !== '>' && x !== 'HOME');
    if (parts.length) breadcrumb.push(...parts);
  });

  /* --- canonical / category hint from the canonical URL ---
   * CAFE24 canonical shape: https://samastore.co.kr/category/<category-slug>/<cate_no>/
   * or for products: https://samastore.co.kr/product/<slug>/<product_no>/
   */
  const canonicalHref = document.querySelector('link[rel=canonical]')?.href || '';
  const canonicalCategory = (canonicalHref.match(/\/category\/([^/]+)\/(\d+)\/?$/) || []);

  return {
    page_title: document.title,
    canonical: canonicalHref || null,
    canonical_category_no: canonicalCategory[2] || null,
    canonical_category_slug: canonicalCategory[1] ? decodeURIComponent(canonicalCategory[1]) : null,
    og: [...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')]
      .map((e) => ({ key: e.getAttribute('property') || e.getAttribute('name'), value: e.getAttribute('content') })),
    jsonld,
    spec_rows: specRows,
    spec_map: specMap,
    option_rows: optionRows,
    selects,
    variants,
    images_main: mainImages,
    images_extra: extraImages,
    sold_out_icons: soldOutIcon,
    sold_out_keywords: keywordHits,
    sold_out_in_buy_box: soldOutInBuyBox,
    product_title: t(titleEl) || titleFallback,
    price_nodes: priceNodes,
    breadcrumb,
    placeholder_leaks: placeholderLeaks,
    language_switch: languageSwitch,
    body_price_strings: (bodyText.match(/[\d,]{3,10}\s*원/g) || []).slice(0, 60),
  };
}

/** Runs in page context: current search result summary (total count, cards). */
function extractSearchSummary() {
  const t = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const candidates = [...document.querySelectorAll('*')]
    .filter((e) => e.children.length === 0 && /(검색결과|검색 결과|총\s*\d+\s*건|총\s*\d+\s*개)/.test(t(e)))
    .map((e) => t(e)).filter(Boolean);
  return {
    summary_lines: [...new Set(candidates)].slice(0, 10),
    card_count: document.querySelectorAll('li[id^=anchorBoxId_]').length,
    current_url: location.href,
    search_input_value: document.querySelector('input[name=query], #search, input[type=search], .search input')?.value || null,
  };
}

module.exports = {
  parseKrw,
  parseDataPrice,
  parseOptionLabel,
  isPriceInquiry,
  classifyPrice,
  INQUIRY_WORD,
  CLOSED_WORD,
  SOLD_OUT_WORD,
  KWON,
  extractListItems,
  extractMenus,
  extractDetail,
  extractSearchSummary,
};
