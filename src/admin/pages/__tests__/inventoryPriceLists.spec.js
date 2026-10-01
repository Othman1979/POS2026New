import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const request = vi.hoisted(() => vi.fn());
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/http.js', () => ({ fetchJsonResponse: request }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
import CategoryPriceListModal from '../../components/CategoryPriceListModal.vue';

const inventorySource = readFileSync(resolve(__dirname, '../Inventory.vue'), 'utf8');
const priceModalSource = readFileSync(resolve(__dirname, '../../components/CategoryPriceListModal.vue'), 'utf8');
const copyModalSource = readFileSync(resolve(__dirname, '../../components/CategoryCopyModal.vue'), 'utf8');
const categoryModalSource = readFileSync(resolve(__dirname, '../../components/CategoryModal.vue'), 'utf8');

const PRODUCTS = [
  { product_id: 1, name: 'Tea', category_id: 3, category_path: 'Drinks', base_gross_price: 1.5, override_gross_price: 2 },
  { product_id: 2, name: 'Coffee', category_id: 3, category_path: 'Drinks', base_gross_price: 2.5, override_gross_price: null },
  { product_id: 3, name: 'Cake', category_id: 4, category_path: 'Desserts', base_gross_price: 3, override_gross_price: 3.25 },
];

describe('Category price-list editor', () => {
  let scope, modal, emit;
  beforeEach(async () => {
    request.mockReset();
    request.mockResolvedValue({ response: { ok: true }, data: { success: true, products: PRODUCTS.map(item => ({ ...item })) } });
    vi.stubGlobal('window', { showAdminConfirm: vi.fn(async () => true), showAdminAlert: vi.fn(), showAdminToast: vi.fn() });
    emit = vi.fn();
    scope = effectScope();
    modal = scope.run(() => CategoryPriceListModal.setup({ show: true, root: { id: 9 } }, { emit, expose: vi.fn() }));
    await vi.waitFor(() => expect(modal.products.value).toHaveLength(3));
    request.mockClear();
    request.mockResolvedValue({ response: { ok: true }, data: { success: true } });
  });
  afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

  it('saves only the products whose price changed, clearing a removed override', async () => {
    modal.draft.value[1] = '2.5';
    modal.draft.value[3] = '';

    await modal.save();

    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('api/admin/category-price-lists/9/prices');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ prices: [{ product_id: 1, gross_price: 2.5 }, { product_id: 3, gross_price: null }] });
    expect(emit).toHaveBeenCalledWith('saved');
  });

  it('sends nothing when an edit only rewrites the same price', async () => {
    modal.draft.value[1] = '2.000';

    await modal.save();

    expect(request).not.toHaveBeenCalled();
  });

  it('stays open with the edits when the admin declines to discard them', async () => {
    window.showAdminConfirm.mockResolvedValue(false);
    modal.draft.value[2] = '2.75';

    await modal.requestClose();

    expect(window.showAdminConfirm).toHaveBeenCalledWith('Discard unsaved price changes?');
    expect(emit).not.toHaveBeenCalledWith('close');
    expect(modal.draft.value[2]).toBe('2.75');
  });

  it('closes without asking when nothing was edited', async () => {
    await modal.requestClose();

    expect(window.showAdminConfirm).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('close');
  });
});

describe('Inventory category price-list workflow', () => {
  it('routes JSON requests through the shared native-fetch seam', () => {
    expect(inventorySource).toContain("import { fetchJson } from '@/shared/http.js';");
    expect(inventorySource).not.toMatch(/\bfetch\s*\(/);
  });

  it('keeps a large price list manageable without another page', () => {
    expect(priceModalSource).toContain('searchQuery');
    expect(priceModalSource).toContain('categoryFilter');
    expect(priceModalSource).toContain('changedOnly');
    expect(priceModalSource).toContain('applyBulkPercentage');
    expect(priceModalSource).toContain('clearFilteredOverrides');
    expect(priceModalSource).toContain('effectiveMoney');
    expect(priceModalSource).toContain('Effective price');
    expect(priceModalSource).toMatch(/h-11/);
  });

  it('exposes price and copy actions on mobile with valid copy destinations', () => {
    const mobileStart = inventorySource.indexOf('<!-- Mobile Card View (< md) -->');
    const mobileEnd = inventorySource.indexOf('<!-- 3. RESTOCK VIEW -->', mobileStart);
    const mobileSource = inventorySource.slice(mobileStart, mobileEnd);

    expect(mobileSource).toContain('openPriceListModal(c)');
    expect(mobileSource).toContain('openCategoryCopyModal(c)');
    expect(inventorySource).toContain('eligibleCopyParentCategories');
    expect(copyModalSource).toMatch(/h-11/);
  });

  it('does not echo the server-owned root id when toggling category status', () => {
    expect(inventorySource).not.toContain('JSON.stringify({ ...c, is_active: nextStatus })');
    expect(inventorySource).toContain('is_price_list_root: Boolean(c.is_price_list_root)');
  });

  it('shows inherited price-list context without accepting a raw root id', () => {
    expect(inventorySource).toContain('c.price_list_root_name');
    expect(categoryModalSource).toContain('inheritedPriceListName');
    expect(categoryModalSource).toContain('is_price_list_root');
    expect(categoryModalSource).not.toContain('price_list_root_id:');
  });
});
