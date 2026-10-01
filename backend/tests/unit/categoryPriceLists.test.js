const {
    grossToNet,
    netToGross,
    loadRegisterPriceContext,
    attachRegisterPrices,
    collectCategorySubtree,
    resolveInheritedRootId
} = require('../../services/categoryPriceLists');

describe('categoryPriceLists money conversion', () => {
    it('converts gross 1.000 at 8% to six-decimal net', () => {
        expect(grossToNet(1, 8)).toBe(0.925926);
        expect(netToGross(0.925926, 8)).toBe(1);
    });

    it('keeps zero valid and preserves values at 0% tax', () => {
        expect(grossToNet(0, 16)).toBe(0);
        expect(grossToNet(1.234567, 0)).toBe(1.234567);
        expect(netToGross(1.234567, 0)).toBe(1.234567);
    });

    it.each([-1, Infinity, -Infinity, NaN])('rejects invalid money %s', (value) => {
        expect(() => grossToNet(value, 8)).toThrow();
        expect(() => netToGross(value, 8)).toThrow();
    });

    it('rejects invalid tax and values whose stored net exceeds DECIMAL(10,6)', () => {
        expect(() => grossToNet(1, -1)).toThrow();
        expect(() => grossToNet(1, 101)).toThrow();
        expect(() => grossToNet(10000, 0)).toThrow();
        expect(() => netToGross(10000, 0)).toThrow();
    });
});

describe('categoryPriceLists tree helpers', () => {
    const categories = [
        { id: 1, parent_id: null, price_list_root_id: 1, is_notes: 0, name: 'Root' },
        { id: 2, parent_id: 1, price_list_root_id: 1, is_notes: 0, name: 'Child' },
        { id: 3, parent_id: 2, price_list_root_id: 1, is_notes: 0, name: 'Grandchild' },
        { id: 4, parent_id: null, price_list_root_id: null, is_notes: 0, name: 'Other' }
    ];

    it('collects a subtree parent-first', () => {
        expect(collectCategorySubtree(categories, 2).map(row => row.id)).toEqual([2, 3]);
    });

    it('inherits only a structurally valid self-pointing root', () => {
        const byId = new Map(categories.map(row => [row.id, row]));
        expect(resolveInheritedRootId(byId, 2)).toBe(1);
        expect(resolveInheritedRootId(byId, 4)).toBeNull();
        byId.get(1).parent_id = 99;
        expect(resolveInheritedRootId(byId, 2)).toBeNull();
    });
});

describe('loadRegisterPriceContext', () => {
    it('deduplicates IDs before one SQL query and resolves mixed products independently', async () => {
        const query = vi.fn().mockResolvedValue([[
            { product_id: 1, name: 'Base', base_price: '2.000000', tax_rate: '0.00', category_id: null, category_is_notes: null, price_list_root_id: null, price_list_root_name: null, override_price: null },
            { product_id: 2, name: 'Override', base_price: '3.000000', tax_rate: '8.00', category_id: 20, category_is_notes: 0, price_list_root_id: 20, price_list_root_name: 'Talabat', override_price: '4.000000' },
            { product_id: 3, name: 'Fallback', base_price: '5.000000', tax_rate: '16.00', category_id: 21, category_is_notes: 0, price_list_root_id: 20, price_list_root_name: 'Talabat', override_price: null },
            { product_id: 4, name: 'Notes', base_price: '6.000000', tax_rate: '0.00', category_id: 22, category_is_notes: 1, price_list_root_id: 20, price_list_root_name: 'Talabat', override_price: '9.000000' }
        ]]);

        const result = await loadRegisterPriceContext({ query }, [4, 2, 2, 1, 3]);

        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][1]).toEqual([1, 2, 3, 4]);
        expect(result.get(1)).toMatchObject({ effective_price: 2, price_list_root_id: null, has_price_override: 0 });
        expect(result.get(2)).toMatchObject({ effective_price: 4, price_list_root_id: 20, has_price_override: 1 });
        expect(result.get(3)).toMatchObject({ effective_price: 5, price_list_root_id: 20, has_price_override: 0 });
        expect(result.get(4)).toMatchObject({ effective_price: 6, price_list_root_id: null, has_price_override: 0 });
    });

    it('attaches resolved pricing to existing product map entries', async () => {
        const executor = { query: vi.fn().mockResolvedValue([[
            { product_id: 7, name: 'Item', base_price: '1.000000', tax_rate: '8.00', category_id: 3, category_is_notes: 0, price_list_root_id: 3, price_list_root_name: 'List', override_price: '1.250000' }
        ]]) };
        const map = new Map([[7, { id: 7, price: 1, modifiers: [{ name: 'Size' }] }]]);

        await attachRegisterPrices(executor, map);

        expect(map.get(7)).toMatchObject({ price: 1, effective_price: 1.25, price_list_root_id: 3, has_price_override: 1 });
        expect(map.get(7).modifiers).toEqual([{ name: 'Size' }]);
    });
});
