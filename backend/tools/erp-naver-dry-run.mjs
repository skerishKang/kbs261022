#!/usr/bin/env node
// CGI -> ecount OAPI -> 네이버 커머스API dry run.
//
// Runs the real planning path end-to-end and prints what it MEASURED. It never
// transmits: the ERP/Naver clients are only built with mode=mock (loopback) or
// mode=disabled, and a live mode is refused here as well as inside the clients.
//
//   node tools/erp-naver-dry-run.mjs            # plan only, no sockets at all
//   node tools/erp-naver-dry-run.mjs --mock     # plan, then drive both mock transports
//   node tools/erp-naver-dry-run.mjs --rows 30  # how many catalogue rows to plan
//
// Test fixtures only: the order below is synthetic, non-identifiable data. No
// customer record from D1 is read, and nothing is written anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet, coverageOf, resolveErpProdCd, saleableRows } from '../lib/product-mapping.mjs';
import { planProductSync, planCustomerSync, planSlip, planInventoryRead, ecountDate, OAPI_FIELD_LIMITS } from '../lib/erp-plan.mjs';
import { createErpOapiClient, oapiModeFromEnv } from '../lib/erp-oapi.mjs';
import { buildRegisterBody, stockFromErpBalance, registerOrModify, ncomModeFromEnv, NCOM_LIMITS } from '../lib/ncommerce.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const useMock = argv.includes('--mock');
const maxRows = Number(flag('rows', 20));

const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const records = buildMappingSet({
  extendedRows: readCsv('data/erp_prep/erp_extended_mapping.csv'),
  uploadRows: readCsv('data/erp_prep/ecount_item_upload.csv'),
  smartstoreRows: readCsv('data/smartstore_prep/smartstore_registration_prep.csv'),
  erpMasterRows: [],
});
const coverage = coverageOf(records);

const SYNTHETIC_ORDER = {
  id: 'DRYRUN-ORD-0001',
  kind: 'purchase',
  status: 'paid',
  created_at: new Date().toISOString(),
  paid_at: new Date().toISOString(),
  erp_cust_cd: '',
  erp_wh_cd: '',
  customer_name: '합성고객',
  total_amount: 2410000,
};
const SYNTHETIC_ITEMS = [
  { product_id: 'samasound.co.kr:3836', product_name: 'SQ5+', qty: 1, unit_price: 1680000, option_label: '기본' },
  { product_id: 'samamusic.co.kr:2574', product_name: 'SPX-8K', qty: 2, unit_price: 365000 },
];

