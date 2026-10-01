import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as orderNotesBoard from './orderNotesBoard.js';

const { mergedCardsByTime } = orderNotesBoard;

describe('mergedCardsByTime', () => {
  it('preserves stable ties, invalid-date ordering and full source groups', () => {
    const rows = [
      { id: 'late', created_at: '2026-07-06T13:00:00' },
      { id: 'bad-a', created_at: 'invalid' },
      { id: 'tie-a', created_at: '2026-07-06T11:00:00' },
      { id: 'bad-b', created_at: 'invalid' },
      { id: 'tie-b', created_at: '2026-07-06T11:00:00' },
    ];
    const result = mergedCardsByTime({ All: rows }, ['All']);
    expect(result.map(row => row.id)).toEqual(['bad-a', 'bad-b', 'tie-a', 'tie-b', 'late']);
    expect(rows.map(row => row.id)).toEqual(['late', 'bad-a', 'tie-a', 'bad-b', 'tie-b']);
    expect(new Set(result)).toEqual(new Set(rows));
  });
  const groups = {
    Takeaway: [
      { id: 'a', created_at: '2026-07-06T10:05:00' },
      { id: 'b', created_at: '2026-07-06T10:01:00' },
    ],
    Delivery: [
      { id: 'c', created_at: '2026-07-06T09:00:00', delivery_date: '2026-07-06T13:03:00' },
    ],
  };
  const columns = ['Takeaway', 'Delivery'];

  it('merges all columns into one list sorted ascending by time', () => {
    expect(mergedCardsByTime(groups, columns).map((o) => o.id)).toEqual(['b', 'c', 'a']);
  });
  it('prefers delivery_date over created_at when present', () => {
    // c is ordered by its delivery_date (13:03 business time / 10:03 UTC), between b (10:01) and a (10:05)
    expect(mergedCardsByTime(groups, columns)[1].id).toBe('c');
  });
  it('ignores missing/undefined columns and invalid dates', () => {
    const g = { X: [{ id: 'z', created_at: 'not-a-date' }], Y: undefined };
    expect(mergedCardsByTime(g, ['X', 'Y', 'Z']).map((o) => o.id)).toEqual(['z']);
  });
  it('does not mutate the input column arrays', () => {
    const snapshot = groups.Takeaway.map((o) => o.id);
    mergedCardsByTime(groups, columns);
    expect(groups.Takeaway.map((o) => o.id)).toEqual(snapshot);
  });
});

describe('buildOrderTypeBoard', () => {
  it('keeps orders without a type out of the first configured type', () => {
    const board = orderNotesBoard.buildOrderTypeBoard?.([
      { id: 'typed', order_type_name: 'طلبات', created_at: '2026-07-16T10:02:00' },
      { id: 'missing', order_type_name: null, created_at: '2026-07-16T10:01:00' },
      { id: 'legacy', order_type_name: 'قديم', created_at: '2026-07-16T10:03:00' },
    ], ['طلبات', 'توصيل'], 'غير محدد') ?? {};

    expect(board.columns).toEqual(['طلبات', 'توصيل', 'قديم', 'غير محدد']);
    expect(board.groups?.['طلبات']?.map((order) => order.id)).toEqual(['typed']);
    expect(board.groups?.['غير محدد']?.map((order) => order.id)).toEqual(['missing']);
    expect(board.groups?.['قديم']?.map((order) => order.id)).toEqual(['legacy']);
  });
});

describe('phone-source filtering', () => {
  const rows = [
    { id: 1, order_type_name: 'Delivery', call_center_user_id: 70 },
    { id: 2, order_type_name: 'Delivery', call_center_user_id: null },
    { id: 3, order_type_name: 'Takeaway' },
  ];

  it('filters source independently from order type', () => {
    expect(orderNotesBoard.filterOrdersBySource(rows, 'phone').map(row => row.id)).toEqual([1]);
    expect(orderNotesBoard.filterOrdersBySource(rows, 'other').map(row => row.id)).toEqual([2, 3]);
    expect(orderNotesBoard.filterOrdersBySource(rows, 'all').map(row => row.id)).toEqual([1, 2, 3]);
  });
});

