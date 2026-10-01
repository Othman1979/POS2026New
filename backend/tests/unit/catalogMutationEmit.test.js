import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { catalogScopeProductIds, emitInventoryChanged, emitStockChanged } = require('../../routes/admin/helpers');

function fakeRequest() {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    return { req: { io: { to } }, emit, to };
}

describe('catalog mutation inventory_changed emitter', () => {
    beforeEach(() => vi.clearAllMocks());

    it('emits the bare event when no ids are supplied', () => {
        for (const productIds of [undefined, null, [], {}, 'x']) {
            const { req, emit, to } = fakeRequest();
            emitInventoryChanged(req, productIds);
            expect(to).toHaveBeenCalledWith('staff');
            expect(emit).toHaveBeenCalledTimes(1);
            expect(emit).toHaveBeenCalledWith('inventory_changed');
        }
    });

    it('falls back to the bare event when any id is not a positive integer', () => {
        for (const productIds of [['x'], [0], [-1], [1.5], [NaN], [3, 'x'], [''], [null], [true]]) {
            const { req, emit } = fakeRequest();
            emitInventoryChanged(req, productIds);
            expect(emit, JSON.stringify(productIds)).toHaveBeenCalledWith('inventory_changed');
            expect(emit.mock.calls[0]).toHaveLength(1);
        }
    });

    it('emits a deduplicated numeric catalog scope for valid ids', () => {
        const { req, emit } = fakeRequest();
        emitInventoryChanged(req, [3, 3, 7]);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith('inventory_changed', { scope: 'catalog', productIds: [3, 7] });
    });

    it('coerces numeric string ids from request bodies', () => {
        const { req, emit } = fakeRequest();
        emitInventoryChanged(req, ['12', 12, '4']);
        expect(emit).toHaveBeenCalledWith('inventory_changed', { scope: 'catalog', productIds: [12, 4] });
    });

    it('announces a stock-only change with the stock scope', () => {
        const { req, emit, to } = fakeRequest();
        emitStockChanged(req);
        expect(to).toHaveBeenCalledWith('staff');
        expect(emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock' });
        expect(() => emitStockChanged({})).not.toThrow();
    });

    it('does nothing without a socket server', () => {
        expect(() => emitInventoryChanged({}, [1])).not.toThrow();
    });

    it('catalogScopeProductIds returns null for missing or invalid ids', () => {
        for (const value of [undefined, null, [], {}, 'x', [''], [0], [1.5], [3, 'x']]) {
            expect(catalogScopeProductIds(value), JSON.stringify(value)).toBeNull();
        }
        expect(catalogScopeProductIds([3, '7', 7])).toEqual([3, 7]);
    });
});
