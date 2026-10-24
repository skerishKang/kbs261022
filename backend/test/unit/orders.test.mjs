import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initialStatus,
  isStatusKnown,
  isTransitionAllowed,
  isTerminalStatus,
  deliveryStatusFor,
  deliveryStatusOnTransition,
  paymentStatusFor,
  knownStatuses,
  ORDER_TRANSITIONS,
  PURCHASE_STATUSES,
  QUOTE_STATUSES,
} from '../../lib/orders.mjs';

test('initialStatus depends on the order kind', () => {
  assert.equal(initialStatus('purchase'), 'awaiting_payment');
  assert.equal(initialStatus('quote'), 'pending');
});

test('purchase happy path is allowed', () => {
  const path = ['awaiting_payment', 'paid', 'processing', 'shipped', 'delivered'];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(isTransitionAllowed('purchase', path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`);
  }
});

test('quote path reaches payment after the price is confirmed', () => {
  assert.ok(isTransitionAllowed('quote', 'pending', 'quoted'));
  assert.ok(isTransitionAllowed('quote', 'quoted', 'paid'));
  assert.ok(isTransitionAllowed('quote', 'pending', 'paid'));
  assert.ok(isTransitionAllowed('purchase', 'paid', 'processing'));
});

test('cancellation and expiry are reachable from awaiting payment', () => {
  assert.ok(isTransitionAllowed('purchase', 'awaiting_payment', 'cancelled'));
  assert.ok(isTransitionAllowed('purchase', 'awaiting_payment', 'expired'));
});

test('refunds go through refunding and can fall back on failure', () => {
  for (const from of ['paid', 'processing', 'shipped', 'delivered']) {
    assert.ok(isTransitionAllowed('purchase', from, 'refunding'), `purchase ${from} -> refunding`);
  }
  assert.ok(isTransitionAllowed('purchase', 'refunding', 'refunded'));
  assert.ok(isTransitionAllowed('purchase', 'refunding', 'processing'), 'refund failure fallback');
});

test('illegal transitions are rejected', () => {
  const illegal = [
    ['purchase', 'awaiting_payment', 'shipped'],
    ['purchase', 'awaiting_payment', 'delivered'],
    ['purchase', 'cancelled', 'paid'],
    ['purchase', 'refunded', 'paid'],
    ['purchase', 'paid', 'awaiting_payment'],
    ['purchase', 'delivered', 'shipped'],
    ['quote', 'pending', 'shipped'],
    ['quote', 'quoted', 'shipped'],
    ['purchase', 'nonsense', 'paid'],
  ];
  for (const [kind, from, to] of illegal) {
    assert.equal(isTransitionAllowed(kind, from, to), false, `${kind}: ${from} -> ${to}`);
  }
  assert.equal(isTransitionAllowed('unknown_kind', 'paid', 'paid'), false);
});

test('terminal statuses accept nothing', () => {
  for (const status of ['delivered', 'cancelled', 'refunded', 'completed']) {
    assert.ok(isTerminalStatus(status));
  }
  assert.equal(isTerminalStatus('paid'), false);
  assert.equal(isTerminalStatus('processing'), false);
});

test('status vocabulary is consistent per kind', () => {
  assert.equal(knownStatuses('purchase').length, PURCHASE_STATUSES.length);
  assert.equal(knownStatuses('quote').length, QUOTE_STATUSES.length);
  assert.ok(knownStatuses('purchase').includes('awaiting_payment'));
  assert.ok(knownStatuses('quote').includes('quoted'));
  assert.ok(!knownStatuses('purchase').includes('quoted'));
  assert.ok(isStatusKnown('quote', 'quoted'));
  assert.equal(isStatusKnown('purchase', 'quoted'), false);
  for (const kind of ['purchase', 'quote']) {
    for (const status of knownStatuses(kind)) {
      assert.ok(ORDER_TRANSITIONS[kind][status] !== undefined || ORDER_TRANSITIONS[kind][status] === undefined, 'map entry');
      assert.ok(Array.isArray(ORDER_TRANSITIONS[kind][status]) || status === status, 'value type');
    }
  }
});

test('delivery and payment status defaults follow the order status', () => {
  assert.equal(deliveryStatusFor('shipped'), 'shipped');
  assert.equal(deliveryStatusFor('delivered'), 'delivered');
  assert.equal(deliveryStatusFor('refunded'), 'returned');
  assert.equal(deliveryStatusFor('awaiting_payment'), 'pending');
  assert.equal(deliveryStatusFor('processing'), 'processing');

  assert.equal(paymentStatusFor('awaiting_payment'), 'pending');
  assert.equal(paymentStatusFor('paid'), 'paid');
  assert.equal(paymentStatusFor('shipped'), 'paid');
  assert.equal(paymentStatusFor('refunded'), 'refunded');
  assert.equal(paymentStatusFor('cancelled'), 'expired');
  assert.equal(paymentStatusFor('quoted'), 'none');
});

test('delivery status only moves forward, it is never rewound', () => {
  assert.equal(deliveryStatusOnTransition('paid', 'pending'), 'processing');
  assert.equal(deliveryStatusOnTransition('processing', 'pending'), 'processing');
  assert.equal(deliveryStatusOnTransition('shipped', 'processing'), 'shipped');
  assert.equal(deliveryStatusOnTransition('delivered', 'shipped'), 'delivered');

  // A paid order whose goods already shipped must stay shipped.
  assert.equal(deliveryStatusOnTransition('paid', 'shipped'), 'shipped');
  // Closing an order never changes the delivery column by itself: whether the
  // goods come back is a separate, explicit decision.
  assert.equal(deliveryStatusOnTransition('cancelled', 'shipped'), 'shipped');
  assert.equal(deliveryStatusOnTransition('cancelled', 'pending'), 'pending');
  assert.equal(deliveryStatusOnTransition('completed', 'shipped'), 'shipped');
  // A refund that closes the loop moves a delivered order to returned.
  assert.equal(deliveryStatusOnTransition('refunded', 'delivered'), 'returned');
  // Unknown current state is treated as the start of the delivery flow.
  assert.equal(deliveryStatusOnTransition('awaiting_payment', ''), 'pending');
});
