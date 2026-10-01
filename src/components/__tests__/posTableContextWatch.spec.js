import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';

const source = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
const ast = parseScript(source, { sourceType: 'module' });
const watchCall = ast.program.body
    .flatMap(node => node.type === 'ExpressionStatement' ? [node.expression] : [])
    .find(node => node.type === 'CallExpression'
        && node.callee.name === 'watch'
        && node.arguments[0]?.name === 'activeTable');
const handler = watchCall.arguments[1];
const buildWatcher = new Function(
    'isActive', 'salesContext', 'setSalesContext', 'fetchData',
    'activeTable', 'activeUser', 'router', 'terminal', 'products', 'cart', 'isLeavingTable', 'clearLeavingTable',
    `let tableContextRequestId = 0; return (${source.slice(handler.start, handler.end)});`
);
const createWatcher = (overrides = {}) => buildWatcher(
    overrides.isActive || { value: true },
    overrides.salesContext || { value: 'register' },
    overrides.setSalesContext || vi.fn(),
    overrides.fetchData || vi.fn(),
    overrides.activeTable || { value: { id: 5 } },
    overrides.activeUser || { value: { role: 'cashier' } },
    overrides.router || { push: vi.fn() },
    overrides.terminal || {},
    overrides.products || {},
    overrides.cart || {},
    overrides.isLeavingTable || (() => false),
    overrides.clearLeavingTable || (() => {}),
);

describe('activeTable watcher catalog reload scope', () => {
    it('skips the catalog read when the sales context is unchanged', async () => {
        const fetchData = vi.fn(), setSalesContext = vi.fn(), terminal = { teardownBarcodeListener: vi.fn() };
        await createWatcher({ salesContext: { value: 'table' }, fetchData, setSalesContext, terminal })({ id: 7 });
        expect(fetchData).not.toHaveBeenCalled();
        expect(setSalesContext).toHaveBeenCalledWith('table');
        expect(terminal.teardownBarcodeListener).toHaveBeenCalledOnce();
    });

    it('reloads the catalog once when the context flips register -> table', async () => {
        const fetchData = vi.fn();
        await createWatcher({ salesContext: { value: 'register' }, fetchData })({ id: 7 });
        expect(fetchData).toHaveBeenCalledOnce();
        expect(fetchData).toHaveBeenCalledWith({ preferCache: true });
    });

    it('skips the register read nobody sees when the table is left for the floor', async () => {
        const fetchData = vi.fn(), router = { push: vi.fn() };
        const salesContext = { value: 'table' };
        await createWatcher({
            salesContext,
            setSalesContext: v => { salesContext.value = v; },
            fetchData,
            activeTable: { value: null },
            router,
            isLeavingTable: () => true,
        })(null);
        expect(salesContext.value).toBe('register');
        expect(fetchData).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
    });

    it('uses the leaving flag for one change only, so a blocked navigation cannot silence a later release', async () => {
        let leaving = true;
        const fetchData = vi.fn();
        const salesContext = { value: 'table' };
        const watcher = createWatcher({
            salesContext,
            setSalesContext: v => { salesContext.value = v; },
            fetchData,
            activeTable: { value: null },
            isLeavingTable: () => leaving,
            clearLeavingTable: () => { leaving = false; },
        });
        await watcher(null);
        expect(fetchData).not.toHaveBeenCalled();
        salesContext.value = 'table';
        await watcher(null);
        expect(fetchData).toHaveBeenCalledOnce();
    });

    it('reloads then redirects a waiter when the table is released in place', async () => {
        const fetchData = vi.fn(), router = { push: vi.fn() };
        const salesContext = { value: 'table' };
        await createWatcher({
            salesContext,
            setSalesContext: v => { salesContext.value = v; },
            fetchData,
            activeTable: { value: null },
            activeUser: { value: { role: 'waiter' } },
            router,
        })(null);
        expect(fetchData).toHaveBeenCalledOnce();
        expect(router.push).toHaveBeenCalledWith('/tables');
    });

    it('does nothing while inactive on the floor plan', async () => {
        const fetchData = vi.fn(), setSalesContext = vi.fn();
        await createWatcher({ isActive: { value: false }, fetchData, setSalesContext })({ id: 7 });
        expect(fetchData).not.toHaveBeenCalled();
        expect(setSalesContext).not.toHaveBeenCalled();
    });
});
