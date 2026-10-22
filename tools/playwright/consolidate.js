'use strict';
/**
 * Consolidates every evidence artifact into one report-friendly JSON so the
 * numbers quoted in reports/site-analysis-playwright.md can be regenerated.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const E = path.join(ROOT, 'reports', 'evidence');

const read = (f) => {
  const p = path.join(E, f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

const domains = read('domains.json');
const run = read('run-summary.json');
const parity = read('api-browser-parity.json');
const final = read('final-verification.json');
const catPages = read('category-pages.json');
const products = read('products-raw.json');

const shots = fs.existsSync(path.join(__dirname, 'screenshots'))
  ? fs.readdirSync(path.join(__dirname, 'screenshots')).filter((f) => f.endsWith('.png'))
  : [];

const csvPath = path.join(ROOT, 'reports', 'data', 'samastore-playwright-sample.csv');
const csvRows = fs.existsSync(csvPath)
  ? fs.readFileSync(csvPath, 'utf8').replace(/^\ufeff/, '').trim().split('\n').length - 1
  : 0;

const out = {
  generated_at: new Date().toISOString(),
  domains,
  category_menu: run && run.category ? {
    lnb_link_count: (run.category.menus || []).reduce((a, m) => a + m.link_count, 0),
    links: (run.category.menus || []).flatMap((m) => m.links || []).map((l) => ({ text: l.text, href: l.href })),
    interaction: run.category.interaction,
  } : null,
  category_pages: (catPages || []).map((c) => ({
    category_text: c.category_text, category_href: c.category_href, item_count: c.item_count,
    placeholder_defect_ids: c.items.filter((i) => i.placeholder_in_rendered_card).map((i) => i.product_no),
    sold_out_badge_ids: c.items.filter((i) => i.sold_out_visible).map((i) => i.product_no),
  })),
  search: run && run.search ? {
    term: run.search.term,
    submitted: run.search.submitted,
    after_url: run.search.after_url,
    result_cards: run.search.summary ? run.search.summary.card_count : null,
    // the storefront's search UI embeds the whole DalueSearch library as inline text,
    // so only keep the short human-readable summary lines
    summary_lines: run.search.summary
      ? (run.search.summary.summary_lines || []).map((s) => String(s).slice(0, 120)).filter((s) => s.length < 120)
      : null,
    screenshot: run.search.screenshot,
  } : null,
  api: parity ? parity.api : null,
  sitemap: parity ? parity.sitemap : null,
  set_operations: parity ? parity.set_operations : null,
  parity_summary: parity ? parity.parity_summary : null,
  api_only_reachability: parity ? parity.browser_checks : null,
  image_checks: final ? {
    total: final.image_checks.length,
    http_200: final.image_checks.filter((i) => i.status === 200).length,
    failures: final.image_checks.filter((i) => i.status !== 200),
  } : null,
  domain_product_identity: final ? final.domain_checks.map((d) => ({
    product_no: d.product_no,
    identical: d.identical,
    canonical_same: d.same_canonical,
    price_same: d.same_price,
    images_same: d.same_images,
    sku_same: d.same_sku,
    canonical: d['www.samamusic.co.kr'].canonical,
    sku: d['www.samamusic.co.kr'].jsonld_sku,
  })) : null,
  ssr_vs_dom: final ? final.ssr_vs_dom : null,
  sample: {
    csv_rows: csvRows,
    products: (products || []).map((p) => ({
      product_no: p.source_product_id,
      name: p.product_name,
      brand: p.brand,
      model: p.model_name,
      published_price: p.published_price,
      published_price_text: p.published_price_text,
      published_price_kind: p.published_price_kind,
      retail_price: p.retail_price,
      stock_status: p.stock_status,
      own_option_groups: p.option_group_count,
      cross_sell_option_groups: p.cross_sell_group_count,
      option_items: p.option_items,
      image_count: p.image_count,
      jsonld_type: p.jsonld_type,
      sample_reason: p.sample_reason,
      sample_source_category: p.sample_source_category,
    })),
  },
  screenshots: shots,
};

fs.writeFileSync(path.join(E, 'consolidated.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(`consolidated: ${out.screenshots.length} screenshots, ${out.sample.csv_rows} csv rows, ${out.parity_summary ? out.parity_summary.sampled : 0} parity rows`);
