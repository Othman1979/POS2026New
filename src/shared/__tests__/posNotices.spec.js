import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

vi.mock('@/shared/i18n.js', () => ({ setLanguage: vi.fn(), t: key => key }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('toast queue', () => {
  it('keeps a warning visible when a later toast arrives, then shows the later one', async () => {
    const { createToastQueue } = await import('@/shared/toastQueue.js');
    const toast = ref({ show: false, message: '', type: 'info' });
    const push = createToastQueue(toast);

    push('Transaction saved. Printing failed', 'warning');
    vi.advanceTimersByTime(10);
    push('Added: Burger', 'success');
    expect(toast.value).toMatchObject({ show: true, message: 'Transaction saved. Printing failed' });

    vi.advanceTimersByTime(6000);
    expect(toast.value).toMatchObject({ show: true, message: 'Added: Burger' });
    vi.advanceTimersByTime(3500);
    expect(toast.value.show).toBe(false);
  });

  it('gives errors a longer lifetime than info toasts', async () => {
    const { createToastQueue } = await import('@/shared/toastQueue.js');
    const toast = ref({ show: false, message: '', type: 'info' });
    const push = createToastQueue(toast);
    push('Print failed', 'error');
    vi.advanceTimersByTime(3600);
    expect(toast.value.show).toBe(true);
  });

  it('lets a newer toast replace a non-critical one at once', async () => {
    const { createToastQueue } = await import('@/shared/toastQueue.js');
    const toast = ref({ show: false, message: '', type: 'info' });
    const push = createToastQueue(toast);
    push('Added: Tea', 'success');
    push('Print failed', 'error');
    expect(toast.value.message).toBe('Print failed');
  });
});

describe('scan message', () => {
  it('keeps the second of two scans 1.5 s apart for its full 2 s', async () => {
    global.localStorage = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
    global.window = { showPosToast: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.resetModules();
    const { useTerminal } = await import('@/pos/useTerminal.js');
    const terminal = useTerminal();
    const addToCart = vi.fn(async () => true);
    const products = [{ id: 1, barcode: '111', name: 'Tea' }, { id: 2, barcode: '222', name: 'Cake' }];
    await terminal.processBarcode('111', products, addToCart);
    vi.advanceTimersByTime(1500);
    await terminal.processBarcode('222', products, addToCart);
    vi.advanceTimersByTime(1000);
    expect(terminal.scanMessage.value).toBe('Added: Cake');
    vi.advanceTimersByTime(1000);
    expect(terminal.scanMessage.value).toBe('');
  });
});

describe('manager override expiry', () => {
  it('does not cancel an open prompt when the override expires', async () => {
    vi.resetModules();
    vi.doMock('@/shared/http.js', () => ({
      fetchJson: vi.fn(), fetchReadJsonResponse: vi.fn(), waitAtMost: vi.fn(),
      fetchJsonResponseWithTimeout: vi.fn()
    }));
    const permissionPolicy = (await import('@posapp/permission-policy')).default;
    const allowed = permissionPolicy.TEMPORARY_CHECKOUT_PERMISSIONS;
    const http = await import('@/shared/http.js');
    http.fetchJsonResponseWithTimeout.mockResolvedValue({ data: { success: true, permissions: [allowed[0]] } });
    global.window = { showPosAlert: vi.fn(), showPosToast: vi.fn(), resetPosDialogs: vi.fn() };
    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();
    auth.overridePin.value = '1234';
    await auth.activateOverride();
    expect(auth.isTempAdmin.value).toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(auth.isTempAdmin.value).toBe(false);
    expect(window.showPosAlert).not.toHaveBeenCalled();
    expect(window.showPosToast).toHaveBeenCalledWith('Manager Override has automatically expired.', 'warning');
    vi.doUnmock('@/shared/http.js');
  });
});
