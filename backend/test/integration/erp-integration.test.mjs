// Integration tests for ERP API client with mock server
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { EcountApiClient, isLockoutMessage } from '../../lib/erp-client.mjs';
import { ErpProductSync, createProductSync } from '../../lib/erp-product-sync.mjs';
import { ErpCustomerSync, createCustomerSync } from '../../lib/erp-customer-sync.mjs';
import { ErpOrderSync, createOrderSync, createErpSyncService } from '../../lib/erp-order-sync.mjs';

// Mock ERP server
let mockServer;
let mockPort;

const errorHandlers = {
  '/api/login/locked': { status: 403, body: { message: '계정 잠금 상태입니다' } },
  '/api/item/not-found': { status: 404, body: { message: 'Item not found' } },
};

before(async () => {
  mockServer = http.createServer((req, res) => {
    let url = req.url || '/';
    // Strip query parameters for matching
    const basePath = url.split('?')[0];

    // Check error handlers first
    if (errorHandlers[url] || errorHandlers[basePath]) {
      const handler = errorHandlers[url] || errorHandlers[basePath];
      res.writeHead(handler.status);
      res.end(JSON.stringify(handler.body));
      return;
    }

    // Handle POST requests with body
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        // Check if it's a sales slip creation
        if (basePath === '/api/sales-slip') {
          res.writeHead(201);
          res.end(JSON.stringify({ slipNo: 'SLIP-001', status: 'created' }));
          return;
        }
        // Check if it's an item upsert
        if (basePath === '/api/item') {
          res.writeHead(201);
          res.end(JSON.stringify({ itemCode: 'SS-3836', status: 'created' }));
          return;
        }
        // Check if it's a trade partner upsert
        if (basePath === '/api/trade-partner') {
          res.writeHead(201);
          res.end(JSON.stringify({ tradeCode: 'CG-000123', status: 'created' }));
          return;
        }
        // Check if it's an inventory query
        if (basePath === '/api/inventory') {
          res.writeHead(200);
          res.end(JSON.stringify({ items: [{ itemCode: 'SS-3836', qty: 100, reserved: 20 }], total: 1 }));
          return;
        }
        // Check if it's a price query
        if (basePath === '/api/price') {
          res.writeHead(200);
          res.end(JSON.stringify({ items: [{ itemCode: 'SS-3836', price: 365000 }], total: 1 }));
          return;
        }
        // Check if it's a login request
        if (basePath === '/api/login') {
          res.writeHead(200);
          res.end(JSON.stringify({ token: 'mock-session-token' }));
          return;
        }
        // Default error
        res.writeHead(404);
        res.end(JSON.stringify({ message: `Not found: ${url}` }));
      });
      return;
    }

    // Handle GET requests
    if (req.method === 'GET') {
      // Check specific item lookup
      if (basePath === '/api/item/SS-3836') {
        res.writeHead(200);
        res.end(JSON.stringify({ itemCode: 'SS-3836', itemName: 'SQ5+', qty: 100 }));
        return;
      }
      if (basePath === '/api/item/SM-2574') {
        res.writeHead(200);
        res.end(JSON.stringify({ itemCode: 'SM-2574', itemName: 'Test Product', qty: 50 }));
        return;
      }
      // Check trade partner lookup
      if (basePath === '/api/trade-partner/CG-000123') {
        res.writeHead(200);
        res.end(JSON.stringify({ tradeCode: 'CG-000123', tradeName: 'Test Customer' }));
        return;
      }
      // Check item search (with query params)
      if (basePath === '/api/item') {
        res.writeHead(200);
        res.end(JSON.stringify({ items: [{ itemCode: 'SS-3836', itemName: 'SQ5+' }], total: 1 }));
        return;
      }
      // Check trade partner search
      if (basePath === '/api/trade-partner') {
        res.writeHead(200);
        res.end(JSON.stringify({ items: [{ tradeCode: 'CG-000123', tradeName: 'Test Customer' }], total: 1 }));
        return;
      }
      // Check inventory
      if (basePath === '/api/inventory') {
        res.writeHead(200);
        res.end(JSON.stringify({ items: [{ itemCode: 'SS-3836', qty: 100, reserved: 20 }], total: 1 }));
        return;
      }
      // Check prices
      if (basePath === '/api/price') {
        res.writeHead(200);
        res.end(JSON.stringify({ items: [{ itemCode: 'SS-3836', price: 365000 }], total: 1 }));
        return;
      }
      // Check login endpoint
      if (basePath === '/api/login') {
        res.writeHead(200);
        res.end(JSON.stringify({ token: 'mock-session-token' }));
        return;
      }
    }

    // Default 404
    res.writeHead(404);
    res.end(JSON.stringify({ message: `Not found: ${url}` }));
  });

  await new Promise((resolve) => {
    mockServer.listen(0, () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => {
    mockServer.close(resolve);
  });
});

