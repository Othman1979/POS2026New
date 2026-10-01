import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/i18n.js', () => ({ t: key => key, setLanguage: vi.fn() }));
const reply = data => ({ ok: true, json: async () => ({ success: true, print_method: 'backend', ...data }) });
let terminal;
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('window', { print: vi.fn(), showPosToast: vi.fn() });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    terminal = (await import('./useTerminal.js')).useTerminal();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('terminal settings recovery', () => {
    it('shares an in-flight load between callers instead of competing responses', async () => {
        const pending = Promise.withResolvers();
        vi.stubGlobal('fetch', vi.fn(() => pending.promise));
        const first = terminal.loadSettings();
        const second = terminal.loadSettings();
        expect(fetch).toHaveBeenCalledOnce();
        pending.resolve(reply());
        expect(await first).toBe(true);
        expect(await second).toBe(true);
        expect(terminal.printMethod.value).toBe('backend');
    });

    it.each([
        ['1', true],
        [true, true],
        ['0', false],
        [false, false],
    ])('exposes the tables setting from a successful snapshot: %s', async (tablesEnabled, expected) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ tables_enabled: tablesEnabled })));
        expect(await terminal.loadSettings()).toBe(true);
        expect(terminal.tablesEnabledSetting.value).toBe(expected);
    });

    it('is the single source of the catalog-owned settings the POS consumes', async () => {
        const { useProducts } = await import('./useProducts.js');
        const products = useProducts();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({
            stock_enabled: '1', recipe_ledger_enabled: '0', tables_enabled: true,
            service_charge_enabled: '1', service_charge_percentage: '12', auto_apply_service_charge: '1',
        })));
        expect(await terminal.loadSettings()).toBe(true);
        expect(products.settings.value).toEqual({
            stock_enabled: '1', recipe_ledger_enabled: '0', tables_enabled: '1',
            service_charge_enabled: '1', service_charge_percentage: '12', auto_apply_service_charge: '1',
        });
        // A later settings read (for example on a KeepAlive return) replaces stale values.
        fetch.mockResolvedValue(reply({ stock_enabled: '0', tables_enabled: '0', service_charge_enabled: '0', service_charge_percentage: '10', auto_apply_service_charge: '0' }));
        expect(await terminal.loadSettings({ force: true })).toBe(true);
        expect(products.settings.value.stock_enabled).toBe('0');
        expect(products.settings.value.service_charge_enabled).toBe('0');
    });

    it('coalesces receipt-printer discovery for terminal setup callers', async () => {
        const pending = Promise.withResolvers();
        vi.stubGlobal('fetch', vi.fn(() => pending.promise));
        const first = terminal.loadReceiptPrinters();
        const second = terminal.loadReceiptPrinters();
        expect(fetch).toHaveBeenCalledOnce();
        pending.resolve(reply({ data: [
            { id: 1, role: 'receipt', name: 'Register' },
            { id: 2, role: 'kitchen', name: 'Kitchen' },
        ] }));
        expect(await first).toBe(true);
        expect(await second).toBe(true);
        expect(terminal.receiptPrinters.value).toEqual([{ id: 1, role: 'receipt', name: 'Register' }]);
    });

    it('settles a stalled printer read so the next open asks again', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        const first = terminal.loadReceiptPrinters();
        await vi.advanceTimersByTimeAsync(15000);
        expect(await first).toBe(false);
        void terminal.loadReceiptPrinters();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('coalesces settings changes during a read into a fresh follow-up snapshot', async () => {
        const pending = Promise.withResolvers();
        vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(reply({ store_name: 'New name' })));
        const first = terminal.loadSettings();
        const changed = terminal.loadSettings({ force: true });
        const changedAgain = terminal.loadSettings({ force: true });
        expect(fetch).toHaveBeenCalledOnce();
        pending.resolve(reply({ store_name: 'Old name' }));
        expect(await first).toBe(true);
        expect(await changed).toBe(true);
        expect(await changedAgain).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(terminal.storeName.value).toBe('New name');
        expect(terminal.settingsLoading.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retains the successful snapshot when a required follow-up fails', async () => {
        const pending = Promise.withResolvers();
        vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValue(new TypeError('offline')));
        const first = terminal.loadSettings();
        const changed = terminal.loadSettings({ force: true });
        pending.resolve(reply({ store_name: 'Last good' }));
        expect(await first).toBe(false);
        expect(await changed).toBe(false);
        expect(terminal.settingsLoaded.value).toBe(true);
        expect(terminal.storeName.value).toBe('Last good');
        expect(terminal.settingsError.value).toBe(''); // silent until the automatic retry fails too
        await vi.advanceTimersByTimeAsync(2000);
        expect(terminal.settingsError.value).toBeTruthy();
        expect(terminal.settingsLoading.value).toBe(false);
        fetch.mockResolvedValue(reply({ store_name: 'Recovered' }));
        expect(await terminal.loadSettings()).toBe(true);
        expect(terminal.storeName.value).toBe('Recovered');
    });

    it.each(['headers', 'body'])('bounds stalled settings %s, exposes failure and can retry', async stage => {
        vi.stubGlobal('fetch', vi.fn(() => stage === 'headers'
            ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => new Promise(() => {}) })));
        let settled = false;
        const request = terminal.loadSettings().then(value => { settled = true; return value; });
        await vi.advanceTimersByTimeAsync(15000);
        expect(settled).toBe(true);
        expect(await request).toBe(false);
        expect(terminal.settingsLoaded.value).toBe(false);
        expect(terminal.settingsError.value).toBeTruthy();
        fetch.mockResolvedValue(reply());
        expect(await terminal.loadSettings()).toBe(true);
        expect(terminal.settingsLoaded.value).toBe(true);
        expect(terminal.settingsError.value).toBe('');
        expect(terminal.printMethod.value).toBe('backend');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never prints with defaults when initial settings cannot be loaded', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
        await expect(terminal.printReceipt({ invoice_id: 1 })).rejects.toThrow();
        expect(window.print).not.toHaveBeenCalled();
        expect(fetch.mock.calls.every(([url]) => url === 'api/system/settings')).toBe(true);
    });

    it('bounds an uncertain receipt admission without printing or resending it', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply()));
        await terminal.loadSettings();
        fetch.mockClear().mockReturnValue(new Promise(() => {}));
        const printed = terminal.printReceipt({ invoice_id: 1 }, { saved: true });
        await vi.advanceTimersByTimeAsync(30000);
        expect(terminal.isPrintingBackend.value).toBe(false);
        expect(await printed).toBe(false);
        expect(fetch).toHaveBeenCalledOnce();
        expect(window.print).not.toHaveBeenCalled();
        expect(window.showPosToast).toHaveBeenCalledWith(expect.stringContaining('not confirmed'), 'warning');
        // A lost acknowledgement must not be presented as a known print failure.
        expect(window.showPosToast.mock.calls[0][0]).not.toContain('Printing failed');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps last successful settings after a failed refresh', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ store_name: 'Fixture' })));
        expect(await terminal.loadSettings()).toBe(true);
        fetch.mockRejectedValue(new TypeError('offline'));
        expect(await terminal.loadSettings()).toBe(false);
        await vi.advanceTimersByTimeAsync(2000);
        expect(terminal.printMethod.value).toBe('backend');
        expect(terminal.storeName.value).toBe('Fixture');
        expect(terminal.settingsLoaded.value).toBe(true);
        expect(terminal.settingsError.value).toBeTruthy();
    });

    it('retries a failed refresh by itself and clears the notice when the server answers again', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ store_name: 'Before' })));
        expect(await terminal.loadSettings()).toBe(true);
        fetch.mockRejectedValue(new TypeError('offline'));
        expect(await terminal.loadSettings({ force: true })).toBe(false);
        await vi.advanceTimersByTimeAsync(2000);
        expect(terminal.settingsError.value).toBe('Settings could not be refreshed. Using the last loaded settings.');
        fetch.mockResolvedValue(reply({ store_name: 'After' }));
        await vi.advanceTimersByTimeAsync(5000);
        expect(terminal.storeName.value).toBe('After');
        expect(terminal.settingsError.value).toBe('');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never shows the notice for a blip that the first retry recovers', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply()));
        await terminal.loadSettings();
        fetch.mockRejectedValueOnce(new TypeError('offline'));
        expect(await terminal.loadSettings({ force: true })).toBe(false);
        expect(terminal.settingsError.value).toBe('');
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(terminal.settingsError.value).toBe('');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('shows a failed first load at once, retries three times, then waits for an event', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
        expect(await terminal.loadSettings()).toBe(false);
        expect(terminal.settingsError.value).toBe('Settings could not be loaded. Retry before checkout or printing.');
        const attemptsAt = [];
        for (let second = 1; second <= 120; second++) {
            await vi.advanceTimersByTimeAsync(1000);
            if (fetch.mock.calls.length > attemptsAt.length + 1) attemptsAt.push(second);
        }
        expect(attemptsAt).toEqual([2, 7, 17]); // then no clock at all
        expect(vi.getTimerCount()).toBe(0);
        fetch.mockResolvedValue(reply());
        terminal.retryFailedSettings(); // e.g. the socket heartbeat
        await vi.advanceTimersByTimeAsync(0);
        expect(terminal.settingsLoaded.value).toBe(true);
        expect(terminal.settingsError.value).toBe('');
    });

    it('sends nothing on a heartbeat while settings are fine', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply()));
        await terminal.loadSettings();
        for (let beat = 0; beat < 100; beat++) terminal.retryFailedSettings();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('stops retrying when the terminal is torn down', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
        await terminal.loadSettings();
        terminal.cancelSettingsRecovery();
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetch).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores an expired settings reply that arrives after successful recovery', async () => {
        const old = Promise.withResolvers();
        vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(reply({ store_name: 'Recovered' })));
        const expired = terminal.loadSettings();
        await vi.advanceTimersByTimeAsync(15000);
        expect(await expired).toBe(false);
        expect(await terminal.loadSettings()).toBe(true);
        old.resolve(reply({ store_name: 'Expired', print_method: 'browser' }));
        await vi.advanceTimersByTimeAsync(0);
        expect(terminal.storeName.value).toBe('Recovered');
        expect(terminal.printMethod.value).toBe('backend');
        expect(terminal.settingsError.value).toBe('');
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['connection', 'json'])('reports an uncertain print after a lost %s acknowledgement', async stage => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply()));
        await terminal.loadSettings();
        fetch.mockClear();
        if (stage === 'connection') fetch.mockRejectedValue(new TypeError('Failed to fetch'));
        else fetch.mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('Truncated JSON'); } });
        expect(await terminal.printReceipt({ invoice_id: 1 }, { saved: true })).toBe(false);
        expect(fetch).toHaveBeenCalledOnce();
        expect(window.print).not.toHaveBeenCalled();
        expect(window.showPosToast).toHaveBeenCalledWith(expect.stringContaining('not confirmed'), 'warning');
        expect(window.showPosToast.mock.calls[0][0]).not.toContain('Printing failed');
        expect(terminal.isPrintingBackend.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('browser receipt printing', () => {
    it('prints on the next render with no fixed wait', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ print_method: 'browser' })));
        vi.stubGlobal('document', { body: { classList: { add: vi.fn(), remove: vi.fn() } } });
        expect(await terminal.loadSettings()).toBe(true);
        const order = { invoice_id: 5 };
        terminal.lastOrder.value = order;
        const printed = terminal.printReceipt(order);
        await vi.advanceTimersByTimeAsync(0);
        expect(window.print).toHaveBeenCalledOnce();
        expect(await printed).toBe(true);
    });
});
