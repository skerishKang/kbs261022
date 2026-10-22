'use strict';
/**
 * Curates the working screenshot folder into a compact, reviewable set that is
 * committed to the repository (reports/screenshots/).
 *
 * Selection rules:
 *   - keep every domain comparison shot (proves the 5 URLs were really opened)
 *   - keep one shot per LNB category (proves the category menu was walked)
 *   - keep the search result shot
 *   - keep detail shots for the SAMPLE products only
 *   - keep option shots for products that have their OWN option group
 *   - keep the sold-out evidence shots
 * Everything else (probe shots, cross-sell option shots) stays out of the repo.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(__dirname, 'screenshots');
const DST = path.join(ROOT, 'reports', 'screenshots');

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });

const products = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'evidence', 'products-raw.json'), 'utf8'));
const sampleIds = new Set(products.map((p) => p.source_product_id));
const ownOptionIds = new Set(products.filter((p) => p.option_group_count > 0).map((p) => p.source_product_id));

const files = fs.existsSync(SRC) ? fs.readdirSync(SRC).filter((f) => f.endsWith('.png')) : [];
const kept = [];
const dropped = [];

for (const f of files) {
  let keep = false;
  let reason = '';
  if (/^domain-/.test(f)) { keep = true; reason = 'domain comparison'; }
  else if (/^category-\d+\.png$/.test(f)) { keep = true; reason = 'category menu walk'; }
  else if (/^category-after-click\.png$/.test(f)) { keep = true; reason = 'category click interaction'; }
  else if (/^list-cate-42\.png$/.test(f)) { keep = true; reason = 'category list page'; }
  else if (/^search-/.test(f)) { keep = true; reason = 'search result'; }
  else if (/^detail-(\d+)\.png$/.test(f)) {
    const id = f.match(/^detail-(\d+)\.png$/)[1];
    if (sampleIds.has(id)) { keep = true; reason = 'sample product detail'; }
  } else if (/^option-(\d+)-product_option_id/.test(f)) {
    const id = f.match(/^option-(\d+)-/)[1];
    if (ownOptionIds.has(id)) { keep = true; reason = 'own option group'; }
  } else if (/^soldout-detail-(\d+)\.png$/.test(f)) { keep = true; reason = 'sold-out evidence'; }
  else if (/^soldout-list-cate-/.test(f)) { keep = true; reason = 'sold-out list evidence'; }

  if (keep) {
    // compress straight to JPEG (max width 1280, q78) so the evidence stays small
    const out = path.join(DST, f.replace(/\.png$/, '.jpg'));
    sharp(path.join(SRC, f))
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(out)
      .then(() => { kept.push({ file: path.basename(out), reason }); })
      .catch((e) => { dropped.push(`${f} (compress failed: ${e.message})`); });
  } else {
    dropped.push(f);
  }
}

setTimeout(() => {
  const files = fs.readdirSync(DST);
  const bytes = files.reduce((a, f) => a + fs.statSync(path.join(DST, f)).size, 0);
  fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'screenshot-manifest.json'), JSON.stringify({
    kept_count: files.length,
    dropped_count: dropped.length,
    kept,
    dropped,
  }, null, 2), 'utf8');
  console.log(`kept ${files.length} screenshots (${(bytes / 1024 / 1024).toFixed(2)} MB), dropped ${dropped.length}`);
}, 2000);
