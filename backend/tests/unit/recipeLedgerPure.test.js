const L = require('../../services/RecipeLedgerService');

describe('units and costs', () => {
  it('converts within a dimension only', () => {
    expect(L.toBaseQty(0.2, 'kg')).toBe(200);
    expect(L.toBaseQty(1.5, 'l')).toBe(1500);
    expect(L.fromBaseQty(2500, 'kg')).toBe(2.5);
    expect(L.unitBelongsTo('weight', 'kg')).toBe(true);
    expect(L.unitBelongsTo('weight', 'ml')).toBe(false);
    expect(() => L.toBaseQty('x', 'g')).toThrow();
    expect(() => L.toBaseQty(1, 'oz')).toThrow();
  });
  it('converts cost per display unit to cost per base unit and back', () => {
    expect(L.toBaseCost(4.5, 'kg')).toBe(0.0045);
    expect(L.fromBaseCost(0.0045, 'kg')).toBe(4.5);
    expect(L.toBaseCost(0.35, 'unit')).toBe(0.35);
  });
  it('packs plus loose', () => {
    expect(L.packsToBase(3, 24, 5, 'unit')).toBe(77);
    expect(L.packsToBase(2, 10000, 0.5, 'kg')).toBe(20500);
    expect(() => L.packsToBase(-1, 24, 0, 'unit')).toThrow();
  });
});

describe('resolveComposition', () => {
  const ctx = {
    recipeLinesByProductId: new Map([
      [1, [{ ingredient_id: 10, qty_per_unit: 200 }, { ingredient_id: 11, qty_per_unit: 100 }]],
      [2, [{ ingredient_id: 12, qty_per_unit: 1 }]],
    ]),
    bundleMembersByProductId: new Map([[4, [{ product_id: 1, qty: 1 }, { product_id: 2, qty: 2 }]]]),
  };
  it('uses own lines, or bundle members minus removed ones, or nothing', () => {
    expect(L.resolveComposition({ product_id: 1 }, ctx)).toEqual([
      { ingredient_id: 10, unit_qty: 200 }, { ingredient_id: 11, unit_qty: 100 },
    ]);
    expect(L.resolveComposition({ product_id: 4, bundleItems: [{ product_id: 2, removed: true }] }, ctx))
      .toEqual([{ ingredient_id: 10, unit_qty: 200 }, { ingredient_id: 11, unit_qty: 100 }]);
    expect(L.resolveComposition({ product_id: 4 }, ctx)).toEqual([
      { ingredient_id: 10, unit_qty: 200 }, { ingredient_id: 11, unit_qty: 100 }, { ingredient_id: 12, unit_qty: 2 },
    ]);
    expect(L.resolveComposition({ product_id: 99 }, ctx)).toEqual([]);
  });
});

