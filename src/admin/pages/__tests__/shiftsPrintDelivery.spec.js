import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

const browserPrint = vi.hoisted(() => vi.fn(async (_layout, provider) => provider()));
vi.mock('vue', async original => ({ ...await original(), onMounted: vi.fn(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('../../composables/useBrowserReportPrint.js', () => ({ useBrowserReportPrint: () => ({ printReport: browserPrint }) }));
import Shifts from '../Shifts.vue';

let scope, page, requests, storage, queued;
beforeEach(() => {
    scope = effectScope(); requests = []; queued = true; browserPrint.mockClear();
    storage = new Map([['pos_receipt_printer_id', '17']]);
    vi.stubGlobal('localStorage', { getItem: key => storage.get(key) ?? null });
    vi.stubGlobal('window', { showAdminConfirm: vi.fn(async () => true), showAdminAlert: vi.fn(async () => {}), showAdminToast: vi.fn(), open: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        requests.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
        return { ok: true, json: async () => ({ success: true, print_queued: queued, print_payload: { print_type: 'audit_report', summary: { total: 12 } }, archive: { id: 4 } }) };
    }));
    page = scope.run(() => Shifts.setup());
    page.selectedShift.value = { id: 7, is_active: false };
    page.yArchive.value = { id: 4 };
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

const actions = [
    ['selected shift', (page, layout) => page.printShiftReport(layout), '/shift-reports/7/print'],
    ['X audit', (page, layout) => page.printAuditReport(layout, 'x_audit'), '/audit-reports/print'],
    ['Z audit', (page, layout) => page.printAuditReport(layout, 'z_audit'), '/audit-reports/print'],
    ['period', (page, layout) => page.printPeriodReport(layout), '/audit-reports/print-period'],
    ['items', (page, layout) => page.printItemsReport(layout), '/audit-reports/print-items'],
    ['Y', (page, layout) => page.printYReport(layout), '/audit-reports/print-y'],
    ['last Y', (page, layout) => page.reopenYArchive(layout), '/audit-reports/y-archives/4/print'],
];
describe('Shifts dropdown delivery', () => {
    it.each(actions)('%s thermal queues on the saved device printer without opening the browser', async (_name, action, endpoint) => {
        await action(page, 'thermal');
        expect(browserPrint).not.toHaveBeenCalled();
        expect(window.open).not.toHaveBeenCalled();
        expect(requests).toContainEqual(expect.objectContaining({ url: `api/admin${endpoint}`, method: 'POST', body: expect.objectContaining({ delivery: 'spooler', receipt_printer_id: '17' }) }));
        expect(window.showAdminToast).toHaveBeenCalledWith('Print job queued.', 'success');
    });

    it.each(actions)('%s A4 keeps browser delivery without selecting or queueing a thermal printer', async (_name, action) => {
        await action(page, 'a4');
        expect(browserPrint).toHaveBeenCalledWith('a4', expect.any(Function));
        expect(requests.every(request => !request.body?.delivery && !request.body?.receipt_printer_id)).toBe(true);
        expect(window.showAdminToast).not.toHaveBeenCalled();
    });

    it('requires the server to acknowledge queueing before reporting success', async () => {
        queued = false;
        expect(await page.printItemsReport('thermal')).toBe(false);
        expect(window.showAdminToast).not.toHaveBeenCalled();
        expect(window.showAdminAlert).toHaveBeenCalled();
    });

    it('does not regenerate or print Y after a declined confirmation', async () => {
        window.showAdminConfirm.mockResolvedValue(false);
        expect(await page.printYReport('thermal')).toBe(false);
        expect(requests).toEqual([]);
        expect(browserPrint).not.toHaveBeenCalled();
    });

    it('allows the scoped server fallback when no device printer is saved', async () => {
        storage.delete('pos_receipt_printer_id');
        await page.printItemsReport('thermal');
        expect(requests[0].body).toMatchObject({ delivery: 'spooler', receipt_printer_id: '' });
    });

    it('blocks another print in either format while a thermal request is pending', async () => {
        let complete;
        fetch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
        const pending = page.printItemsReport('thermal');
        expect(await page.printItemsReport('thermal')).toBe(false);
        expect(await page.printItemsReport('a4')).toBe(false);
        expect(fetch).toHaveBeenCalledOnce();
        expect(browserPrint).not.toHaveBeenCalled();
        complete({ json: async () => ({ success: true, print_queued: true, print_payload: { print_type: 'category_items_report' } }) });
        expect(await pending).toBe(true);
        expect(page.isPrinting.value).toBe(false);
    });

    it('does not retry or switch to a browser after a lost thermal response', async () => {
        fetch.mockRejectedValue(new Error('Response lost'));
        expect(await page.printItemsReport('thermal')).toBe(false);
        expect(fetch).toHaveBeenCalledOnce();
        expect(browserPrint).not.toHaveBeenCalled();
        expect(window.showAdminToast).not.toHaveBeenCalled();
        expect(page.isPrinting.value).toBe(false);
    });

    it('explains that a lost thermal response may already have queued the report', async () => {
        fetch.mockRejectedValue(new Error('Response lost after commit'));
        await page.printItemsReport('thermal');
        expect(window.showAdminAlert).toHaveBeenCalledWith('The print result could not be confirmed. It may already be queued. Check Printing before retrying.');
    });

    it('uses the canonical selected-shift A4 payload without rebuilding amounts from the screen', async () => {
        const payload = { print_type: 'z_report', expected_cash: 12, gross_sales: 42 };
        page.selectedShift.value.gross_sales = 999999;
        page.selectedShift.value.expected_cash = 999999;
        fetch.mockResolvedValueOnce({ json: async () => ({ success: true, print_payload: payload }) });
        expect(await page.printShiftReport('a4')).toEqual(payload);
        expect(fetch).toHaveBeenCalledWith('api/admin/shift-reports/7/print-payload?type=z_report', undefined);
    });

    it.each(actions)('%s prints the selection made at click time even when A4 loads slowly', async (_name, action, endpoint) => {
        let provide;
        browserPrint.mockImplementationOnce((_layout, provider) => new Promise(resolve => { provide = async () => resolve(await provider()); }));
        page.filterDateFrom.value = '2026-07-01';
        page.filterDateTo.value = '2026-07-02';
        const pending = action(page, 'a4');
        if (_name === 'Y') expect(window.showAdminConfirm).not.toHaveBeenCalled();
        page.selectedShift.value = { id: 8, is_active: true };
        page.yArchive.value = { id: 5 };
        page.filterDateFrom.value = '2026-08-01';
        page.filterDateTo.value = '2026-08-02';
        await provide();
        await pending;
        const reportRequest = requests.find(request => request.url.includes(endpoint.replace(/\/print$/, '')));
        expect(reportRequest, 'request must retain its original shift/archive').toBeDefined();
        if (reportRequest.body) {
            expect(reportRequest.body.business_date || reportRequest.body.start_date).toBe('2026-07-01');
            if (reportRequest.body.end_date) expect(reportRequest.body.end_date).toBe('2026-07-02');
        }
        if (_name === 'selected shift') expect(reportRequest.url).toContain('type=z_report');
        if (_name === 'last Y') {
            expect(reportRequest.url).toBe('api/admin/audit-reports/y-archives/4/print-payload');
            expect(reportRequest.method).toBe('GET');
            expect(reportRequest.body).toBeNull();
        }
    });
});
