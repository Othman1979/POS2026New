const {
  savedLineKey,
  buildSavedLineIndex,
  resolveCheckoutSavedLine,
  resolveTableSavedLine,
  priceMapFor,
  taxOverridesFor
} = require('../../modules/orders/SavedOrderLines');

const saved = {
  id: 10,
  product_id: 4,
  item_name: 'Burger',
  note: '',
  quantity: 2,
  price_at_sale: 5.25,
  tax_rate: 16,
  selected_modifiers: JSON.stringify([{ gid: 'g1', oid: 'o1', group: 'Size', option: 'Large' }]),
  modifier_surcharge: 0.75,
  modifier_tax_amount: 0.1
};

function expectErrorWithStatus(action, message, statusCode) {
  let caught;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(caught.message).toBe(message);
  expect(caught.statusCode).toBe(statusCode);
}

describe('SavedOrderLines', () => {
  it('requires a stable saved identity when otherwise identical lines have different stock mappings', () => {
    const rows = [
      { ...saved, stock_authority: 'none', stock_snapshot: null },
      { ...saved, id: 11, stock_authority: 'legacy_product', stock_snapshot: '{"version":1}' }
    ];
    const submitted = { product_id: 4, name: 'Burger', note: '', qty: 1 };
    expect(() => resolveCheckoutSavedLine(buildSavedLineIndex(rows), submitted)).toThrow();
    expect(() => resolveTableSavedLine(buildSavedLineIndex(rows), submitted)).toThrow();
    expect(resolveCheckoutSavedLine(buildSavedLineIndex(rows), { ...submitted, order_item_id: 11 }))
      .toMatchObject({ stock_authority: 'legacy_product', stock_snapshot: '{"version":1}', matchedById: true });
  });
  it('pins a submitted line to its persisted id and consumes quantity', () => {
    const index = buildSavedLineIndex([saved]);
    const submitted = { order_item_id: 10, product_id: 4, name: 'Burger', note: '', qty: 1 };
    const context = resolveCheckoutSavedLine(index, submitted);
    expect(context).toMatchObject({ price: 5.25, taxRate: 16, remaining: 1 });
  });

  it('accepts floating-point quantity noise within the historical exact-id tolerance', () => {
    const index = buildSavedLineIndex([
      { ...saved, quantity: 0.3 },
      { ...saved, id: 11, quantity: 1, price_at_sale: 6 }
    ]);
    const context = resolveCheckoutSavedLine(index, {
      order_item_id: 10,
      product_id: 4,
      name: 'Burger',
      note: '',
      qty: 0.30000000000000004
    });
    expect(context).toMatchObject({ price: 5.25, matchedById: true });
    expect(context.remaining).toBeCloseTo(0, 12);
  });

  it('rejects reusing a cheap saved id after its quantity is consumed in a mixed-price group', () => {
    const index = buildSavedLineIndex([{ ...saved, quantity: 1 }, { ...saved, id: 11, quantity: 1, price_at_sale: 6 }]);
    resolveCheckoutSavedLine(index, { order_item_id: 10, product_id: 4, name: 'Burger', note: '', qty: 1 });
    expectErrorWithStatus(() => resolveCheckoutSavedLine(index, { order_item_id: 10, product_id: 4, name: 'Burger', note: '', qty: 1 }), 'Items cannot be changed while cashing out. Edit the order on the floor plan first.', 403);
  });

  it('rejects a saved id borrowed by another product', () => {
    const index = buildSavedLineIndex([saved]);
    expectErrorWithStatus(() => resolveCheckoutSavedLine(index, { order_item_id: 10, product_id: 9, name: 'Drink', note: '', qty: 1 }), 'Saved item identity changed. Refresh the order and try again.', 409);
  });

  it('allows id-less fallback only for an unambiguous group', () => {
    const index = buildSavedLineIndex([saved]);
    const context = resolveCheckoutSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1 });
    expect(context.price).toBe(5.25);
    expect(context.taxRate).toBe(16);
  });

  it('rejects id-less fallback when one identity has multiple historical prices', () => {
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, quantity: 1, price_at_sale: 6 }]);
    expectErrorWithStatus(() => resolveCheckoutSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1 }), 'Items cannot be changed while cashing out. Edit the order on the floor plan first.', 403);
  });

  it('keys custom lines by name and note', () => {
    expect(savedLineKey({ product_id: null, item_name: 'Open Item', note: 'No salt' })).toBe('custom:Open Item|No salt');
  });

  it('rejects id-less fallback when tax context is ambiguous', () => {
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, quantity: 1, tax_rate: 8 }]);
    expectErrorWithStatus(() => resolveCheckoutSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1 }), 'Items cannot be changed while cashing out. Edit the order on the floor plan first.', 403);
  });

  it('returns the persisted modifier money context', () => {
    const index = buildSavedLineIndex([saved]);
    const context = resolveCheckoutSavedLine(index, { order_item_id: 10, product_id: 4, name: 'Burger', note: '', qty: 1, selectedModifiers: [{ gid: 'g1', oid: 'o1', group: 'Size', option: 'Large' }] });
    expect(context.selectedModifiers).toContain('"gid":"g1"');
    expect(context.modifier_surcharge).toBe(0.75);
    expect(context.modifier_tax_amount).toBe(0.1);
  });

  it('uses checkout modifier identity to select one of otherwise equivalent snapshots', () => {
    const large = saved.selected_modifiers;
    const small = JSON.stringify([{ gid: 'g1', oid: 'o2', group: 'Size', option: 'Small' }]);
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, quantity: 1, selected_modifiers: small }]);
    const context = resolveCheckoutSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1, selectedModifiers: JSON.parse(large) });
    expect(context.selectedModifiers).toBe(large);
  });

  it('allows missing tax only for a legacy checkout snapshot', () => {
    const index = buildSavedLineIndex([{ ...saved, tax_rate: undefined }]);
    expectErrorWithStatus(() => resolveCheckoutSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1 }), 'Items cannot be changed while cashing out. Edit the order on the floor plan first.', 403);
    expect(resolveCheckoutSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1 }, { allowMissingTax: true }).taxRate).toBeNull();
  });

  it('table re-save accepts a stale id only when one complete context exists', () => {
    const index = buildSavedLineIndex([saved]);
    expect(resolveTableSavedLine(index, { order_item_id: 999, product_id: 4, name: 'Burger', note: '', qty: 1 })).toMatchObject({ price: 5.25, taxRate: 16, matchedById: false });
  });

  it('table re-save rejects a stale id when complete contexts conflict', () => {
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, price_at_sale: 6 }]);
    expectErrorWithStatus(
      () => resolveTableSavedLine(index, { order_item_id: 999, product_id: 4, name: 'Burger', note: '', qty: 1 }),
      'Saved item context is stale or ambiguous. Refresh the order and try again.',
      409
    );
  });

  it('table re-save rejects an id-less line with conflicting modifier snapshots', () => {
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, selected_modifiers: JSON.stringify([{ gid: 'g1', oid: 'o2', group: 'Size', option: 'Small' }]) }]);
    expectErrorWithStatus(() => resolveTableSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1 }), 'Saved item context is stale or ambiguous. Refresh the order and try again.', 409);
  });

  it('preserves exact-id tax provenance when building overrides', () => {
    const rows = [
      { ...saved, id: 10, product_id: 4, item_name: 'Finite', tax_rate: 16 },
      { ...saved, id: 11, product_id: 5, item_name: 'String finite', tax_rate: '8' },
      { ...saved, id: 12, product_id: 6, item_name: 'Explicit null', tax_rate: null },
      { ...saved, id: 13, product_id: 7, item_name: 'Missing', tax_rate: undefined },
      { ...saved, id: 14, product_id: 8, item_name: 'Invalid', tax_rate: 'not-a-rate' }
    ];
    const index = buildSavedLineIndex(rows);
    const resolved = rows.map(row => {
      const line = {
        order_item_id: row.id,
        product_id: row.product_id,
        name: row.item_name,
        note: '',
        qty: 1
      };
      return [line, resolveCheckoutSavedLine(index, line, { allowMissingTax: true })];
    });
    const overrides = taxOverridesFor(new Map(resolved));
    expect(overrides.get(resolved[0][0])).toBe(16);
    expect(overrides.get(resolved[1][0])).toBe(8);
    expect(overrides.get(resolved[2][0])).toBe(0);
    expect(overrides.has(resolved[3][0])).toBe(false);
    expect(overrides.has(resolved[4][0])).toBe(false);
    expect(overrides.size).toBe(3);
  });

  it('exposes the single-price fallback map expected by database repricing', () => {
    const index = buildSavedLineIndex([saved]);
    expect(priceMapFor(index).get('4|')).toBe(5.25);
  });

  it('keeps every saved identity in the repricing map with the last saved price', () => {
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, price_at_sale: 6 }]);
    expect(priceMapFor(index).has('4|')).toBe(true);
    expect(priceMapFor(index).get('4|')).toBe(6);
  });

  it('rejects price ambiguity before a matching modifier can select a snapshot', () => {
    const small = JSON.stringify([{ gid: 'g1', oid: 'o2', group: 'Size', option: 'Small' }]);
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, price_at_sale: 6, selected_modifiers: small }]);
    expectErrorWithStatus(() => resolveCheckoutSavedLine(index, {
      product_id: 4, name: 'Burger', note: '', qty: 1, selectedModifiers: JSON.parse(saved.selected_modifiers)
    }), 'Items cannot be changed while cashing out. Edit the order on the floor plan first.', 403);
  });

  it('rejects finite tax, surcharge, and modifier-tax ambiguity before modifier matching', () => {
    const small = JSON.stringify([{ gid: 'g1', oid: 'o2', group: 'Size', option: 'Small' }]);
    for (const changed of [{ tax_rate: 8 }, { modifier_surcharge: 1 }, { modifier_tax_amount: 0.2 }]) {
      const index = buildSavedLineIndex([saved, { ...saved, id: 11, selected_modifiers: small, ...changed }]);
      expectErrorWithStatus(() => resolveCheckoutSavedLine(index, {
        product_id: 4, name: 'Burger', note: '', qty: 1, selectedModifiers: JSON.parse(saved.selected_modifiers)
      }), 'Items cannot be changed while cashing out. Edit the order on the floor plan first.', 403);
    }
  });

  it('uses null modifier snapshot when a varied group has no matching submitted snapshot', () => {
    const small = JSON.stringify([{ gid: 'g1', oid: 'o2', group: 'Size', option: 'Small' }]);
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, selected_modifiers: small }]);
    expect(resolveCheckoutSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1 }).selectedModifiers).toBeNull();
    expect(resolveCheckoutSavedLine(index, {
      product_id: 4, name: 'Burger', note: '', qty: 1,
      selectedModifiers: [{ gid: 'g1', oid: 'missing', group: 'Size', option: 'Missing' }]
    }).selectedModifiers).toBeNull();
  });

  it('returns a selected modifier snapshot only when the submitted identity matches it', () => {
    const small = JSON.stringify([{ gid: 'g1', oid: 'o2', group: 'Size', option: 'Small' }]);
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, selected_modifiers: small }]);
    expect(resolveCheckoutSavedLine(index, {
      product_id: 4, name: 'Burger', note: '', qty: 1, selectedModifiers: JSON.parse(small)
    }).selectedModifiers).toBe(small);
  });

  it('returns the unique saved name, or null when fallback names differ', () => {
    const oneName = buildSavedLineIndex([saved]);
    expect(resolveCheckoutSavedLine(oneName, { product_id: 4, name: 'Burger', note: '', qty: 1 }).name).toBe('Burger');

    const differentNames = buildSavedLineIndex([saved, { ...saved, id: 11, item_name: 'Burger renamed' }]);
    expect(resolveCheckoutSavedLine(differentNames, { product_id: 4, name: 'Burger', note: '', qty: 1 }).name).toBeNull();
  });

  it('uses one finite tax rate even when another snapshot has missing tax', () => {
    const index = buildSavedLineIndex([saved, { ...saved, id: 11, tax_rate: undefined }]);
    expect(resolveCheckoutSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1 }).taxRate).toBe(16);
  });

  it('allows legacy tax fallback with no or multiple finite tax rates', () => {
    const noFiniteTax = buildSavedLineIndex([{ ...saved, tax_rate: undefined }]);
    const multipleFiniteTaxes = buildSavedLineIndex([saved, { ...saved, id: 11, tax_rate: 8 }]);
    const line = { product_id: 4, name: 'Burger', note: '', qty: 1 };
    expect(resolveCheckoutSavedLine(noFiniteTax, line, { allowMissingTax: true }).taxRate).toBeNull();
    expect(resolveCheckoutSavedLine(multipleFiniteTaxes, line, { allowMissingTax: true }).taxRate).toBeNull();
  });
});
