import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';

// Run the real reconnect handler with its reads replaced by controllable promises.
const source = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
const body = parseScript(source, { sourceType: 'module' }).program.body;
const decl = name => { const n = body.find(x => x.declarations?.some(d => d.id.name === name)); return source.slice(n.start, n.end); };
const deps = ['isActive', 'terminal', 'refreshCatalogAndCart', 'refreshCatalogUnlessCurrent', 'cart', 'fetchHeldOrderSummary',
    'reconcileOpeningShiftReference', 'canLoadTableWorkspace', 'tables', 'activeTable', 'loadActiveTableDraft'];
// A reconnect after boot: the initial snapshot has completed (boot-time reconnects
// are covered in posBootCatalogOrder.spec.js).
const build = new Function(...deps, `let initialCatalogSnapshotStarted = true; let initialCatalogSnapshotComplete = true;
let initialRecoveryRefreshStarted = false; let initialConnectReconcilePending = false; let bootReconnectRecoveryPending = false;
${decl('handleSocketReconnected')}
${decl('recoverAfterReconnect')}
return handleSocketReconnected;`);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const pending = () => vi.fn(() => new Promise(() => {}));

function harness() {
    let settle;
    const d = {
        isActive: { value: true },
        terminal: { loadSettings: vi.fn(() => new Promise(r => { settle = r; })) },
        refreshCatalogAndCart: pending(),
        cart: { fetchOrderTypes: pending(), probePendingCheckout: vi.fn() },
        fetchHeldOrderSummary: pending(),
        reconcileOpeningShiftReference: pending(),
        canLoadTableWorkspace: ({ settingsReadSucceeded }) => settingsReadSucceeded === true,
        tables: { loadTableWorkspace: vi.fn() },
        activeTable: { value: null },
        loadActiveTableDraft: vi.fn(),
    };
    // The token check itself is covered in posBootCatalogOrder.spec.js; here it always reads.
    d.refreshCatalogUnlessCurrent = (...args) => d.refreshCatalogAndCart(...args);
    return { d, settle: v => settle(v), run: build(...deps.map(k => d[k])) };
}

describe('PosTerminal reconnect recovery', () => {
    it('reads settings first, then starts every other read together without waiting on a stalled one', async () => {
        const { d, settle, run } = harness();
        const done = run();
        await flush();
        expect(d.refreshCatalogAndCart).not.toHaveBeenCalled();
        settle(true);
        await flush();
        expect(d.refreshCatalogAndCart).toHaveBeenCalledOnce();
        expect(d.cart.fetchOrderTypes).toHaveBeenCalledWith({ force: true });
        expect(d.fetchHeldOrderSummary).toHaveBeenCalledWith({ fresh: true });
        expect(d.reconcileOpeningShiftReference).toHaveBeenCalledOnce();
        expect(d.tables.loadTableWorkspace).toHaveBeenCalledWith({ force: true });
        void done;
    });

    it('keeps going when one read fails and skips tables when settings failed', async () => {
        const { d, settle, run } = harness();
        d.refreshCatalogAndCart.mockRejectedValue(new Error('x'));
        d.cart.fetchOrderTypes.mockResolvedValue();
        d.fetchHeldOrderSummary.mockResolvedValue();
        d.reconcileOpeningShiftReference.mockResolvedValue();
        const done = run();
        settle(false);
        await expect(done).resolves.toBeUndefined();
        expect(d.cart.fetchOrderTypes).toHaveBeenCalled();
        expect(d.tables.loadTableWorkspace).not.toHaveBeenCalled();
    });

    it('reloads the active table QR draft so an import never uses a stale one', async () => {
        const { d, run } = harness();
        d.activeTable.value = { id: 7 };
        run();
        await flush();
        expect(d.loadActiveTableDraft).toHaveBeenCalledWith(7);
    });

    it('sends nothing while the POS view is parked', async () => {
        const { d, run } = harness();
        d.isActive.value = false;
        await run();
        expect(d.terminal.loadSettings).not.toHaveBeenCalled();
    });
});
