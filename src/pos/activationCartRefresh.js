// Decides the catalog/cart-price work a POS KeepAlive reactivation owes.
// A clean return with no restore owes nothing. A held order restored from its
// local backup cart carries hold-time prices, so it is re-priced once even when
// the catalog itself is clean; a server-canonical restore is already priced.
export function planActivationCartRefresh({
  catalog = false,
  contextChanged = false,
  catalogIds = [],
  stock = false,
  restoreOutcome = 'none',
  restoreSource = null,
} = {}) {
  const serverCanonical = restoreOutcome === 'server-canonical-held' || restoreSource === 'server';
  const localFallback = !serverCanonical && (restoreOutcome === 'local-held-order' || restoreSource === 'local');
  const refreshCartPrices = !serverCanonical;
  if (catalog || contextChanged) {
    return { catalog: { refreshCartPrices, preferCache: !catalog }, catalogIds: [], stock: false, repriceCart: false };
  }
  if (localFallback) {
    // Revalidating scopes covers named catalog rows; the one re-price follows.
    return { catalog: null, catalogIds: [], stock: stock || catalogIds.length > 0, repriceCart: true };
  }
  return { catalog: null, catalogIds, refreshCartPrices, stock: !catalogIds.length && stock, repriceCart: false };
}
