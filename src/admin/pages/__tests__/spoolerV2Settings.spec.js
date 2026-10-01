import fs from 'node:fs';
import path from 'node:path';
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

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'Settings.vue'), 'utf8').replace(/\r\n/g, '\n');
const arabic = JSON.parse(fs.readFileSync(path.resolve(root, '../../shared/i18n/ar.json'), 'utf8'));

describe('Print Queue V2 settings surface', () => {
    it('renders durable station health and confidence without claiming paper was printed', () => {
        for (const text of ['stations', 'last_sync_at', 'local_queue_depth', 'renderer', 'helper', 'Device confirmed', 'Windows accepted', 'Bytes sent', 'Stored on terminal', 'Cancellation pending']) {
            expect(settings).toContain(text);
        }
        expect(settings).not.toContain('delivery_protocol');
        expect(settings.toLowerCase()).not.toContain('paper printed');
    });

    it('shows when each printer last printed and its last error instead of a probed status', () => {
        for (const text of ['printer.last_printed_at', 'printer.last_error_code', 'formatAgo']) expect(settings).toContain(text);
        for (const removed of ['status_checked_at', 'formatCapability', 'Status capability']) expect(settings).not.toContain(removed);
        for (const key of ['Last printed', 'Last error']) expect(arabic[key], key).toBeTruthy();
    });

    it('keeps replacement and health reconciliation in the existing tab', () => {
        for (const text of [
            'api/admin/spooler-agents/',
            'createPrintQueueRefreshController',
            "activeTab.value === 'printQueue'",
            'printQueueRefresh.start()',
            'printQueueRefresh.stop()'
        ]) {
            expect(settings).toContain(text);
        }
        for (const removed of [
            'printQueuePollTimer',
            'printQueueHealthLoading',
            'schedulePrintQueuePolling',
            'stopPrintQueuePolling'
        ]) expect(settings).not.toContain(removed);
        expect(settings).not.toContain('/rollback-v1');
        expect(settings).not.toContain('terminalize-v1');
        expect(settings).not.toContain('V1_CUTOVER_OUTCOME_UNKNOWN');
        expect(settings).not.toContain('Confirm the old V1 service is stopped before reprinting this outcome-unknown job.');
    });

    it('has Arabic catalog entries for every new cashier-facing label', () => {
        for (const key of ['Print station', 'Local queue', 'Last sync', 'Renderer', 'Helper', 'Device confirmed', 'Windows accepted', 'Bytes sent', 'Stored on terminal', 'Cancellation pending', 'Draining', 'Outcome unknown', 'Missing', 'Download diagnostics']) {
            expect(arabic[key], key).toBeTruthy();
        }
    });

    it('offers one confirmation for only the server-cancelable queue states', () => {
        expect(settings).toContain("['pending', 'sent', 'local_accepted'].includes(job.status)");
        expect(settings).toContain('window.confirm');
        expect(settings).toContain('data.outcome');
        expect(settings).toContain('await printQueueRefresh.refreshNow({ force: true })');
        expect(settings).not.toContain('showCancelModal');
        expect(settings).not.toContain('cancelReason');
        for (const key of ['Cancel Print', 'Are you sure you want to cancel this print job?', 'Print job canceled.', 'Print job cancellation requested.']) {
            expect(arabic[key], key).toBeTruthy();
        }
    });
});

describe('Print Queue V2 health reads', () => {
    const HEALTH = 'api/admin/print-queue/health';
    const healthReads = () => fetch.mock.calls.filter(([url]) => url === HEALTH).length;
    let scope, page;

    beforeEach(async () => {
        scope = effectScope();
        hooks.mounted.length = 0; hooks.unmounted.length = 0;
        vi.stubGlobal('window', { showAdminAlert: vi.fn(), confirm: () => true, prompt: () => 'jammed', addEventListener: vi.fn(), removeEventListener: vi.fn() });
        vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
        vi.stubGlobal('fetch', vi.fn(async (url, options) => ({
            json: async () => options?.method === 'POST'
                ? { success: true, outcome: 'canceled' }
                : { success: url === 'api/system/settings' || url === HEALTH, stations: [] }
        })));
        page = scope.run(() => Settings.setup());
        hooks.mounted.forEach(fn => fn());
        await vi.waitFor(() => expect(page.isLoading.value).toBe(false));
    });
    afterEach(() => { hooks.unmounted.forEach(fn => fn()); scope.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('reads health once on open, reusing the bootstrap read for the initial load', () => {
        expect(healthReads()).toBe(1);
    });

    it.each([
        ['canceling a job', () => page.cancelPrintJob({ id: 41, status: 'pending' })],
        ['queueing a reprint', () => page.reprintQueueJob({ id: 42, last_failure_class: null })],
        ['draining a station', () => page.drainSpoolerStation({ spooler_id: 'bar-pc' })]
    ])('reads health again after %s', async (_, action) => {
        await action();
        expect(healthReads()).toBe(2);
    });
});