describe('planLineRows', () => {
  const rec = (productQty, net) => ({ productQty, byIngredient: new Map([[10, { unit_qty: 200, net_qty: net }]]) });
  it('new line writes usage; empty composition writes nothing', () => {
    expect(L.planLineRows({ key: 'k', qty: 3, isNew: true, composition: [{ ingredient_id: 10, unit_qty: 200 }] }, null))
      .toEqual([{ ingredient_id: 10, kind: 'usage', qty: -600, unit_qty: 200, product_qty: 3 }]);
    expect(L.planLineRows({ key: 'k', qty: 3, isNew: true, composition: [] }, null)).toEqual([]);
  });
  it('existing line without rows stays empty', () => {
    expect(L.planLineRows({ key: 'k', qty: 5, isNew: false, composition: [{ ingredient_id: 10, unit_qty: 200 }] }, null)).toEqual([]);
  });
  it('unchanged writes nothing; increase uses frozen unit_qty', () => {
    expect(L.planLineRows({ key: 'k', qty: 3, isNew: false, composition: [{ ingredient_id: 10, unit_qty: 999 }] }, rec(3, 600))).toEqual([]);
    expect(L.planLineRows({ key: 'k', qty: 4, isNew: false, composition: [] }, rec(3, 600)))
      .toEqual([{ ingredient_id: 10, kind: 'usage', qty: -200, unit_qty: 200, product_qty: 1 }]);
  });
  it('decrease reverses, bounded, last fraction exact', () => {
    expect(L.planLineRows({ key: 'k', qty: 1, isNew: false, composition: [] }, rec(3, 600)))
      .toEqual([{ ingredient_id: 10, kind: 'reversal', qty: 400, unit_qty: 200, product_qty: -2 }]);
    let r = rec(1, 200);
    const a = L.reversalRows(r, 0.333333);
    r = rec(0.666667, 200 - a[0].qty);
    const b = L.reversalRows(r, 0.333333);
    r = rec(0.333334, r.byIngredient.get(10).net_qty - b[0].qty);
    const c = L.reversalRows(r, 0.333334);
    expect(L.roundSix(a[0].qty + b[0].qty + c[0].qty)).toBe(200);
    expect(L.reversalRows(rec(3, 600), 10)[0]).toEqual({
      ingredient_id: 10, kind: 'reversal', qty: 600, unit_qty: 200, product_qty: -3,
    });
  });
  it('conserves tiny components across fractional additions and reversals', () => {
    let recorded = null;
    for (const qty of [0.333333, 0.666666, 1]) {
      const rows = L.planLineRows({ qty, isNew: !recorded, composition: [{ ingredient_id: 10, unit_qty: 0.000001 }] }, recorded);
      const net = L.roundSix((recorded?.byIngredient.get(10).net_qty || 0) - rows[0].qty);
      recorded = { productQty: qty, byIngredient: new Map([[10, { unit_qty: 0.000001, net_qty: net }]]) };
    }
    expect(recorded.byIngredient.get(10).net_qty).toBe(0.000001);
    for (const qty of [0.333333, 0.333333, 0.333334]) {
      const rows = L.reversalRows(recorded, qty);
      expect(rows).toHaveLength(1);
      recorded.productQty = L.roundSix(recorded.productQty + rows[0].product_qty);
      recorded.byIngredient.get(10).net_qty = L.roundSix(recorded.byIngredient.get(10).net_qty - rows[0].qty);
    }
    expect(recorded.productQty).toBe(0);
    expect(recorded.byIngredient.get(10).net_qty).toBe(0);
  });
});

describe('effectiveBalance and portions', () => {
  it('ignores corrections whose target predates the count', () => {
    const rows = [
      { id: 1, kind: 'receipt', qty: 10 }, { id: 2, kind: 'count', qty: 100 },
      { id: 3, kind: 'correction', qty: -10, corrects_movement_id: 1 },
      { id: 4, kind: 'waste', qty: -5 }, { id: 5, kind: 'correction', qty: 5, corrects_movement_id: 4 },
    ];
    expect(L.effectiveBalance(rows, 2)).toBe(100);
  });
  it('portions possible is the floor of the tightest ingredient', () => {
    const lines = [{ ingredient_id: 10, qty_per_unit: 200 }, { ingredient_id: 12, qty_per_unit: 1 }];
    expect(L.portionsPossible(lines, new Map([[10, 4700], [12, 30]])))
      .toEqual({ portions: 23, limiting_ingredient_id: 10 });
    expect(L.portionsPossible(lines, new Map([[10, 4700]]))).toBeNull();
    expect(L.portionsPossible(lines, new Map([[10, -300], [12, 30]])))
      .toEqual({ portions: 0, limiting_ingredient_id: 10 });
  });
});

describe('assignLineKey', () => {
  it('copies a saved key once and mints a sibling; pre-activation stays null', () => {
    const claimed = new Set();
    const first = L.assignLineKey({
      hasSavedContext: true, savedKey: 'a'.repeat(32), matchedById: true, enabled: true, claimedKeys: claimed
    });
    const sibling = L.assignLineKey({
      hasSavedContext: true, savedKey: 'a'.repeat(32), enabled: true, claimedKeys: claimed
    });
    const pre = L.assignLineKey({ hasSavedContext: true, savedKey: null, enabled: true, claimedKeys: new Set() });
    expect(first).toEqual({ lineKey: 'a'.repeat(32), isNew: false });
    expect(sibling.isNew).toBe(true);
    expect(sibling.lineKey).toMatch(/^[0-9a-f]{32}$/);
    expect(sibling.lineKey).not.toBe(first.lineKey);
    expect(pre).toEqual({ lineKey: null, isNew: false });
  });
});