describe('platform settlement board helpers', () => {
  it('summarizes every held platform order regardless of kitchen printing', () => {
    const summary = orderNotesBoard.platformSettlementSummary?.([
      { id: 1, isHeld: true, total: 5.8, raw_held_data: { kitchen_fired: 1 } },
      { id: 2, isHeld: true, total: 2.5, raw_held_data: { kitchen_fired: 0 } },
      { id: 3, isHeld: false, total: 99, raw_held_data: { kitchen_fired: 1 } },
      { id: 4, isHeld: true, total: 1.1, raw_held_data: { kitchen_fired: '1' } },
    ]) ?? {};

    expect(summary.held?.map((order) => order.id)).toEqual([1, 2, 4]);
    expect(summary.count).toBe(3);
    expect(summary.total).toBe(9.4);
  });

  it('prints each newly settled receipt and reports failures without retrying duplicates', async () => {
    const attempted = [];
    const result = await orderNotesBoard.printSettledReceipts?.([
      { invoice_id: 10, duplicate: false },
      { invoice_id: 11, duplicate: true },
      { invoice_id: 12, duplicate: false },
    ], async ({ invoice_id, print_request_id }) => {
      expect(print_request_id).toBe(`checkout-receipt:${invoice_id}:primary`);
      attempted.push(invoice_id);
      return invoice_id === 10;
    });

    expect(attempted).toEqual([10, 12]);
    expect(result).toEqual({ attempted: 2, failed: 1 });
  });

  it('wires the held-order summary and close-and-print action into desktop and mobile views', () => {
    const source = readFileSync(new URL('../components/OrderNotes.vue', import.meta.url), 'utf8');
    expect(source).toContain('notes-platform-mobile');
    expect(source).toContain('.notes-platform-mobile {');
    expect(source).toContain("$t('Close & print')");
    expect(source).not.toContain("$t('Fire orders first')");
    expect(source).not.toContain('notes-platform-close--blocked');
    expect(source).not.toContain('notes-platform-mobile__action--blocked');
    expect(source).toContain('.notes-platform-close:not(:disabled)');
    expect(source).toContain('platformSettlementSummary');
    expect(source).toContain('printSettledReceipts');
  });

  it('exposes legacy kitchen-baseline review state instead of offering unsafe follow-ups', () => {
    const notesSource = readFileSync(new URL('../components/OrderNotes.vue', import.meta.url), 'utf8');
    const cardSource = readFileSync(new URL('../components/OrderNoteCard.vue', import.meta.url), 'utf8');
    const cartSource = readFileSync(new URL('../components/pos/PosCartWorkspace.vue', import.meta.url), 'utf8');

    expect(notesSource).toContain('baselineUnknown');
    expect(cardSource).toContain("$t('Kitchen review')");
    expect(cartSource).toContain('confirmHeldKitchenBaseline');
    expect(cartSource).toContain("$t('Confirm kitchen baseline')");
    expect(cartSource).toContain('!isHeldBaselineUnknown');
  });

  it('recovers a lost claim response from the server instead of treating the recovery envelope as a cart', () => {
    const terminalSource = readFileSync(new URL('../components/PosTerminal.vue', import.meta.url), 'utf8');
    expect(terminalSource).toContain('readHeldOrderHandoff');
    expect(terminalSource).toContain('claimHeldOrder');
    expect(terminalSource).toContain('clearHeldOrderHandoff');
    expect(terminalSource).not.toContain('cart.restoreHeldOrder(Array.isArray(restoredHeldOrder)');
  });

  it('shows active claim ownership and requires an explicit kitchen-baseline confirmation', () => {
    const notesSource = readFileSync(new URL('../components/OrderNotes.vue', import.meta.url), 'utf8');
    const cardSource = readFileSync(new URL('../components/OrderNoteCard.vue', import.meta.url), 'utf8');
    const cartSource = readFileSync(new URL('../components/pos/PosCartWorkspace.vue', import.meta.url), 'utf8');
    expect(cardSource).toContain('claimIsActive');
    expect(cardSource).toContain('claim_owner_name');
    expect(cardSource).toContain("$t('Being edited')");
    expect(cartSource).toContain('showPosConfirm');
    expect(cartSource).toContain("t('I verified that the current items were already sent to the kitchen.')");
  });

  it('shows original phone source without inventing held lifecycle state in paid history', () => {
    const notesSource = readFileSync(new URL('../components/OrderNotes.vue', import.meta.url), 'utf8');
    const cardSource = readFileSync(new URL('../components/OrderNoteCard.vue', import.meta.url), 'utf8');
    expect(notesSource).toContain('sourceFilter');
    expect(notesSource).toContain('filterOrdersBySource');
    expect(notesSource).toContain('call_center_user_name');
    expect(notesSource).toContain("isTableOrDineInName(o.order_type_name) && !o.call_center_user_id");
    expect(notesSource).toContain('v-if="!selectedOrder.isHeld || !selectedOrder.call_center_user_id"');
    expect(cardSource).toContain('callCenterSourceName');
    expect(cardSource).toContain("order.isHeld && order.call_center_user_id");
    expect(cardSource).toContain("'note-card__source--history': !order.isHeld");
  });

  it('labels a restored hold action as saving changes instead of creating a new hold', () => {
    const checkoutSource = readFileSync(new URL('../components/pos/CheckoutModal.vue', import.meta.url), 'utf8');
    expect(checkoutSource).toContain("restoredHeldOrder ? $t('Save changes') : $t('Hold')");
  });
});
