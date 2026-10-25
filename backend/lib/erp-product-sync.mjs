// ERP product mapping - CGI catalog <-> iCount ERP items
//
// Handles:
// - Product ID -> ERP item code mapping
// - Product data -> ERP item format conversion
// - Inventory/price sync (read-only from ERP)
// - Batch operations for bulk sync

import { erpCodeFor } from './erp.mjs';
import { EcountApiClient } from './erp-client.mjs';

export const ERP_SYNC_VERSION = '1.0.0';

// Site code prefixes (same as erp.mjs but with longer codes for ERP compatibility)
const SITE_CODE_PREFIX = {
  'samasound.co.kr': 'SS',
  samasound: 'SS',
  'samamusic.co.kr': 'SM',
  samamusic: 'SM',
  'yamaha.co.kr': 'YM',
  yamaha: 'YM',
  'samastore.co.kr': 'SA',
  samastore: 'SA',
};

/**
 * Generate ERP item code from CGI product ID.
 * CGI format: "domain:product_number" -> ERP format: "PREFIX-NNNN"
 */
export function productToErpCode(productId) {
  return erpCodeFor(productId);
}

/**
 * Parse ERP item code back to CGI product reference.
 * "SS-3836" -> { site: 'samasound', productId: '3836' }
 */
export function parseErpCode(erpCode) {
  const match = String(erpCode || '').match(/^([A-Z]{2})-(\d+)$/);
  if (!match) return null;
  const prefixMap = {
    SS: 'samasound',
    SM: 'samamusic',
    YM: 'yamaha',
    SA: 'samastore',
    XX: 'unknown',
  };
  return {
    site: prefixMap[match[1]] || 'unknown',
    productId: match[2],
  };
}

/**
 * Convert CGI product data to ERP item format.
 * CGI: { id, name, brand, price, model, category, options, ... }
 * ERP: { itemCode, itemName, brand, spec, category, price, ... }
 */
export function productToErpItem(product) {
  if (!product || !product.id) {
    throw new Error('Product id is required');
  }

  const erpCode = productToErpCode(product.id);
  const site = typeof product.id === 'string' && product.id.includes(':')
    ? product.id.split(':')[0]
    : '';
  const prefix = SITE_CODE_PREFIX[site] || 'XX';

  // Map category to ERP category code
  const erpCategory = product.categoryCode || 'P0000';

  return {
    itemCode: erpCode,
    itemName: product.name || '',
    shortName: product.shortName || product.name || '',
    brand: product.brand || '',
    spec: product.model || '',
    categoryCode: erpCategory,
    categoryPath: product.categoryPath || '',
    unit: product.unit || 'EA',
    unitCode: '3', // EA = 3 in ERP
    price: product.price != null ? product.price : 0,
    vatInclusive: product.vatInclusive !== false,
    vatRate: product.vatRate != null ? product.vatRate : 10,
    weight: product.weight || 0,
    usageStatus: '0', // 0=active
    inventoryManage: true,
    serialManage: false,
    lotManage: false,
    imageCount: product.imageCount || 0,
    imageUrl: product.imageUrl || '',
    productUrl: product.productUrl || '',
    // Additional CGI-specific fields for reference
    _source: 'cgi-storefront',
    _sourceId: product.id,
    _options: product.options || null,
  };
}

/**
 * Convert multiple products to ERP items.
 */
