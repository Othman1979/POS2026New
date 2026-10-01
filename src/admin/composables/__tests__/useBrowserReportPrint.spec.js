import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProxy, reactive } from 'vue';

const getSystemSettings = vi.fn();
const t = vi.fn(key => key);

vi.mock('@/shared/systemSettings.js', () => ({ getSystemSettings }));
vi.mock('@/shared/i18n.js', () => ({ t }));

function createHarness() {
    const listeners = new Set();
    const openedUrls = [];
    const popup = {
        closed: false,
        close: vi.fn(() => { popup.closed = true; }),
        focus: vi.fn(),
        postMessage: vi.fn(),
        location: {}
    };
    Object.defineProperty(popup.location, 'href', {
        configurable: true,
        get: () => openedUrls.at(-1) || 'about:blank',
        set: value => openedUrls.push(String(value))
    });

    const storage = new Map([['pos_admin_language', 'ar']]);
    const fakeWindow = {
        location: { origin: 'https://pos.test' },
        open: vi.fn(() => popup),
        focus: vi.fn(),
        showAdminAlert: vi.fn(),
        addEventListener: vi.fn((type, handler) => {
            if (type === 'message') listeners.add(handler);
        }),
        removeEventListener: vi.fn((type, handler) => {
            if (type === 'message') listeners.delete(handler);
        })
    };
    const localStorage = {
        getItem: vi.fn(key => storage.get(key) ?? null),
        setItem: vi.fn((key, value) => storage.set(key, value))
    };

    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });

    return {
        fakeWindow,
        popup,
        openedUrls,
        listeners,
        dispatch(data, overrides = {}) {
            for (const listener of [...listeners]) {
                listener({
                    origin: fakeWindow.location.origin,
                    source: popup,
                    data,
                    ...overrides
                });
            }
        }
    };
}

async function beginReadyPrint(printReport, harness, layout, provider) {
    const pending = printReport(layout, provider);
    await Promise.resolve();
    const target = new URL(harness.openedUrls.at(-1));
    const nonce = target.searchParams.get('admin_report');
    harness.dispatch({ type: 'POS_ADMIN_PRINT_READY', nonce, layout });
    await Promise.resolve();
    return { pending, nonce };
}

beforeEach(() => {
    vi.useRealTimers();
    getSystemSettings.mockReset();
    t.mockClear();
});

