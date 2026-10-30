// CGI <-> ecount ERP linkage reconciliation over the three committed datasets.
//
// Why a separate module: the existing product-mapping.mjs joins the *prep*
// files for the whole 4,575 catalogue, but the ERP linkage question asked by
// #20/#101 is narrower and sharper — it is about the 1,000 products that are
// actually live on Naver, and about what may and may not be transmitted to the
// ERP for those rows. That distinction does not exist anywhere in the code yet:
//   ncom_registration_ledger.json   1,000 live originProductNo
//   data/full_catalog               4,575 CGI master (the 정본)
//   ERP item master                 964 items — NOT in this repository at all
//
// The third input is the whole problem. The 964-item ERP read of 2026-10-23
// survives only as aggregates in reports/data/erp/erp_readonly_comparison.json:
// 0 exact code matches, 1 exact name pair, 25 exact model pairs, 62 candidate
// pairs. Item-level ERP rows were deliberately kept out of the repo. So this
// module refuses to invent ERP rows and instead classifies each live Naver
// product into what is actually knowable today:
//
//   confirmed        an ERP item code established by exact code or barcode match
//   probable         name/model agreement only — an indicator, never a mapping
//   needs_new_item   no ERP counterpart found: must be registered before any slip
//   undetermined     cannot be judged without the ERP item master
//
// "undetermined" is the honest answer for most rows and is reported as such
// rather than being collapsed into "needs_new_item". Registering a duplicate ERP
// item for a product that already exists at 000123 is the expensive mistake this
// module exists to prevent.

import { erpCodeFor } from './erp.mjs';
import { normalizeCgiId } from './product-mapping.mjs';

/** Canonical CGI id from the many shapes the ledger and master both use. */
export function canonicalCgiId(value) {
  let id = normalizeCgiId(String(value || '').trim());
  // The ledger mixes "samamusic:2098" and "samamusic.co.kr:1769" for one site.
  id = id.replace(/^samamusic\.co\.kr:/, 'samamusic:');
  id = id.replace(/^samasound\.co\.kr:/, 'samasound:');
  id = id.replace(/^yamaha\.co\.kr:/, 'yamaha:');
  id = id.replace(/^samastore\.co\.kr:/, 'samastore:');
  return id;
}

/** ERP 품목코드 proposed for a CGI id — SS-/SM-/YM-/SA- + source product number. */
export function proposedProdCd(cgiId) {
  return erpCodeFor(canonicalCgiId(cgiId));
}

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * Index the CGI master by canonical id. product_db_compact.csv carries
 * source_site + source_product_id separately, and its master_product_key column
 * is malformed ("|SQ5") so it cannot be used as a key.
 */
export function indexMaster(masterRows = []) {
  const byId = new Map();
  const keyDefects = [];
  for (const row of masterRows) {
    const site = String(row.source_site || '').trim();
    const pid = String(row.source_product_id || '').trim();
    if (!site || !pid) continue;
    const id = canonicalCgiId(`${site}:${pid}`);
    byId.set(id, row);
    const key = String(row.master_product_key || '');
    if (key.startsWith('|')) keyDefects.push(key);
  }
  return { byId, keyDefects };
}

/**
 * Classify one live Naver product against whatever ERP evidence exists.
 * `erpCodes` / `erpBarcodes` are the only sources of a *confirmed* match; when
 * both are empty the result is undetermined unless the caller asserts the ERP
 * read was complete.
 */
export function classifyLink({
  ledgerRow,
  masterRow = null,
  erpCodes = new Set(),
  erpBarcodes = new Map(),
  erpReadComplete = false,
} = {}) {
  const cgiId = canonicalCgiId(ledgerRow?.cgiId);
  const proposed = proposedProdCd(cgiId);
  const barcode = String(masterRow?.barcode || masterRow?.item_code || '').trim();
  const reasons = [];

  if (erpCodes.has(proposed)) {
    return { cgiId, proposedProdCd: proposed, status: 'confirmed', basis: 'erp_code_exact', erpProdCd: proposed, reasons };
  }
  if (barcode && erpBarcodes.has(barcode)) {
    return { cgiId, proposedProdCd: proposed, status: 'confirmed', basis: 'erp_barcode_exact', erpProdCd: erpBarcodes.get(barcode), reasons };
  }
  if (!erpReadComplete) {
    reasons.push('erp_item_master_not_in_repo');
    if (!masterRow) reasons.push('not_in_cgi_master');
    return { cgiId, proposedProdCd: proposed, status: 'undetermined', basis: null, erpProdCd: null, reasons };
  }
  // ERP read asserted complete and no code/barcode hit: this is genuinely new.
  if (!masterRow) reasons.push('not_in_cgi_master');
  reasons.push('no_erp_code_or_barcode_match');
  return { cgiId, proposedProdCd: proposed, status: 'needs_new_item', basis: null, erpProdCd: null, reasons };
}

/**
 * Cross-tabulate the live ledger against the CGI master and report both
 * directions: live products missing from the master, and master products never
 * registered on Naver.
 */
