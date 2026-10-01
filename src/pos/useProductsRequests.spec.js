import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
  // A failed read schedules a retry timer on its module instance; left alone it
  // would fire into a later test's fetch mock after the module is reset.
  try { (await import('./useProducts.js')).useProducts().cancelCatalogRecovery(); } catch (_) { /* module never loaded */ }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('useProducts request ownership', () => {
  const responseFor = (
    products,
    total = products.length,
    selectedCategory = 1,
    availableCategories = [{ id: 1, parent_id: null }, { id: 2, parent_id: null }],
  ) => ({
    ok: true,
    json: async () => ({
      success: true, products, pagination: { total },
      categories: availableCategories,
      categories_included: true, selected_category_id: selectedCategory,
    })
  });

  it('sends one append request while Load More is pending and permits the next page afterward', async () => {
    let resolveAppend;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 1 }], 3))
      .mockImplementationOnce(() => new Promise(resolve => { resolveAppend = resolve; }))
      .mockResolvedValueOnce(responseFor([{ id: 3 }], 3));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();

    catalog.loadMoreProducts();
    catalog.loadMoreProducts();
    catalog.loadMoreProducts();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.isCatalogLoading.value).toBe(true);
    expect(new URL(fetchMock.mock.calls[1][0], 'http://pos.test').searchParams.get('offset')).toBe('1');

    resolveAppend(responseFor([{ id: 2 }], 3));
    await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
    catalog.loadMoreProducts();
    await vi.waitFor(() => expect(catalog.products.value.map(product => product.id)).toEqual([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(fetchMock.mock.calls[2][0], 'http://pos.test').searchParams.get('offset')).toBe('2');
  });

  it('blocks appending old products while a new category loads and ignores an older append response', async () => {
    const pending = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(responseFor([{ id: 1 }], 4))
      .mockImplementation(() => new Promise(resolve => pending.push(resolve))));
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();
    catalog.loadMoreProducts();
    catalog.selectMainCategory(2);
    catalog.loadMoreProducts();
    expect(fetch).toHaveBeenCalledTimes(3);

    pending[0](responseFor([{ id: 2 }], 4));
    await Promise.resolve();
    await Promise.resolve();
    expect(catalog.isCatalogLoading.value).toBe(true);
    pending[1](responseFor([{ id: 20 }], 1, 2));
    await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
    expect(catalog.products.value.map(product => product.id)).toEqual([20]);
  });

  it('revalidates catalog GETs through the browser HTTP cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseFor([{ id: 1, category_id: 1 }]));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('api/pos/products?'),
      expect.objectContaining({
        cache: 'no-cache',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reopens a recently visited category without another request or loading state', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockResolvedValueOnce(responseFor([{ id: 20, category_id: 2 }], 1, 2))
      .mockResolvedValueOnce(responseFor([{ id: 11, category_id: 1 }], 1, 1));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]));

    catalog.selectMainCategory(1);

    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([10]);
    expect(catalog.isCatalogLoading.value).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a pending category request when returning to a cached category', async () => {
    let resolveSecond;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    catalog.selectMainCategory(2);
    const secondSignal = fetchMock.mock.calls[1][1].signal;
    catalog.selectMainCategory(1);

    expect(secondSignal.aborted).toBe(true);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([10]);
    expect(catalog.isCatalogLoading.value).toBe(false);

    resolveSecond(responseFor([{ id: 20, category_id: 2 }], 1, 2));
    await Promise.resolve();
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([10]);
  });

  it('drops recent category snapshots when an authoritative invalidation occurs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockResolvedValueOnce(responseFor([{ id: 20, category_id: 2 }], 1, 2))
      .mockResolvedValueOnce(responseFor([{ id: 11, category_id: 1 }], 1, 1));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]));

    catalog.invalidateCatalogSnapshots();
    catalog.selectMainCategory(1);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([11]));

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('cancels an in-flight category read when an authoritative invalidation occurs', async () => {
    let resolveStaleCategory;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockImplementationOnce(() => new Promise(resolve => { resolveStaleCategory = resolve; }))
      .mockResolvedValueOnce(responseFor([{ id: 21, category_id: 2, is_available: 0 }], 1, 2));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    catalog.selectMainCategory(2);
    const staleSignal = fetchMock.mock.calls[1][1].signal;

    catalog.invalidateCatalogSnapshots();

    expect(staleSignal.aborted).toBe(true);
    expect(catalog.isCatalogLoading.value).toBe(false);
    resolveStaleCategory(responseFor([{ id: 20, category_id: 2, is_available: 1 }], 1, 2));
    await Promise.resolve();
    await Promise.resolve();
    expect(catalog.filteredProducts.value).toEqual([]);

    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([21]));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps an authoritative refresh and overlays availability changes received while it is pending', async () => {
    let resolveRecovery;
    const refreshedCategories = [
      { id: 1, parent_id: null },
      { id: 2, parent_id: null },
      { id: 3, parent_id: null },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([
        { id: 10, category_id: 1, is_available: 1, can_sell: 1 },
      ], 1, 1))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRecovery = resolve; }))
      .mockResolvedValueOnce(responseFor([
        { id: 10, category_id: 1, is_available: 1, can_sell: 1 },
        { id: 11, category_id: 1, is_available: 0, can_sell: 0 },
      ], 2, 1, refreshedCategories));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    const recovery = catalog.fetchData({ forceFull: true });
    const recoverySignal = fetchMock.mock.calls[1][1].signal;

    catalog.applyProductAvailabilityChanges([
      { product_id: 10, is_available: 0, can_sell: 0 },
      { product_id: 11, is_available: 0, can_sell: 0 },
    ]);
    catalog.applyProductAvailabilityChanges([
      { product_id: 10, is_available: 1, can_sell: 1 },
    ]);

    expect(recoverySignal.aborted).toBe(false);
    resolveRecovery(responseFor([
      { id: 10, category_id: 1, is_available: 0, can_sell: 0 },
      { id: 11, category_id: 1, is_available: 1, can_sell: 1 },
    ], 2, 1, refreshedCategories));
    await recovery;

    expect(catalog.categories.value).toEqual(refreshedCategories);
    expect(catalog.filteredProducts.value).toEqual([
      { id: 10, category_id: 1, is_available: 1, can_sell: 1 },
      { id: 11, category_id: 1, is_available: 0, can_sell: 0 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('lets an authoritative reconciliation correct an older availability event', async () => {
    let resolveRecovery;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([
        { id: 10, category_id: 1, is_available: 1, can_sell: 1 },
      ], 1, 1))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRecovery = resolve; }))
      .mockResolvedValueOnce(responseFor([
        { id: 10, category_id: 1, is_available: 1, can_sell: 1 },
      ], 1, 1));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    const recovery = catalog.fetchData({ forceFull: true });
    catalog.applyProductAvailabilityChanges([
      { product_id: 10, is_available: 0, can_sell: 0 },
    ]);
    expect(catalog.filteredProducts.value[0]).toMatchObject({ is_available: 0, can_sell: 0 });

    resolveRecovery(responseFor([
      { id: 10, category_id: 1, is_available: 1, can_sell: 1 },
    ], 1, 1));
    await recovery;

    expect(catalog.filteredProducts.value).toEqual([
      { id: 10, category_id: 1, is_available: 1, can_sell: 1 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps a live availability event when the overlapping refresh fails', async () => {
    let resolveRecovery;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([
        { id: 10, category_id: 1, is_available: 1, can_sell: 1 },
      ], 1, 1))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRecovery = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    const recovery = catalog.fetchData({ forceFull: true });
    catalog.applyProductAvailabilityChanges([
      { product_id: 10, is_available: 0, can_sell: 0 },
    ]);
    resolveRecovery({ ok: false, status: 503 });
    await recovery;

    expect(catalog.filteredProducts.value).toEqual([
      { id: 10, category_id: 1, is_available: 0, can_sell: 0 },
    ]);
    expect(catalog.catalogLoadError.value).toBe('Unable to load products.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds recent category snapshots and refetches an evicted category', async () => {
    const availableCategories = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, parent_id: null }));
    const fetchMock = vi.fn();
    for (let category = 1; category <= 7; category += 1) {
      fetchMock.mockResolvedValueOnce(responseFor(
        [{ id: category * 10, category_id: category }],
        1,
        category,
        availableCategories,
      ));
    }
    fetchMock.mockResolvedValueOnce(responseFor([{ id: 11, category_id: 1 }], 1, 1, availableCategories));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    for (let category = 2; category <= 7; category += 1) {
      catalog.selectMainCategory(category);
      await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([category * 10]));
    }

    catalog.selectMainCategory(1);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([11]));
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('derives a complete direct subcategory from its cached parent page', async () => {
    const availableCategories = [
      { id: 1, parent_id: null },
      { id: 11, parent_id: 1 },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([
        { id: 10, category_id: 1 },
        { id: 110, category_id: 11 },
      ], 2, 1, availableCategories))
      .mockResolvedValueOnce(responseFor([{ id: 111, category_id: 11 }], 1, 1, availableCategories));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    catalog.selectSubcategory(11);

    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([110]);
    expect(catalog.isCatalogLoading.value).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries one transient non-JSON catalog response without parsing the HTML body', async () => {
    const htmlResponse = {
      ok: true,
      status: 200,
      headers: { get: vi.fn().mockReturnValue('text/html; charset=utf-8') },
      json: vi.fn(),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(htmlResponse)
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();

    expect(htmlResponse.json).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([10]);
    expect(catalog.catalogLoadError.value).toBe('');
  });

  it('retries invalid JSON when a proxy omits the response content type', async () => {
    const invalidJson = vi.fn().mockRejectedValue(new SyntaxError('Unexpected token <'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => '' },
        json: invalidJson,
      })
      .mockResolvedValueOnce(responseFor([{ id: 17, category_id: 1 }], 1, 1));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();

    expect(invalidJson).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([17]);
    expect(catalog.catalogLoadError.value).toBe('');
  });

  it('stops after one retry when non-JSON responses persist', async () => {
    const htmlResponse = () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      json: vi.fn(),
    });
    const first = htmlResponse();
    const second = htmlResponse();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.json).not.toHaveBeenCalled();
    expect(second.json).not.toHaveBeenCalled();
    expect(catalog.filteredProducts.value).toEqual([]);
    expect(catalog.catalogLoadError.value).toBe('Unable to load products.');
  });

  it('does not derive a subcategory from an incomplete parent page', async () => {
    const availableCategories = [
      { id: 1, parent_id: null },
      { id: 11, parent_id: 1 },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([
        { id: 10, category_id: 1 },
        { id: 110, category_id: 11 },
      ], 3, 1, availableCategories))
      .mockResolvedValueOnce(responseFor([{ id: 111, category_id: 11 }], 1, 1, availableCategories));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    catalog.selectSubcategory(11);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([111]));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serializes product availability updates', async () => {
    const response = { ok: true, json: vi.fn().mockResolvedValue({ success: true }) };
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const products = (await import('./useProducts.js')).useProducts();

    await expect(products.setProductAvailability(12, false)).resolves.toEqual({
      response,
      data: { success: true },
    });
    expect(fetchMock).toHaveBeenCalledWith('api/pos/products/12/availability', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_available: false }),
      signal: expect.any(AbortSignal),
    });
  });

  it('serializes category-price resolution for the requested sales context', async () => {
    const response = { ok: true, json: vi.fn().mockResolvedValue({ success: true, products: [] }) };
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const products = (await import('./useProducts.js')).useProducts();

    await products.resolveCategoryPrices([4, 9], 'register');

    expect(fetchMock).toHaveBeenCalledWith('api/pos/category-prices/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sales_context: 'register', product_ids: [4, 9] }),
      signal: expect.any(AbortSignal),
    });
  });

  it('gives category-price resolution a deadline so a stalled request cannot hang recovery', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const products = (await import('./useProducts.js')).useProducts();
    const pending = products.resolveCategoryPrices([4], 'register');
    const outcome = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(15000);
    await outcome;
    vi.useRealTimers();
  });

  it('stock refresh keeps cached scopes and marks them stale', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockResolvedValueOnce(responseFor([{ id: 20, category_id: 2 }], 1, 2))
      .mockResolvedValueOnce(responseFor([{ id: 11, category_id: 1 }], 1, 1))
      .mockResolvedValueOnce(responseFor([{ id: 21, category_id: 2 }], 1, 2));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]));
    catalog.selectMainCategory(1);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([10]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await catalog.revalidateCatalogScopes();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshUrl = new URL(fetchMock.mock.calls[2][0], 'http://pos.test');
    expect(refreshUrl.searchParams.get('lightweight')).toBe('1');
    expect(refreshUrl.searchParams.get('category_id')).toBe('1');
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([11]);

    catalog.selectMainCategory(2);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const revalidateUrl = new URL(fetchMock.mock.calls[3][0], 'http://pos.test');
    expect(revalidateUrl.searchParams.get('lightweight')).toBe('1');
    expect(revalidateUrl.searchParams.get('category_id')).toBe('2');
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([21]));

    catalog.selectMainCategory(1);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([11]));
    catalog.selectMainCategory(2);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([21]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('catalog-scoped refresh keeps the cache, re-reads the current scope lightweight, and marks other scopes stale', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockResolvedValueOnce(responseFor([{ id: 20, category_id: 2 }], 1, 2))
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }, { id: 5, category_id: 1 }], 2, 1))
      .mockResolvedValueOnce(responseFor([{ id: 20, category_id: 2 }], 1, 2));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]));
    catalog.selectMainCategory(1);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([10]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await catalog.revalidateCatalogScopes();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshUrl = new URL(fetchMock.mock.calls[2][0], 'http://pos.test');
    expect(refreshUrl.searchParams.get('lightweight')).toBe('1');
    expect(refreshUrl.searchParams.get('category_id')).toBe('1');
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([10, 5]);

    catalog.selectMainCategory(2);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const revalidateUrl = new URL(fetchMock.mock.calls[3][0], 'http://pos.test');
    expect(revalidateUrl.searchParams.get('lightweight')).toBe('1');
    expect(revalidateUrl.searchParams.get('category_id')).toBe('2');
    await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));

    catalog.selectMainCategory(1);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([10, 5]);
    catalog.selectMainCategory(2);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a named stock change marks only cached scopes holding it stale and reports whether the loaded rows hold it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockResolvedValueOnce(responseFor([{ id: 20, category_id: 2 }], 1, 2));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();
    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]));
    catalog.selectMainCategory(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Category 1 is on screen: its row is named, so the caller must read now.
    expect(catalog.noteStockChange([10])).toBe(true);
    // Category 2 is cached off screen: marked stale, nothing to read now.
    expect(catalog.noteStockChange(['20'])).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // An unrelated product touches nothing.
    expect(catalog.noteStockChange([999])).toBe(false);

    fetchMock.mockResolvedValueOnce(responseFor([{ id: 20, category_id: 2, stock: 3 }], 1, 2));
    catalog.selectMainCategory(2);
    expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(new URL(fetchMock.mock.calls[2][0], 'http://pos.test').searchParams.get('category_id')).toBe('2');
    await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
    // Category 1 was named while loaded (the caller's deferred refresh has not
    // run here), so returning to it revalidates instead of trusting old rows.
    fetchMock.mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1));
    catalog.selectMainCategory(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it('a named stock change on the loaded scope marks it stale at once, so leaving before the deferred refresh still revalidates it on return', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockResolvedValueOnce(responseFor([{ id: 20, category_id: 2 }], 1, 2));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();

    // Category 1 is on screen and named: the caller schedules a 250 ms refresh.
    expect(catalog.noteStockChange([10])).toBe(true);
    // The cashier moves to an uncached category before it runs.
    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]));
    await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1, stock: 4 }], 1, 1));
    catalog.selectMainCategory(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(new URL(fetchMock.mock.calls[2][0], 'http://pos.test').searchParams.get('category_id')).toBe('1');
  });

  it('a named stock change asks for a read while a catalog read is in flight, so the answer cannot paint pre-sale stock', async () => {
    let resolveCategory2;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockImplementationOnce(() => new Promise(resolve => { resolveCategory2 = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();

    // Category 2 is not cached: rows still belong to category 1 while its read is pending.
    catalog.selectMainCategory(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.noteStockChange([20])).toBe(true);

    resolveCategory2(responseFor([{ id: 20, category_id: 2, stock: 1 }], 1, 2));
    await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
    // Settled and named nowhere on screen: no read is requested.
    expect(catalog.noteStockChange([999])).toBe(false);
  });

  it('a named stock change on the loaded scope refreshes it and stales only the cached scopes holding the product; an unscoped one stales them all', async () => {
    const cats = [{ id: 1, parent_id: null }, { id: 2, parent_id: null }, { id: 3, parent_id: null }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1, cats))
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 2 }, { id: 20, category_id: 2 }], 2, 2, cats))
      .mockResolvedValueOnce(responseFor([{ id: 30, category_id: 3 }], 1, 3, cats));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();
    for (const category of [2, 3]) {
      catalog.selectMainCategory(category);
      await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
      expect(fetchMock).toHaveBeenCalledTimes(category);
    }
    catalog.selectMainCategory(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Named product 10 is on screen: the terminal reads the loaded scope only.
    fetchMock.mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1, stock: 4 }], 1, 1, cats));
    expect(catalog.noteStockChange([10])).toBe(true);
    await catalog.fetchData({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Category 3 holds none of it and stays fresh; category 2 holds it and revalidates.
    catalog.selectMainCategory(3);
    await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockResolvedValueOnce(responseFor([{ id: 10, category_id: 2 }, { id: 20, category_id: 2 }], 2, 2, cats));
    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    // Unscoped: the affected set is unknown, so category 3 revalidates as well.
    catalog.markCatalogScopesStale();
    fetchMock.mockResolvedValueOnce(responseFor([{ id: 30, category_id: 3 }], 1, 3, cats));
    catalog.selectMainCategory(3);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
  });

  it('a named stock change asks for a read while a read of the loaded scope is in flight, so a landing answer cannot paint pre-sale stock', async () => {
    let resolveRefresh;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();

    // The loaded scope is being re-read; product 20 is not in its rows yet.
    const refreshing = catalog.fetchData({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.noteStockChange([20])).toBe(true);

    resolveRefresh(responseFor([{ id: 10, category_id: 1 }, { id: 20, category_id: 1 }], 2, 1));
    await refreshing;
    expect(catalog.noteStockChange([999])).toBe(false);
  });

  it('measures catalog reads per sale across 10 tills with the real catalog composable', async () => {
    // Each till shows its own category and caches a second one. A sale names 3 products.
    const affected = [101, 102, 103];
    const measure = async (decide, shownAffected) => {
      let total = 0;
      for (let till = 0; till < 10; till += 1) {
        vi.resetModules();
        const own = till === 0 && shownAffected ? [{ id: 101, category_id: 1 }] : [{ id: till * 10 + 1, category_id: 1 }];
        const fetchMock = vi.fn().mockImplementation(async (url) => (
          new URL(url, 'http://pos.test').searchParams.get('category_id') === '2'
            ? responseFor([{ id: till * 10 + 2, category_id: 2 }], 1, 2)
            : responseFor(own, 1, 1)));
        vi.stubGlobal('fetch', fetchMock);
        const catalog = (await import('./useProducts.js')).useProducts();
        await catalog.fetchData();
        catalog.selectMainCategory(2);
        await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
        catalog.selectMainCategory(1);
        const baseline = fetchMock.mock.calls.length;
        await decide(catalog);
        // The till then revisits both categories.
        catalog.selectMainCategory(2);
        catalog.selectMainCategory(1);
        await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
        total += fetchMock.mock.calls.length - baseline;
      }
      return total;
    };
    // Master: every stock event ran revalidateCatalogScopes().
    const before = await measure(catalog => catalog.revalidateCatalogScopes(), false);
    // The terminal's real stock refresh, with the scheduler replaced by a direct call.
    const viaTerminal = (act) => async (catalog) => {
      const { createStockChangeRefresh } = await import('./stockChangeRefresh.js');
      let run;
      const refresh = createStockChangeRefresh({ products: catalog, createScheduler: fn => { run = fn; return { request() {}, cancel() {}, pending: () => false }; } });
      if (act(refresh)) await run();
    };
    const gated = viaTerminal(refresh => refresh.noteNamed(affected));
    const unscoped = viaTerminal(refresh => { refresh.noteUnscoped(); return true; });
    const after = await measure(gated, false);
    const afterOneOnScreen = await measure(gated, true);
    const afterUnscoped = await measure(unscoped, false);
    console.info(`catalog GETs per sale incl. revisits, 10 tills: before=${before} after(off screen)=${after} after(1 till shows an affected product)=${afterOneOnScreen} unscoped fallback=${afterUnscoped}`);
    expect(after).toBe(0);
    expect(before).toBeGreaterThan(after);
    expect(afterOneOnScreen).toBeGreaterThan(after);
    expect(afterOneOnScreen).toBeLessThan(before);
    expect(afterUnscoped).toBe(before);
  });

  it('availability event patches live and cached rows without dropping the cache', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1, is_available: 1, can_sell: 1 }], 1, 1))
      .mockResolvedValueOnce(responseFor([{ id: 20, category_id: 2, is_available: 1, can_sell: 1 }], 1, 2));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();

    await catalog.fetchData();
    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([20]));

    catalog.applyProductAvailabilityChanges([
      { product_id: 10, is_available: 0, can_sell: 0 },
      { product_id: 20, is_available: 0, can_sell: 0 },
    ]);
    expect(catalog.products.value.find(product => product.id === 20).can_sell).toBe(0);

    catalog.selectMainCategory(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const restored = catalog.products.value.find(product => product.id === 10);
    expect(restored.can_sell).toBe(0);
    expect(restored.is_available).toBe(0);
  });

  it('background revalidation re-reads every row the user loaded with Load More', async () => {
    const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ id: from + i, category_id: 1 }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor(rows(1, 120), 200))
      .mockResolvedValueOnce(responseFor(rows(121, 80), 200))
      .mockResolvedValueOnce(responseFor(rows(1, 200), 200));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();
    catalog.loadMoreProducts();
    await vi.waitFor(() => expect(catalog.filteredProducts.value).toHaveLength(200));

    await catalog.revalidateCatalogScopes();
    const params = new URL(fetchMock.mock.calls[2][0], 'http://pos.test').searchParams;
    expect(params.get('offset')).toBe('0');
    expect(params.get('limit')).toBe('200');
    expect(catalog.filteredProducts.value).toHaveLength(200);

    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(new URL(fetchMock.mock.calls[3][0], 'http://pos.test').searchParams.get('limit')).toBe('120');
  });

  it('restores the cached category immediately when the search is cleared', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor([{ id: 10, category_id: 1 }], 1, 1))
      .mockResolvedValueOnce(responseFor([{ id: 99, category_id: 2 }], 1, 1));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();
    vi.useFakeTimers();
    try {
      catalog.searchQuery.value = 'tea';
      await Promise.resolve();
      vi.advanceTimersByTime(149);
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      catalog.searchQuery.value = '';
      await Promise.resolve();
      await Promise.resolve();
      expect(catalog.filteredProducts.value.map(product => product.id)).toEqual([10]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useProducts sales-context switches', () => {
  const categoriesFor = context => context === 'table'
    ? [{ id: 1, parent_id: null }, { id: 2, parent_id: null }]
    : [{ id: 1, parent_id: null }, { id: 3, parent_id: null }];
  const catalogResponse = (url) => {
    const params = new URL(url, 'http://pos.test').searchParams;
    const context = params.get('sales_context');
    const category = Number(params.get('category_id') || 1);
    const lightweight = params.has('lightweight');
    return {
      ok: true,
      json: async () => ({
        success: true,
        products: [{ id: `${context}-${category}`, category_id: category, price: context === 'table' ? 9 : 5 }],
        pagination: { total: 1 },
        categories: lightweight ? [] : categoriesFor(context),
        categories_included: !lightweight,
        selected_category_id: lightweight ? null : 1,
      }),
    };
  };

  it('keeps each context cached across register -> table -> register and revalidates in the background', async () => {
    const fetchMock = vi.fn(async url => catalogResponse(url));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();
    catalog.setSalesContext('table');
    await catalog.fetchData({ preferCache: true });
    catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(catalog.filteredProducts.value.map(p => p.id)).toEqual(['table-2']));
    const beforeReturn = fetchMock.mock.calls.length;

    catalog.setSalesContext('register');
    // Same frame: cached register rows, rail and category, no blank grid.
    expect(catalog.filteredProducts.value.map(p => p.id)).toEqual(['register-1']);
    expect(catalog.categories.value.map(c => c.id)).toEqual([1, 3]);
    expect(catalog.activeCategory.value).toBe(1);

    const revalidations = catalog.catalogRevalidations.value;
    await catalog.fetchData({ preferCache: true });
    await vi.waitFor(() => expect(catalog.catalogRevalidations.value).toBe(revalidations + 1));
    expect(fetchMock.mock.calls.length).toBe(beforeReturn + 1);
    const params = new URL(fetchMock.mock.calls.at(-1)[0], 'http://pos.test').searchParams;
    expect(params.get('sales_context')).toBe('register');
    expect(params.get('lightweight')).toBe('1');

    catalog.setSalesContext('table');
    expect(catalog.activeCategory.value).toBe(2);
    expect(catalog.categories.value.map(c => c.id)).toEqual([1, 2]);
    expect(catalog.filteredProducts.value.map(p => p.id)).toEqual(['table-2']);
  });

  it('re-reads full metadata for a context whose categories went stale while it was hidden', async () => {
    const fetchMock = vi.fn(async url => catalogResponse(url));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();
    catalog.setSalesContext('table');
    await catalog.fetchData({ preferCache: true });
    await catalog.fetchData({ forceFull: true }); // a catalog change seen in table context
    catalog.setSalesContext('register');
    expect(catalog.filteredProducts.value.map(p => p.id)).toEqual(['register-1']);
    await catalog.fetchData({ preferCache: true });
    await vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
    const params = new URL(fetchMock.mock.calls.at(-1)[0], 'http://pos.test').searchParams;
    expect(params.get('sales_context')).toBe('register');
    expect(params.has('lightweight')).toBe(false);
  });


  it('drops the catalog token when a scoped read sees a newer one, so the next check reads in full', async () => {
    const withToken = (token, selected) => ({
      ok: true,
      json: async () => ({
        success: true, products: [{ id: 1 }], pagination: { total: 1 },
        categories: [{ id: 1, parent_id: null }, { id: 2, parent_id: null }],
        categories_included: true, selected_category_id: selected, catalog_generation: token,
      }),
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(withToken('g1', 1))
      .mockResolvedValueOnce(withToken('g1', 2))
      .mockResolvedValueOnce(withToken('g2', 1))
      .mockResolvedValueOnce(withToken('g2', 2))
      .mockResolvedValueOnce(withToken('g3', 1)));
    const catalog = (await import('./useProducts.js')).useProducts();
    await catalog.fetchData();
    expect(catalog.catalogGeneration.value).toBe('g1');
    await catalog.fetchData({ force: true });
    expect(catalog.catalogGeneration.value).toBe('g1');
    await catalog.fetchData({ force: true });
    expect(catalog.catalogGeneration.value).toBeNull();
    // Untouched cached scopes were never marked stale: a second scoped read at
    // the same token must not restore it.
    await catalog.fetchData({ force: true });
    expect(catalog.catalogGeneration.value).toBeNull();
    await catalog.fetchData({ forceFull: true });
    expect(catalog.catalogGeneration.value).toBe('g3');
  });
});
