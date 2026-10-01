import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { effectScope } from 'vue';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('vue', async original => ({ ...await original(), onMounted: vi.fn(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/http.js', () => ({ fetchJson: (...args) => api.get(...args), fetchJsonResponse: (...args) => api.post(...args) }));
import PlatformRemittances from '../PlatformRemittances.vue';

const root = resolve(process.cwd());
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const page = read('src/admin/pages/PlatformRemittances.vue');
const registry = read('src/admin/pageRegistry.js');
const sidebar = read('src/admin/components/Sidebar.vue');
const i18n = JSON.parse(readFileSync(resolve(root, 'src/shared/i18n/ar.json'), 'utf8'));

describe('platform reconciliation admin workflow', () => {
    it('registers one localized management page', () => {
        expect(registry).toContain("'platform-remittances': () => import('./pages/PlatformRemittances.vue')");
        expect(sidebar).toContain("page: 'platform-remittances'");
        expect(sidebar).toContain("label: 'Platform Payouts'");
        expect(i18n['Platform Payouts']).toBe('دفعات منصات التوصيل');
    });

    it('keeps provider, record, and immutable history sections bounded', () => {
        for (const text of ['Platform balances', 'Record a payout', 'Previous payouts']) {
            expect(page).toContain(text);
        }
        expect(page).toContain("fetchJson('/api/admin/platform-remittances/providers')");
        expect(page).toContain('fetchJson(`/api/admin/platform-remittances/receivables?');
        expect(page).toContain('fetchJson(`/api/admin/platform-remittances?');
        expect(page).toContain("/reverse");
        expect(page).not.toContain('defineStore');
        expect(page).not.toContain('createPlatformApi');
        expect(page).not.toContain('AllocationBuilder');
    });

    it('presents the payout as one workspace with a secondary full-width history ledger', () => {
        expect(page).toContain('class="admin-grid-shell payout-entry-shell"');
        expect(page).toContain('class="payout-workbench"');
        expect(page).toContain('class="payout-summary"');
        expect(page).toContain('grid-template-areas:');
        expect(page).toContain('"workbench summary"');
        expect(page).toContain('"history history"');
        expect(page).toContain('.payout-history {');
        expect(page).toContain('grid-area: history;');
    });

    it('supports bounded adjustment rows, direction/category rules, and required correction notes', () => {
        expect(page).toContain('addAdjustment');
        expect(page).toContain('removeAdjustment');
        expect(page).toContain('ADJUSTMENT_CATEGORIES');
        expect(page).toContain('deduction');
        expect(page).toContain('addition');
        expect(page).toContain("['correction', 'other'].includes(adjustment.category)");
        expect(page).toContain('Adjustment note is required');
    });

    it('requires a reversal reason and retains invoice/balance information on mobile', () => {
        expect(page).toContain('reverseReason');
        expect(page).toContain('A reversal reason is required');
        expect(page).toContain('invoice_id');
        expect(page).toContain('open_amount');
        expect(page).toContain('@media (max-width: 639px)');
        expect(page).toContain('.payout-invoice__allocation');
        expect(page).toContain('grid-column: 1 / -1');
    });
});

describe('platform payout entry', () => {
    const balances = [
        { invoice_id: 11, open_amount: '10.10', balance_token: 'b11' },
        { invoice_id: 12, open_amount: '0.20', balance_token: 'b12' },
        { invoice_id: 13, open_amount: '-0.70', balance_token: 'b13' }
    ];
    let scope, view, receivables;

    beforeEach(async () => {
        receivables = balances;
        api.get.mockReset().mockImplementation(async () => ({ success: true, receivables, remittances: [], providers: [] }));
        api.post.mockReset();
        scope = effectScope();
        view = scope.run(() => PlatformRemittances.setup({}, { expose: vi.fn() }));
        await view.selectProvider(5);
    });
    afterEach(() => scope.stop());

    const posted = () => {
        expect(api.post).toHaveBeenCalledOnce();
        return JSON.parse(api.post.mock.calls[0][1].body);
    };

    it('defaults every balance to its full signed open amount', () => {
        expect(view.allocationRows.value.map(row => row.allocationAmount)).toEqual([10.1, 0.2, -0.7]);
        expect(view.computedNetCents.value).toBe(960);
    });

    it('saves a payout whose amount matches the computed cents exactly', async () => {
        view.adjustments.value = [
            { direction: 'deduction', category: 'commission', amount: '1.15', note: '' },
            { direction: 'addition', category: 'reimbursement', amount: '0.35', note: '' }
        ];
        view.netReceived.value = '8.8';
        expect(view.differenceCents.value).toBe(0);
        api.post.mockResolvedValue({ response: { status: 200 }, data: { success: true } });
        await view.recordSettlement();
        expect(posted()).toMatchObject({ order_type_id: 5, net_received: '8.8', invoice_allocations: [
            { invoice_id: 11, balance_token: 'b11', allocation_amount: '10.1' },
            { invoice_id: 12, balance_token: 'b12', allocation_amount: '0.2' },
            { invoice_id: 13, balance_token: 'b13', allocation_amount: '-0.7' }
        ] });
    });

    it('blocks a payout that is one cent away from the computed amount', async () => {
        view.netReceived.value = '9.61';
        await view.recordSettlement();
        expect(view.differenceCents.value).toBe(1);
        expect(view.validationMessage.value).toBe('The entered payout must equal the computed payout exactly.');
        expect(api.post).not.toHaveBeenCalled();
    });

    it('sends an over-allocation unchanged for the server to judge', async () => {
        view.setAllocation(balances[1], '99');
        view.netReceived.value = '108.4';
        api.post.mockResolvedValue({ response: { status: 200 }, data: { success: true } });
        await view.recordSettlement();
        expect(posted().invoice_allocations[1]).toEqual({ invoice_id: 12, balance_token: 'b12', allocation_amount: '99' });
    });

    it('clears the allocations and issues a new intent key after a stale balance rejection', async () => {
        view.netReceived.value = '9.6';
        const staleKey = view.idempotencyKey.value;
        receivables = [{ invoice_id: 11, open_amount: '4.00', balance_token: 'b11-new' }];
        api.post.mockResolvedValue({ response: { status: 409 }, data: { success: false, code: 'PLATFORM_REMITTANCE_STALE_BALANCE' } });
        await view.recordSettlement();
        expect(view.staleMessage.value).toBe('A balance changed while you were preparing this statement. Review the refreshed balances and explicitly select the allocations again.');
        expect(view.allocationRows.value).toEqual([{ invoice_id: 11, open_amount: '4.00', balance_token: 'b11-new', allocationAmount: '' }]);
        expect(view.idempotencyKey.value).not.toBe(staleKey);
        expect(view.idempotencyKey.value).not.toBe('');
    });
});
