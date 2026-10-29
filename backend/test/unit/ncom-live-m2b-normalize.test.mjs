// Unit contract for normalizeM2bPackages — the bridge between the committed m2b
// registration-prep packages (snake_case top-level keys, body under .package)
// and the live-lane contract (flat camelCase: cgiId·productName·sellerManagementCode·body).
// Found as a real defect on 2026-10-29: the live runner read the committed file
// raw and searched Naver with undefined seller codes ("undefined: no existing
// product" ×3). Fixtures that are already flat must pass through unchanged.
//
//   node --test test/unit/ncom-live-m2b-normalize.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeM2bPackages } from '../../lib/ncom-live-pipeline.mjs';

test('normalizeM2bPackages flattens the committed m2b shape and passes flat fixtures through', () => {
  const m2b = [
    {
      cgi_id: 'samamusic.co.kr:1769', product_name: 'K&M 19797 케이앤엠 태블릿 PC 스탠드', seller_management_code: 'samamusic:1769',
      package: {
        cgiId: 'samamusic.co.kr:1769', productName: 'K&M 19797 케이앤엠 태블릿 PC 스탠드', sellerManagementCode: 'samamusic:1769',
        body: { originProduct: { salePrice: 116000 }, smartstoreChannelProduct: { naverShoppingRegistration: false } },
      },
      images: { upload_plan: { representative: 'https://example.invalid/a.jpg', additional: [] } },
    },
    {
      cgiId: 'samamusic.co.kr:3417', productName: 'flat', sellerManagementCode: 'samamusic:3417',
      body: { originProduct: { salePrice: 518000 } },
    },
  ];
  const [first, flat] = normalizeM2bPackages(m2b);
  assert.equal(first.cgiId, 'samamusic.co.kr:1769');
  assert.equal(first.productName, 'K&M 19797 케이앤엠 태블릿 PC 스탠드');
  assert.equal(first.sellerManagementCode, 'samamusic:1769');
  assert.equal(first.body.originProduct.salePrice, 116000, 'the m2b body under .package becomes the top-level body');
  assert.equal(first.images.upload_plan.representative, 'https://example.invalid/a.jpg', 'the upload plan is untouched');
  assert.equal(flat.cgiId, 'samamusic.co.kr:3417');
  assert.equal(flat.productName, 'flat');
  assert.equal(flat.sellerManagementCode, 'samamusic:3417');
  assert.equal(flat.body.originProduct.salePrice, 518000);
});

test('normalizeM2bPackages leaves every other package field intact for the pipeline', () => {
  const raw = {
    cgi_id: 'samamusic.co.kr:3418', seller_management_code: 'samamusic:3418',
    package: { cgiId: 'samamusic.co.kr:3418', sellerManagementCode: 'samamusic:3418', body: { originProduct: { salePrice: 1818000 } } },
    blockers: { reason_split: [{ reason: 'detail_content_absent', resolution: 'tooling_auto' }] },
    customer_inputs_pending: ['원산지 정책', '배송비·배송 방식'],
  };
  const [normalized] = normalizeM2bPackages([raw]);
  assert.deepEqual(normalized.blockers, raw.blockers, 'snake_case evidence fields ride along untouched');
  assert.deepEqual(normalized.customer_inputs_pending, raw.customer_inputs_pending);
  assert.equal(normalized.cgiId, 'samamusic.co.kr:3418');
});
