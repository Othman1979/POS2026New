import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';

// Exercise the real event handler with its network consumers replaced.
const source = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
const handler = parseScript(source, { sourceType: 'module' }).program.body
    .flatMap(node => node.declarations || []).find(node => node.id.name === 'onSettingsChanged').init;
const buildHandler = new Function('terminal', 'products', 'cart', 'reconcileOpeningShiftReference', 'auth', 'can', 'tables', `return (${source.slice(handler.start, handler.end)});`);
const createHandler = (terminal, products, cart, reconcileOpeningShiftReference, dependencies = {}) => buildHandler(
    terminal,
    products,
    cart,
    reconcileOpeningShiftReference,
    dependencies.auth || { activeUser: { value: { role: 'call_center' } } },
    dependencies.can || (() => false),
    dependencies.tables || { loadTableWorkspace: vi.fn() },
);

describe('settings event refresh scope', () => {
    it.each(['order_type_numbering', 'receipt_config', 'duplicate_customer_receipt', 'print_method', 'first_shift_starting_cash'])('does not reload products for %s', key => {
        const terminal = { loadSettings: vi.fn() }, products = { fetchData: vi.fn() }, cart = { fetchOrderTypes: vi.fn() };
        const shift = vi.fn();
        createHandler(terminal, products, cart, shift)({ keys: [key] });
        expect(products.fetchData).not.toHaveBeenCalled();
        expect(terminal.loadSettings).toHaveBeenCalledWith({ force: true });
        if (key === 'first_shift_starting_cash') expect(shift).toHaveBeenCalledOnce();
    });

    it.each(['tables_enabled', 'service_charge_enabled', 'service_charge_percentage', 'auto_apply_service_charge'])('takes %s from the settings read alone, without a catalog read', key => {
        const terminal = { loadSettings: vi.fn() }, products = { fetchData: vi.fn(), revalidateCatalogScopes: vi.fn() };
        createHandler(terminal, products, { fetchOrderTypes: vi.fn() }, vi.fn())({ keys: [key] });
        expect(terminal.loadSettings).toHaveBeenCalledWith({ force: true });
        expect(products.fetchData).not.toHaveBeenCalled();
        expect(products.revalidateCatalogScopes).not.toHaveBeenCalled();
    });

    it.each(['stock_enabled', 'recipe_ledger_enabled'])('revalidates cached rows, not the whole catalog, when %s changes', key => {
        const products = { fetchData: vi.fn(), revalidateCatalogScopes: vi.fn() };
        createHandler({ loadSettings: vi.fn() }, products, { fetchOrderTypes: vi.fn() }, vi.fn())({ keys: [key, 'service_charge_enabled'] });
        expect(products.revalidateCatalogScopes).toHaveBeenCalledOnce();
        expect(products.fetchData).not.toHaveBeenCalled();
    });

    it.each([undefined, {}, { keys: [] }])('retains full recovery for an unscoped event: %j', payload => {
        const products = { fetchData: vi.fn() };
        createHandler({ loadSettings: vi.fn() }, products, { fetchOrderTypes: vi.fn() }, vi.fn())(payload);
        expect(products.fetchData).toHaveBeenCalledOnce();
    });

    it('refreshes order types without reloading products', () => {
        const products = { fetchData: vi.fn() }, cart = { fetchOrderTypes: vi.fn() };
        createHandler({ loadSettings: vi.fn() }, products, cart, vi.fn())({ keys: ['default_order_type_id', 'order_types'] });
        expect(products.fetchData).not.toHaveBeenCalled();
        expect(cart.fetchOrderTypes).toHaveBeenCalledWith({ force: true });
    });

    it('reloads table state after a tables setting change for an authorized register', async () => {
        const tables = { loadTableWorkspace: vi.fn() };
        const terminal = { loadSettings: vi.fn().mockResolvedValue(true) };
        const onSettingsChanged = createHandler(
            terminal,
            { fetchData: vi.fn() },
            { fetchOrderTypes: vi.fn() },
            vi.fn(),
            {
                auth: { activeUser: { value: { role: 'cashier' } } },
                can: permission => permission === 'tables.access',
                tables,
            },
        );

        onSettingsChanged({ keys: ['tables_enabled'] });
        await terminal.loadSettings.mock.results[0].value;
        await Promise.resolve();
        expect(tables.loadTableWorkspace).toHaveBeenCalledWith({ force: true });
    });
});
