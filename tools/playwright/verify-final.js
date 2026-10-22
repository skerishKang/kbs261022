'use strict';
/**
 * Final verification pass:
 *  A. IMAGE CHECK   - do the extracted representative/additional image URLs actually load?
 *  B. DOMAIN CHECK - do samamusic.co.kr and samastore.co.kr serve the SAME product
 *                    for the same product id (canonical, price, brand, images)?
 *  C. HTTP vs DOM   - does the raw SSR HTML of a product page carry the same
 *                    spec values the browser renders after hydration?
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { launch, sleep, withRetry, logEvidence, shotPath, ROOT } = require('./lib/browser');

function head(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0.0.0' } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, type: res.headers['content-type'], length: res.headers['content-length'] });
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e.message) }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

(async () => {
  const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'evidence', 'products-raw.json'), 'utf8'));
  const report = { image_checks: [], domain_checks: [], ssr_vs_dom: [] };

  /* ---------------- A. image reachability ---------------- */
  const urls = [];
  rows.forEach((r) => {
    if (r.main_image) urls.push({ id: r.source_product_id, kind: 'main', url: r.main_image });
    (r.additional_images || '').split(' | ').filter(Boolean)
      .slice(0, 2).forEach((u) => urls.push({ id: r.source_product_id, kind: 'extra', url: u }));
  });
  for (const u of urls) {
    const abs = u.url.startsWith('//') ? `https:${u.url}` : u.url;
    const res = await head(abs);
    report.image_checks.push({ ...u, absolute_url: abs, ...res });
    await new Promise((r) => setTimeout(r, 120));
  }

  /* ---------------- B. same product across the two domains ---------------- */
  const { browser, context } = await launch({ headless: process.env.SAMASTORE_HEADLESS === '1' });
  const page = await context.newPage();
  const SAMPLE = ['4167', '4558', '5685', '3184', '1710'];
  for (const pno of SAMPLE) {
    const rec = { product_no: pno };
    for (const host of ['www.samamusic.co.kr', 'samastore.co.kr']) {
      const url = `https://${host}/product/detail.html?product_no=${pno}&cate_no=42&display_group=1`;
      try {
        await withRetry(async () => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          // wait until the 기본 정보 table actually exists (the skin fills it late)
          await page.waitForFunction(
            () => [...document.querySelectorAll('table')].some((t) => (t.querySelector('caption')?.textContent || '').includes('기본 정보')),
            { timeout: 30000 },
          ).catch(() => {});
          await sleep(1200);
        }, { label: `domain:${host}:${pno}`, retries: 3 });
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
          const imgs = [...new Set([...document.querySelectorAll('img')]
            .map((e) => e.getAttribute('src') || e.getAttribute('data-src'))
            .filter((s) => s && s.includes('/web/product/')))];
          // simple, deterministic hash inside the page (no crypto API dependency)
          const hash = (s) => {
            let h = 0;
            for (let i = 0; i < s.length; i += 1) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
            return (h >>> 0).toString(16);
          };
          // the DOM ORDER of images is not stable across hosts (lazy load + cross-sell
          // block ordering), so compare the SET, not the sequence.
          // the two hosts rewrite the image host prefix (www.samamusic.co.kr vs
          // samastore.co.kr) while the file path is byte-identical -> normalise it.
          const normaliseImg = (s) => s.replace(/^\/\/(www\.)?samamusic\.co\.kr/, '//HOST').replace(/^\/\/samastore\.co\.kr/, '//HOST');
          const sortedImgs = [...imgs].map(normaliseImg).sort();
          const jl = [...document.querySelectorAll('script[type="application/ld+json"]')]
            .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } }).filter(Boolean);
          const p = jl.find((j) => j && (j['@type'] === 'Product' || j['@type'] === 'ProductGroup'));
          return {
            final_url: location.href,
            canonical: document.querySelector('link[rel=canonical]')?.href || null,
            og_url: document.querySelector('meta[property="og:url"]')?.content || null,
            spec,
            image_count: imgs.length,
            image_hash: hash(sortedImgs.join('|')),
            image_hash_ordered: hash(imgs.join('|')),
            images: sortedImgs,
            jsonld_sku: p ? (p.sku || p.productGroupID || '') : '',
            jsonld_price: p && p.offers ? p.offers.price : '',
            jsonld_availability: p && p.offers ? p.offers.availability : '',
          };
        });
        rec[host] = d;
      } catch (err) {
        rec[host] = { error: String(err.message || err) };
        logEvidence('domain-checks.jsonl', { step: 'domainCheck', host, product_no: pno, error: rec[host].error });
      }
      await sleep(800);
    }
    const a = rec['www.samamusic.co.kr'];
    const b = rec['samastore.co.kr'];
    rec.same_canonical = (a.canonical || null) === (b.canonical || null) && !!a.canonical;
    rec.same_price = !!(a.spec && b.spec) && a.spec['판매가'] === b.spec['판매가'];
    rec.same_images = a.image_hash === b.image_hash && a.image_count > 0;
    rec.same_sku = a.jsonld_sku === b.jsonld_sku && !!a.jsonld_sku;
    rec.identical = rec.same_canonical && rec.same_price && rec.same_images && rec.same_sku;
    report.domain_checks.push(rec);
    await sleep(400);
  }

  /* ---------------- C. SSR HTML vs hydrated DOM ---------------- */
  const { browser: b2 } = { browser };
  const httpsGet = (url) => new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0.0.0' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });

  for (const pno of ['4167', '4558', '3184']) {
    const url = `https://www.samamusic.co.kr/product/detail.html?product_no=${pno}&cate_no=42&display_group=1`;
    const html = await httpsGet(url);
    // pull the 기본 정보 rows straight out of the raw HTML (no JS)
    const ssr = [];
    const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/g;
    let m;
    while ((m = tableRe.exec(html)) !== null) {
      if (!m[1].includes('기본 정보')) continue;
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let rm;
      while ((rm = rowRe.exec(m[1])) !== null) {
        const th = rm[1].match(/<th[^>]*>([\s\S]*?)<\/th>/);
        const td = rm[1].match(/<td[^>]*>([\s\S]*?)<\/td>/);
        if (!th || !td) continue;
        const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        ssr.push({ label: strip(th[1]), value: strip(td[1]) });
      }
    }
    // the DOM value comes from the row we already collected
    const row = rows.find((r) => r.source_product_id === pno);
    const domSpec = {};
    (row && row.__spec_rows) || [];
    report.ssr_vs_dom.push({
      product_no: pno,
      ssr_rows: ssr,
      ssr_price: (ssr.find((x) => x.label === '판매가') || {}).value || null,
      ssr_brand: (ssr.find((x) => x.label === '브랜드') || {}).value || null,
      dom_price: row ? row.published_price_text : null,
      dom_brand: row ? row.brand : null,
      ssr_has_jsonld: /application\/ld\+json/.test(html),
      ssr_html_bytes: Buffer.byteLength(html, 'utf8'),
    });
  }

  fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'final-verification.json'), JSON.stringify(report, null, 2), 'utf8');

  const imgOk = report.image_checks.filter((i) => i.status === 200).length;
  const domSame = report.domain_checks.filter((d) => d.identical).length;
  console.log(`images_ok=${imgOk}/${report.image_checks.length} domain_identical=${domSame}/${report.domain_checks.length}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