describe('useBrowserReportPrint', () => {
    it('opens synchronously, waits for the exact popup handshake, then posts an allowlisted payload once', async () => {
        const harness = createHarness();
        const order = [];
        getSystemSettings.mockImplementation(async () => {
            order.push('settings');
            return {
                success: true,
                store_name: 'Store',
                store_address: 'Address',
                store_phone: 'Phone',
                receipt_config: '{}',
                tax_inclusive_pricing: '1',
                jofotara_sales_tax_secret_key: 'must-not-cross',
                print_method: 'spooler'
            };
        });
        const provider = vi.fn(async () => {
            order.push('provider');
            return {
                print_type: 'daily_summary_report',
                report_id: 'daily:1',
                storeInfo: {
                    store_name: 'Canonical Store',
                    jofotara_sales_tax_secret_key: 'also-must-not-cross'
                }
            };
        });
        const { useBrowserReportPrint } = await import('../useBrowserReportPrint.js');
        const { printReport, isPrinting } = useBrowserReportPrint();

        const { pending, nonce } = await beginReadyPrint(printReport, harness, 'a4', provider);
        await expect(pending).resolves.toBe(true);

        expect(harness.fakeWindow.open).toHaveBeenCalledWith('about:blank', '_blank');
        expect(harness.openedUrls[0]).toContain('/print-receipt?');
        expect(order).toEqual(['settings', 'provider']);
        expect(harness.fakeWindow.focus).toHaveBeenCalledBefore(provider);
        expect(harness.popup.postMessage).toHaveBeenCalledTimes(1);
        const [message, targetOrigin] = harness.popup.postMessage.mock.calls[0];
        expect(targetOrigin).toBe('https://pos.test');
        expect(message).toMatchObject({ type: 'POS_ADMIN_PRINT_PAYLOAD', nonce, layout: 'a4' });
        expect(message.payload).toMatchObject({
            type: 'daily_summary_report',
            language: 'ar',
            direction: 'rtl',
            data: {
                print_type: 'daily_summary_report',
                report_id: 'daily:1',
                business_config: {
                    business_sql_offset: '+03:00',
                    business_day_start_hour: 6,
                },
                storeInfo: {
                    store_name: 'Canonical Store',
                    store_address: 'Address',
                    store_phone: 'Phone',
                    receipt_config: '{}',
                    tax_inclusive_pricing: '1'
                }
            }
        });
        expect(JSON.stringify(message)).not.toContain('jofotara');
        expect(JSON.stringify(message)).not.toContain('print_method');
        expect(harness.listeners.size).toBe(0);
        expect(isPrinting.value).toBe(false);
    });

    it('snapshots nested Vue proxies before crossing the postMessage boundary', async () => {
        const harness = createHarness();
        getSystemSettings.mockResolvedValue({ success: true });
        const summary = reactive({ sales_collected: 12.5, nested: { count: 2 } });
        const provider = vi.fn(async () => ({
            print_type: 'daily_summary_report',
            summary,
        }));
        const { useBrowserReportPrint } = await import('../useBrowserReportPrint.js');
        const workflow = useBrowserReportPrint();
        const { pending } = await beginReadyPrint(workflow.printReport, harness, 'thermal', provider);

        await expect(pending).resolves.toBe(true);
        const [message] = harness.popup.postMessage.mock.calls[0];
        expect(isProxy(summary)).toBe(true);
        expect(isProxy(message.payload.data.summary)).toBe(false);
        expect(message.payload.data.summary).toEqual({ sales_collected: 12.5, nested: { count: 2 } });
    });

    it('ignores a wrong origin, source, nonce, or layout before accepting the exact ready message', async () => {
        const harness = createHarness();
        getSystemSettings.mockResolvedValue({ success: true });
        const provider = vi.fn(async () => ({ print_type: 'audit_report' }));
        const { useBrowserReportPrint } = await import('../useBrowserReportPrint.js');
        const { printReport } = useBrowserReportPrint();
        const pending = printReport('thermal', provider);
        await Promise.resolve();
        const target = new URL(harness.openedUrls.at(-1));
        const nonce = target.searchParams.get('admin_report');

        harness.dispatch({ type: 'POS_ADMIN_PRINT_READY', nonce, layout: 'thermal' }, { origin: 'https://evil.test' });
        harness.dispatch({ type: 'POS_ADMIN_PRINT_READY', nonce, layout: 'thermal' }, { source: {} });
        harness.dispatch({ type: 'POS_ADMIN_PRINT_READY', nonce: 'wrong', layout: 'thermal' });
        harness.dispatch({ type: 'POS_ADMIN_PRINT_READY', nonce, layout: 'a4' });
        await Promise.resolve();
        expect(provider).not.toHaveBeenCalled();

        harness.dispatch({ type: 'POS_ADMIN_PRINT_READY', nonce, layout: 'thermal' });
        await expect(pending).resolves.toBe(true);
        expect(provider).toHaveBeenCalledTimes(1);
    });

    it('does not run the provider when the popup is blocked or never becomes ready', async () => {
        vi.useFakeTimers();
        const blocked = createHarness();
        blocked.fakeWindow.open.mockReturnValue(null);
        const provider = vi.fn();
        const { useBrowserReportPrint } = await import('../useBrowserReportPrint.js');
        const first = useBrowserReportPrint();
        await expect(first.printReport('thermal', provider)).resolves.toBe(false);
        expect(provider).not.toHaveBeenCalled();

        const stalled = createHarness();
        const second = useBrowserReportPrint();
        const pending = second.printReport('a4', provider);
        await vi.advanceTimersByTimeAsync(10001);
        await expect(pending).resolves.toBe(false);
        expect(provider).not.toHaveBeenCalled();
        expect(stalled.popup.close).toHaveBeenCalledTimes(1);
        expect(stalled.listeners.size).toBe(0);
    });

    it('does not run the provider when system settings return an unsuccessful response', async () => {
        const harness = createHarness();
        getSystemSettings.mockResolvedValue({ success: false, message: 'Unavailable' });
        const provider = vi.fn(async () => ({ print_type: 'z_report' }));
        const { useBrowserReportPrint } = await import('../useBrowserReportPrint.js');
        const workflow = useBrowserReportPrint();
        const { pending } = await beginReadyPrint(workflow.printReport, harness, 'thermal', provider);

        await expect(pending).resolves.toBe(false);
        expect(provider).not.toHaveBeenCalled();
        expect(harness.popup.postMessage).not.toHaveBeenCalled();
        expect(harness.popup.close).toHaveBeenCalledTimes(1);
    });

    it('closes quietly for an intentional provider cancellation and aborts if the popup closed meanwhile', async () => {
        const harness = createHarness();
        getSystemSettings.mockResolvedValue({ success: true });
        const provider = vi.fn(async () => false);
        const { useBrowserReportPrint } = await import('../useBrowserReportPrint.js');
        const first = useBrowserReportPrint();
        const { pending } = await beginReadyPrint(first.printReport, harness, 'thermal', provider);
        await expect(pending).resolves.toBe(false);
        expect(harness.popup.close).toHaveBeenCalledTimes(1);
        expect(harness.fakeWindow.showAdminAlert).not.toHaveBeenCalled();

        const closed = createHarness();
        getSystemSettings.mockResolvedValue({ success: true });
        const closeDuringProvider = vi.fn(async () => {
            closed.popup.closed = true;
            return { print_type: 'daily_sales_report' };
        });
        const second = useBrowserReportPrint();
        const next = await beginReadyPrint(second.printReport, closed, 'a4', closeDuringProvider);
        await expect(next.pending).resolves.toBe(false);
        expect(closed.popup.postMessage).not.toHaveBeenCalled();
    });

    it('rejects invalid layouts and suppresses duplicate requests while one preview is active', async () => {
        const harness = createHarness();
        getSystemSettings.mockResolvedValue({ success: true });
        const provider = vi.fn(async () => ({ print_type: 'daily_expenses_report' }));
        const { useBrowserReportPrint } = await import('../useBrowserReportPrint.js');
        const workflow = useBrowserReportPrint();

        await expect(workflow.printReport('letter', provider)).resolves.toBe(false);
        expect(harness.fakeWindow.open).not.toHaveBeenCalled();

        const first = workflow.printReport('thermal', provider);
        await Promise.resolve();
        await expect(workflow.printReport('a4', provider)).resolves.toBe(false);
        expect(harness.fakeWindow.open).toHaveBeenCalledTimes(1);
        const target = new URL(harness.openedUrls.at(-1));
        harness.dispatch({
            type: 'POS_ADMIN_PRINT_READY',
            nonce: target.searchParams.get('admin_report'),
            layout: 'thermal'
        });
        await expect(first).resolves.toBe(true);
    });

    it('does not claim a handoff for an unsupported report type', async () => {
        const harness = createHarness();
        getSystemSettings.mockResolvedValue({ success: true });
        const provider = vi.fn(async () => ({ print_type: 'receipt' }));
        const { useBrowserReportPrint } = await import('../useBrowserReportPrint.js');
        const workflow = useBrowserReportPrint();
        const { pending } = await beginReadyPrint(workflow.printReport, harness, 'thermal', provider);

        await expect(pending).resolves.toBe(false);
        expect(harness.popup.postMessage).not.toHaveBeenCalled();
        expect(harness.popup.close).toHaveBeenCalledTimes(1);
        expect(harness.fakeWindow.showAdminAlert).toHaveBeenCalledTimes(1);
    });
});
