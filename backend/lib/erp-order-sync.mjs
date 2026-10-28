// ERP order transmission - sales slip creation via iCount API
//
// Transmits orders to ERP using the real API client.
// Handles:
// - Order payload construction
// - Sales slip creation
// - Idempotency via dedupe keys
// - Lockout detection and graceful failure

import { EcountApiClient } from './erp-client.mjs';
import {
  ERP_ADAPTER,
  ERP_ADAPTER_VERSION,
  ERP_ACTION_SALES_SLIP,
  buildEcountSalesSlip,
  erpDedupeKey,
} from './erp.mjs';
import { generateTradeCode } from './erp-customer-sync.mjs';

export const ERP_ORDER_SYNC_VERSION = '1.0.0';

/**
 * ERP order transmission service.
 * Sends orders to iCount ERP as sales slips.
 */
export class ErpOrderSync {
  constructor(client, options = {}) {
    if (!client) throw new Error('ERP client is required');
    this.client = client;
    this.options = options;
    this.dryRun = options.dryRun || false;
  }

  /**
   * Transmit order to ERP.
   * @param {Object} order - Order data from CGI
   * @param {Array} items - Order items
   * @param {Object} options - Additional options
   * @returns {Object} Transmission result
   */
  async transmitOrder(order, items, options = {}) {
    if (!order || !order.id) {
      return {
        delivered: false,
        status: 'error',
        error: 'Order id is required',
      };
    }

    // Check if account is locked
    if (this.client.locked) {
      return {
        delivered: false,
        status: 'skipped',
        error: `ERP account locked: ${this.client.lockoutReason}`,
        lockout: true,
      };
    }

    // Build the sales slip payload
    const payload = buildEcountSalesSlip({
      order,
      items,
      mode: options.mode || 'live',
      liveWrite: !this.dryRun && !this.client.locked,
      generatedAt: options.generatedAt || new Date(),
    });

    // Add dedupe key for idempotency
    payload.idempotency_key = options.dedupeKey || erpDedupeKey(order.id, ERP_ACTION_SALES_SLIP);

    // In dry-run mode, just return the payload
    if (this.dryRun) {
      return {
        delivered: false,
        status: 'dry_run',
        payload,
        note: 'Dry run mode - no data transmitted to ERP',
      };
    }

    // Try to transmit
    try {
      // Ensure trade partner exists
      let tradePartnerCode = null;
      if (order.customer_id) {
        tradePartnerCode = generateTradeCode(order.customer_id);
      }

      // Prepare the sales slip data for API
      const slipData = this.buildSlipData(payload, tradePartnerCode);

      // Transmit to ERP
      const result = await this.client.createSalesSlip(slipData);

      return {
        delivered: true,
        status: 'sent',
        erp_slip_no: result.slipNo || result.orderNo || null,
        erp_response: result,
        dedupe_key: payload.idempotency_key,
      };
    } catch (e) {
      const isLockout = e.message.includes('locked');
      return {
        delivered: false,
        status: isLockout ? 'locked' : 'failed',
        error: e.message,
        lockout: isLockout,
        dedupe_key: payload.idempotency_key,
        payload: this.dryRun ? payload : undefined,
      };
    }
  }

  /**
   * Build sales slip data for ERP API.
   * Converts the internal payload format to the API format.
   */
  buildSlipData(payload, tradePartnerCode) {
    const lines = payload.lines.map((line) => ({
      seq: line.seq,
      prodCd: line.prod_cd,
      prodDes: line.prod_des,
      qty: line.qty,
      outPrice: line.out_price,
      outPriceVat: line.out_price_vat,
      vatRate: line.vat_rate,
      amt: line.amt,
      remark: line.remark,
    }));

    return {
      slipNo: payload.source.order_id,
      slipDate: this.formatDate(payload.source.created_at),
      tradeCode: tradePartnerCode || payload.customer.customer_name,
      tradeName: payload.customer.customer_name,
      payMethod: payload.payment.payment_method || '0',
      payDate: payload.payment.paid_at ? this.formatDate(payload.payment.paid_at) : this.formatDate(new Date()),
      amount: payload.totals.total_amount,
      suppliedAmount: payload.totals.supplied_amount,
      vatAmount: payload.totals.vat_amount,
      note: payload.note || payload.admin_note,
      idempotencyKey: payload.idempotency_key,
      lines,
    };
  }

  /**
   * Format date for ERP (YYYYMMDD).
   */
  formatDate(date) {
    if (!date) return this.formatDate(new Date());
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  /**
   * Transmit multiple orders.
   */
  async transmitOrders(orders, batchSize = 10) {
    const result = { total: orders.length, sent: 0, failed: 0, skipped: 0, errors: [] };

    for (let i = 0; i < orders.length; i += batchSize) {
      const batch = orders.slice(i, i + batchSize);
      for (const { order, items } of batch) {
        try {
          const transResult = await this.transmitOrder(order, items);
          if (transResult.delivered) {
            result.sent++;
          } else if (transResult.status === 'skipped' || transResult.status === 'dry_run') {
            result.skipped++;
          } else {
            result.failed++;
            result.errors.push({ orderId: order.id, error: transResult.error });
          }
          if (transResult.lockout) {
            result.errors.push({ error: 'Account locked - stopping transmission' });
            return result;
          }
        } catch (e) {
          result.failed++;
          result.errors.push({ orderId: order.id, error: e.message });
        }
      }
    }

    return result;
  }

  /**
   * Build test payload without transmitting (for verification).
   */
  buildTestPayload(order, items) {
    return buildEcountSalesSlip({
      order,
      items,
      mode: 'test',
      liveWrite: false,
    });
  }
}

/**
 * Create order sync service.
 */
export function createOrderSync(client, options = {}) {
  if (!client) throw new Error('ERP client is required');
  return new ErpOrderSync(client, options);
}

/**
 * ERP transmission factory.
 * Creates the appropriate sync service based on mode.
 */
export function createErpSyncService(env = {}, fetchFn = fetch) {
  const client = new EcountApiClient(env, fetchFn);
  const dryRun = String(env.ERP_DRY_RUN || 'NO').toUpperCase() === 'YES';
  const orderSync = createOrderSync(client, { dryRun });

  return {
    client,
    orderSync,
    dryRun,
    ready: client.ready,
    locked: client.locked,
    available: client.available,
  };
}
