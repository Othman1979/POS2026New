import { describe, expect, it } from 'vitest';
import { moveSplitItem, splitItemFractionally, buildSplitRequest } from './stores/orderSession/splitChecks.js';
const item = { order_item_id: 12, id: 2, qty: 3.25, price: 2, note: 'No ice', tax_rate: 0, recipe_line_key: 'saved-preparation', stock_snapshot: '{"version":3}' };
const makeId = () => 'moved';
describe('chosen split quantities', () => {
  it('moves and returns an exact chosen fraction without mutating the saved context', () => {
    const fromItems = [{ ...item }], toItems = [];
    const moved = moveSplitItem({ fromItems, toItems, index: 0, quantity: '2.125', makeId });
    expect(moved.fromItems[0].qty).toBe(1.125); expect(moved.toItems[0]).toEqual({ ...item, qty: 2.125, cartId: 'moved' });
    expect(fromItems).toEqual([item]); expect(toItems).toEqual([]);
    const returned = moveSplitItem({ fromItems: moved.toItems, toItems: moved.fromItems, index: 0, quantity: '.125', makeId });
    expect(returned.fromItems[0].qty).toBe(2); expect(returned.toItems[0].qty).toBe(1.25);
    expect(returned.toItems[0].recipe_line_key).toBe(item.recipe_line_key);
  });
  it.each(['', '0', '-1', '3.250001', '0.0000001', null, true])('rejects invalid chosen quantity %j without moving anything', quantity => {
    expect(moveSplitItem({ fromItems: [item], toItems: [], index: 0, quantity, makeId })).toEqual({ fromItems: [item], toItems: [] });
  });
  it('does not create zero-sized portions at the storage precision limit', () => {
    const tiny = [{ ...item, qty: 0.000001 }];
    expect(splitItemFractionally(tiny, 0, 2, makeId)).toEqual(tiny);
  });
  it('lets an existing group consolidate its unpaid quantities into the Remaining Check', () => {
    const input = { table: { id: 1, table_number: '1', current_order_id: 4 }, seats: [{ id: 2, items: [] }],
      remainingItems: [item], parentTotals: { subtotal: 6.5, discount: 0, tax: 0, total: 6.5 }, makeId };
    expect(buildSplitRequest(input)).toBeNull();
    const revised = buildSplitRequest({ ...input, allowRemainingOnly: true });
    expect(revised.splits).toHaveLength(1); expect(revised.splits[0].split_role).toBe('remainder');
    expect(revised.splits[0].items).toEqual([item]); expect(revised.splits[0].subtotal).toBe(6.5);
  });
});
