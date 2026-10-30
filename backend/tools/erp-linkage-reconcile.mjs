// Reconciles the live Naver registration ledger against the CGI product master
// and produces the ERP linkage plan + distribution analysis as committed JSON.
//
// Read-only. Touches no product, no ERP document, no ledger row.
//
//   node tools/erp/erp-linkage-reconcile.mjs
//
// Outputs (all under reports/data/erp/):
//   linkage_reconciliation_<date>.json   joint coverage, duplicates, gaps
//   linkage_plan_<date>.json             per-product ERP transmit decision
//   naver_selection_analysis_<date>.json distribution of the live 1,000

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../../backend/lib/product-mapping.mjs';
import {
  reconcileLive,
  buildLinkagePlan,
  distributions,
  topN,
  canonicalCgiId,
} from '../../backend/lib/erp-linkage-plan.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '../..'); // backend/tools -> repo root
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const LEDGER = 'reports/data/registration/ncom_registration_ledger.json';
const MASTER = 'data/full_catalog/product_db_compact.csv';
const COMPARISON = 'reports/data/erp/erp_readonly_comparison.json';

const date = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outDir = path.join(ROOT, 'reports/data/erp');
fs.mkdirSync(outDir, { recursive: true });

const ledgerAll = json(LEDGER);
const masterRows = parseCsv(read(MASTER));
const comparison = json(COMPARISON);

const liveRows = ledgerAll.filter((r) => r.kind === 'cgi-ncom-registration');
const otherRows = ledgerAll.filter((r) => r.kind !== 'cgi-ncom-registration');

// No ERP item master exists in this repository, so no exact code/barcode match
// can be established here. Empty sets are passed deliberately: the plan then
// reports "undetermined" instead of pretending a new item is required.
const erpCodes = new Set();
const erpBarcodes = new Map();
const erpReadComplete = false;

const recon = reconcileLive({ ledgerRows: ledgerAll, masterRows, otherLedgerRows: otherRows });
const plan = buildLinkagePlan({ ledgerRows: ledgerAll, masterRows, erpCodes, erpBarcodes, erpReadComplete });

// Distributions over the LIVE products, joined to master fields.
const liveMasterRows = recon.masterRegisteredRows.map((x) => x.masterRow);
const liveDist = distributions(liveMasterRows);
const catalogDist = distributions(masterRows);

// Batch attribution: which artifact introduced each ledger row.
//
// Two shapes exist. The bulk register_*_batch files carry results[].cgiId. The
// earliest (pilot) registrations predate that convention and survive only as
// pilot_register_request*.json rows, so both are indexed — otherwise the first
// handful of products read as "unattributed" when their evidence is committed.
const bulkDir = path.join(ROOT, 'reports/data/registration/bulk');
const liveDir = path.join(ROOT, 'reports/data/registration/live');
const batchFiles = fs.existsSync(bulkDir)
  ? fs.readdirSync(bulkDir).filter((f) => /^register_.*\.json$/.test(f)).sort().map((f) => path.join(bulkDir, f))
  : [];
const pilotFiles = fs.existsSync(liveDir)
  ? fs.readdirSync(liveDir).filter((f) => /^pilot_register_request.*\.json$/.test(f)).sort().map((f) => path.join(liveDir, f))
  : [];
const batchByCgi = new Map();
const batchMeta = [];
const indexBatch = (absPath, rowsOf, metaOf) => {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(absPath, 'utf8')); } catch { return; }
  const rows = rowsOf(doc);
  const rel = path.relative(ROOT, absPath);
  batchMeta.push({ file: rel, ...metaOf(doc), resultCount: rows.length });
  for (const r of rows) {
    const id = canonicalCgiId(r.cgiId || r.sourceId || r.cgi_id);
    if (!id) continue;
    if (!batchByCgi.has(id)) batchByCgi.set(id, []);
    batchByCgi.get(id).push(rel);
  }
};
for (const f of batchFiles) {
  indexBatch(f, (d) => (Array.isArray(d.results) ? d.results : []), (d) => ({
    scope: typeof d.scope === 'string' ? d.scope : null,
    ranAt: d.ran_at || null,
  }));
}
for (const f of pilotFiles) {
  indexBatch(f, (d) => (Array.isArray(d.rows) ? d.rows : []), (d) => ({
    scope: 'pilot — first live registrations (predates bulk register_* convention)',
    ranAt: d.built_at || null,
  }));
}

const attribution = { attributed: 0, unattributed: 0, multiBatch: 0, byBatch: {} };
const unattributedSamples = [];
for (const row of liveRows) {
  const id = canonicalCgiId(row.cgiId);
  const files = batchByCgi.get(id);
  if (files && files.length) {
    attribution.attributed += 1;
    if (files.length > 1) attribution.multiBatch += 1;
    for (const f of files) attribution.byBatch[f] = (attribution.byBatch[f] || 0) + 1;
  } else {
    attribution.unattributed += 1;
    if (unattributedSamples.length < 10) unattributedSamples.push(id);
  }
}

