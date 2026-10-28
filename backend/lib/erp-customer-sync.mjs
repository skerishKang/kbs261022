// ERP customer/trade-partner mapping
//
// Maps CGI customer data to iCount ERP trade partners.
// Supports read-only lookup and new trade partner creation.

import { EcountApiClient } from './erp-client.mjs';

export const ERP_CUSTOMER_SYNC_VERSION = '1.0.0';

/**
 * Convert CGI customer data to ERP trade partner format.
 * CGI: { id, name, email, phone, address, ... }
 * ERP: { tradeCode, tradeName, contact, phone, address, ... }
 */
export function customerToErpTradePartner(customer) {
  if (!customer || !customer.id) {
    throw new Error('Customer id is required');
  }

  // Generate trade partner code from customer ID
  // Format: CG-000001 (CGI prefix + zero-padded ID)
  const tradeCode = generateTradeCode(customer.id);

  // Parse address
  const addr = parseAddress(customer);

  return {
    tradeCode,
    tradeName: customer.name || customer.customer_name || '',
    contactName: customer.contactName || customer.name || '',
    tradeType: '0', // 0=customer, 1=supplier
    businessNo: customer.businessNo || '',
    phone: customer.phone || customer.customer_phone || '',
    mobile: customer.mobile || '',
    email: customer.email || customer.customer_email || '',
    address: addr.address || '',
    addressDetail: addr.detail || '',
    zipCode: addr.zip || '',
    city: addr.city || '',
    usageStatus: '0', // 0=active
    paymentTerm: customer.paymentTerm || '0',
    taxNo: customer.taxNo || '',
    // CGI reference fields
    _source: 'cgi-storefront',
    _sourceId: customer.id,
  };
}

/**
 * Generate trade partner code from customer ID.
 * Supports both numeric and string IDs.
 */
export function generateTradeCode(customerId) {
  const id = String(customerId || '');

  // If ID is numeric, zero-pad to 6 digits
  if (/^\d+$/.test(id)) {
    return `CG-${id.padStart(6, '0')}`;
  }

  // If ID has a prefix, use it
  const match = id.match(/^([a-zA-Z]+)[-:]?(\d+)$/);
  if (match) {
    return `CG-${match[2].padStart(6, '0')}`;
  }

  // Fallback: hash the ID
  const hash = simpleHash(id);
  return `CG-${hash.toString(36).toUpperCase().padStart(6, '0').slice(-6)}`;
}

/**
 * Simple hash function for generating trade codes.
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Parse address from CGI customer data.
 * Handles various address formats.
 */
function parseAddress(customer) {
  const result = { address: '', detail: '', zip: '', city: '' };

  // Direct address fields
  if (customer.address) {
    result.address = customer.address;
  }
  if (customer.customer_addr) {
    result.address = customer.customer_addr;
  }
  if (customer.addressDetail) {
    result.detail = customer.addressDetail;
  }
  if (customer.customer_addr_detail) {
    result.detail = customer.customer_addr_detail;
  }
  if (customer.zipCode || customer.zip) {
    result.zip = customer.zipCode || customer.zip;
  }
  if (customer.city) {
    result.city = customer.city;
  }

  // Try to parse from full address string
  if (!result.zip && result.address) {
    const match = result.address.match(/^(\d{3}-\d{3})\s*(.*)$/);
    if (match) {
      result.zip = match[1];
      result.address = match[2];
    }
  }

  return result;
}

/**
 * Convert ERP trade partner data to CGI customer format.
 */
export function erpTradePartnerToCgi(partnerData) {
  if (!partnerData) return null;
  return {
    id: partnerData._sourceId || partnerData.tradeCode,
    name: partnerData.tradeName || '',
    contact_name: partnerData.contactName || '',
    phone: partnerData.phone || '',
    mobile: partnerData.mobile || '',
    email: partnerData.email || '',
    address: partnerData.address || '',
    address_detail: partnerData.addressDetail || '',
    zip_code: partnerData.zipCode || '',
    city: partnerData.city || '',
    business_no: partnerData.businessNo || '',
    tax_no: partnerData.taxNo || '',
    erp_trade_code: partnerData.tradeCode || '',
  };
}

/**
 * ERP customer sync service.
 * Handles trade partner operations.
 */
export class ErpCustomerSync {
  constructor(client, options = {}) {
    if (!client) throw new Error('ERP client is required');
    this.client = client;
    this.cache = new Map();
    this.cacheTtlMs = options.cacheTtlMs || 300000;
  }

  /**
   * Lookup trade partner by code.
   */
  async lookupPartner(tradeCode) {
    const cacheKey = `partner:${tradeCode}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
      return cached.data;
    }

    const partner = await this.client.lookupTradePartner(tradeCode);
    this.cache.set(cacheKey, { data: partner, ts: Date.now() });
    return partner;
  }

  /**
   * Search trade partners by keyword.
   */
  async searchPartners(keyword, page = 1, limit = 50) {
    return this.client.searchTradePartners(keyword, page, limit);
  }

  /**
   * Sync customer to ERP (upsert trade partner).
   */
  async syncCustomer(customer) {
    const partner = customerToErpTradePartner(customer);
    const result = await this.client.upsertTradePartner(partner);
    this.cache.set(`partner:${partner.tradeCode}`, { data: result, ts: Date.now() });
    return result;
  }

  /**
   * Sync multiple customers to ERP.
   */
  async syncCustomers(customers, batchSize = 50) {
    if (!Array.isArray(customers) || customers.length === 0) {
      return { total: 0, success: 0, failed: 0, errors: [] };
    }

    const result = { total: customers.length, success: 0, failed: 0, errors: [] };

    for (let i = 0; i < customers.length; i += batchSize) {
      const batch = customers.slice(i, i + batchSize);
      for (const customer of batch) {
        try {
          await this.syncCustomer(customer);
          result.success++;
        } catch (e) {
          result.failed++;
          result.errors.push({ customerId: customer.id, error: e.message });
          if (e.message.includes('locked')) {
            result.errors.push({ error: 'Account locked - stopping sync' });
            return result;
          }
        }
      }
    }

    return result;
  }

  /**
   * Lookup customer by ID using trade code.
   */
  async lookupCustomer(customerId) {
    const tradeCode = generateTradeCode(customerId);
    try {
      const partner = await this.lookupPartner(tradeCode);
      return erpTradePartnerToCgi(partner);
    } catch (e) {
      return null;
    }
  }

  /**
   * Get cached partner count.
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
 * Create customer sync service.
 */
export function createCustomerSync(client, options = {}) {
  if (!client) throw new Error('ERP client is required');
  return new ErpCustomerSync(client, options);
}
