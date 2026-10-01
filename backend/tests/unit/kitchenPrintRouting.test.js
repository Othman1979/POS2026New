const { buildKitchenPrintPayloads, filterRoutableKitchenLines } = require('../../services/kitchenPrintRouting');

describe('kitchen print routing', () => {
    it('routes an explicitly assigned subcategory without also routing to its parent', async () => {
        const executor = {
            query: vi.fn(async sql => {
                if (sql.includes('FROM categories')) return [[{ id: 2, parent_id: 1 }]];
                if (sql.includes('FROM printers')) return [[
                    { category_id: 2, id: 10, name: 'Grill', windows_name: 'Grill', type: 'windows', is_active: 1 },
                    { category_id: 1, id: 11, name: 'Main', windows_name: 'Main', type: 'windows', is_active: 1 }
                ]];
                return [[]];
            })
        };
        const result = await buildKitchenPrintPayloads(executor, {
            print_batch_id: 'subscription-1', order_id: 'S1-1', date: '2026-07-22',
            items: [{ id: 1, name: 'Chicken', qty: 1, category_id: 2 }]
        });
        expect(result.unroutedItems).toEqual([]);
        expect(result.payloads.map(payload => payload.printer_id).sort()).toEqual([10]);
        expect(result.payloads.every(payload => payload.data.items[0].name === 'Chicken')).toBe(true);
    });

    it('returns real kitchen lines that have no active route', async () => {
        const executor = { query: vi.fn(async () => [[]]) };
        const result = await buildKitchenPrintPayloads(executor, {
            print_batch_id: 'subscription-2', order_id: 'S1-2', items: [{ id: 2, name: 'Soup', qty: 1, category_id: 9 }]
        });
        expect(result.payloads).toEqual([]);
        expect(result.unroutedItems).toEqual([expect.objectContaining({ id: 2, name: 'Soup' })]);
    });

    it('strips printer control bytes from kitchen headings before queue payload creation', async () => {
        const executor = {
            query: vi.fn(async sql => {
                if (sql.includes('FROM categories')) return [[{ id: 2, parent_id: null }]];
                if (sql.includes('FROM printers')) return [[
                    { category_id: 2, id: 10, name: 'Kitchen', windows_name: 'Kitchen', type: 'windows', is_active: 1 }
                ]];
                return [[]];
            })
        };
        const result = await buildKitchenPrintPayloads(executor, {
            print_batch_id: 'sanitized-heading',
            order_id: 1,
            order_type_name: 'Hold\x1b@ 4',
            table_number: 'Table\x1dV 2',
            hash_number: 'Hash\x1b! 9',
            items: [{ id: 1, name: 'Chicken', qty: 1, category_id: 2 }]
        });

        expect(result.payloads[0].data).toMatchObject({
            order_type_name: 'Hold@ 4',
            table_number: 'TableV 2',
            hash_number: 'Hash! 9'
        });
    });

    it('keeps distinct bundle children that share one kitchen printer', async () => {
        const executor = {
            query: vi.fn(async sql => {
                if (sql.includes('FROM categories')) return [[
                    { id: 2, parent_id: null },
                    { id: 3, parent_id: null }
                ]];
                if (sql.includes('FROM printers')) return [[
                    { category_id: 2, id: 10, name: 'Kitchen', windows_name: 'Kitchen', type: 'windows', is_active: 1 },
                    { category_id: 3, id: 10, name: 'Kitchen', windows_name: 'Kitchen', type: 'windows', is_active: 1 }
                ]];
                return [[]];
            })
        };
        const result = await buildKitchenPrintPayloads(executor, {
            print_batch_id: 'subscription-void-bundle',
            void_ticket: true,
            items: [{
                id: 50, product_id: 500, name: 'Meal Bundle', qty: 1,
                bundleItems: [
                    { product_id: 1, name: 'Burger', qty: 1, category_id: 2 },
                    { product_id: 2, name: 'Fries', qty: 1, category_id: 3 }
                ]
            }]
        });

        expect(result.payloads).toHaveLength(1);
        expect(result.payloads[0].data.items.map(item => item.product_id)).toEqual([1, 2]);
    });

    it('shows an id-less bundle sibling as context when children use different printers', async () => {
        const executor = {
            query: vi.fn(async sql => {
                if (sql.includes('FROM categories')) return [[
                    { id: 2, parent_id: null },
                    { id: 3, parent_id: null }
                ]];
                if (sql.includes('FROM printers')) return [[
                    { category_id: 2, id: 10, name: 'Grill', windows_name: 'Grill', type: 'windows', is_active: 1 },
                    { category_id: 3, id: 11, name: 'Fryer', windows_name: 'Fryer', type: 'windows', is_active: 1 }
                ]];
                return [[]];
            })
        };
        const result = await buildKitchenPrintPayloads(executor, {
            print_batch_id: 'bundle-split-printers',
            items: [{
                id: 50, product_id: 500, name: 'Meal Bundle', qty: 1,
                bundleItems: [
                    { product_id: 1, name: 'Burger', qty: 1, category_id: 2 },
                    { product_id: 2, name: 'Fries', qty: 1, category_id: 3 }
                ]
            }]
        });

        expect(result.payloads).toHaveLength(2);
        for (const payload of result.payloads) {
            expect(payload.data.items).toHaveLength(2);
            expect(payload.data.items.filter(item => item._isOther)).toHaveLength(1);
        }
    });

    it('filterRoutableKitchenLines splits by direct and parent category routes', async () => {
        // seed: category 1 → printer (existing); insert category 2 (no printer); category 3 child of 1
        const executor = {
            query: vi.fn(async sql => {
                if (sql.includes('FROM categories')) return [[
                    { id: 1, parent_id: null },
                    { id: 2, parent_id: null },
                    { id: 3, parent_id: 1 }
                ]];
                if (sql.includes('FROM printers')) return [[
                    { category_id: 1, id: 10, name: 'Main', windows_name: 'Main', type: 'windows', is_active: 1 }
                ]];
                return [[]];
            })
        };
        const { routable, unrouted } = await filterRoutableKitchenLines(executor, [
            { id: 1, category_id: 1 }, { id: 2, category_id: 3 }, { id: 3, category_id: 2 }, { id: 4, category_id: null }
        ]);
        expect(routable.map(l => l.id)).toEqual([1, 2]);
        expect(unrouted.map(l => l.id)).toEqual([3, 4]);
    });
});
