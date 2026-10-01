import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope } from 'vue';
import { renderToString } from 'vue/server-renderer';
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
import StationHealthNotice from '../../components/settings/StationHealthNotice.vue';

const HEALING = 'Spooler on station {name} cannot register: its identity belongs to another station. It is fixing this automatically.';
const BLOCKED = 'Spooler on station {name} cannot register: its identity belongs to another station. Set its station name back, or ask support to reset it.';
const arabic = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../shared/i18n/ar.json'), 'utf8'));

async function render(station, translate = key => key) {
    const app = createSSRApp(StationHealthNotice, { station });
    app.config.globalProperties.$t = translate;
    return renderToString(app);
}

const mismatched = state => ({ spooler_id: 'bar-pc', name: 'Bar PC', station_mismatch: true, station_mismatch_state: state, last_error: 'PRINTER_RECOVERY_REQUIRED', online: false, printers: [] });

describe('station health notice', () => {
    it('promises an automatic fix only while the agent is fixing it', async () => {
        const html = await render(mismatched('healing'));
        expect(html).toContain('Spooler on station Bar PC cannot register: its identity belongs to another station. It is fixing this automatically.');
        expect(html).toContain('role="alert"');
        expect(html).not.toContain('ask support');
    });

    it('tells staff what to do when the agent is blocked, refused, or too old to say', async () => {
        for (const state of ['blocked', null, undefined]) {
            const html = await render(mismatched(state));
            expect(html).toContain('Set its station name back, or ask support to reset it.');
            expect(html).not.toContain('fixing this automatically');
        }
    });

    it('renders both Arabic sentences with the station name', async () => {
        const translate = key => arabic[key] || key;
        const healing = await render(mismatched('healing'), translate);
        expect(healing).toContain('الطابعة الوسيطة في المحطة Bar PC لا تستطيع التسجيل: هويتها مرتبطة بمحطة أخرى. تقوم بإصلاح ذلك تلقائياً.');
        const blocked = await render(mismatched('blocked'), translate);
        expect(blocked).toContain('الطابعة الوسيطة في المحطة Bar PC لا تستطيع التسجيل: هويتها مرتبطة بمحطة أخرى. أعد اسم المحطة كما كان، أو اطلب من الدعم إعادة ضبطها.');
        expect(arabic[HEALING]).toContain('{name}');
        expect(arabic[BLOCKED]).toContain('{name}');
        expect(arabic['Printers waiting for this station']).toBeTruthy();
    });

    it('lists the printers of a station that is not syncing, and nothing for a healthy one', async () => {
        const offline = await render({ spooler_id: 'bar-pc', online: false, last_error: null, printers: ['Bar receipt', 'Bar kitchen'] });
        expect(offline).toContain('Bar receipt, Bar kitchen');
        expect(offline).not.toContain('cannot register');
        const online = await render({ spooler_id: 'bar-pc', online: true, last_error: null, printers: ['Bar receipt'] });
        expect(online).not.toContain('Bar receipt');
        expect(online).not.toContain('data-testid');
    });
});

describe('print queue station list', () => {
    let scope, page;
    const stations = [
        { spooler_id: 'front', online: true, last_error: null, printers: ['Front receipt'] },
        { spooler_id: 'old-name', online: false, last_error: null, printers: [] },
        { spooler_id: 'bar', online: false, last_error: null, station_mismatch: true, printers: ['Bar receipt'] },
        { spooler_id: 'pending-setup', online: false, last_error: null, printers: ['Patio'] }
    ];
    beforeEach(async () => {
        scope = effectScope();
        vi.stubGlobal('window', { showAdminAlert: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
        vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
        vi.stubGlobal('fetch', vi.fn(async url => ({
            json: async () => url === 'api/admin/print-queue/health'
                ? { success: true, summary: [], recent: [], printers: [], spooler: { active: true, count: 1 }, stations }
                : { success: url === 'api/system/settings' }
        })));
        hooks.mounted.length = 0; hooks.unmounted.length = 0;
        page = scope.run(() => Settings.setup());
        hooks.mounted.forEach(fn => fn());
        await vi.waitFor(() => expect(page.isLoading.value).toBe(false));
    });
    afterEach(() => { hooks.unmounted.forEach(fn => fn()); scope.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('hides an offline station that has no printers and no fault, but keeps every other one', () => {
        expect(page.visibleStations.value.map(station => station.spooler_id)).toEqual(['front', 'bar', 'pending-setup']);
    });

    it('shows the spooler status card, not a blank section, when every retained station is hidden', async () => {
        page.printQueueHealth.value = { ...page.printQueueHealth.value, spooler: { active: false, count: 0 }, stations: [stations[1]] };
        expect(page.visibleStations.value).toEqual([]);
        page.activeTab.value = 'printQueue';
        page.isLoading.value = false;
        const app = createSSRApp({ ...Settings, setup: () => page });
        app.config.globalProperties.$t = key => key;
        const html = await renderToString(app);
        expect(html).toContain('connected stations');
        expect(html).not.toContain('Print station');
    });

    it('still offers every station, hidden or not, in the printer form picker', () => {
        expect(page.availableSpoolers.value.map(station => station.id)).toContain('old-name');
    });
});
