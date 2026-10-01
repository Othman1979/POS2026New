import { describe, expect, it, vi } from 'vitest';
import { buildCartRenderModel } from '../cartRenderModel.js';

const line = (id, overrides = {}) => ({
  id,
  cartId: `cart-${id}`,
  name: `Item ${id}`,
  note: '',
  price: 2,
  qty: 1,
  ...overrides,
});

describe('cart render model', () => {
  it('groups visible lines in course order while retaining their live cart indexes', () => {
    const cart = [
      line(1, { course: { id: 2 } }),
      line(2),
      line(3, { course: { id: 1 } }),
      line(4, { course: { id: 2 } }),
      line(5, { course: { id: 9 } }),
    ];

    const model = buildCartRenderModel({
      cartItems: cart,
      getGrossTotal: item => item.id * 10,
      getDisplayName: item => item.name,
    });

    expect(model.groups.map(group => group.courseLevel)).toEqual([null, 1, 2]);
    expect(model.groups.map(group => group.rows.map(row => row.index))).toEqual([[1], [2], [0, 3]]);
    expect(model.groups[2].rows.map(row => row.grossTotal)).toEqual([10, 40]);
  });

  it('hides only the separately rendered automatic service-charge line', () => {
    const service = line(1, { note: 'Auto-Gratuity' });
    const ordinary = line(2, { note: 'Auto-Gratuity\nManual text' });

    const hidden = buildCartRenderModel({
      cartItems: [service, ordinary],
      hideAutomaticServiceCharge: true,
      getGrossTotal: () => 1,
      getDisplayName: item => item.name,
    });
    const visible = buildCartRenderModel({
      cartItems: [service, ordinary],
      hideAutomaticServiceCharge: false,
      getGrossTotal: () => 1,
      getDisplayName: item => item.name,
    });

    expect(hidden.groups[0].rows.map(row => row.item.id)).toEqual([2]);
    expect(visible.groups[0].rows.map(row => row.item.id)).toEqual([1, 2]);
  });

  it('indexes receipt rows once, keeps the first duplicate key, and prepares display fields once per line', () => {
    const getGrossTotal = vi.fn(item => item.id + 0.5);
    const getDisplayName = vi.fn(item => `Display ${item.id}`);
    const cart = [
      line(1, { key: 'sale-1', note: ' No salt \n\n Extra hot ' }),
      line(2, { price: 3, qty: 2 }),
    ];
    const model = buildCartRenderModel({
      cartItems: cart,
      presentationRows: [
        { key: 'sale-1', netAmount: 7, lineDiscountAmount: 1 },
        { key: 'sale-1', netAmount: 99, lineDiscountAmount: 9 },
      ],
      getGrossTotal,
      getDisplayName,
    });
    const [first, second] = model.groups[0].rows;

    expect(first.presentation).toMatchObject({ netAmount: 7, lineDiscountAmount: 1 });
    expect(first.netAmount).toBe(7);
    expect(first.noteLines).toEqual([' No salt ', ' Extra hot ']);
    expect(first.displayName).toBe('Display 1');
    expect(second.presentation).toBeNull();
    expect(second.netAmount).toBe(6);
    expect(getGrossTotal).toHaveBeenCalledTimes(2);
    expect(getDisplayName).toHaveBeenCalledTimes(2);
  });

  it('uses the same row-key fallback as receipt presentation', () => {
    const cart = [line(1, { cartId: null }), line(2, { cartId: null })];
    const model = buildCartRenderModel({
      cartItems: cart,
      presentationRows: [{ key: 'row-1', netAmount: 4 }],
      getGrossTotal: () => 0,
      getDisplayName: item => item.name,
    });

    expect(model.groups[0].rows.map(row => row.key)).toEqual(['row-0', 'row-1']);
    expect(model.groups[0].rows[1].netAmount).toBe(4);
  });
});
