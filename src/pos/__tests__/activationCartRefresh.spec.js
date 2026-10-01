import { describe, expect, it } from 'vitest';
import { planActivationCartRefresh } from '@/pos/activationCartRefresh.js';

// Counts the cart-price re-resolves and catalog reads a plan triggers, mirroring
// the onActivated wiring in PosTerminal.vue.
const run = (input) => {
  const plan = planActivationCartRefresh(input);
  const calls = { catalogFetch: 0, catalogIds: 0, stock: 0, reprice: 0, repriceWithPrices: 0 };
  if (plan.catalog) {
    calls.catalogFetch += 1;
    calls.reprice += 1;
    if (plan.catalog.refreshCartPrices) calls.repriceWithPrices += 1;
  } else if (plan.catalogIds.length) calls.catalogIds += 1;
  else if (plan.stock) calls.stock += 1;
  if (plan.repriceCart) { calls.reprice += 1; calls.repriceWithPrices += 1; }
  return calls;
};

const none = { catalogFetch: 0, catalogIds: 0, stock: 0, reprice: 0, repriceWithPrices: 0 };

describe('POS reactivation cart refresh plan', () => {
  it('sends nothing on a clean return with no restore', () => {
    expect(run({})).toEqual(none);
  });

  it('re-prices a local-fallback held restore exactly once with a clean catalog', () => {
    expect(run({ restoreOutcome: 'local-held-order' })).toEqual({ ...none, reprice: 1, repriceWithPrices: 1 });
    // OrderNotes restore from its backup cart before activation.
    expect(run({ restoreSource: 'local' })).toEqual({ ...none, reprice: 1, repriceWithPrices: 1 });
  });

  it('does not re-price a server-canonical restore with a clean catalog', () => {
    expect(run({ restoreOutcome: 'server-canonical-held' })).toEqual(none);
    expect(run({ restoreSource: 'server' })).toEqual(none);
  });

  it('keeps a single price-refreshing catalog pass when the catalog is dirty', () => {
    expect(run({ catalog: true, restoreSource: 'local' })).toEqual({ ...none, catalogFetch: 1, reprice: 1, repriceWithPrices: 1 });
    expect(run({ catalog: true, restoreSource: 'server' })).toEqual({ ...none, catalogFetch: 1, reprice: 1 });
  });

  it('revalidates named catalog rows once and re-prices a local restore once', () => {
    expect(run({ catalogIds: ['7'], restoreSource: 'local' })).toEqual({ ...none, stock: 1, reprice: 1, repriceWithPrices: 1 });
    expect(planActivationCartRefresh({ catalogIds: ['7'], restoreSource: 'server' }))
      .toMatchObject({ catalogIds: ['7'], refreshCartPrices: false, repriceCart: false });
  });

  it('on a sales-context change refreshes the catalog once, re-pricing only a restore that is not server-canonical', () => {
    // A server-held cart is already priced: a context switch must not re-price it (screen == charged).
    for (const server of [{ restoreSource: 'server' }, { restoreOutcome: 'server-canonical-held' }]) {
      expect(planActivationCartRefresh({ contextChanged: true, ...server }))
        .toEqual({ catalog: { refreshCartPrices: false, preferCache: true }, catalogIds: [], stock: false, repriceCart: false });
    }
    for (const local of [{ restoreSource: 'local' }, { restoreOutcome: 'local-held-order' }]) {
      expect(planActivationCartRefresh({ contextChanged: true, ...local }))
        .toEqual({ catalog: { refreshCartPrices: true, preferCache: true }, catalogIds: [], stock: false, repriceCart: false });
    }
    expect(planActivationCartRefresh({ contextChanged: true }).repriceCart).toBe(false);
  });
});
