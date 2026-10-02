import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onUnmounted: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, setLanguage: vi.fn(), currentLanguage: { value: 'en' }, languageChoices: [] }));
vi.mock('../components/settings/DeviceAccessSettings.vue', () => ({ default: {} }));
import Settings from '../pages/Settings.vue';

const RESET_URL = '/api/admin/maintenance/reset-operational-data';
let scope, page, requests, resetResponse;
beforeEach(async () => {
    scope = effectScope(); requests = []; resetResponse = { success: true };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', { showAdminAlert: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        requests.push({ url, method: options?.method || 'GET', body: options?.body ?? null });
        if (url === RESET_URL || url === '/api/admin/maintenance/factory-reset') return { json: async () => resetResponse };
        return { json: async () => url === 'api/system/settings' ? { success: true } : { success: false } };
    }));
    page = scope.run(() => Settings.setup());
    await page.loadData(); await nextTick();
    requests = [];
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const resetRequests = () => requests.filter(({ url }) => url === RESET_URL);

describe('Settings operational reset', () => {
    it('sends the typed maintenance password once, only when the admin submits the reset', async () => {
        page.maintenancePassword.value = 'venue-secret';
        await nextTick();
        expect(requests).toEqual([]);

        await page.resetOperationalData();

        expect(resetRequests()).toEqual([{ url: RESET_URL, method: 'POST', body: JSON.stringify({ password: 'venue-secret' }) }]);
    });

    it('masks the maintenance password field', async () => {
        const app = createSSRApp({ ...Settings, setup: () => page });
        app.config.globalProperties.$t = key => key;

        const field = (await renderToString(app)).match(/<input[^>]*placeholder="Maintenance password"[^>]*>/)?.[0];

        expect(field, 'maintenance password field rendered').toBeDefined();
        expect(field).toContain('type="password"');
    });

    it('clears the maintenance password after a successful reset', async () => {
        page.maintenancePassword.value = 'venue-secret';

        await page.resetOperationalData();

        expect(page.maintenancePassword.value).toBe('');
    });

    it('does not call the reset endpoint without a password', async () => {
        await page.resetOperationalData();

        expect(resetRequests()).toEqual([]);
    });

    it('keeps the password for a retry when the server rejects the reset', async () => {
        resetResponse = { success: false, message: 'Wrong maintenance password.' };
        page.maintenancePassword.value = 'venue-secret';

        await page.resetOperationalData();

        expect(window.showAdminAlert).toHaveBeenCalledWith('Wrong maintenance password.');
        expect(page.maintenancePassword.value).toBe('venue-secret');
    });
});

describe('Settings factory reset', () => {
    const FACTORY_URL = '/api/admin/maintenance/factory-reset';
    const factoryRequests = () => requests.filter(({ url }) => url === FACTORY_URL);

    it('asks for confirmation and sends the password to the factory reset endpoint', async () => {
        window.confirm = vi.fn(() => true);
        page.maintenanceScope.value = 'factory';
        page.maintenancePassword.value = 'venue-secret';

        await page.resetOperationalData();

        expect(window.confirm).toHaveBeenCalledTimes(1);
        expect(factoryRequests()).toEqual([{ url: FACTORY_URL, method: 'POST', body: JSON.stringify({ password: 'venue-secret' }) }]);
        expect(resetRequests()).toEqual([]);
        expect(page.maintenancePassword.value).toBe('');
    });

    it('does nothing when the confirmation is declined', async () => {
        window.confirm = vi.fn(() => false);
        page.maintenanceScope.value = 'factory';
        page.maintenancePassword.value = 'venue-secret';

        await page.resetOperationalData();

        expect(factoryRequests()).toEqual([]);
        expect(page.maintenancePassword.value).toBe('venue-secret');
    });
});
