// Pure money / cart arithmetic. No I/O, no globals — fully unit-testable.
// All amounts are INTEGER KRW. Prices in the catalog are VAT-inclusive
// (Ecount mapping: out_price_vat = 1), so supplied_amount = total / 1.1.

export const DEFAULT_VAT_RATE = 0.1;
export const ORDER_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

/** Coerce to a non-negative integer, falling back when not a finite number. */
export function toNonNegInt(value, fallback = 0) {
  let n;
  if (value === null || value === undefined || value === '') {
    n = NaN;
  } else if (typeof value === 'number') {
    n = value;
  } else {
    const cleaned = String(value).replace(/[^\d.-]/g, '');
    n = cleaned === '' ? NaN : Number(cleaned);
  }
  n = Math.round(n);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Split a VAT-inclusive total into supplied amount (공급가액) and VAT. */
export function splitTax(totalAmount, vatRate = DEFAULT_VAT_RATE) {
  const total = toNonNegInt(totalAmount);
  const rate = Number(vatRate);
  if (!Number.isFinite(rate) || rate <= 0) return { suppliedAmount: total, vatAmount: 0 };
  const supplied = Math.round(total / (1 + rate));
  return { suppliedAmount: supplied, vatAmount: total - supplied };
}

/** FNV-1a over a string, returned as 8 hex chars. Stable across runtimes. */
export function hash32(input) {
  let h = 0x811c9dc5;
  const s = String(input == null ? '' : input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Fingerprint of a cart: product ids + quantities, order independent.
 * Used to detect duplicate submissions of the same cart.
 */
export function cartHash(items) {
  const parts = (Array.isArray(items) ? items : []).map((item) => {
    const id = String(item.product_id != null ? item.product_id : item.id != null ? item.id : '');
    const qty = toNonNegInt(item.qty, 1) || 1;
    return `${id}|${qty}`;
  });
  parts.sort();
  return hash32(parts.join(';'));
}

/**
 * Compute order totals from normalized line items.
 *
 * Each input item: { qty, unit_price } (unit_price may be null when the price
 * is not confirmed — "inquiry" products). A line without a unit price
 * contributes 0 to the total and makes the whole order non-payable.
 */
export function computeTotals(items, options = {}) {
  const vatRate = Number(options.vatRate) || DEFAULT_VAT_RATE;
  const shippingFee = toNonNegInt(options.shippingFee);
  const list = Array.isArray(items) ? items : [];

  let itemTotal = 0;
  const lines = list.map((item, index) => {
    const qty = Math.max(1, toNonNegInt(item.qty, 1));
    const hasPrice = item.unit_price !== null && item.unit_price !== undefined;
    const unitPrice = hasPrice ? toNonNegInt(item.unit_price) : null;
    const lineTotal = unitPrice === null ? 0 : unitPrice * qty;
    if (unitPrice !== null) itemTotal += lineTotal;
    return { seq: index + 1, unit_price: unitPrice, qty, line_total: lineTotal, payable: unitPrice !== null };
  });

  const totalAmount = itemTotal + shippingFee;
  const { suppliedAmount, vatAmount } = splitTax(totalAmount, vatRate);

  return {
    lines,
    item_total: itemTotal,
    shipping_fee: shippingFee,
    total_amount: totalAmount,
    supplied_amount: suppliedAmount,
    vat_amount: vatAmount,
    payable: lines.length > 0 && lines.every((line) => line.payable),
  };
}

/**
 * Decide the order kind from its items.
 * A purchase (payment possible) requires every item to have a confirmed price
 * and a positive total. Anything else falls back to a quote request.
 */
export function decideKind(items, options = {}) {
  const totals = computeTotals(items, options);
  return totals.payable && totals.total_amount > 0 ? 'purchase' : 'quote';
}

function randomPart(len, randomFn) {
  const alphabet = ORDER_ID_ALPHABET;
  const bytes = new Uint8Array(len);
  const filled = randomFn(bytes);
  // Supports both in-place fillers (crypto.getRandomValues) and returning fillers (tests).
  const source = filled && typeof filled.length === 'number' && filled.length >= len ? filled : bytes;
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[source[i] % alphabet.length];
  return out;
}

/**
 * Order id, e.g. "ORD-20261024-K7M2P".
 * Also used as the PG orderId, so it must satisfy Toss's rule:
 * 6-64 chars of [A-Za-z0-9-_] -> 18 chars here.
 * Inject `now` / `randomFn` for deterministic tests.
 */
export function nextOrderId(now = new Date(), randomFn = (buf) => crypto.getRandomValues(buf)) {
  const d = now instanceof Date ? now : new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `ORD-${y}${m}${day}-${randomPart(5, randomFn)}`;
}

/** Validate a PG/order id against Toss's orderId rules. */
export function isValidPgOrderId(orderId) {
  return typeof orderId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(orderId);
}

/** Build a short unique idempotency key for PG calls (<= 300 chars). */
export function pgIdempotencyKey(action, orderId, extra = '') {
  return `cgi:${action}:${orderId}:${hash32(extra)}`.slice(0, 300);
}
