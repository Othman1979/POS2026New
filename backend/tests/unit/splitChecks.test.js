import { describe, expect, it } from 'vitest';

const loadSplitChecks = () => import('@/pos/stores/orderSession/splitChecks.js');
const ids = (() => {
  let next = 0;
  return () => `split-${++next}`;
})();

describe('splitChecks', () => {
  it('previews 4.75 halves as complementary cents', async () => {
    const { buildSplitPreview } = await loadSplitChecks();
    const preview = buildSplitPreview({
      seats: [
        { id: 1, items: [{ price: 4.75, qty: 0.5, tax_rate: 16 }] },
        { id: 2, items: [{ price: 4.75, qty: 0.5, tax_rate: 16 }] },
      ],
      unassignedItems: [],
      parentTotals: { subtotal: 4.75, discount: 0, tax: 0, total: 4.75 },
      orderDiscount: null,
      taxInclusive: true,
    });

    expect(preview.buckets.map((bucket) => bucket.totalCents)).toEqual([238, 237]);
    expect(preview.buckets.map((bucket) => bucket.itemTotalCents[0])).toEqual([238, 237]);
  });

  it('allocates complementary cents between fractional rows still unassigned', async () => {
    const { buildSplitPreview } = await loadSplitChecks();
    const preview = buildSplitPreview({
      seats: [{ id: 1, items: [] }, { id: 2, items: [] }],
      unassignedItems: [
        { price: 4.75, qty: 0.5, tax_rate: 16 },
        { price: 4.75, qty: 0.5, tax_rate: 16 },
      ],
      parentTotals: { subtotal: 4.75, discount: 0, tax: 0, total: 4.75 },
      orderDiscount: null,
      taxInclusive: true,
    });

    expect(preview.byId.get('unassigned').itemTotalCents).toEqual([238, 237]);
    expect(preview.byId.get('unassigned').totalCents).toBe(475);
  });

  it('previews fixed discount and service-charge cents without allocating empty seats', async () => {
    const { buildSplitPreview } = await loadSplitChecks();
    const preview = buildSplitPreview({
      seats: [
        { id: 1, items: [{ price: 10, qty: 1, tax_rate: 0 }] },
        { id: 2, items: [{ price: 20, qty: 1, tax_rate: 0 }] },
        { id: 3, items: [] },
      ],
      unassignedItems: [],
      parentTotals: { subtotal: 33, discount: 3, tax: 0, total: 30 },
      orderDiscount: { type: 'fixed', value: 3 },
      serviceChargeSnapshot: { percentage: 10 },
      serviceChargeLine: { price: 3, qty: 1, note: 'Auto-Gratuity', tax_rate: 0 },
      taxInclusive: false,
    });

    expect(preview.buckets.map((bucket) => bucket.id)).toEqual([1, 2]);
    expect(preview.buckets.map((bucket) => bucket.serviceChargeCents)).toEqual([100, 200]);
    expect(preview.buckets.map((bucket) => bucket.discountCents)).toEqual([100, 200]);
    expect(preview.buckets.map((bucket) => bucket.totalCents)).toEqual([1000, 2000]);
  });

  it('uses backend-rounded percent-discount weights before the stable tie-break', async () => {
    const { buildSplitPreview } = await loadSplitChecks();
    const preview = buildSplitPreview({
      seats: [
        { id: 1, items: [{ price: 0.05, qty: 1, tax_rate: 0 }] },
        { id: 2, items: [{ price: 0.09, qty: 1, tax_rate: 0 }] },
      ],
      unassignedItems: [],
      parentTotals: { subtotal: 0.14, discount: 0.01, tax: 0, total: 0.13 },
      orderDiscount: { type: 'percent', value: 10 },
      taxInclusive: true,
    });

    expect(preview.buckets.map((bucket) => bucket.discountCents)).toEqual([1, 0]);
    expect(preview.buckets.map((bucket) => bucket.totalCents)).toEqual([4, 9]);
  });

  it('returns an empty preview safely while the modal initializes', async () => {
    const { buildSplitPreview } = await loadSplitChecks();
    const preview = buildSplitPreview({ seats: [], unassignedItems: [], parentTotals: null });
    expect(preview.buckets).toEqual([]);
    expect(preview.byId.size).toBe(0);
  });

  it('submits allocated payable hints without sending server-owned allocation data', async () => {
    const { buildSplitRequest } = await loadSplitChecks();
    const request = buildSplitRequest({
      table: { id: 5, table_number: 'A1', current_order_id: 8 },
      seats: [
        { id: 1, name: 'Seat 1', items: [{ price: 4.75, qty: 0.5, tax_rate: 16 }] },
        { id: 2, name: 'Seat 2', items: [{ price: 4.75, qty: 0.5, tax_rate: 16 }] },
      ],
      parentTotals: { subtotal: 4.75, discount: 0, tax: 0, total: 4.75 },
      orderDiscount: null,
      serviceChargeSnapshot: null,
      serviceChargeLine: null,
      taxInclusive: true,
      makeId: ids,
    });

    expect(request.splits.map((split) => split.subtotal)).toEqual([2.38, 2.37]);
    expect(JSON.stringify(request)).not.toContain('split_money_cents');
  });

  it('keeps untouched items on a first-class Remaining Check', async () => {
    const { buildSplitRequest } = await loadSplitChecks();
    const request = buildSplitRequest({
      table: { id: 5, table_number: 'A1', current_order_id: 8 },
      remainingItems: [{ id: 1, price: 4, qty: 1, tax_rate: 0 }],
      seats: [{ id: 2, name: 'Check 2', items: [{ id: 2, price: 2, qty: 1, tax_rate: 0 }] }],
      parentTotals: { subtotal: 6, discount: 0, tax: 0, total: 6 },
      orderDiscount: null,
      serviceChargeSnapshot: null,
      serviceChargeLine: null,
      makeId: ids,
    });

    expect(request.splits).toHaveLength(2);
    expect(request.splits[0]).toMatchObject({
      referenceName: 'Table A1 - Remaining Check',
      split_role: 'remainder',
      items: [{ id: 1, qty: 1 }],
    });
    expect(request.splits[1]).toMatchObject({ referenceName: 'Table A1 - Check 2' });
  });

  it('does not create a split until at least one item leaves the Remaining Check', async () => {
    const { buildSplitRequest } = await loadSplitChecks();
    expect(buildSplitRequest({
      table: { id: 5, table_number: 'A1', current_order_id: 8 },
      remainingItems: [{ id: 1, price: 4, qty: 1, tax_rate: 0 }],
      seats: [{ id: 2, name: 'Check 2', items: [] }],
      parentTotals: { subtotal: 4, discount: 0, tax: 0, total: 4 },
      orderDiscount: null,
      serviceChargeSnapshot: null,
      serviceChargeLine: null,
      makeId: ids,
    })).toBeNull();
  });

  it('moves an entire multi-quantity line when explicitly requested', async () => {
    const { moveSplitItem } = await loadSplitChecks();
    const result = moveSplitItem({
      fromItems: [{ id: 1, qty: 3 }], toItems: [], index: 0, moveAll: true, makeId: ids,
    });
    expect(result.fromItems).toEqual([]);
    expect(result.toItems[0].qty).toBe(3);
  });

  it('splits fractional quantity with the final residue and leaves input unchanged', async () => {
    const { splitItemFractionally } = await loadSplitChecks();
    const items = [{ id: 1, qty: 1, price: 4, note: '' }];

    const result = splitItemFractionally(items, 0, 3, ids);

    expect(items).toEqual([{ id: 1, qty: 1, price: 4, note: '' }]);
    expect(result.map((item) => item.qty)).toEqual([0.333333, 0.333333, 0.333334]);
    expect(result.reduce((sum, item) => sum + item.qty, 0)).toBe(1);
  });

  it('conserves a one-sixth split at the backend quantity precision', async () => {
    const { splitItemFractionally } = await loadSplitChecks();

    const result = splitItemFractionally([{ id: 1, qty: 1 }], 0, 6, ids);

    expect(result.map((item) => item.qty)).toEqual([0.166667, 0.166667, 0.166667, 0.166667, 0.166667, 0.166665]);
    expect(result.reduce((sum, item) => sum + item.qty, 0)).toBe(1);
  });

  it('preserves an amount-derived quantity when split three ways', async () => {
    const { splitItemFractionally } = await loadSplitChecks();

    const result = splitItemFractionally([{ id: 1, qty: 0.217391, price: 23 }], 0, 3, ids);

    expect(result.map((item) => item.qty)).toEqual([0.072464, 0.072464, 0.072463]);
    expect(result.reduce((sum, item) => sum + item.qty, 0)).toBe(0.217391);
  });

  it('moves one unit without merging financially distinct saved lines', async () => {
    const { moveSplitItem } = await loadSplitChecks();
    const line = {
      id: 3, qty: 2, price: 5, note: '', order_item_id: 12,
      tax_rate: 16, modifier_surcharge: 1, modifier_tax_amount: 0.14,
      selectedModifiers: [{ id: 2, price: 1 }], discountType: 'percent', discountValue: 10,
    };
    const existingDifferentSavedLine = { ...line, qty: 1, order_item_id: 99 };

    const result = moveSplitItem({
      fromItems: [line], toItems: [existingDifferentSavedLine], index: 0, makeId: ids,
    });

    expect(result.fromItems[0].qty).toBe(1);
    expect(result.toItems).toHaveLength(2);
    expect(result.toItems.map((item) => item.order_item_id)).toEqual([99, 12]);
    expect(line.qty).toBe(2);
  });

  it('does not merge bundle lines with different child selections', async () => {
    const { moveSplitItem } = await loadSplitChecks();
    const source = {
      id: 10,
      qty: 1,
      price: 5,
      note: '',
      bundleItems: [{ product_id: 1, name: 'Coffee', qty: 1 }],
    };
    const destination = {
      ...source,
      bundleItems: [{ product_id: 2, name: 'Tea', qty: 1 }],
    };

    const result = moveSplitItem({
      fromItems: [source],
      toItems: [destination],
      index: 0,
      makeId: ids,
    });

    expect(result.toItems).toHaveLength(2);
    expect(result.toItems.map((item) => item.bundleItems[0].product_id)).toEqual([2, 1]);
  });

  it('distributes fixed order discount proportionally with an exact capped sum', async () => {
    const { buildSplitRequest } = await loadSplitChecks();
    const request = buildSplitRequest({
      table: { id: 5, table_number: 'A1', current_order_id: 8 },
      seats: [
        { id: 1, name: 'Seat 1', items: [{ id: 1, qty: 1, price: 10, note: '', tax_rate: 0 }] },
        { id: 2, name: 'Seat 2', items: [{ id: 2, qty: 1, price: 20, note: '', tax_rate: 0 }] },
        { id: 3, name: 'Seat 3', items: [{ id: 3, qty: 1, price: 0, note: '', tax_rate: 0 }] },
      ],
      orderDiscount: { type: 'fixed', value: 50 },
      serviceChargeSnapshot: null,
      serviceChargeLine: null,
      makeId: ids,
    });

    expect(request.splits.map((split) => split.subtotal)).toEqual([0, 0, 0]);
    expect(request.splits.map((split) => split.order_discount)).toEqual([
      { type: 'fixed', value: 10 },
      { type: 'fixed', value: 20 },
      { type: 'fixed', value: 0 },
    ]);
  });

  it('builds a deterministic split request with distributed service-charge cents', async () => {
    const { buildSplitRequest } = await loadSplitChecks();
    const seats = [
      { id: 1, name: 'Seat 1', items: [{ id: 1, qty: 1, price: 10, note: '', tax_rate: 0 }] },
      { id: 2, name: 'Seat 2', items: [{ id: 2, qty: 1, price: 20, note: '', tax_rate: 0 }] },
    ];

    const request = buildSplitRequest({
      table: { id: 5, table_number: 'A1', current_order_id: 8 },
      seats,
      orderDiscount: { type: 'percent', value: 10 },
      serviceChargeSnapshot: { percentage: 10 },
      serviceChargeLine: { id: 'FEE', qty: 1, price: 3, note: 'Auto-Gratuity', tax_rate: 0 },
      makeId: ids,
    });

    expect(request).toMatchObject({ tableId: 5, currentOrderId: 8, voidReason: 'Bill Split' });
    expect(request.splits).toHaveLength(2);
    expect(request.splits.map((split) => split.items.at(-1).price)).toEqual([1, 2]);
    expect(request.splits.map((split) => split.subtotal)).toEqual([9.9, 19.8]);
    expect(request.splits.map((split) => split.order_discount)).toEqual([
      { type: 'percent', value: 10 }, { type: 'percent', value: 10 },
    ]);
  });

  it('returns no request when no seat has items', async () => {
    const { buildSplitRequest } = await loadSplitChecks();

    expect(buildSplitRequest({
      table: { id: 5, current_order_id: 8 }, seats: [{ id: 1, name: 'Seat 1', items: [] }],
      orderDiscount: { type: 'percent', value: 0 }, serviceChargeSnapshot: null,
      serviceChargeLine: null, makeId: ids,
    })).toBeNull();
  });

  it('omits empty seats from the final split request', async () => {
    const { buildSplitRequest } = await loadSplitChecks();
    const request = buildSplitRequest({
      table: { id: 5, table_number: 'A1', current_order_id: 8 },
      seats: [
        { id: 1, name: 'Seat 1', items: [{ id: 1, qty: 1, price: 5, note: '', tax_rate: 0 }] },
        { id: 2, name: 'Seat 2', items: [] },
        { id: 3, name: 'Seat 3', items: [] },
      ],
      orderDiscount: { type: 'percent', value: 0 }, serviceChargeSnapshot: null,
      serviceChargeLine: null, makeId: ids,
    });

    expect(request.splits).toHaveLength(1);
    expect(request.splits[0].referenceName).toBe('Table A1 - Seat 1');
  });
});