function tally(list, key) {
  const out = {};
  for (const item of list) {
    const k = key(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

const lines = [];
const say = (text) => { lines.push(text); };

say('== CGI -> ERP -> 네이버 dry run');
say(`mode: ERP=${oapiModeFromEnv(process.env)} NCOM=${ncomModeFromEnv(process.env)} transmitted=false`);
if (oapiModeFromEnv(process.env) === 'live' || ncomModeFromEnv(process.env) === 'live') {
  console.error('this entry point is dry-run only; unset ERP_MODE/NCOM_MODE=live and use the real worker path');
  process.exit(2);
}

say('');
say('-- catalogue (read from the committed mapping material)');
say(`rows=${coverage.total} joined_all_three=${coverage.fullyJoinedAllThree} price_public=${coverage.pricePublic} price_inquiry=${coverage.priceInquiry} barcode=${coverage.barCode} stock_numeric=${coverage.stockNumeric} naver_item_id=${coverage.naverItemId} erp_code_verified=${coverage.erpProdCdVerified} saleable=${saleableRows(records).length}`);
say(`prod_cd_source=${JSON.stringify(tally(records, (r) => r.erpProdCdSource))}`);
say(`resolve=${JSON.stringify(tally(records, (r) => resolveErpProdCd(r.cgiId, records).status))}`);

const sample = records.slice(0, maxRows);
const productPlan = planProductSync(sample.map((r) => ({
  productId: r.erpProdCdProposed,
  productName: r.prodDes,
  unit: r.unit,
  prodType: r.prodType,
  barCode: r.barCode,
  taxRate: r.taxRate,
  remarksWin: r.sizeDes,
})), { maxRowsPerCall: 1 });
say('');
say(`-- ERP 품목등록 plan (${sample.length} rows requested)`);
say(`accepted=${productPlan.acceptedCount} rejected=${productPlan.rejected.length} batches=${productPlan.batches.length} minIntervalMs=10000`);
if (productPlan.rejected.length) say(`reject_reasons=${JSON.stringify(tally(productPlan.rejected, (r) => r.problems.map((p) => `${p.field}:${p.reason}`).join(',')))}`);

const custPlan = planCustomerSync([{ businessNo: '', name: '합성고객' }, { businessNo: '123-45-67890', name: '합성거래처' }]);
say('');
say('-- ERP 거래처 plan (synthetic fixtures only)');
say(`accepted=${custPlan.acceptedCount} rejected=${custPlan.rejected.length} reject_reasons=${JSON.stringify(tally(custPlan.rejected, (r) => r.problems.map((p) => p.field).join(',')))}`);

const slipNoCust = planSlip({ order: SYNTHETIC_ORDER, items: SYNTHETIC_ITEMS });
const slipResolved = planSlip({ order: SYNTHETIC_ORDER, items: SYNTHETIC_ITEMS, cust: '00035', whCd: '00001', ioDate: ecountDate(Date.now()) });
say('');
say('-- ERP 전표 plan');
say(`unresolved_cust: accepted=${slipNoCust.acceptedCount} rejected=${slipNoCust.rejected.length} reasons=${JSON.stringify(tally(slipNoCust.rejected, (r) => r.problems.map((p) => `${p.field}:${p.reason}`).join(',')))}`);
say(`resolved:        accepted=${slipResolved.acceptedCount} rejected=${slipResolved.rejected.length} batches=${slipResolved.batches.length} dedupe=${slipResolved.dedupeKey}`);
say(`UPLOAD_SER_NO per order: ${JSON.stringify([...new Set(slipResolved.batches[0]?.body.SaleOrderList.map((b) => b.BulkDatas.UPLOAD_SER_NO) || [])])}`);

const inventory = planInventoryRead({ baseDate: ecountDate(Date.now()), prodCds: sample.slice(0, 25).map((r) => r.erpProdCdProposed) });
say('');
say('-- ERP 재고 read plan');
say(`endpoint=${inventory.endpoint} chunks=${inventory.chunks.length} minIntervalMs=${inventory.minIntervalMs} codes=${inventory.chunks.reduce((s, c) => s + c.prodCds.length, 0)} note=${inventory.note}`);

// Measured over the WHOLE catalogue, not a sample: the answer is a fact about
// 4,575 rows, and a sample would hide which blocker actually binds.
const registerChecks = records.map((r) => buildRegisterBody(
  { prodDes: r.prodDes, price: r.price, stockQuantity: r.stockQty, sellerManagementCode: r.sellerManagementCode },
  { leafCategoryId: r.naverCategoryNo || '', detailContent: '', images: {} },
));
say('');
say(`-- 네이버 상품등록 feasibility (${records.length} rows)`);
say(`registerable_now=${registerChecks.filter((c) => !c.problems.length).length} of ${records.length}`);
say(`problems=${JSON.stringify(tally(registerChecks.flatMap((c) => c.problems), (p) => `${p.field}:${p.reason}`))}`);
say(`image_upload_limit=${NCOM_LIMITS.imagesPerUploadCall}/call, external URLs rejected -> every row needs POST /v1/product-images/upload first`);

if (useMock) {
  const { startMockOapiServer } = await import('../test/helpers/mock-erp-oapi.mjs');
  const { startMockNcomServer } = await import('../test/helpers/mock-ncom.mjs');
  const { createNcomClient } = await import('../lib/ncommerce.mjs');
  say('');
  say('-- mock transports (loopback only, nothing leaves this machine)');

  const erpMock = await startMockOapiServer();
  const erp = createErpOapiClient({
    env: { ERP_MODE: 'mock', ERP_MOCK_BASE_URL: erpMock.baseUrl, ECOUNT_COM_CODE: 'DRYRUN', ECOUNT_USER_ID: 'DRYRUN', ECOUNT_API_CERT_KEY: 'MOCK' },
    now: () => 0,
    sleep: async () => {},
  });
  await erp.bootstrap();
  say(`erp.bootstrap: zone=${erp.zone} session_present=${Boolean(erp.sessionId)}`);
  const productRows = productPlan.batches.slice(0, 3).map((b) => b.body.ProductList[0].BulkDatas);
  const productCall = await erp.call('saveBasicProduct', null, { rows: productRows, dedupeKey: 'dryrun:product:1' });
  say(`erp.SaveBasicProduct: ok=${productCall.ok} sent=${productRows.length} rows=${productCall.rows.length} slipNos=${JSON.stringify(productCall.slipNos)} quota_known=${productCall.quota?.known}`);
  const balance = await erp.call('listInventoryBalance', { BASE_DATE: ecountDate(Date.now()), PROD_CD: '', WH_CD: '' });
  say(`erp.GetListInventoryBalanceStatus: ok=${balance.ok} result_rows=${balance.result.length}`);

  const realMapping = new Map(balance.result.map((row) => [String(row.PROD_CD), {}]));
  const realBridge = stockFromErpBalance({ erpRows: balance.result, mappingByProdCd: realMapping });
  say(`BAL_QTY -> stock, today: updates=${realBridge.counts.updates} rejected=${realBridge.counts.rejected} reasons=${JSON.stringify(tally(realBridge.rejected, (r) => r.reason))}`);

  const ncomMock = await startMockNcomServer();
  const ncom = createNcomClient({
    env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: ncomMock.baseUrl, NCOM_CLIENT_ID: 'DRYRUN', NCOM_CLIENT_SECRET: 'MOCKSECRET' },
    fetchFn: fetch,
    bcryptHashpw: async (plain, salt) => `$2a$10$${Buffer.from(`${plain}|${salt}`).toString('base64')}`,
    now: () => 1700000000000,
    sleep: async () => {},
  });
  const decision = await registerOrModify(ncom, {
    record: { prodDes: 'SQ5+', price: { value: 1680000, state: 'public' }, stockQuantity: 12, sellerManagementCode: 'samasound.co.kr:3836' },
    leafCategoryId: '50005556',
    images: { representative: 'https://prd-phinf.pstatic.net/mock/1.png', additional: [], uploadedViaImageApi: true },
    detailContent: 'dry-run 상세설명',
  });
  say(`naver.registerOrModify(dry): action=${decision.action} code=${decision.sellerManagementCode} transmitted=${decision.transmitted}`);

  // The same bridge with one mock 네이버상품ID, to show what unblocks it.
  const mockMapping = new Map(balance.result.map((row) => [String(row.PROD_CD), { naverItemId: 500001 }]));
  const mockBridge = stockFromErpBalance({ erpRows: balance.result, mappingByProdCd: mockMapping });
  say(`BAL_QTY -> stock, if an item id existed: updates=${mockBridge.counts.updates} endpoints=${JSON.stringify([...new Set(mockBridge.updates.map((u) => u.endpointKey))])}`);
  say(`mock calls seen: erp=${erpMock.calls.length} ncom=${ncomMock.calls.length}`);
  await erpMock.close();
  await ncomMock.close();
}

say('');
say(`nothing was transmitted. field limits enforced locally: PROD_CD<=${OAPI_FIELD_LIMITS.PROD_CD}, PROD_DES<=${OAPI_FIELD_LIMITS.PROD_DES}, CUST<=${OAPI_FIELD_LIMITS.CUST}, BAR_CODE<=${OAPI_FIELD_LIMITS.BAR_CODE}`);
console.log(lines.join('\n'));
