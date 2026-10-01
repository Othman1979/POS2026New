import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const CATS = [{ id: 1, parent_id: null }, { id: 2, parent_id: null }, { id: 3, parent_id: null }];
const responseFor = (products, category) => ({
  ok: true,
  json: async () => ({
    success: true, products, pagination: { total: products.length },
    categories: CATS, categories_included: true, selected_category_id: category,
  }),
});
const categoryOf = (url) => Number(new URL(url, 'http://pos.test').searchParams.get('category_id')) || 1;

// Real catalog composable; only the scheduler is manual, so a test decides when
// the deferred read runs.
async function setup(rowsByCategory) {
  const holds = new Map();
  const reads = [];
  const fetchMock = vi.fn(async (url) => {
    const category = categoryOf(url);
    reads.push(category);
    const held = holds.get(category);
    if (held) await held.promise;
    return responseFor(rowsByCategory[category], category);
  });
  vi.stubGlobal('fetch', fetchMock);
  const catalog = (await import('./useProducts.js')).useProducts();
  const { createStockChangeRefresh } = await import('./stockChangeRefresh.js');
  let run;
  const requested = vi.fn();
  const refresh = createStockChangeRefresh({
    products: catalog,
    createScheduler: (fn) => { run = fn; return { request: requested, cancel() {}, pending: () => false }; },
  });
  const hold = (category) => {
    let release;
    holds.set(category, { promise: new Promise(resolve => { release = resolve; }) });
    return () => { holds.delete(category); release(); };
  };
  const quiet = () => new Promise(resolve => setTimeout(resolve, 30));
  const settled = () => vi.waitFor(() => expect(catalog.isCatalogLoading.value).toBe(false));
  const visit = async (category) => { catalog.selectMainCategory(category); await settled(); };
  return { catalog, refresh, run: () => run(), requested, reads, hold, visit, settled, quiet };
}

const ROWS = { 1: [{ id: 10, category_id: 1 }], 2: [{ id: 10, category_id: 2 }, { id: 20, category_id: 2 }], 3: [{ id: 30, category_id: 3 }] };

describe('stock change refresh keeps every cached scope honest', () => {
  it('an unscoped change then a switch to another cached category before the read runs still revalidates the scope left behind', async () => {
    const t = await setup(ROWS);
    await t.catalog.fetchData();
    await t.visit(2);
    t.catalog.selectMainCategory(1);

    t.refresh.noteUnscoped();
    t.catalog.selectMainCategory(2);
    await t.run();
    await t.settled();

    t.reads.length = 0;
    t.catalog.selectMainCategory(1);
    await vi.waitFor(() => expect(t.reads).toEqual([1]));
  });

  it('a named change while a read of another scope is in flight leaves that scope stale once it lands', async () => {
    const t = await setup(ROWS);
    await t.catalog.fetchData();
    const release = t.hold(2);
    t.catalog.selectMainCategory(2);

    expect(t.refresh.noteNamed([10])).toBe(true);
    release();
    await t.settled();
    t.catalog.selectMainCategory(1);
    await t.run();
    await t.settled();

    t.reads.length = 0;
    t.catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(t.reads).toEqual([2]));
  });

  it('a named change while the previous refresh of the loaded scope is still running does not lose its mark when that read lands', async () => {
    const t = await setup(ROWS);
    await t.catalog.fetchData();
    await t.visit(2);
    t.catalog.selectMainCategory(1);

    const release = t.hold(1);
    const running = t.catalog.fetchData({ force: true });
    expect(t.refresh.noteNamed([10])).toBe(true);
    release();
    await running;
    t.catalog.selectMainCategory(2);
    await t.run();
    await t.settled();

    t.reads.length = 0;
    t.catalog.selectMainCategory(1);
    await vi.waitFor(() => expect(t.reads).toEqual([1]));
  });

  it('a named change reads the loaded scope only and leaves scopes holding none of it fresh', async () => {
    const t = await setup(ROWS);
    await t.catalog.fetchData();
    await t.visit(2);
    await t.visit(3);
    t.catalog.selectMainCategory(1);

    expect(t.refresh.noteNamed([10])).toBe(true);
    t.reads.length = 0;
    await t.run();
    await t.settled();
    expect(t.reads).toEqual([1]);

    t.reads.length = 0;
    t.catalog.selectMainCategory(3);
    await t.settled();
    await t.quiet();
    expect(t.reads).toEqual([]);
    // Category 2 holds product 10, so it revalidates on its next view.
    t.catalog.selectMainCategory(2);
    await vi.waitFor(() => expect(t.reads).toEqual([2]));
  });

  it('re-applies only the pending ids, and clears them once run', async () => {
    const t = await setup(ROWS);
    await t.catalog.fetchData();
    await t.visit(3);
    t.catalog.selectMainCategory(1);
    expect(t.refresh.noteNamed([10])).toBe(true);
    const noted = vi.spyOn(t.catalog, 'noteStockChange');
    const marked = vi.spyOn(t.catalog, 'markCatalogScopesStale');
    await t.run();
    expect(noted).toHaveBeenCalledWith(['10']);
    expect(marked).not.toHaveBeenCalled();
    noted.mockClear();
    await t.run();
    expect(noted).not.toHaveBeenCalled();
  });

  it('runs an unscoped change by marking every scope before the read', async () => {
    const t = await setup(ROWS);
    await t.catalog.fetchData();
    await t.visit(3);
    t.catalog.selectMainCategory(1);
    const order = [];
    const marked = vi.spyOn(t.catalog, 'markCatalogScopesStale').mockImplementation(() => order.push('mark'));
    const fetched = vi.spyOn(t.catalog, 'fetchData').mockImplementation(async () => { order.push('read'); });
    t.refresh.noteUnscoped();
    await t.run();
    // Once when the event arrives and once more at the start of the deferred run.
    expect(order).toEqual(['mark', 'mark', 'read']);
    expect(fetched).toHaveBeenCalledWith({ force: true });
    marked.mockRestore();
  });
});