export function reconcileLive({ ledgerRows = [], masterRows = [], otherLedgerRows = [] } = {}) {
  const live = ledgerRows.filter((r) => r.kind === 'cgi-ncom-registration');
  const { byId: masterById, keyDefects } = indexMaster(masterRows);

  const seen = new Map();
  const duplicates = [];
  for (const row of live) {
    const id = canonicalCgiId(row.cgiId);
    if (seen.has(id)) duplicates.push({ cgiId: id, originProductNo: [seen.get(id).originProductNo, row.originProductNo] });
    else seen.set(id, row);
  }

  const originNos = new Map();
  const originDuplicates = [];
  for (const row of live) {
    const no = String(row.originProductNo ?? '');
    if (!no) continue;
    if (originNos.has(no)) originDuplicates.push({ originProductNo: no, cgiIds: [originNos.get(no), canonicalCgiId(row.cgiId)] });
    else originNos.set(no, canonicalCgiId(row.cgiId));
  }

  const inMaster = [];
  const notInMaster = [];
  for (const row of live) {
    const id = canonicalCgiId(row.cgiId);
    if (masterById.has(id)) inMaster.push({ cgiId: id, row, masterRow: masterById.get(id) });
    else notInMaster.push({ cgiId: id, row });
  }

  const liveIdSet = new Set([...seen.keys()]);
  const unregistered = [];
  for (const id of masterById.keys()) if (!liveIdSet.has(id)) unregistered.push(id);

  const otherIds = new Set(otherLedgerRows.map((r) => canonicalCgiId(r.cgiId)));
  const stockSyncOnly = [...liveIdSet].filter((id) => otherIds.has(id));

  return {
    liveCount: live.length,
    uniqueLiveCgiIds: seen.size,
    uniqueOriginProductNos: originNos.size,
    duplicateCgiIds: duplicates,
    duplicateOriginProductNos: originDuplicates,
    inMasterCount: inMaster.length,
    notInMasterCount: notInMaster.length,
    notInMaster: notInMaster.map((x) => x.cgiId),
    masterRegisteredRows: inMaster,
    masterCount: masterById.size,
    unregisteredOnNaverCount: unregistered.length,
    unregisteredOnNaver: unregistered,
    alsoInStockSyncLedger: stockSyncOnly.length,
    masterKeyDefects: keyDefects.length,
    masterKeyDefectSample: keyDefects.slice(0, 5),
  };
}

/**
 * Deterministic distribution of a set of master rows, for the "why these 1,000"
 * question. Only fields the source actually carries are counted; a blank stays a
 * blank bucket instead of being dropped, because a missing brand is itself
 * evidence about how the batch was chosen.
 */
export function distributions(rows = []) {
  const bucket = (field, transform = (v) => v) => {
    const out = {};
    for (const row of rows) {
      const raw = row[field];
      const key = blank(raw) ? '(blank)' : transform(String(raw).trim());
      out[key] = (out[key] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
  };

  const priceBand = (value) => {
    const n = Number(String(value).replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return '(no_public_price)';
    if (n < 50000) return 'a_under_50k';
    if (n < 100000) return 'b_50k_100k';
    if (n < 300000) return 'c_100k_300k';
    if (n < 1000000) return 'd_300k_1m';
    if (n < 5000000) return 'e_1m_5m';
    return 'f_over_5m';
  };

  return {
    bySite: bucket('source_site'),
    byBrand: bucket('brand'),
    byCategory: bucket('category_name'),
    byPriceState: bucket('public_price_state'),
    byPriceBand: bucket('public_price', priceBand),
    bySalesStatus: bucket('sales_status'),
    byManufacturer: bucket('manufacturer'),
    byOptionCount: bucket('option_value_count'),
  };
}

/** Top-N entries of a distribution, for report tables. */
export function topN(dist, n = 10) {
  return Object.entries(dist).slice(0, n);
}

/**
 * Full linkage plan for the live products. Returns one record per live product
 * with what may be transmitted, what must be registered first, and what cannot
 * be decided. Nothing here writes anything.
 */
export function buildLinkagePlan({ ledgerRows = [], masterRows = [], erpCodes = new Set(), erpBarcodes = new Map(), erpReadComplete = false } = {}) {
  const { byId: masterById } = indexMaster(masterRows);
  const live = ledgerRows.filter((r) => r.kind === 'cgi-ncom-registration');
  const records = [];
  for (const row of live) {
    const id = canonicalCgiId(row.cgiId);
    const masterRow = masterById.get(id) || null;
    const link = classifyLink({ ledgerRow: row, masterRow, erpCodes, erpBarcodes, erpReadComplete });
    records.push({
      ...link,
      originProductNo: row.originProductNo ?? null,
      smartstoreChannelProductNo: row.smartstoreChannelProductNo ?? null,
      sellerManagementCode: row.sellerManagementCode ?? null,
      displayStatus: row.displayStatus ?? null,
      registeredAt: row.registered_at ?? null,
      productName: masterRow ? String(masterRow.product_name || '').trim() : null,
      brand: masterRow ? String(masterRow.brand || '').trim() : null,
      model: masterRow ? String(masterRow.model || '').trim() : null,
      categoryName: masterRow ? String(masterRow.category_name || '').trim() : null,
      publicPrice: masterRow ? String(masterRow.public_price || '').trim() : null,
      publicPriceState: masterRow ? String(masterRow.public_price_state || '').trim() : null,
      availability: masterRow ? String(masterRow.availability || '').trim() : null,
    });
  }
  const summary = {};
  for (const r of records) summary[r.status] = (summary[r.status] || 0) + 1;
  return {
    records,
    summary: { total: records.length, ...summary },
    erpReadComplete,
    note: 'plan only — no ERP document was created and no existing product was modified',
  };
}