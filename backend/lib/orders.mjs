// Order / payment / delivery state machines. Pure data, no I/O.

/** Purchase order statuses (payment path). */
export const PURCHASE_STATUSES = [
  'awaiting_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'refunding',
  'refunded',
  'cancelled',
  'expired',
];

/** Quote order statuses (no payment until the price is confirmed). */
export const QUOTE_STATUSES = [
  'pending',
  'quoted',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'refunding',
  'refunded',
  'cancelled',
  'completed',
];

/**
 * Allowed status transitions per order kind.
 *
 * purchase: awaiting_payment -> paid -> processing -> shipped -> delivered
 *           cancelled / expired reachable from awaiting_payment
 *           refunding -> refunded (back to processing when the refund fails)
 * quote:    pending -> quoted -> paid (price confirmed & paid) -> fulfillment
 *           pending -> paid      (price confirmed by staff, then paid)
 *           quoted -> cancelled  completed = closed with no fulfillment
 */
export const ORDER_TRANSITIONS = {
  purchase: {
    awaiting_payment: ['paid', 'cancelled', 'expired'],
    paid: ['processing', 'shipped', 'refunding', 'cancelled'],
    processing: ['shipped', 'delivered', 'refunding', 'cancelled'],
    shipped: ['delivered', 'refunding', 'cancelled'],
    delivered: ['refunding'],
    refunding: ['refunded', 'processing'],
    refunded: [],
    cancelled: [],
    expired: [],
  },
  quote: {
    pending: ['quoted', 'paid', 'cancelled'],
    quoted: ['paid', 'cancelled'],
    paid: ['processing', 'shipped', 'refunding', 'cancelled'],
    processing: ['shipped', 'delivered', 'refunding', 'cancelled'],
    shipped: ['delivered', 'refunding', 'cancelled'],
    delivered: ['refunding'],
    refunding: ['refunded', 'processing'],
    refunded: [],
    cancelled: [],
    completed: [],
  },
};

/** Initial status for a newly created order of a given kind. */
export function initialStatus(kind) {
  return kind === 'purchase' ? 'awaiting_payment' : 'pending';
}

export function knownStatuses(kind) {
  return kind === 'purchase' ? PURCHASE_STATUSES : QUOTE_STATUSES;
}

export function isStatusKnown(kind, status) {
  return knownStatuses(kind).includes(status);
}

export function isTerminalStatus(status) {
  return status === 'delivered' || status === 'cancelled' || status === 'refunded' || status === 'completed';
}

export function isTransitionAllowed(kind, from, to) {
  const map = ORDER_TRANSITIONS[kind];
  if (!map) return false;
  const allowed = map[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export const PAYMENT_STATUSES = [
  'none',
  'pending',
  'paid',
  'failed',
  'expired',
  'partial_refunded',
  'refunded',
];

export const DELIVERY_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'returned'];

/** Delivery status implied by an order status (best-effort default). */
export function deliveryStatusFor(orderStatus) {
  if (orderStatus === 'shipped') return 'shipped';
  if (orderStatus === 'delivered') return 'delivered';
  if (orderStatus === 'refunded' || orderStatus === 'cancelled' || orderStatus === 'completed') return 'returned';
  if (orderStatus === 'processing' || orderStatus === 'paid') return 'processing';
  return 'pending';
}

const DELIVERY_PROGRESS = { pending: 0, processing: 1, shipped: 2, delivered: 3, returned: 4 };

/**
 * Delivery status to apply after an order status change.
 *
 * Only monotonic progress is applied. A status that implies a step already
 * passed (e.g. "paid" after the goods were shipped) must not rewind the
 * delivery column. Closing an order ("cancelled", "completed") never changes
 * the delivery column either: whether the goods actually came back is a
 * separate, explicit decision.
 */
export function deliveryStatusOnTransition(orderStatus, currentDeliveryStatus) {
  if (orderStatus === 'cancelled' || orderStatus === 'completed') return currentDeliveryStatus || 'pending';
  const implied = deliveryStatusFor(orderStatus);
  const current = currentDeliveryStatus || 'pending';
  if ((DELIVERY_PROGRESS[implied] ?? -1) < (DELIVERY_PROGRESS[current] ?? -1)) return current;
  return implied;
}

/** Payment status implied by an order status change. */
export function paymentStatusFor(orderStatus) {
  if (orderStatus === 'awaiting_payment') return 'pending';
  if (orderStatus === 'paid' || orderStatus === 'processing' || orderStatus === 'shipped' || orderStatus === 'delivered') return 'paid';
  if (orderStatus === 'refunding') return 'paid';
  if (orderStatus === 'refunded') return 'refunded';
  if (orderStatus === 'cancelled' || orderStatus === 'expired') return 'expired';
  if (orderStatus === 'quoted' || orderStatus === 'pending') return 'none';
  return 'none';
}

export const ORDER_STATUS_LABELS = {
  awaiting_payment: '결제 대기',
  paid: '결제 완료',
  processing: '처리 중',
  shipped: '배송 중',
  delivered: '배송 완료',
  refunding: '환불 처리 중',
  refunded: '환불 완료',
  cancelled: '취소',
  expired: '만료',
  pending: '접수 대기',
  quoted: '견적 고지',
  completed: '완료',
};

export const PAYMENT_STATUS_LABELS = {
  none: '미결제',
  pending: '결제 대기',
  paid: '결제 완료',
  failed: '결제 실패',
  expired: '결제 만료',
  partial_refunded: '부분 환불',
  refunded: '환불 완료',
};

export const ERP_SYNC_STATUSES = ['pending', 'sent', 'confirmed', 'failed', 'skipped'];
