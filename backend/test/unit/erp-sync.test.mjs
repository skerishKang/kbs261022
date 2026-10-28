// Unit tests for ERP API client and sync modules
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EcountApiClient,
  isLockoutMessage,
  createErpClient,
  ERP_API_VERSION,
} from '../../lib/erp-client.mjs';

import {
  productToErpCode,
  parseErpCode,
  productToErpItem,
  productsToErpItems,
  erpInventoryToCgi,
  erpPriceToCgi,
  ErpProductSync,
  createProductSync,
  ERP_SYNC_VERSION,
} from '../../lib/erp-product-sync.mjs';

import {
  customerToErpTradePartner,
  generateTradeCode,
  erpTradePartnerToCgi,
  ErpCustomerSync,
  createCustomerSync,
  ERP_CUSTOMER_SYNC_VERSION,
} from '../../lib/erp-customer-sync.mjs';

import {
  ErpOrderSync,
  createOrderSync,
  createErpSyncService,
  ERP_ORDER_SYNC_VERSION,
} from '../../lib/erp-order-sync.mjs';

// ---------------------------------------------------------------------------
// ERP API Client Tests
// ---------------------------------------------------------------------------

test('ERP client version is exported', () => {
  assert.equal(ERP_API_VERSION, '2.0.0');
});

test('isLockoutMessage detects Korean lockout messages', () => {
  assert.equal(isLockoutMessage('계정 잠금 상태입니다'), true);
  assert.equal(isLockoutMessage('계정이 잠겼습니다'), true);
  assert.equal(isLockoutMessage('잠금 해제 후 다시 로그인하세요'), true);
});

test('isLockoutMessage detects English lockout messages', () => {
  assert.equal(isLockoutMessage('Account is locked'), true);
  assert.equal(isLockoutMessage('Account locked due to failed attempts'), true);
  assert.equal(isLockoutMessage('Access blocked'), true);
});

test('isLockoutMessage returns false for non-lockout messages', () => {
  assert.equal(isLockoutMessage('Invalid credentials'), false);
  assert.equal(isLockoutMessage('Network error'), false);
  assert.equal(isLockoutMessage('Timeout'), false);
  assert.equal(isLockoutMessage(''), false);
  assert.equal(isLockoutMessage(null), false);
  assert.equal(isLockoutMessage(undefined), false);
});

test('EcountApiClient constructor with no credentials', () => {
  const client = new EcountApiClient({});
  assert.equal(client.available, false);
  assert.equal(client.ready, false);
  assert.equal(client.locked, false);
});

test('EcountApiClient constructor with credentials', () => {
  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  });
  assert.equal(client.available, true);
  assert.equal(client.ready, true);
});

test('EcountApiClient constructor with alternative env names', () => {
  const client = new EcountApiClient({
    ERP_COM_CODE: '54134',
    ERP_USER_ID: 'cgiinc',
    ERP_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  });
  assert.equal(client.available, true);
});

test('EcountApiClient constructor with API key', () => {
  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
    ERP_OAPI_TOKEN: 'api-key-123',
  });
  assert.equal(client.apiKey, 'api-key-123');
});

test('EcountApiClient login throws without credentials', async () => {
  const client = new EcountApiClient({});
  await assert.rejects(() => client.login(), /credentials not configured/);
});

test('EcountApiClient login with mock fetch', async () => {
  const fetchMock = async (url, opts) => {
    return {
      ok: true,
      json: async () => ({ token: 'session-token-123' }),
    };
  };

  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  }, fetchMock);

  const token = await client.login();
  assert.equal(token, 'session-token-123');
  assert.equal(client.sessionToken, 'session-token-123');
});

test('EcountApiClient login detects lockout', async () => {
  const fetchMock = async () => {
    return {
      ok: false,
      json: async () => ({ message: '계정 잠금 상태입니다' }),
    };
  };

  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'wrong-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  }, fetchMock);

  await assert.rejects(() => client.login(), /account locked/i);
  assert.equal(client.locked, true);
});

test('EcountApiClient login with invalid credentials', async () => {
  const fetchMock = async () => {
    return {
      ok: false,
      json: async () => ({ message: 'Invalid credentials' }),
    };
  };

  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'wrong-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  }, fetchMock);

  await assert.rejects(() => client.login(), /login failed/i);
  assert.equal(client.locked, false);
});