// Price/inventory coverage of the live set — the fields an ERP slip depends on.
const liveCoverage = {
  // The master's price state vocabulary is public / inquiry_price /
  // sold_out_sale_completed / missing — not "public_price".
  withPublicPrice: liveMasterRows.filter((r) => String(r.public_price_state || '') === 'public').length,
  priceInquiry: liveMasterRows.filter((r) => String(r.public_price_state || '') === 'inquiry_price').length,
  priceOtherState: liveMasterRows.filter((r) => !['public', 'inquiry_price'].includes(String(r.public_price_state || ''))).length,
  withModel: liveMasterRows.filter((r) => String(r.model || '').trim() !== '').length,
  withBrand: liveMasterRows.filter((r) => String(r.brand || '').trim() !== '').length,
  stockManaged: liveMasterRows.filter((r) => /use_stock"\s*:\s*true/.test(String(r.availability || ''))).length,
};

const reconciliation = {
  generated_at: new Date().toISOString(),
  date,
  sources: { ledger: LEDGER, master: MASTER, comparison: COMPARISON },
  live_ledger: {
    rows: liveRows.length,
    unique_cgi_ids: recon.uniqueLiveCgiIds,
    unique_origin_product_nos: recon.uniqueOriginProductNos,
    duplicate_cgi_ids: recon.duplicateCgiIds,
    duplicate_origin_product_nos: recon.duplicateOriginProductNos,
    display_status_on: liveRows.filter((r) => r.displayStatus === 'ON').length,
    also_present_in_stock_sync_ledger: recon.alsoInStockSyncLedger,
  },
  cgi_master: {
    rows: recon.masterCount,
    unregistered_on_naver: recon.unregisteredOnNaverCount,
    malformed_master_product_key: recon.masterKeyDefects,
    malformed_key_sample: recon.masterKeyDefectSample,
  },
  join: {
    live_in_master: recon.inMasterCount,
    live_not_in_master: recon.notInMasterCount,
    not_in_master_cgi_ids: recon.notInMaster,
    master_rows_live_in_master: recon.masterRegisteredRows.length,
  },
  erp: {
    item_master_in_repo: false,
    exact_code_matches: comparison.exact_code_matches,
    exact_name_pairs: comparison.name_exact_pairs,
    exact_model_pairs: comparison.model_exact_pairs,
    candidate_pairs: comparison.candidate_pairs,
    erp_items_total: comparison.erp_total_items,
    erp_read_complete: erpReadComplete,
    blocked_reason: 'ERP item-level master is not committed; the 964-item read exists only as aggregates in erp_readonly_comparison.json',
  },
  live_field_coverage: liveCoverage,
  batch_attribution: { ...attribution, unattributed_sample: unattributedSamples },
  batch_files: batchMeta,
  writes_performed: { naver_products_changed: 0, erp_documents_created: 0, ledger_rows_added: 0 },
};

const planDoc = {
  generated_at: new Date().toISOString(),
  ...plan,
  summary_detail: {
    confirmed: plan.summary.confirmed || 0,
    probable: plan.summary.probable || 0,
    needs_new_item: plan.summary.needs_new_item || 0,
    undetermined: plan.summary.undetermined || 0,
  },
};

const selectionAnalysis = {
  generated_at: new Date().toISOString(),
  subject: 'live Naver SmartStore registrations (1,000)',
  note: 'Distribution of the products actually registered. This is a description of what happened, not evidence that sales performance, margin, or strategic brand drove the selection.',
  live_distributions: {
    site: topN(liveDist.bySite, 10),
    brand: topN(liveDist.byBrand, 20),
    category: topN(liveDist.byCategory, 20),
    price_state: topN(liveDist.byPriceState, 10),
    price_band: topN(liveDist.byPriceBand, 10),
    sales_status: topN(liveDist.bySalesStatus, 10),
    option_count: topN(liveDist.byOptionCount, 10),
  },
  catalog_distributions: {
    site: topN(catalogDist.bySite, 10),
    brand: topN(catalogDist.byBrand, 20),
    category: topN(catalogDist.byCategory, 20),
    price_state: topN(catalogDist.byPriceState, 10),
    price_band: topN(catalogDist.byPriceBand, 10),
  },
  live_vs_catalog_site_share: (() => {
    const liveTotal = liveMasterRows.length || 1;
    const catTotal = masterRows.length || 1;
    const out = {};
    for (const site of ['samasound', 'samamusic', 'yamaha', 'samastore']) {
      out[site] = {
        live: liveMasterRows.filter((r) => r.source_site === site).length,
        live_share: Number((liveMasterRows.filter((r) => r.source_site === site).length / liveTotal).toFixed(4)),
        catalog: masterRows.filter((r) => r.source_site === site).length,
        catalog_share: Number((masterRows.filter((r) => r.source_site === site).length / catTotal).toFixed(4)),
      };
    }
    return out;
  })(),
  evidence_available: {
    margin: false,
    sales_volume: false,
    representative_product_flag: false,
    batch_selection_reason_text: true,
  },
};

const write = (name, obj) => {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return path.relative(ROOT, file);
};

const written = [
  write(`linkage_reconciliation_${date}.json`, reconciliation),
  write(`linkage_plan_${date}.json`, planDoc),
  write(`naver_selection_analysis_${date}.json`, selectionAnalysis),
];

console.log('=== LINKAGE RECONCILIATION ===');
console.log('live rows          :', liveRows.length, '(unique cgiId', recon.uniqueLiveCgiIds + ')');
console.log('live in master     :', recon.inMasterCount);
console.log('live NOT in master :', recon.notInMasterCount);
console.log('master rows        :', recon.masterCount, '(unregistered on Naver', recon.unregisteredOnNaverCount + ')');
console.log('duplicate cgiIds   :', recon.duplicateCgiIds.length, '| duplicate originProductNo:', recon.duplicateOriginProductNos.length);
console.log('');
console.log('=== ERP LINKAGE PLAN ===');
console.log(JSON.stringify(planDoc.summary_detail));
console.log('');
console.log('=== BATCH ATTRIBUTION ===');
console.log('attributed', attribution.attributed, '| unattributed', attribution.unattributed, '| multiBatch', attribution.multiBatch);
console.log('');
console.log('=== LIVE FIELD COVERAGE ===');
console.log(JSON.stringify(liveCoverage));
console.log('');
console.log('written:');
for (const f of written) console.log(' ', f);