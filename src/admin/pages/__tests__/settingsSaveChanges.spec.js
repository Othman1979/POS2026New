import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onUnmounted: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, setLanguage: vi.fn(), currentLanguage: { value: 'en' }, languageChoices: [] }));
vi.mock('../../components/settings/DeviceAccessSettings.vue', () => ({ default: {} }));
import Settings from '../Settings.vue';

let scope, page, writes;
beforeEach(async () => {
    scope = effectScope(); writes = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', { showAdminAlert: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        if (options?.method === 'POST') { writes.push(JSON.parse(options.body)); return { json: async () => ({ success: true }) }; }
        return { json: async () => url === 'api/system/settings'
            ? { success: true, print_method: 'backend', order_type_numbering: '0', stock_enabled: '0', tables_enabled: '1' }
            : { success: false } };
    }));
    page = scope.run(() => Settings.setup());
    await page.loadData(); await nextTick();
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('General settings changes', () => {
    it('does not resubmit a language change that was already saved immediately', async () => {
        await page.selectLanguage('ar');
        await page.saveSettings();
        expect(writes).toEqual([{ admin_language: 'ar' }]);
    });

    it('sends only the numbering toggle and skips a second unchanged save', async () => {
        page.orderTypeNumbering.value = true;
        await page.saveSettings();
        expect(writes).toEqual([{ order_type_numbering: '1' }]);
        await page.saveSettings();
        expect(writes).toHaveLength(1);
    });

    it('retains changed fields after a failed save for explicit retry', async () => {
        page.printMethod.value = 'browser';
        fetch.mockImplementationOnce(async () => ({ json: async () => ({ success: false, message: 'Try again' }) }));
        await page.saveSettings();
        await page.saveSettings();
        expect(writes).toEqual([{ print_method: 'browser' }]);
        expect(window.showAdminAlert).toHaveBeenCalled();
    });

    it('does not treat another edit during saving as already persisted', async () => {
        const pending = Promise.withResolvers();
        page.orderTypeNumbering.value = true;
        fetch.mockImplementationOnce(() => pending.promise);
        const saving = page.saveSettings();
        page.printMethod.value = 'browser';
        pending.resolve({ json: async () => ({ success: true }) });
        await saving;
        await page.saveSettings();
        expect(writes).toEqual([{ print_method: 'browser' }]);
    });

    it('starts first-shift cash from zero when the setting has never been saved', () => {
        expect(page.firstShiftStartingCash.value).toBe('0');
    });

    it('loads the stored first-shift cash and saves only the edited amount', async () => {
        fetch.mockImplementationOnce(async () => ({ json: async () => ({ success: true, first_shift_starting_cash: '25.500' }) }));
        await page.loadData();
        expect(page.firstShiftStartingCash.value).toBe('25.500');
        page.firstShiftStartingCash.value = '30.000';
        await page.saveSettings();
        expect(writes).toEqual([{ first_shift_starting_cash: '30.000' }]);
    });
});
