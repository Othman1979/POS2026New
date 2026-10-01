const {
  validateBundleCartLines,
  canonicalizeBundleCartLines,
  insertPersistedBundleChildren
} = require('../../services/bundleOrderItems');

describe('bundle checkout context', () => {
  it('uses the trusted catalog bundle identity and returns ordered member definitions', async () => {
    const query = vi.fn().mockResolvedValue([[
      { bundle_id: 4, product_id: 1, qty: 1, name: 'Burger', category_id: 2, sort_order: 0 },
      { bundle_id: 4, product_id: 2, qty: 1, name: 'Drink', category_id: 3, sort_order: 1 }
    ]]);
    const trustedProductMap = new Map([[4, { id: 4, is_bundle: 1 }]]);

    const definitions = await validateBundleCartLines(
      { query },
      [{ product_id: 4, bundleItems: [{ product_id: 1 }, { product_id: 2 }] }],
      { requireBundleItems: true, trustedProductMap }
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('p.category_id');
    expect(query.mock.calls[0][0]).toContain('ORDER BY pbi.bundle_id, pbi.sort_order');
    expect(definitions.get(4)).toEqual([
      expect.objectContaining({ product_id: 1, qty: 1, name: 'Burger', category_id: 2, sort_order: 0 }),
      expect.objectContaining({ product_id: 2, qty: 1, name: 'Drink', category_id: 3, sort_order: 1 })
    ]);
  });

  it('reuses validated definitions without querying once per bundle line', async () => {
    const query = vi.fn();
    const definitions = new Map([[4, [
      { bundle_id: 4, product_id: 1, qty: 1, name: 'Burger', category_id: 2 },
      { bundle_id: 4, product_id: 2, qty: 1, name: 'Drink', category_id: 3 }
    ]]]);
    const lines = [
      { product_id: 4, bundleItems: [{ product_id: 1, removed: true, note: 'No onion' }] },
      { product_id: 4, bundleItems: [{ product_id: 2, note: 'Cold' }] }
    ];

    await canonicalizeBundleCartLines({ query }, lines, { validatedMembersByBundleId: definitions });

    expect(query).not.toHaveBeenCalled();
    expect(lines[0].bundleItems).toEqual([
      expect.objectContaining({ product_id: 1, category_id: 2, removed: true, note: 'No onion' }),
      expect.objectContaining({ product_id: 2, category_id: 3, removed: false, note: null })
    ]);
    expect(lines[1].bundleItems).toEqual([
      expect.objectContaining({ product_id: 1, removed: false, note: null }),
      expect.objectContaining({ product_id: 2, removed: false, note: 'Cold' })
    ]);
  });

  it('batches bundle identity and member reads when validation context is unavailable', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ id: 4, is_bundle: 1 }, { id: 5, is_bundle: 1 }]])
      .mockResolvedValueOnce([[
        { bundle_id: 4, product_id: 1, qty: 1, name: 'Burger', category_id: 2 },
        { bundle_id: 5, product_id: 2, qty: 1, name: 'Drink', category_id: 3 }
      ]]);
    const lines = [
      { product_id: 4, bundleItems: [] },
      { product_id: 5, bundleItems: [] }
    ];

    await canonicalizeBundleCartLines({ query }, lines);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain('WHERE id IN (?)');
    expect(query.mock.calls[1][0]).toContain('WHERE pbi.bundle_id IN (?)');
    expect(lines[0].bundleItems[0]).toMatchObject({ product_id: 1, name: 'Burger' });
    expect(lines[1].bundleItems[0]).toMatchObject({ product_id: 2, name: 'Drink' });
  });

  it('keeps frozen persisted child money and modifier metadata in one child batch', async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 2 }]);
    const nextSortOrder = await insertPersistedBundleChildren({ query }, {
      invoiceId: 77,
      parentItemId: 900,
      parentQty: 3,
      startSortOrder: 5,
      parentRow: { id: 88, invoice_id: 77, quantity: 2, parent_item_id: null },
      childRows: [
        {
          id: 89,
          invoice_id: 77,
          parent_item_id: 88,
          product_id: 1,
          item_name: 'Burger',
          quantity: 2,
          price_at_sale: 1.25,
          tax_rate: 8,
          tax_amount: 0.1,
          note: 'No onion',
          selected_modifiers: '[{"group":"Size","option":"Large"}]',
          modifier_surcharge: 0.25,
          modifier_tax_amount: 0.02,
          discount_type: 'percent',
          discount_value: 10,
          sort_order: 0
        },
        {
          id: 90,
          invoice_id: 77,
          parent_item_id: 88,
          product_id: 2,
          item_name: 'Drink',
          quantity: 2,
          price_at_sale: 0,
          tax_rate: 0,
          tax_amount: 0,
          sort_order: 1
        }
      ]
    });

    expect(nextSortOrder).toBe(7);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('VALUES ?');
    expect(query.mock.calls[0][1]).toEqual([[
      [77, 1, 'Burger', 3, 1.25, 8, 0.1, 'No onion', '[{"group":"Size","option":"Large"}]', 0.25, 0.02, 'percent', 10, 5, 900],
      [77, 2, 'Drink', 3, 0, 0, 0, null, null, null, null, null, 0, 6, 900]
    ]]);
  });
});
