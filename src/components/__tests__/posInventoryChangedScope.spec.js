import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';

// Exercise the real event handler with its catalog and cart consumers replaced.
const source = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
const handler = parseScript(source, { sourceType: 'module' }).program.body
    .flatMap(node => node.declarations || []).find(node => node.id.name === 'onInventoryChanged').init;
const buildHandler = new Function(
    'products',
    'syncCartAvailabilityFromCatalog',
    'refreshCartCatalogPrices',
    'refreshCatalogAndCart',
    'stockRefresh',
    'cartItems',
    'collectCartCatalogProductIds',
    `return (${source.slice(handler.start, handler.end)});`,
);

const createHarness = (cartProductIds = [], screenProductIds = []) => {
    const deps = {
        products: {
            revalidateCatalogScopes: vi.fn().mockResolvedValue(undefined),
        },
        syncCartAvailabilityFromCatalog: vi.fn(),
        refreshCartCatalogPrices: vi.fn().mockResolvedValue(undefined),
        refreshCatalogAndCart: vi.fn().mockResolvedValue(undefined),
        stockRefresh: { noteNamed: vi.fn(ids => ids.some(id => screenProductIds.map(String).includes(String(id)))), noteUnscoped: vi.fn() },
        cartItems: { value: cartProductIds.map(id => ({ product_id: id })) },
        collectCartCatalogProductIds: vi.fn(items => items.map(item => item.product_id)),
    };
    const onInventoryChanged = buildHandler(
        deps.products,
        deps.syncCartAvailabilityFromCatalog,
        deps.refreshCartCatalogPrices,
        deps.refreshCatalogAndCart,
        deps.stockRefresh,
        deps.cartItems,
        deps.collectCartCatalogProductIds,
    );
    return { deps, onInventoryChanged };
};

describe('inventory event refresh scope', () => {
    it('refreshes only the listed products and reprices a cart that contains one of them', async () => {
        const { deps, onInventoryChanged } = createHarness([5, 9]);
        await onInventoryChanged({ scope: 'catalog', productIds: [5] });
        expect(deps.products.revalidateCatalogScopes).toHaveBeenCalledOnce();
        expect(deps.products.revalidateCatalogScopes).toHaveBeenCalledWith();
        expect(deps.syncCartAvailabilityFromCatalog).toHaveBeenCalledOnce();
        expect(deps.refreshCartCatalogPrices).toHaveBeenCalledOnce();
        expect(deps.refreshCatalogAndCart).not.toHaveBeenCalled();
        expect(deps.stockRefresh.noteUnscoped).not.toHaveBeenCalled();
        expect(deps.stockRefresh.noteNamed).not.toHaveBeenCalled();
    });

    it('skips cart repricing when no listed product is in the cart', async () => {
        const { deps, onInventoryChanged } = createHarness([9]);
        await onInventoryChanged({ scope: 'catalog', productIds: [5] });
        expect(deps.products.revalidateCatalogScopes).toHaveBeenCalledWith();
        expect(deps.syncCartAvailabilityFromCatalog).toHaveBeenCalledOnce();
        expect(deps.refreshCartCatalogPrices).not.toHaveBeenCalled();
        expect(deps.refreshCatalogAndCart).not.toHaveBeenCalled();
    });

    it('treats a catalog event without product ids as unknown and refreshes fully', async () => {
        const { deps, onInventoryChanged } = createHarness([5]);
        await onInventoryChanged({ scope: 'catalog', productIds: [] });
        expect(deps.products.revalidateCatalogScopes).not.toHaveBeenCalled();
        expect(deps.refreshCatalogAndCart).toHaveBeenCalledOnce();
    });

    it('routes stock events to the coalescing scheduler only', async () => {
        const { deps, onInventoryChanged } = createHarness([5]);
        await onInventoryChanged({ scope: 'stock' });
        expect(deps.stockRefresh.noteUnscoped).toHaveBeenCalledOnce();
        expect(deps.products.revalidateCatalogScopes).not.toHaveBeenCalled();
        expect(deps.refreshCatalogAndCart).not.toHaveBeenCalled();
        expect(deps.refreshCartCatalogPrices).not.toHaveBeenCalled();
    });

    it('ignores availability events, which have their own targeted handler', async () => {
        const { deps, onInventoryChanged } = createHarness([5]);
        await onInventoryChanged({ scope: 'availability' });
        expect(deps.stockRefresh.noteUnscoped).not.toHaveBeenCalled();
        expect(deps.stockRefresh.noteNamed).not.toHaveBeenCalled();
        expect(deps.products.revalidateCatalogScopes).not.toHaveBeenCalled();
        expect(deps.refreshCatalogAndCart).not.toHaveBeenCalled();
        expect(deps.syncCartAvailabilityFromCatalog).not.toHaveBeenCalled();
    });

    it('retains the full refresh for an unscoped event', async () => {
        const { deps, onInventoryChanged } = createHarness([5]);
        await onInventoryChanged(undefined);
        expect(deps.refreshCatalogAndCart).toHaveBeenCalledOnce();
        expect(deps.products.revalidateCatalogScopes).not.toHaveBeenCalled();
    });

    describe('stock events that name their products', () => {
        it('hands the named products to the stock refresh, which decides whether a read is needed', async () => {
            const { deps, onInventoryChanged } = createHarness([], [7]);
            await onInventoryChanged({ scope: 'stock', productIds: [7, 8] });
            expect(deps.stockRefresh.noteNamed).toHaveBeenCalledOnce();
            expect(deps.stockRefresh.noteNamed).toHaveBeenCalledWith([7, 8]);
            expect(deps.stockRefresh.noteUnscoped).not.toHaveBeenCalled();
            expect(deps.refreshCatalogAndCart).not.toHaveBeenCalled();
            expect(deps.products.revalidateCatalogScopes).not.toHaveBeenCalled();
        });

        it('treats an event without ids as unscoped', async () => {
            for (const payload of [{ scope: 'stock' }, { scope: 'stock', productIds: [] }]) {
                const { deps, onInventoryChanged } = createHarness([], []);
                await onInventoryChanged(payload);
                expect(deps.stockRefresh.noteUnscoped).toHaveBeenCalledOnce();
                expect(deps.stockRefresh.noteNamed).not.toHaveBeenCalled();
            }
        });
    });
});
