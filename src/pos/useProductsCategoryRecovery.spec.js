import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const categories = [
  { id: 1, name: 'Food', parent_id: null },
  { id: 2, name: 'Drinks', parent_id: null },
  { id: 3, name: 'Dessert', parent_id: null },
  { id: 11, name: 'Hot food', parent_id: 1 },
];
const product = category => ({ id: category * 10, category_id: category, name: `Item ${category}` });
const payload = (category = 1, overrides = {}) => ({
  success: true, categories, categories_included: true, selected_category_id: category,
  products: [product(category)], settings: { stock_enabled: '1', tables_enabled: '1' },
  pagination: { total: 1 }, ...overrides,
});
const response = data => ({ ok: true, json: async () => data });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function initialCatalog(data = payload()) {
  const fetchMock = vi.fn().mockResolvedValueOnce(response(data));
  vi.stubGlobal('fetch', fetchMock);
  const catalog = (await import('./useProducts.js')).useProducts();
  await catalog.fetchData({ forceFull: true });
  return { catalog, fetchMock };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('POS category failure recovery', () => {
  it.each([
    ['self-reference', [{ id: 11, parent_id: 11 }]],
    ['two-category cycle', [{ id: 11, parent_id: 12 }, { id: 12, parent_id: 11 }]],
    ['mixed string/number cycle', [{ id: 11, parent_id: '12' }, { id: '12', parent_id: '11' }]],
    ['longer cycle', [{ id: 11, parent_id: 12 }, { id: 12, parent_id: 13 }, { id: 13, parent_id: 11 }]],
    ['missing parent', [{ id: 11, parent_id: 999 }]],
  ])('recovers the selected subcategory after a refresh introduces a %s', async (_label, children) => {
    const { catalog, fetchMock } = await initialCatalog();
    fetchMock.mockResolvedValueOnce(response(payload(1, { products: [product(11)] })));
    catalog.selectSubcategory(11);
    await flush();
    expect(catalog.filteredProducts.value).toEqual([product(11)]);

    const changedCategories = [...categories.filter(row => row.id !== 11), ...children];
    fetchMock.mockResolvedValueOnce(response(payload(1, { categories: changedCategories, products: [product(11)] })))
      .mockResolvedValueOnce(response(payload(1, { categories: changedCategories })));
    await catalog.fetchData({ forceFull: true });

    expect(catalog.activeCategory.value).toBe(1);
    expect(catalog.activeSubcategory.value).toBeNull();
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
    expect(catalog.isCatalogLoading.value).toBe(false);
    expect(catalog.catalogLoadError.value).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const correction = new URL(fetchMock.mock.calls[3][0], 'http://fixture').searchParams;
    expect(correction.get('category_id')).toBe('1');
    expect(correction.has('subcategory_id')).toBe(false);

    fetchMock.mockResolvedValueOnce(response(payload(2, { categories: changedCategories })));
    catalog.selectMainCategory(2);
    await flush();
    expect(catalog.filteredProducts.value).toEqual([product(2)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a valid nested subcategory with mixed string/number parent IDs', async () => {
    const nested = [...categories.filter(row => row.id !== 11),
      { id: 11, parent_id: '12' }, { id: '12', parent_id: '1' }];
    const { catalog, fetchMock } = await initialCatalog(payload(1, { categories: nested }));
    fetchMock.mockResolvedValueOnce(response(payload(1, { categories: nested, products: [product(11)] })));
    catalog.selectSubcategory('11');
    await flush();
    expect(catalog.activeSubcategory.value).toBe(11);
    expect(catalog.filteredProducts.value).toEqual([product(11)]);
    expect(catalog.isCatalogLoading.value).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the server-selected default visible after the initial full load', async () => {
    const { catalog } = await initialCatalog(payload(2));
    expect(catalog.activeCategory.value).toBe(2);
    expect(catalog.filteredProducts.value).toEqual([product(2)]);
  });

  it('hides old-category rows during a failed selection and retries the requested category from zero', async () => {
    const { catalog, fetchMock } = await initialCatalog(payload(1, { pagination: { total: 5 } }));
    fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'));
    catalog.selectMainCategory(2);
    expect(catalog.activeCategory.value).toBe(2);
    expect(catalog.filteredProducts.value).toEqual([]);
    expect(catalog.hasMoreProducts.value).toBe(false);
    await flush();
    expect(catalog.catalogLoadError.value).toBeTruthy();
    expect(catalog.products.value).toEqual([product(1)]);
    expect(catalog.categories.value).toEqual(categories);
    catalog.loadMoreProducts();
    await catalog.fetchData({ append: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(response(payload(2)));
    await catalog.retryCatalogLoad();
    const params = new URL(fetchMock.mock.calls[2][0], 'http://fixture').searchParams;
    expect(params.get('category_id')).toBe('2');
    expect(params.get('offset')).toBe('0');
    expect(catalog.filteredProducts.value).toEqual([product(2)]);
    expect(catalog.catalogLoadError.value).toBe('');
  });

  it('keeps subcategory and parent snapshots separate and restores the parent instantly', async () => {
    const { catalog, fetchMock } = await initialCatalog();
    const child = deferred();
    fetchMock.mockReturnValueOnce(child.promise);
    catalog.selectSubcategory(11);
    expect(catalog.filteredProducts.value).toEqual([]);
    expect(new URL(fetchMock.mock.calls[1][0], 'http://fixture').searchParams.get('subcategory_id')).toBe('11');
    child.resolve(response(payload(1, { products: [product(11)] })));
    await flush();
    expect(catalog.filteredProducts.value).toEqual([product(11)]);
    catalog.selectSubcategory(null);
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
    expect(catalog.isCatalogLoading.value).toBe(false);
    expect(catalog.catalogLoadError.value).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves same-category products when a background refresh fails', async () => {
    const { catalog, fetchMock } = await initialCatalog();
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const refresh = catalog.fetchData({ forceFull: true });
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
    pending.resolve({ ok: false, status: 503 });
    await refresh;
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
    expect(catalog.catalogLoadError.value).toBeTruthy();
  });

  it('preserves metadata and the chosen category after failure following an empty category', async () => {
    const { catalog, fetchMock } = await initialCatalog(payload(2, { products: [], pagination: { total: 0 } }));
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    catalog.selectMainCategory(3);
    await flush();
    expect(catalog.categories.value).toEqual(categories);
    expect(catalog.activeCategory.value).toBe(3);
    expect(catalog.filteredProducts.value).toEqual([]);
  });

  it.each(['headers', 'body'])('times out stalled %s and rejects a late completion', async stage => {
    const { catalog, fetchMock } = await initialCatalog();
    const pending = deferred();
    fetchMock.mockReturnValueOnce(stage === 'headers' ? pending.promise : Promise.resolve({ ok: true, json: () => pending.promise }));
    catalog.selectMainCategory(2);
    await flush();
    await vi.advanceTimersByTimeAsync(14999);
    expect(catalog.isCatalogLoading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(catalog.isCatalogLoading.value).toBe(false);
    expect(catalog.catalogLoadError.value).toMatch(/too long/i);
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    pending.resolve(stage === 'headers' ? response(payload(2)) : payload(2));
    await flush();
    expect(catalog.filteredProducts.value).toEqual([]);
    expect(catalog.products.value).toEqual([product(1)]);
    fetchMock.mockResolvedValueOnce(response(payload(2)));
    await catalog.retryCatalogLoad();
    expect(catalog.filteredProducts.value).toEqual([product(2)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts superseded requests and keeps a later successful category despite late old replies', async () => {
    const { catalog, fetchMock } = await initialCatalog();
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(payload(3)));
    catalog.selectMainCategory(2);
    catalog.selectMainCategory(3);
    await flush();
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    expect(catalog.filteredProducts.value).toEqual([product(3)]);
    pending.resolve(response(payload(2)));
    await flush();
    expect(catalog.filteredProducts.value).toEqual([product(3)]);
    expect(catalog.catalogLoadError.value).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a failed append at the same offset without losing the first page', async () => {
    const { catalog, fetchMock } = await initialCatalog(payload(1, { pagination: { total: 2 } }));
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    catalog.loadMoreProducts(); await flush();
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
    fetchMock.mockResolvedValueOnce(response(payload(1, { products: [{ ...product(1), id: 12 }], pagination: { total: 2 } })));
    await catalog.retryCatalogLoad();
    const params = new URL(fetchMock.mock.calls[2][0], 'http://fixture').searchParams;
    expect(params.get('offset')).toBe('1');
    expect(catalog.filteredProducts.value.map(row => row.id)).toEqual([10, 12]);
  });

  it('aborts the previous workspace read and obtains full metadata in the new workspace', async () => {
    const { catalog, fetchMock } = await initialCatalog();
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    catalog.selectMainCategory(2);
    catalog.setSalesContext('table');
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    expect(catalog.isCatalogLoading.value).toBe(false);
    pending.resolve(response(payload(2))); await flush();
    expect(catalog.filteredProducts.value).toEqual([]);
    fetchMock.mockResolvedValueOnce(response(payload(1)));
    await catalog.fetchData();
    const params = new URL(fetchMock.mock.calls[2][0], 'http://fixture').searchParams;
    expect(params.get('sales_context')).toBe('table');
    expect(params.has('lightweight')).toBe(false);
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
  });

  it('requests full metadata if searching after the initial snapshot failed', async () => {
    const { catalog, fetchMock } = await initialCatalog({ success: false });
    fetchMock.mockResolvedValueOnce(response(payload(2)));
    catalog.searchQuery.value = 'Item';
    await vi.advanceTimersByTimeAsync(301); await flush();
    const params = new URL(fetchMock.mock.calls[1][0], 'http://fixture').searchParams;
    expect(params.get('search')).toBe('Item');
    expect(params.has('lightweight')).toBe(false);
    expect(catalog.categories.value).toEqual(categories);
  });

  it('hides category rows for a debounced search and restores the category snapshot afterward', async () => {
    const { catalog, fetchMock } = await initialCatalog();
    const pendingSearch = deferred();
    fetchMock.mockReturnValueOnce(pendingSearch.promise);
    catalog.searchQuery.value = 'Drinks';
    await vi.advanceTimersByTimeAsync(301); await flush();
    expect(catalog.filteredProducts.value).toEqual([]);
    const params = new URL(fetchMock.mock.calls[1][0], 'http://fixture').searchParams;
    expect(params.get('search')).toBe('Drinks');
    expect(params.has('category_id')).toBe(false);
    pendingSearch.resolve(response(payload(1, { products: [product(2)], categories_included: false })));
    await flush();
    expect(catalog.filteredProducts.value).toEqual([product(2)]);

    catalog.searchQuery.value = '';
    await vi.advanceTimersByTimeAsync(301); await flush();
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
    expect(catalog.isCatalogLoading.value).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reuses the same category snapshot when its ID changes string/number form', async () => {
    const { catalog, fetchMock } = await initialCatalog(payload(2));
    catalog.selectMainCategory('2');
    expect(catalog.filteredProducts.value).toEqual([product(2)]);
    expect(catalog.isCatalogLoading.value).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not attribute removed-category rows to the fallback selected category', async () => {
    const { catalog, fetchMock } = await initialCatalog(payload(2));
    const remaining = categories.filter(row => row.id !== 2);
    fetchMock.mockResolvedValueOnce(response(payload(2, { categories: remaining })));
    const corrected = deferred();
    fetchMock.mockReturnValueOnce(corrected.promise);
    const refresh = catalog.fetchData({ forceFull: true });
    await flush();
    expect(catalog.activeCategory.value).toBe(1);
    expect(catalog.filteredProducts.value).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    corrected.resolve(response(payload(1, { categories: remaining })));
    await refresh; await flush();
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
  });
});

describe('catalog cache survives failed refreshes', () => {
  async function twoCachedCategories() {
    const { catalog, fetchMock } = await initialCatalog();
    fetchMock.mockResolvedValueOnce(response(payload(2, { products: [product(2)] })));
    catalog.selectMainCategory(2);
    await flush();
    expect(catalog.filteredProducts.value).toEqual([product(2)]);
    return { catalog, fetchMock };
  }

  it('keeps cached categories visible after a failed forceFull refresh', async () => {
    const { catalog, fetchMock } = await twoCachedCategories();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await catalog.fetchData({ forceFull: true });
    catalog.selectMainCategory(1);
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
  });

  it('keeps the stale mark when a revalidation fails, so the next visit revalidates again', async () => {
    const { catalog, fetchMock } = await twoCachedCategories();
    fetchMock.mockResolvedValueOnce(response(payload(2, { products: [product(2)] })));
    await catalog.revalidateCatalogScopes();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const before = fetchMock.mock.calls.length;
    catalog.selectMainCategory(1);
    await flush();
    catalog.selectMainCategory(2);
    await flush();
    catalog.selectMainCategory(1);
    await flush();
    expect(fetchMock.mock.calls.length - before).toBe(2);
  });

  it('reports when a stale-scope revalidation lands so the cart can resync prices', async () => {
    const { catalog, fetchMock } = await twoCachedCategories();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await catalog.fetchData({ forceFull: true });
    const seen = catalog.catalogRevalidations.value;
    fetchMock.mockResolvedValueOnce(response(payload(1, { products: [{ ...product(1), price: 9 }] })));
    catalog.selectMainCategory(1);
    await flush();
    expect(catalog.catalogRevalidations.value).toBe(seen + 1);
  });

  it('still reports the revalidation when it fails first and the automatic retry lands', async () => {
    const { catalog, fetchMock } = await twoCachedCategories();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await catalog.fetchData({ forceFull: true });
    const seen = catalog.catalogRevalidations.value;
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    catalog.selectMainCategory(1);
    await flush();
    expect(catalog.catalogRevalidations.value).toBe(seen);
    fetchMock.mockResolvedValueOnce(response(payload(1, { products: [{ ...product(1), price: 9 }] })));
    await vi.advanceTimersByTimeAsync(10000);
    expect(catalog.catalogRevalidations.value).toBe(seen + 1);
  });

  it('reconciles an overlapping availability event without discarding other cached categories', async () => {
    const { catalog, fetchMock } = await twoCachedCategories();
    const held = deferred();
    fetchMock.mockImplementationOnce(() => held.promise);
    const read = catalog.fetchData({ force: true });
    catalog.applyProductAvailabilityChanges([{ product_id: 20, is_available: 0, can_sell: 0 }]);
    fetchMock.mockResolvedValueOnce(response(payload(2, { products: [product(2)] })));
    held.resolve(response(payload(2, { products: [product(2)] })));
    await read;
    const lastUrl = String(fetchMock.mock.calls.at(-1)[0]);
    expect(lastUrl).toContain('lightweight=1');
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    catalog.selectMainCategory(1);
    expect(catalog.filteredProducts.value).toEqual([product(1)]);
  });
});

describe('catalog read recovery without user action', () => {
  it('retries a failed read after 2 s, then only on a heartbeat after the quick retries are spent', async () => {
    const { catalog, fetchMock } = await initialCatalog();
    fetchMock.mockReset().mockRejectedValue(new TypeError('Failed to fetch'));
    await catalog.fetchData({ forceFull: true });
    expect(catalog.catalogLoadError.value).not.toBe('');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);

    fetchMock.mockReset().mockResolvedValue(response(payload()));
    catalog.retryFailedCatalog();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(catalog.catalogLoadError.value).toBe('');
    catalog.retryFailedCatalog();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending quick retry', async () => {
    const { catalog, fetchMock } = await initialCatalog();
    fetchMock.mockReset().mockRejectedValue(new TypeError('Failed to fetch'));
    await catalog.fetchData({ forceFull: true });
    catalog.cancelCatalogRecovery();
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