test('EcountApiClient request throws when locked', async () => {
  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  });
  client.locked = true;
  client.lockoutReason = 'test lockout';

  await assert.rejects(() => client.request('GET', '/test'), /account locked/i);
});

test('EcountApiClient request with mock fetch', async () => {
  const fetchMock = async (url, opts) => {
    return {
      ok: true,
      json: async () => ({ itemCode: 'SS-3836', itemName: 'SQ5+' }),
    };
  };

  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  }, fetchMock);

  // Mock login
  client.sessionToken = 'test-token';

  const result = await client.request('GET', '/api/item/SS-3836');
  assert.equal(result.itemCode, 'SS-3836');
  assert.equal(result.itemName, 'SQ5+');
});

test('EcountApiClient lookupItem', async () => {
  const fetchMock = async () => ({
    ok: true,
    json: async () => ({ itemCode: 'SS-3836' }),
  });

  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  }, fetchMock);
  client.sessionToken = 'test-token';

  const item = await client.lookupItem('SS-3836');
  assert.equal(item.itemCode, 'SS-3836');
});

test('EcountApiClient reset clears session', () => {
  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  });
  client.sessionToken = 'test-token';
  client.locked = true;

  client.reset();

  assert.equal(client.sessionToken, null);
  assert.equal(client.locked, false);
});

test('createErpClient factory', () => {
  const client = createErpClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  });
  assert.ok(client instanceof EcountApiClient);
  assert.equal(client.available, true);
});

// ---------------------------------------------------------------------------
// Product Sync Tests
// ---------------------------------------------------------------------------

test('ERP sync version is exported', () => {
  assert.equal(ERP_SYNC_VERSION, '1.0.0');
});

test('productToErpCode maps domain IDs', () => {
  assert.equal(productToErpCode('samasound.co.kr:3836'), 'SS-3836');
  assert.equal(productToErpCode('samamusic.co.kr:2574'), 'SM-2574');
  assert.equal(productToErpCode('yamaha.co.kr:77'), 'YM-77');
});

test('productToErpCode maps short IDs', () => {
  assert.equal(productToErpCode('samasound:3836'), 'SS-3836');
  assert.equal(productToErpCode('samamusic:2574'), 'SM-2574');
});

test('productToErpCode handles unknown domains', () => {
  assert.equal(productToErpCode('unknown.com:123'), 'XX-123');
});

test('productToErpCode handles bare IDs', () => {
  assert.equal(productToErpCode('12345'), 'XX-12345');
});

test('parseErpCode parses SS codes', () => {
  const result = parseErpCode('SS-3836');
  assert.deepEqual(result, { site: 'samasound', productId: '3836' });
});

test('parseErpCode parses SM codes', () => {
  const result = parseErpCode('SM-2574');
  assert.deepEqual(result, { site: 'samamusic', productId: '2574' });
});

test('parseErpCode parses YM codes', () => {
  const result = parseErpCode('YM-77');
  assert.deepEqual(result, { site: 'yamaha', productId: '77' });
});

test('parseErpCode handles invalid format', () => {
  assert.equal(parseErpCode('INVALID'), null);
  assert.equal(parseErpCode(''), null);
  assert.equal(parseErpCode(null), null);
});

test('productToErpItem converts product to ERP item', () => {
  const product = {
    id: 'samasound.co.kr:3836',
    name: 'SQ5+',
    shortName: 'SQ5+',
    brand: 'ALLEN&HEATH',
    model: 'SQ5+',
    categoryCode: 'P0000',
    categoryPath: 'Power > SQ5+',
    price: 365000,
    unit: 'EA',
    weight: 1.5,
    imageCount: 2,
    imageUrl: 'https://example.com/img.jpg',
    productUrl: 'https://example.com/product',
    options: [{ name: 'Color', value: 'Black' }],
  };

  const item = productToErpItem(product);

  assert.equal(item.itemCode, 'SS-3836');
  assert.equal(item.itemName, 'SQ5+');
  assert.equal(item.brand, 'ALLEN&HEATH');
  assert.equal(item.price, 365000);
  assert.equal(item.vatRate, 10);
  assert.equal(item._source, 'cgi-storefront');
  assert.equal(item._sourceId, 'samasound.co.kr:3836');
});

test('productToErpItem throws without id', () => {
  assert.throws(() => productToErpItem({}), /Product id is required/);
  assert.throws(() => productToErpItem(null), /Product id is required/);
});