function createTestClient(options = {}) {
  return new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: `http://localhost:${mockPort}`,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Integration Tests: Login
// ---------------------------------------------------------------------------

test('integration: login with valid credentials', async () => {
  const client = createTestClient();
  const token = await client.login();
  assert.equal(token, 'mock-session-token');
  assert.equal(client.sessionToken, 'mock-session-token');
});

test('integration: login with locked account', async () => {
  const client = new EcountApiClient({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: `http://localhost:${mockPort}/api/login/locked`,
  });

  await assert.rejects(() => client.login(), /account locked/i);
  assert.equal(client.locked, true);
});

// ---------------------------------------------------------------------------
// Integration Tests: Item Operations
// ---------------------------------------------------------------------------

test('integration: lookup item by code', async () => {
  const client = createTestClient();
  await client.login();

  const item = await client.lookupItem('SS-3836');
  assert.equal(item.itemCode, 'SS-3836');
  assert.equal(item.itemName, 'SQ5+');
});

test('integration: search items', async () => {
  const client = createTestClient();
  await client.login();

  const result = await client.searchItems('SQ');
  assert.ok(result.items);
  assert.equal(result.total, 1);
});

test('integration: upsert item', async () => {
  const client = createTestClient();
  await client.login();

  const result = await client.upsertItem({
    itemCode: 'SS-3836',
    itemName: 'SQ5+',
    price: 365000,
  });
  assert.equal(result.itemCode, 'SS-3836');
  assert.equal(result.status, 'created');
});

// ---------------------------------------------------------------------------
// Integration Tests: Order Operations
// ---------------------------------------------------------------------------

test('integration: create sales slip', async () => {
  const client = createTestClient();
  await client.login();

  const result = await client.createSalesSlip({
    slipNo: 'ORD-001',
    tradeCode: 'CG-000123',
    amount: 100000,
    lines: [{ seq: 1, prodCd: 'SS-3836', qty: 1, outPrice: 100000 }],
  });
  assert.equal(result.slipNo, 'SLIP-001');
  assert.equal(result.status, 'created');
});

// ---------------------------------------------------------------------------
// Integration Tests: Trade Partner Operations
// ---------------------------------------------------------------------------

test('integration: lookup trade partner', async () => {
  const client = createTestClient();
  await client.login();

  const partner = await client.lookupTradePartner('CG-000123');
  assert.equal(partner.tradeCode, 'CG-000123');
  assert.equal(partner.tradeName, 'Test Customer');
});

test('integration: upsert trade partner', async () => {
  const client = createTestClient();
  await client.login();

  const result = await client.upsertTradePartner({
    tradeCode: 'CG-000123',
    tradeName: 'Test Customer',
    phone: '010-1234-5678',
  });
  assert.equal(result.tradeCode, 'CG-000123');
  assert.equal(result.status, 'created');
});

// ---------------------------------------------------------------------------
// Integration Tests: Inventory and Price
// ---------------------------------------------------------------------------

test('integration: get inventory', async () => {
  const client = createTestClient();
  await client.login();

  const result = await client.getInventory(['SS-3836']);
  assert.ok(result.items);
  assert.equal(result.items[0].itemCode, 'SS-3836');
  assert.equal(result.items[0].qty, 100);
});

test('integration: get prices', async () => {
  const client = createTestClient();
  await client.login();

  const result = await client.getPrices(['SS-3836']);
  assert.ok(result.items);
  assert.equal(result.items[0].itemCode, 'SS-3836');
  assert.equal(result.items[0].price, 365000);
});

// ---------------------------------------------------------------------------
// Integration Tests: Product Sync Service
// ---------------------------------------------------------------------------

test('integration: product sync lookupProduct', async () => {
  const client = createTestClient();
  await client.login();

  const sync = createProductSync(client);
  const item = await sync.lookupProduct('samasound.co.kr:3836');
  assert.equal(item.itemCode, 'SS-3836');
});

test('integration: product sync fetchInventory', async () => {
  const client = createTestClient();
  await client.login();

  const sync = createProductSync(client);
  const result = await sync.fetchInventory(['samasound.co.kr:3836']);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].erp_code, 'SS-3836');
  assert.equal(result.items[0].available, 80); // 100 - 20
});

