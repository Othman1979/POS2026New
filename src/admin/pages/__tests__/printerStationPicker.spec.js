import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
const hooks = vi.hoisted(() => ({ mounted: [], unmounted: [] }));
vi.mock('vue', async original => ({
    ...await original(),
    useSSRContext: () => ({ modules: new Set() }),
    onMounted: fn => hooks.mounted.push(fn),
    onUnmounted: fn => hooks.unmounted.push(fn)
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, setLanguage: vi.fn(), currentLanguage: { value: 'en' }, languageChoices: [] }));
vi.mock('../../components/settings/DeviceAccessSettings.vue', () => ({ default: {} }));
import Settings from '../Settings.vue';

// /print-queue/health sends `stations`, keyed by spooler_id with a display name
// (backend/tests/integration/spoolerV2Health.test.js pins that response shape).
// The picker once read `spoolers`, a key the endpoint never sent, so a registered
// station was visible on the print-queue panel yet the dropdown offered only 'primary'.
const health = {
    success: true,
    summary: [],
    recent: [],
    printers: [],
    spooler: { active: true, count: 2 },
    stations: [
        { spooler_id: 'bar-pc', name: 'Bar PC' },
        { spooler_id: 'kitchen-pc', name: '' }
    ]
};

let scope, page;
beforeEach(async () => {
    scope = effectScope();
    vi.stubGlobal('window', { showAdminAlert: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async url => ({
        json: async () => url === 'api/admin/print-queue/health' ? health : { success: url === 'api/system/settings' }
    })));
    hooks.mounted.length = 0; hooks.unmounted.length = 0;
    page = scope.run(() => Settings.setup());
    hooks.mounted.forEach(fn => fn());
    await vi.waitFor(() => expect(page.isLoading.value).toBe(false));
});
afterEach(() => { hooks.unmounted.forEach(fn => fn()); scope.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('printer station picker', () => {
    it('offers every station the health endpoint reports, after primary', () => {
        expect(page.availableSpoolers.value).toEqual([
            { id: 'primary', name: 'Primary station' },
            { id: 'bar-pc', name: 'Bar PC' },
            { id: 'kitchen-pc', name: 'kitchen-pc' }
        ]);
    });

    it('keeps an offline station the edited printer is bound to selectable', () => {
        page.printerForm.value = { ...page.printerForm.value, spooler_id: 'patio-pc' };
        expect(page.availableSpoolers.value.map(station => station.id)).toEqual(['primary', 'bar-pc', 'kitchen-pc', 'patio-pc']);
    });
});