test('productsToErpItems converts multiple products', () => {
  const products = [
    { id: 'samasound.co.kr:3836', name: 'SQ5+' },
    { id: 'samamusic.co.kr:2574', name: 'Test Product' },
    { name: 'No ID' }, // Should be filtered out
  ];

  const items = productsToErpItems(products);

  assert.equal(items.length, 2);
  assert.equal(items[0].itemCode, 'SS-3836');
  assert.equal(items[1].itemCode, 'SM-2574');
});

test('productsToErpItems handles empty array', () => {
  assert.deepEqual(productsToErpItems([]), []);
});

test('productsToErpItems handles null', () => {
  assert.deepEqual(productsToErpItems(null), []);
});

test('erpInventoryToCgi converts ERP inventory to CGI format', () => {
  const erpData = {
    itemCode: 'SS-3836',
    qty: 100,
    onHand: 80,
    reserved: 20,
    safetyStock: 10,
    updatedAt: '2026-10-25T00:00:00Z',
  };

  const cgiData = erpInventoryToCgi(erpData);

  assert.equal(cgiData.erp_code, 'SS-3836');
  assert.equal(cgiData.qty, 100);
  assert.equal(cgiData.on_hand, 80);
  assert.equal(cgiData.reserved, 20);
  assert.equal(cgiData.safety_stock, 10);
  assert.equal(cgiData.available, 80); // 100 - 20
});

test('erpInventoryToCgi handles null', () => {
  assert.equal(erpInventoryToCgi(null), null);
});

test('erpPriceToCgi converts ERP price to CGI format', () => {
  const erpData = {
    itemCode: 'SS-3836',
    price: 365000,
    vatRate: 10,
    discountRate: 5,
    effectiveDate: '2026-10-01',
    updatedAt: '2026-10-25T00:00:00Z',
  };

  const cgiData = erpPriceToCgi(erpData);

  assert.equal(cgiData.erp_code, 'SS-3836');
  assert.equal(cgiData.price, 365000);
  assert.equal(cgiData.vat_rate, 10);
  assert.equal(cgiData.discount, 5);
});

test('erpPriceToCgi handles null', () => {
  assert.equal(erpPriceToCgi(null), null);
});

test('ErpProductSync constructor requires client', () => {
  assert.throws(() => new ErpProductSync(null), /ERP client is required/);
});

test('ErpProductSync constructor with client', () => {
  const client = new EcountApiClient({});
  const sync = new ErpProductSync(client, { batchSize: 100 });
  assert.ok(sync);
  assert.equal(sync.batchSize, 100);
});

test('ErpProductSync syncProducts with empty array', async () => {
  const client = new EcountApiClient({});
  const sync = new ErpProductSync(client);

  const result = await sync.syncProducts([]);
  assert.deepEqual(result, { total: 0, success: 0, failed: 0, errors: [] });
});

test('ErpProductSync syncProducts with invalid input', async () => {
  const client = new EcountApiClient({});
  const sync = new ErpProductSync(client);

  const result = await sync.syncProducts(null);
  assert.deepEqual(result, { total: 0, success: 0, failed: 0, errors: [] });
});

test('createProductSync factory', () => {
  const client = new EcountApiClient({});
  const sync = createProductSync(client);
  assert.ok(sync instanceof ErpProductSync);
});

test('createProductSync factory throws without client', () => {
  assert.throws(() => createProductSync(null), /ERP client is required/);
});

test('ErpProductSync cache operations', async () => {
  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  });
  client.sessionToken = 'test-token';

  const sync = new ErpProductSync(client, { cacheTtlMs: 1000 });

  // Mock lookupItem
  client.lookupItem = async () => ({ itemCode: 'SS-3836', itemName: 'SQ5+' });

  // First call - should fetch from API
  const item1 = await sync.lookupProduct('samasound.co.kr:3836');
  assert.equal(item1.itemCode, 'SS-3836');

  // Second call - should use cache
  const item2 = await sync.lookupProduct('samasound.co.kr:3836');
  assert.equal(item2.itemCode, 'SS-3836');

  // Cache should have 1 entry
  assert.equal(sync.cachedCount, 1);

  // Clear cache
  sync.clearCache();
  assert.equal(sync.cachedCount, 0);
});

// ---------------------------------------------------------------------------
// Customer Sync Tests
// ---------------------------------------------------------------------------

