import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { tableRowEndsSession } from '@/pos/tableWorkspacePolicy.js';
import { describe, expect, it, vi } from 'vitest';

// Runs the real onTableUpdate / vacate code of PosTerminal with its dependencies replaced.
const source = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
const body = parseScript(source, { sourceType: 'module' }).program.body;
const decl = name => { const n = body.find(x => x.declarations?.some(d => d.id.name === name)); return source.slice(n.start, n.end); };
const watchNode = body.find(x => x.type === 'ExpressionStatement' && source.slice(x.start, x.end).includes('vacateActiveTableIfFreed'));
const watchStmt = source.slice(watchNode.start, watchNode.end);
const build = new Function('scope', `with (scope) {
let tableUpdateTimeout = null;
${decl('vacateActiveTableIfFreed')}
${decl('onTableUpdate')}
${watchStmt}
return { onTableUpdate, vacateActiveTableIfFreed };
}`);

function harness({ inFlight = false } = {}) {
    const d = {
        restaurantTables: { value: [{ id: 7, status: 'occupied', current_order_id: 70 }] },
        activeTable: { value: { id: 7, status: 'occupied', current_order_id: 70 } },
        cart: { checkoutInFlight: { value: inFlight } },
        tables: { isTableWorkspaceLoading: { value: false }, loadTableWorkspace: vi.fn(async () => {}) },
        closeTable: vi.fn(), router: {}, watch: vi.fn(), tableRowEndsSession,
    };
    return { d, ...build(new Proxy(d, { has: () => true, get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : globalThis[k]) })) };
}
const freed = { action: 'update_single_table', table: { id: 7, status: 'available', current_order_id: null } };

describe('PosTerminal table update echo', () => {
    it('tears down the session when another till vacates the table', () => {
        const { d, onTableUpdate } = harness();
        onTableUpdate(freed);
        expect(d.closeTable).toHaveBeenCalledOnce();
    });

    it('keeps the session while this till checkout is in flight, then vacates once only if the checkout failed', () => {
        const { d, onTableUpdate, vacateActiveTableIfFreed } = harness({ inFlight: true });
        onTableUpdate(freed);
        expect(d.closeTable).not.toHaveBeenCalled();
        expect(d.restaurantTables.value[0].status).toBe('available');
        // Success: the store already cleared the active table.
        d.activeTable.value = null;
        vacateActiveTableIfFreed();
        expect(d.closeTable).not.toHaveBeenCalled();
        // Failure: the session is still open against a freed row.
        d.activeTable.value = { id: 7, status: 'occupied', current_order_id: 70 };
        vacateActiveTableIfFreed();
        expect(d.closeTable).toHaveBeenCalledOnce();
    });

    it('keeps the session when the table is freed then reopened by another order during the checkout, and closes only if the checkout failed', () => {
        const { d, onTableUpdate, vacateActiveTableIfFreed } = harness({ inFlight: true });
        onTableUpdate(freed);
        onTableUpdate({ action: 'update_single_table', table: { id: 7, status: 'occupied', current_order_id: 80 } });
        expect(d.closeTable).not.toHaveBeenCalled();
        expect(d.activeTable.value.current_order_id).toBe(70);
        // Success: the store cleared the active table, so nothing closes.
        const kept = d.activeTable.value;
        d.activeTable.value = null;
        vacateActiveTableIfFreed();
        expect(d.closeTable).not.toHaveBeenCalled();
        // Failure: the row now belongs to another order.
        d.activeTable.value = kept;
        vacateActiveTableIfFreed();
        expect(d.closeTable).toHaveBeenCalledOnce();
    });

    it('keeps a new unsaved table and its cart when a checkout settles without a sale', () => {
        const { d } = harness();
        d.activeTable.value = { id: 5, status: 'available', current_order_id: null };
        d.restaurantTables.value = [{ id: 5, status: 'available', current_order_id: null }];
        const [getter, onChange] = d.watch.mock.calls[0];
        expect(getter()).toBe(false);
        onChange(false);
        expect(d.closeTable).not.toHaveBeenCalled();
    });

    it('runs the deferred vacate check when checkoutInFlight settles on a saved table', () => {
        const { d } = harness({ inFlight: true });
        d.restaurantTables.value = [{ id: 7, status: 'available', current_order_id: null }];
        d.watch.mock.calls[0][1](false);
        expect(d.closeTable).toHaveBeenCalledOnce();
    });

    it('queues a follow-up table read when a row update lands during a full load', () => {
        const { d, onTableUpdate } = harness();
        d.tables.isTableWorkspaceLoading.value = true;
        onTableUpdate({ action: 'update_single_table', table: { id: 9, status: 'occupied' } });
        expect(d.tables.loadTableWorkspace).toHaveBeenCalledWith({ force: true, skipActivation: true });
    });
});
