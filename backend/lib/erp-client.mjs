// Ecount ERP API client - real iCount OAPI wrapper
//
// This module implements the actual ERP API communication for iCount ERP.
// It supports login, item lookup, order transmission, and data sync.
//
// Security: Credentials are loaded from env, never logged or committed.
// The account may be locked - handle lockout gracefully without retrying.

import { ERP_ADAPTER, ERP_ADAPTER_VERSION } from './erp.mjs';

export const ERP_API_VERSION = '2.0.0';
export const ERP_SYSTEM = 'ecount';
export const ERP_LOGIN_ENDPOINT = '/api/login';
export const ERP_ITEM_ENDPOINT = '/api/item';
export const ERP_ORDER_ENDPOINT = '/api/sales-slip';
export const ERP_TRADE_ENDPOINT = '/api/trade-partner';

// Lockout detection patterns
const LOCKOUT_PATTERNS = [
  /계정.*잠금/i,
  /잠겼/i,
  /locked/i,
  /잠금/i,
  /block/i,
];

export function isLockoutMessage(message) {
  const str = String(message || '');
  return LOCKOUT_PATTERNS.some((p) => p.test(str));
}

/**
 * Ecount ERP API client.
 * Handles authentication, item operations, and order transmission.
 */
export class EcountApiClient {
  constructor(env = {}, fetchFn = fetch) {
    this.comCode = env.ECOUNT_COM_CODE || env.ERP_COM_CODE || '';
    this.userId = env.ECOUNT_USER_ID || env.ERP_USER_ID || '';
    this.password = env.ECOUNT_PASSWORD || env.ERP_PASSWORD || '';
    this.baseUrl = env.ERP_OAPI_BASE_URL || '';
    this.apiKey = env.ERP_OAPI_TOKEN || env.ECOUNT_API_KEY || '';
    this.fetchFn = fetchFn;
    this.sessionToken = null;
    this.locked = false;
    this.lockoutReason = null;
  }

  get available() {
    return Boolean(this.comCode && this.userId && this.password && this.baseUrl);
  }

  get ready() {
    return this.available && !this.locked;
  }

  /**
   * Login to iCount ERP.
   * Returns session token or throws on failure.
   * Detects account lockout and sets locked=true.
   */
  async login() {
    if (!this.available) {
      throw new Error('ERP credentials not configured (need comCode, userId, password, baseUrl)');
    }
    if (this.locked) {
      throw new Error(`ERP account locked: ${this.lockoutReason}`);
    }
    if (this.sessionToken) {
      return this.sessionToken;
    }

    try {
      const response = await this.fetchFn(`${this.baseUrl}${ERP_LOGIN_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          comCode: this.comCode,
          userId: this.userId,
          password: this.password,
        }),
      });

      let body = null;
      try { body = await response.json(); } catch (e) { body = { text: (await response.text()).slice(0, 500) }; }

      if (!response.ok) {
        const message = body?.message || body?.error || `HTTP ${response.status}`;
        if (isLockoutMessage(message)) {
          this.locked = true;
          this.lockoutReason = message;
          throw new Error(`ERP account locked: ${message}`);
        }
        throw new Error(`ERP login failed: ${message}`);
      }

      this.sessionToken = body.token || body.session || body.sessionToken;
      if (!this.sessionToken) {
        throw new Error('ERP login succeeded but no session token returned');
      }
      return this.sessionToken;
    } catch (e) {
      if (e.message.includes('account locked')) {
        throw e;
      }
      throw new Error(`ERP login error: ${e.message}`);
    }
  }

  /**
   * Make an authenticated API request.
   */
  async request(method, path, data = null) {
    if (this.locked) {
      throw new Error(`ERP account locked: ${this.lockoutReason}`);
    }
    if (!this.sessionToken) {
      await this.login();
    }

    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.sessionToken}`,
    };

    const init = {
      method,
      headers,
    };
    if (data && method !== 'GET') {
      init.body = JSON.stringify(data);
    }

    const response = await this.fetchFn(url, init);
    let body = null;
    try { body = await response.json(); } catch (e) { body = { text: (await response.text()).slice(0, 500) }; }

    if (!response.ok) {
      const message = body?.message || body?.error || `HTTP ${response.status}`;
      if (isLockoutMessage(message)) {
        this.locked = true;
        this.lockoutReason = message;
        this.sessionToken = null;
        throw new Error(`ERP account locked: ${message}`);
      }
      throw new Error(`ERP API error (${method} ${path}): ${message}`);
    }

    return body;
  }

  /**
   * Lookup item by code.
   */
  async lookupItem(itemCode) {
    return this.request('GET', `${ERP_ITEM_ENDPOINT}/${encodeURIComponent(itemCode)}`);
  }

  /**
   * Search items by keyword.
   */
  async searchItems(keyword, page = 1, limit = 50) {
    const qs = new URLSearchParams({ keyword, page: String(page), limit: String(limit) });
    return this.request('GET', `${ERP_ITEM_ENDPOINT}?${qs}`);
  }

  /**
   * Create or update item (master data sync).
   */
  async upsertItem(itemData) {
    return this.request('POST', ERP_ITEM_ENDPOINT, itemData);
  }

  /**
   * Create sales slip (order transmission).
   */
  async createSalesSlip(slipData) {
    return this.request('POST', ERP_ORDER_ENDPOINT, slipData);
  }

  /**
   * Lookup trade partner by code.
   */
  async lookupTradePartner(code) {
    return this.request('GET', `${ERP_TRADE_ENDPOINT}/${encodeURIComponent(code)}`);
  }

  /**
   * Search trade partners.
   */
  async searchTradePartners(keyword, page = 1, limit = 50) {
    const qs = new URLSearchParams({ keyword, page: String(page), limit: String(limit) });
    return this.request('GET', `${ERP_TRADE_ENDPOINT}?${qs}`);
  }

  /**
   * Create or update trade partner (customer sync).
   */
  async upsertTradePartner(partnerData) {
    return this.request('POST', ERP_TRADE_ENDPOINT, partnerData);
  }

  /**
   * Get inventory levels for items.
   */
  async getInventory(itemCodes = []) {
    if (!itemCodes.length) return { items: [] };
    return this.request('POST', '/api/inventory', { itemCodes });
  }

  /**
   * Get prices for items.
   */
  async getPrices(itemCodes = []) {
    if (!itemCodes.length) return { items: [] };
    return this.request('POST', '/api/price', { itemCodes });
  }

  /**
   * Reset session (logout).
   */
  reset() {
    this.sessionToken = null;
    this.locked = false;
    this.lockoutReason = null;
  }
}

/**
 * Create ERP API client from env.
 */
export function createErpClient(env = {}, fetchFn = fetch) {
  return new EcountApiClient(env, fetchFn);
}