test('ERP customer sync version is exported', () => {
  assert.equal(ERP_CUSTOMER_SYNC_VERSION, '1.0.0');
});

test('generateTradeCode generates codes for numeric IDs', () => {
  assert.equal(generateTradeCode('1'), 'CG-000001');
  assert.equal(generateTradeCode('123'), 'CG-000123');
  assert.equal(generateTradeCode('123456'), 'CG-123456');
});

test('generateTradeCode generates codes for string IDs', () => {
  const code = generateTradeCode('USER-123');
  assert.match(code, /^CG-[A-Z0-9]{6}$/);
});

test('generateTradeCode handles empty ID', () => {
  const code = generateTradeCode('');
  assert.match(code, /^CG-[A-Z0-9]{6}$/);
});

test('customerToErpTradePartner converts customer to trade partner', () => {
  const customer = {
    id: 123,
    name: 'Test Customer',
    contactName: 'John Doe',
    phone: '010-1234-5678',
    mobile: '010-1234-5678',
    email: 'test@example.com',
    address: 'Seoul, Korea',
    addressDetail: '123 Main St',
    zipCode: '04524',
    city: 'Seoul',
    businessNo: '123-4567890',
  };

  const partner = customerToErpTradePartner(customer);

  assert.equal(partner.tradeCode, 'CG-000123');
  assert.equal(partner.tradeName, 'Test Customer');
  assert.equal(partner.contactName, 'John Doe');
  assert.equal(partner.phone, '010-1234-5678');
  assert.equal(partner.email, 'test@example.com');
  assert.equal(partner._source, 'cgi-storefront');
  assert.equal(partner._sourceId, 123);
});

test('customerToErpTradePartner throws without id', () => {
  assert.throws(() => customerToErpTradePartner({}), /Customer id is required/);
});

test('erpTradePartnerToCgi converts trade partner to customer', () => {
  const partner = {
    tradeCode: 'CG-000123',
    tradeName: 'Test Customer',
    contactName: 'John Doe',
    phone: '010-1234-5678',
    mobile: '010-1234-5678',
    email: 'test@example.com',
    address: 'Seoul, Korea',
    addressDetail: '123 Main St',
    zipCode: '04524',
    city: 'Seoul',
    _sourceId: 123,
  };

  const customer = erpTradePartnerToCgi(partner);

  assert.equal(customer.id, 123);
  assert.equal(customer.name, 'Test Customer');
  assert.equal(customer.phone, '010-1234-5678');
  assert.equal(customer.erp_trade_code, 'CG-000123');
});

test('erpTradePartnerToCgi handles null', () => {
  assert.equal(erpTradePartnerToCgi(null), null);
});

test('ErpCustomerSync constructor requires client', () => {
  assert.throws(() => new ErpCustomerSync(null), /ERP client is required/);
});

test('ErpCustomerSync constructor with client', () => {
  const client = new EcountApiClient({});
  const sync = new ErpCustomerSync(client);
  assert.ok(sync);
});

test('ErpCustomerSync syncCustomers with empty array', async () => {
  const client = new EcountApiClient({});
  const sync = new ErpCustomerSync(client);

  const result = await sync.syncCustomers([]);
  assert.deepEqual(result, { total: 0, success: 0, failed: 0, errors: [] });
});

test('createCustomerSync factory', () => {
  const client = new EcountApiClient({});
  const sync = createCustomerSync(client);
  assert.ok(sync instanceof ErpCustomerSync);
});

test('createCustomerSync factory throws without client', () => {
  assert.throws(() => createCustomerSync(null), /ERP client is required/);
});

// ---------------------------------------------------------------------------
// Order Sync Tests
// ---------------------------------------------------------------------------

test('ERP order sync version is exported', () => {
  assert.equal(ERP_ORDER_SYNC_VERSION, '1.0.0');
});

test('ErpOrderSync constructor requires client', () => {
  assert.throws(() => new ErpOrderSync(null), /ERP client is required/);
});

test('ErpOrderSync constructor with client', () => {
  const client = new EcountApiClient({});
  const sync = new ErpOrderSync(client);
  assert.ok(sync);
});

test('ErpOrderSync transmitOrder without order', async () => {
  const client = new EcountApiClient({});
  const sync = new ErpOrderSync(client);

  const result = await sync.transmitOrder(null, []);
  assert.equal(result.delivered, false);
  assert.equal(result.status, 'error');
});