export function productsToErpItems(products) {
  if (!Array.isArray(products)) return [];
  return products
    .filter((p) => p && p.id)
    .map((p) => {
      try {
        return productToErpItem(p);
      } catch (e) {
        console.warn(`Failed to convert product ${p?.id}: ${e.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Build inventory sync payload from ERP response.
 * ERP: { itemCode, qty, onHand, safetyStock, ... }
 * CGI: { erp_code, qty, available, safety_stock, ... }
 */
export function erpInventoryToCgi(inventoryData) {
  if (!inventoryData) return null;
  return {
    erp_code: inventoryData.itemCode || inventoryData.prodCd || '',
    qty: inventoryData.qty || inventoryData.balQty || 0,
    on_hand: inventoryData.onHand || 0,
    reserved: inventoryData.reserved || 0,
    safety_stock: inventoryData.safetyStock || 0,
    available: (inventoryData.qty || 0) - (inventoryData.reserved || 0),
    last_updated: inventoryData.updatedAt || new Date().toISOString(),
  };
}

/**
 * Build price sync payload from ERP response.
 * ERP: { itemCode, price, vatRate, discountRate, ... }
 * CGI: { erp_code, price, vat_rate, discount, ... }
 */
export function erpPriceToCgi(priceData) {
  if (!priceData) return null;
  return {
    erp_code: priceData.itemCode || priceData.prodCd || '',
    price: priceData.price || priceData.outPrice || 0,
    vat_rate: priceData.vatRate || 10,
    discount: priceData.discountRate || 0,
    effective_date: priceData.effectiveDate || null,
    last_updated: priceData.updatedAt || new Date().toISOString(),
  };
}

/**
 * ERP product sync service.
 * Handles batch operations for product, inventory, and price sync.
 */
export class ErpProductSync {
  constructor(client, options = {}) {
    if (!client) throw new Error('ERP client is required');
    this.client = client;
    this.batchSize = options.batchSize || 50;
    this.retryCount = options.retryCount || 2;
    this.retryDelayMs = options.retryDelayMs || 1000;
    this.cache = new Map();
    this.cacheTtlMs = options.cacheTtlMs || 300000; // 5 minutes
  }

  /**
   * Sync products to ERP (upsert items).
   * Returns summary with success/failure counts.
   */
  async syncProducts(products) {
    if (!Array.isArray(products) || products.length === 0) {
      return { total: 0, success: 0, failed: 0, errors: [] };
    }

    const items = productsToErpItems(products);
    const result = { total: items.length, success: 0, failed: 0, errors: [] };

    // Process in batches
    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = items.slice(i, i + this.batchSize);
      const batchResult = await this.upsertBatch(batch, result);
      Object.assign(result, batchResult);
    }

    return result;
  }

  /**
   * Upsert multiple items in a batch.
   */
  async upsertBatch(items, result) {
    for (const item of items) {
      try {
        await this.client.upsertItem(item);
        result.success++;
        this.cache.set(`item:${item.itemCode}`, { data: item, ts: Date.now() });
      } catch (e) {
        result.failed++;
        result.errors.push({ itemCode: item.itemCode, error: e.message });
        // Don't retry on lockout
        if (e.message.includes('locked')) {
          result.errors.push({ itemCode: item.itemCode, error: 'Account locked - stopping sync' });
          return { success: 0, failed: items.length - result.success, errors: [{ lockout: true }] };
        }
      }
    }
    return {};
  }

  /**
   * Fetch inventory from ERP for given product IDs.
   */
  async fetchInventory(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return { items: [], total: 0 };
    }

    const codes = productIds.map((id) => productToErpCode(id));
    const result = await this.client.getInventory(codes);
    const cgiItems = (result.items || []).map(erpInventoryToCgi);

    return {
      items: cgiItems,
      total: cgiItems.length,
      erp_total: result.total || 0,
    };
  }

  /**
   * Fetch prices from ERP for given product IDs.
   */
  async fetchPrices(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return { items: [], total: 0 };
    }

    const codes = productIds.map((id) => productToErpCode(id));
    const result = await this.client.getPrices(codes);
    const cgiItems = (result.items || []).map(erpPriceToCgi);

    return {
      items: cgiItems,
      total: cgiItems.length,
      erp_total: result.total || 0,
    };
  }

  /**
   * Lookup single item from ERP with caching.
   */
  async lookupProduct(productId) {
    const code = productToErpCode(productId);
    const cacheKey = `item:${code}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
      return cached.data;
    }

    try {
      const item = await this.client.lookupItem(code);
      this.cache.set(cacheKey, { data: item, ts: Date.now() });
      return item;
    } catch (e) {
      // Return cached data even if expired on error
      if (cached) return cached.data;
      throw e;
    }
  }

  /**
   * Sync all products from ERP to local cache.
   * Read-only operation - only fetches data, does not write to ERP.
   */
  async syncFromErp(options = {}) {
    const page = options.page || 1;
    const limit = options.limit || this.batchSize;
    const keyword = options.keyword || '';

    const result = await this.client.searchItems(keyword, page, limit);
    const items = result.items || [];

    // Cache all fetched items
    for (const item of items) {
      const code = item.itemCode || item.prodCd;
      if (code) {
        this.cache.set(`item:${code}`, { data: item, ts: Date.now() });
      }
    }

    return {
      items,
      total: result.total || items.length,
      page,
      limit,
    };
  }

  /**
   * Get cached item count.
   */
  get cachedCount() {
    return this.cache.size;
  }

  /**
   * Clear cache.
   */
  clearCache() {
    this.cache.clear();
  }
}

/**
 * Create product sync service.
 */
export function createProductSync(client, options = {}) {
  if (!client) throw new Error('ERP client is required');
  return new ErpProductSync(client, options);
}
