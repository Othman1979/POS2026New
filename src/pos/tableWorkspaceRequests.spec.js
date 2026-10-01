import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTableOrderWorkflow } from './stores/orderSession/tableOrderWorkflow.js';
import { getTables } from './stores/orderSession/orderSessionApi.js';

vi.mock('@/shared/i18n.js', () => ({ t: key => key }));

beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function harness() {
    const pending = [];
    const api = { getTables: vi.fn(() => new Promise(resolve => pending.push(resolve))) };
    const ui = {};
    const clearOrderDraft = vi.fn();
    const workflow = createTableOrderWorkflow({
        api, ui, clearOrderDraft, readOrderDraft: () => ({}), getActor: () => ({ user: { id: 1 } }), can: () => false
    });
    const complete = (index, id, currentOrderId = null) => pending[index]({ data: {
        success: true,
        settings: { tables_enabled: true, table_mode: 'fixed' },
        sections: [],
        tables: [{ id, table_number: String(id), status: currentOrderId ? 'occupied' : 'available', current_order_id: currentOrderId }]
    } });
    return { api, ui, workflow, complete, clearOrderDraft };
}

describe('table workspace refresh ownership', () => {
    it.each(['headers', 'body'])('releases stalled floor %s after 15 seconds and preserves counts for retry', async stage => {
        vi.useFakeTimers();
        const { api, ui, workflow } = harness();
        api.getTables.mockImplementation(getTables);
        workflow.restaurantTables.value = [{ id: 1, current_order_id: 101, active_split_count: 4 }];
        let signal;
        vi.stubGlobal('fetch', vi.fn((url, options) => {
            signal = options?.signal;
            return stage === 'headers' ? new Promise(() => {}) : Promise.resolve({ json: () => new Promise(() => {}) });
        }));
        const read = workflow.loadTableWorkspace({ force: true, skipActivation: true });
        await vi.advanceTimersByTimeAsync(15000);
        expect(workflow.isTableWorkspaceLoading.value).toBe(false);
        await read;
        expect(signal.aborted).toBe(true);
        expect(ui.tableActionError).not.toBe('');
        expect(workflow.tableWorkspaceLoadFailed.value).toBe(true);
        expect(workflow.restaurantTables.value[0].active_split_count).toBe(4);
        fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, tables: [{ id: 1, current_order_id: 101, active_split_count: 2 }] }) });
        await workflow.loadTableWorkspace({ force: true, skipActivation: true });
        expect(ui.tableActionError).toBe('');
        expect(workflow.tableWorkspaceLoadFailed.value).toBe(false);
        expect(workflow.restaurantTables.value[0].active_split_count).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ends a reassigned table session instead of attaching its old cart to the new order', async () => {
        const { workflow, complete, clearOrderDraft } = harness();
        workflow.activeTable.value = { id: 1, status: 'occupied', current_order_id: 101 };
        const read = workflow.loadTableWorkspace({ force: true, skipActivation: true });
        await Promise.resolve();
        complete(0, 1, 202);
        await read;
        expect(workflow.activeTable.value).toBe(null);
        expect(clearOrderDraft).toHaveBeenCalledWith({ startNew: true });
    });

    it.each(['unchanged', 'split', 'new session', 'saved order'])('preserves the cart for %s while reconciling the workspace', async kind => {
        const { workflow, complete, clearOrderDraft } = harness();
        workflow.activeTable.value = { id: 1, status: 'occupied', current_order_id: 101, is_split: kind === 'split' };
        const read = workflow.loadTableWorkspace({ force: true, skipActivation: true });
        if (kind === 'new session') workflow.invalidateTableSession();
        if (kind === 'new session' || kind === 'saved order') workflow.activeTable.value.current_order_id = 202;
        await Promise.resolve();
        complete(0, 1, kind === 'split' ? 202 : 101);
        await read;
        expect(workflow.activeTable.value.current_order_id).toBe(kind === 'new session' || kind === 'saved order' ? 202 : 101);
        expect(clearOrderDraft).not.toHaveBeenCalled();
    });

    it('shares the current read and coalesces forced refreshes into one later snapshot', async () => {
        const { api, workflow, complete } = harness();
        const first = workflow.loadTableWorkspace({ skipActivation: true });
        const joined = workflow.loadTableWorkspace({ skipActivation: true });
        const forced = workflow.loadTableWorkspace({ force: true, skipActivation: true });
        const alsoForced = workflow.loadTableWorkspace({ force: true, skipActivation: true });
        let forcedFinished = false;
        forced.then(() => { forcedFinished = true; });
        await Promise.resolve();
        expect(api.getTables).toHaveBeenCalledTimes(1);
        complete(0, 1);
        await Promise.all([first, joined]);
        await vi.waitFor(() => expect(api.getTables).toHaveBeenCalledTimes(2));
        expect(forcedFinished).toBe(false);
        complete(1, 2);
        await Promise.all([forced, alsoForced]);
        expect(workflow.restaurantTables.value.map(table => table.id)).toEqual([2]);
        expect(workflow.isTableWorkspaceLoading.value).toBe(false);
        expect(api.getTables).toHaveBeenCalledTimes(2);
    });

    it('keeps ordinary cached reads cheap but honors a subsequent forced refresh', async () => {
        const { api, workflow, complete } = harness();
        const first = workflow.loadTableWorkspace({ skipActivation: true });
        await Promise.resolve();
        complete(0, 1);
        await first;
        await workflow.loadTableWorkspace({ skipActivation: true });
        expect(api.getTables).toHaveBeenCalledTimes(1);
        const fresh = workflow.loadTableWorkspace({ force: true, skipActivation: true });
        await Promise.resolve();
        complete(1, 2);
        await fresh;
        expect(workflow.restaurantTables.value.map(table => table.id)).toEqual([2]);
    });

    it('releases failed reads so queued recovery can still refresh the workspace', async () => {
        const { api, ui, workflow, complete } = harness();
        api.getTables.mockImplementationOnce(() => { throw new Error('Disconnected'); });
        const first = workflow.loadTableWorkspace({ skipActivation: true });
        const recovery = workflow.loadTableWorkspace({ force: true, skipActivation: true });
        await first;
        await vi.waitFor(() => expect(api.getTables).toHaveBeenCalledTimes(2));
        complete(0, 3);
        await recovery;
        expect(ui.tableActionError).toBe('');
        expect(workflow.restaurantTables.value.map(table => table.id)).toEqual([3]);
        expect(workflow.isTableWorkspaceLoading.value).toBe(false);
    });
});