test('ErpOrderSync transmitOrder with locked account', async () => {
  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  });
  client.locked = true;
  client.lockoutReason = 'test lockout';

  const sync = new ErpOrderSync(client);

  const result = await sync.transmitOrder({ id: 'ORD-001' }, []);
  assert.equal(result.delivered, false);
  assert.equal(result.status, 'skipped');
  assert.equal(result.lockout, true);
});

test('ErpOrderSync transmitOrder in dry run mode', async () => {
  const client = new EcountApiClient({});
  const sync = new ErpOrderSync(client, { dryRun: true });

  const order = {
    id: 'ORD-001',
    customer_name: 'Test Customer',
    total_amount: 100000,
  };
  const items = [{ product_id: 'samasound.co.kr:3836', qty: 1 }];

  const result = await sync.transmitOrder(order, items);
  assert.equal(result.delivered, false);
  assert.equal(result.status, 'dry_run');
  assert.ok(result.payload);
});

test('ErpOrderSync buildSlipData formats correctly', () => {
  const client = new EcountApiClient({});
  const sync = new ErpOrderSync(client);

  const payload = {
    source: { order_id: 'ORD-001', created_at: '2026-10-25T00:00:00Z' },
    customer: { customer_name: 'Test Customer' },
    payment: { payment_method: 'card', paid_at: '2026-10-25T00:00:00Z' },
    totals: { total_amount: 100000, supplied_amount: 90909, vat_amount: 9091 },
    lines: [{
      seq: 1,
      prod_cd: 'SS-3836',
      prod_des: 'SQ5+',
      qty: 1,
      out_price: 100000,
      out_price_vat: 1,
      vat_rate: 10,
      amt: 100000,
      remark: '',
    }],
    note: 'Test note',
    admin_note: 'Admin note',
    idempotency_key: 'test-key',
  };

  const slipData = sync.buildSlipData(payload, 'CG-000123');

  assert.equal(slipData.slipNo, 'ORD-001');
  assert.equal(slipData.tradeCode, 'CG-000123');
  assert.equal(slipData.tradeName, 'Test Customer');
  assert.equal(slipData.amount, 100000);
  assert.equal(slipData.lines.length, 1);
  assert.equal(slipData.lines[0].prodCd, 'SS-3836');
});

test('ErpOrderSync formatDate formats correctly', () => {
  const client = new EcountApiClient({});
  const sync = new ErpOrderSync(client);

  assert.equal(sync.formatDate('2026-10-25T00:00:00Z'), '20261025');
  assert.equal(sync.formatDate(new Date(2026, 9, 25)), '20261025');
});

test('ErpOrderSync formatDate handles invalid date', () => {
  const client = new EcountApiClient({});
  const sync = new ErpOrderSync(client);

  // Should not throw, should return current date
  const result = sync.formatDate('invalid-date');
  assert.match(result, /^\d{8}$/);
});

test('ErpOrderSync buildTestPayload builds payload', () => {
  const client = new EcountApiClient({});
  const sync = new ErpOrderSync(client);

  const order = {
    id: 'ORD-001',
    customer_name: 'Test Customer',
    total_amount: 100000,
  };
  const items = [{ product_id: 'samasound.co.kr:3836', qty: 1 }];

  const payload = sync.buildTestPayload(order, items);

  assert.equal(payload.adapter, 'ecount-test');
  assert.equal(payload.mode, 'test');
  assert.equal(payload.live_write, false);
  assert.equal(payload.lines.length, 1);
});

test('createOrderSync factory', () => {
  const client = new EcountApiClient({});
  const sync = createOrderSync(client);
  assert.ok(sync instanceof ErpOrderSync);
});

test('createOrderSync factory throws without client', () => {
  assert.throws(() => createOrderSync(null), /ERP client is required/);
});

test('createErpSyncService creates service', () => {
  const service = createErpSyncService({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
  });

  assert.ok(service.client);
  assert.ok(service.orderSync);
  assert.equal(service.ready, true);
  assert.equal(service.available, true);
});

test('createErpSyncService with dry run mode', () => {
  const service = createErpSyncService({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: 'https://erp.example.com/api',
    ERP_DRY_RUN: 'YES',
  });

  assert.equal(service.dryRun, true);
});

test('createErpSyncService with no credentials', () => {
  const service = createErpSyncService({});

  assert.equal(service.ready, false);
  assert.equal(service.available, false);
});