test('integration: product sync fetchPrices', async () => {
  const client = createTestClient();
  await client.login();

  const sync = createProductSync(client);
  const result = await sync.fetchPrices(['samasound.co.kr:3836']);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].erp_code, 'SS-3836');
  assert.equal(result.items[0].price, 365000);
});

// ---------------------------------------------------------------------------
// Integration Tests: Customer Sync Service
// ---------------------------------------------------------------------------

test('integration: customer sync lookupPartner', async () => {
  const client = createTestClient();
  await client.login();

  const sync = createCustomerSync(client);
  const partner = await sync.lookupPartner('CG-000123');
  assert.equal(partner.tradeCode, 'CG-000123');
});

test('integration: customer sync syncCustomer', async () => {
  const client = createTestClient();
  await client.login();

  const sync = createCustomerSync(client);
  const result = await sync.syncCustomer({
    id: 123,
    name: 'Test Customer',
    phone: '010-1234-5678',
    email: 'test@example.com',
  });
  assert.equal(result.tradeCode, 'CG-000123');
});

// ---------------------------------------------------------------------------
// Integration Tests: Order Sync Service
// ---------------------------------------------------------------------------

test('integration: order sync transmitOrder', async () => {
  const client = createTestClient();
  await client.login();

  const sync = createOrderSync(client);
  const result = await sync.transmitOrder(
    {
      id: 'ORD-001',
      customer_id: 123,
      customer_name: 'Test Customer',
      total_amount: 100000,
      created_at: '2026-10-25T00:00:00Z',
    },
    [
      {
        product_id: 'samasound.co.kr:3836',
        product_name: 'SQ5+',
        qty: 1,
        unit_price: 100000,
        line_total: 100000,
      },
    ]
  );

  assert.equal(result.delivered, true);
  assert.equal(result.status, 'sent');
  assert.equal(result.erp_slip_no, 'SLIP-001');
});

test('integration: order sync in dry run mode', async () => {
  const client = createTestClient();
  await client.login();

  const sync = createOrderSync(client, { dryRun: true });
  const result = await sync.transmitOrder(
    { id: 'ORD-001', customer_name: 'Test Customer', total_amount: 100000 },
    [{ product_id: 'samasound.co.kr:3836', qty: 1 }]
  );

  assert.equal(result.delivered, false);
  assert.equal(result.status, 'dry_run');
  assert.ok(result.payload);
});

// ---------------------------------------------------------------------------
// Integration Tests: Full Service
// ---------------------------------------------------------------------------

test('integration: createErpSyncService', () => {
  const service = createErpSyncService({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: `http://localhost:${mockPort}`,
  });

  assert.ok(service.client);
  assert.ok(service.orderSync);
  assert.equal(service.ready, true);
  assert.equal(service.available, true);
  assert.equal(service.locked, false);
});

test('integration: createErpSyncService with dry run', () => {
  const service = createErpSyncService({
    ECOUNT_COM_CODE: '54134',
    ECOUNT_USER_ID: 'cgiinc',
    ECOUNT_PASSWORD: 'test-password',
    ERP_OAPI_BASE_URL: `http://localhost:${mockPort}`,
    ERP_DRY_RUN: 'YES',
  });

  assert.equal(service.dryRun, true);
  assert.equal(service.orderSync.dryRun, true);
});
