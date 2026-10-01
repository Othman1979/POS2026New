import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTableOrderWorkflow } from './stores/orderSession/tableOrderWorkflow.js';
import * as realApi from './stores/orderSession/orderSessionApi.js';

vi.mock('@/shared/i18n.js', () => ({ t: key => key }));

beforeEach(() => {
    vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const harness = api => {
    const ui = {};
    const workflow = createTableOrderWorkflow({
        api, ui, clearOrderDraft: vi.fn(), readOrderDraft: () => ({}), getActor: () => ({ user: { id: 1 } }), can: () => false
    });
    return { ui, workflow };
};

describe('table action deadlines', () => {
    it('split cancel navigates right after the mutation without pre-navigation reads', async () => {
        vi.stubGlobal('window', { showPosConfirm: vi.fn(async () => true), showPosToast: vi.fn(), showPosAlert: vi.fn() });
        const api = {
            cancelTableSplit: vi.fn(async () => ({ response: { ok: true }, data: { success: true, message: 'ok' } })),
            getTableSplits: vi.fn(() => new Promise(() => {})),
            getTables: vi.fn(() => new Promise(() => {})),
        };
        const { workflow } = harness(api);
        const router = { push: vi.fn() };
        expect(await workflow.cancelSplitGroup({ id: 4 }, { router })).toBe(true);
        expect(router.push).toHaveBeenCalledWith('/tables');
        expect(api.getTableSplits).not.toHaveBeenCalled();
        expect(api.getTables).not.toHaveBeenCalled();
    });

    it.each(['joinTables', 'disjoinTable'])('%s resolves without waiting for the floor refresh', async action => {
        const api = {
            joinTables: vi.fn(async () => ({ response: { ok: true }, data: { success: true, message: 'ok' } })),
            disjoinTables: vi.fn(async () => ({ response: { ok: true }, data: { success: true, message: 'ok' } })),
            getTables: vi.fn(() => new Promise(() => {})),
        };
        const { workflow } = harness(api);
        const result = await Promise.race([
            workflow[action](1, [2]),
            new Promise(resolve => setTimeout(() => resolve('blocked'), 50)),
        ]);
        expect(result).toEqual({ success: true, message: 'ok' });
        expect(api.getTables).toHaveBeenCalled();
    });

    it('a stalled join times out with a translated uncertain message and reconciles the floor', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        const api = { ...realApi, getTables: vi.fn(() => new Promise(() => {})) };
        const { workflow } = harness(api);
        const join = workflow.joinTables(1, [2]);
        await vi.advanceTimersByTimeAsync(15000);
        const result = await join;
        expect(result.success).toBe(false);
        expect(result.message).toBe('The table action was not confirmed. Check the floor before retrying.');
        expect(api.getTables).toHaveBeenCalled();
    });

    it.each([
        ['splitTable', () => realApi.splitTable({})],
        ['updateTableSplits', () => realApi.updateTableSplits({})],
        ['disjoinTables', () => realApi.disjoinTables({})],
        ['cancelTableSplit', () => realApi.cancelTableSplit(1)],
        ['voidTableItems', () => realApi.voidTableItems({})],
    ])('%s rejects after 15 seconds on a stalled link', async (_, call) => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        const request = call();
        const settled = request.then(() => 'resolved', e => e.name);
        await vi.advanceTimersByTimeAsync(15000);
        expect(await settled).toBe('TimeoutError');
    });
});
