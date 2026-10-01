import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

vi.mock('vue', async original => ({ ...await original(), onMounted: vi.fn(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('../../composables/useBrowserReportPrint.js', () => ({ useBrowserReportPrint: () => ({ printReport: vi.fn(), isPrinting: false }) }));
import Shifts from '../Shifts.vue';

let scope, page, writes;
beforeEach(() => {
    scope = effectScope();
    writes = [];
    vi.stubGlobal('window', { showAdminConfirm: vi.fn(async () => true), showAdminAlert: vi.fn(async () => {}) });
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        if (options?.method === 'PUT') writes.push(JSON.parse(options.body));
        return { json: async () => ({ success: true, shifts: [], pagination: {} }) };
    }));
    page = scope.run(() => Shifts.setup());
    page.selectedShift.value = { id: 7, is_active: false, starting_cash: 50, actual_cash: 90, live_expected_cash: 80 };
    page.showModal.value = true;
    page.newStartingCash.value = 50;
    page.newActualCash.value = 90;
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

describe('Shifts cash correction behavior', () => {
    it.each([0, 80, 123.45])('saves an ending-only correction of %s without rewriting opening cash', async amount => {
        page.newActualCash.value = amount;
        await page.updateShiftCash();
        expect(writes).toEqual([{ shift_id: 7, actual_cash: amount }]);
        expect(window.showAdminConfirm).toHaveBeenCalledOnce();
        expect(page.showModal.value).toBe(false);
    });

    it('restores both saved values when editing again after Cancel', () => {
        page.newStartingCash.value = 999;
        page.newActualCash.value = 0;
        page.isEditingCash.value = false;
        page.beginCashEdit();
        expect(page.newStartingCash.value).toBe(50);
        expect(page.newActualCash.value).toBe(90);
        expect(page.isEditingCash.value).toBe(true);
    });

    it.each(['', ' ', -1, 'not cash', Infinity, 100000000])('rejects invalid ending cash %s before confirming or sending', async amount => {
        page.newActualCash.value = amount;
        await page.updateShiftCash();
        expect(writes).toEqual([]);
        expect(window.showAdminConfirm).not.toHaveBeenCalled();
        expect(page.cashEditError.value).not.toBe('');
        expect(page.showModal.value).toBe(true);
    });

    it('does not confuse blank opening cash with unchanged zero', async () => {
        page.selectedShift.value.starting_cash = 0;
        page.newStartingCash.value = '';
        page.newActualCash.value = 80;
        await page.updateShiftCash();
        expect(writes).toEqual([]);
        expect(window.showAdminConfirm).not.toHaveBeenCalled();
    });

    it('shares one pending confirmation and save across repeated clicks', async () => {
        let confirm;
        window.showAdminConfirm.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
        page.newActualCash.value = 80;
        const first = page.updateShiftCash();
        const second = page.updateShiftCash();
        expect(window.showAdminConfirm).toHaveBeenCalledOnce();
        confirm(true);
        await Promise.all([first, second]);
        expect(writes).toHaveLength(1);
        expect(page.isUpdatingCash.value).toBe(false);
    });

    it('declining confirmation preserves the unsaved form and drawer', async () => {
        window.showAdminConfirm.mockResolvedValue(false);
        page.isEditingCash.value = true;
        page.newActualCash.value = 0;
        await page.updateShiftCash();
        expect(writes).toEqual([]);
        expect(page.newActualCash.value).toBe(0);
        expect(page.isEditingCash.value).toBe(true);
        expect(page.isUpdatingCash.value).toBe(false);
    });

    it('keeps open-shift editing limited to starting cash', async () => {
        page.selectedShift.value.is_active = true;
        page.newStartingCash.value = 0;
        page.newActualCash.value = null;
        await page.updateShiftCash();
        expect(writes).toEqual([{ shift_id: 7, starting_cash: 0 }]);
        expect(window.showAdminConfirm).not.toHaveBeenCalled();
    });

    it('keeps corrections available after a rejected save', async () => {
        fetch.mockResolvedValue({ json: async () => ({ success: false, message: 'Save failed' }) });
        page.isEditingCash.value = true;
        page.newActualCash.value = 0;
        await page.updateShiftCash();
        expect(page.showModal.value).toBe(true);
        expect(page.isEditingCash.value).toBe(true);
        expect(page.newActualCash.value).toBe(0);
        expect(page.isUpdatingCash.value).toBe(false);
    });

    it('opens the cash editor on the suggested variance correction', () => {
        page.selectedShift.value.variance_hint = { kind: 'count_excluded_opening', suggested: { starting_cash: 60, actual_cash: 140 } };
        page.applyVarianceSuggestion();
        expect(page.isEditingCash.value).toBe(true);
        expect(page.newStartingCash.value).toBe(60);
        expect(page.newActualCash.value).toBe(140);
        expect(writes).toEqual([]);
    });

    it('keeps the saved opening cash when the variance suggestion only corrects ending cash', () => {
        page.selectedShift.value.variance_hint = { kind: 'count_excluded_opening', suggested: { actual_cash: 140 } };
        page.newStartingCash.value = 999;
        page.applyVarianceSuggestion();
        expect(page.newStartingCash.value).toBe(50);
        expect(page.newActualCash.value).toBe(140);
    });

    it('keeps the variance hint after loading the shift report details', async () => {
        const hint = { kind: 'count_excluded_opening', suggested: { actual_cash: 140 } };
        fetch.mockImplementationOnce(async () => ({ json: async () => ({ success: true, print_payload: { expected_cash: 80, variance_hint: null } }) }));
        await page.openShiftModal({ id: 7, is_active: false, starting_cash: 50, actual_cash: 90, variance_hint: hint });
        expect(page.selectedShift.value.variance_hint).toEqual(hint);
        expect(page.selectedShift.value.live_expected_cash).toBe(80);
    });
});
