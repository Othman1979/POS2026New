import { afterEach, describe, expect, it, vi } from 'vitest';
import { POS_ORDER_SESSION_KEYS } from '@/pos/posSessionStorage.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('useAuth refresh hydration', () => {
  it('coalesces approval clicks, keeps only supported fields and expires the in-memory PIN', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('sessionStorage', { getItem: () => null });
    vi.stubGlobal('window', { showPosAlert: vi.fn() });
    let finish;
    const fetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();
    auth.activeUser.value = { id: 2, role: 'cashier', permissions: [] };
    auth.overridePin.value = '1234';
    const pending = auth.activateOverride();
    await auth.activateOverride();
    expect(fetch).toHaveBeenCalledTimes(1);
    finish({ json: async () => ({ success: true, permissions: ['pos.discount', 'pos.checkout'] }) });
    await pending;
    expect(auth.temporaryPermissions.value).toEqual(['pos.discount']);
    expect(auth.activeManagerPin.value).toBe('1234');
    expect(auth.hasAdminPrivilege.value).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(auth.isTempAdmin.value).toBe(false);
    expect(auth.activeManagerPin.value).toBe('');
    expect(auth.temporaryPermissions.value).toEqual([]);
  });
  it('keeps temporary checkout approval separate from administrator report access', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null });
    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();
    auth.activeUser.value = { id: 2, role: 'cashier', permissions: [] };
    auth.isTempAdmin.value = true;
    expect(auth.hasAdminPrivilege.value).toBe(false);
    auth.activeUser.value = { id: 1, role: 'admin', permissions: [] };
    expect(auth.hasAdminPrivilege.value).toBe(true);
  });
  it('restores the shared active user from the authenticated POS session', async () => {
    const user = {
      id: 7,
      name: 'Cashier',
      role: 'cashier',
      permissions: ['orders.view'],
    };

    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key) => key === 'pos_user' ? JSON.stringify(user) : null),
      removeItem: vi.fn(),
    });

    const { useAuth } = await import('@/pos/useAuth.js');
    const { usePermissions } = await import('@/pos/usePermissions.js');
    const auth = useAuth();

    expect(auth.activeUser.value).toEqual(user);
    expect(usePermissions().can('orders.view')).toBe(true);
  });

  it('owns active-shift hydration and always releases the checking state', async () => {
    const shift = { id: 41, status: 'open' };
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ success: true, data: shift }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    });

    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();
    const result = await auth.checkActiveShift(7);

    expect(fetchMock.mock.calls[0][0]).toBe('api/auth/shifts?action=check&user_id=7');
    expect(result).toEqual(shift);
    expect(auth.activeShift.value).toEqual(shift);
    expect(auth.isShiftChecking.value).toBe(false);
  });

  it('hydrates the previous drawer close as reference without changing entered starting cash', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        success: true,
        shift: null,
        previous_shift_closing_cash: 72.5,
        suggested_starting_cash: null,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    });

    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();
    auth.startingCashInput.value = 18;
    auth.markStartingCashEdited();

    const result = await auth.checkActiveShift(7);

    expect(result).toBeNull();
    expect(auth.previousShiftClosingCash.value).toBe(72.5);
    expect(auth.startingCashInput.value).toBe(18);
  });

  it('prefills an untouched first-shift form from the server suggestion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        success: true,
        shift: null,
        previous_shift_closing_cash: null,
        suggested_starting_cash: 100,
      }),
    }));
    vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null), removeItem: vi.fn() });

    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();
    await auth.checkActiveShift(7);

    expect(auth.startingCashInput.value).toBe(100);
  });

  it('clears a stale suggestion while preserving cashier-edited cash', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ success: true, shift: null, previous_shift_closing_cash: null, suggested_starting_cash: 100 }),
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ success: true, shift: null, previous_shift_closing_cash: 80, suggested_starting_cash: null }),
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ success: true, shift: null, previous_shift_closing_cash: null, suggested_starting_cash: 120 }),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null), removeItem: vi.fn() });

    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();

    await auth.checkActiveShift(7);
    expect(auth.startingCashInput.value).toBe(100);
    await auth.checkActiveShift(7);
    expect(auth.startingCashInput.value).toBe(0);

    auth.startingCashInput.value = 75;
    auth.markStartingCashEdited();
    await auth.checkActiveShift(7);
    expect(auth.startingCashInput.value).toBe(75);
  });

  it('clears a prior drawer reference when a later shift check is unsuccessful', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          success: true,
          shift: null,
          previous_shift_closing_cash: 72.5,
        }),
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ success: false }),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    });

    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();

    await auth.checkActiveShift(7);
    expect(auth.previousShiftClosingCash.value).toBe(72.5);

    await auth.checkActiveShift(7);
    expect(auth.previousShiftClosingCash.value).toBeNull();
  });

  it('ignores a slower shift-check response after a newer snapshot has completed', async () => {
    let resolveFirst;
    let resolveSecond;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const second = new Promise((resolve) => { resolveSecond = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    });

    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();
    const olderCheck = auth.checkActiveShift(7);
    const newerCheck = auth.checkActiveShift(7);

    resolveSecond({
      json: vi.fn().mockResolvedValue({
        success: true,
        shift: null,
        previous_shift_closing_cash: null,
        suggested_starting_cash: null,
      }),
    });
    await newerCheck;
    resolveFirst({
      json: vi.fn().mockResolvedValue({
        success: true,
        shift: null,
        previous_shift_closing_cash: 72.5,
        suggested_starting_cash: 100,
      }),
    });
    await olderCheck;

    expect(auth.previousShiftClosingCash.value).toBeNull();
    expect(auth.startingCashInput.value).toBe(0);
  });
});

describe('useAuth held-order cleanup', () => {
  it('releases a restored held order before invalidating the session on logout', async () => {
    const memoryStorage = () => {
      const data = new Map();
      return {
        getItem: key => data.has(key) ? data.get(key) : null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
        key: index => [...data.keys()][index] ?? null,
        get length() { return data.size; },
      };
    };
    const local = memoryStorage();
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('window', { location: { href: '/pos' } });
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetch);
    const { writeOrderContext } = await import('@/pos/stores/orderSession/orderSessionPersistence.js');
    writeOrderContext(local, {
      version: 2,
      scope: { kind: 'held', id: 'H-12' },
      restoredHeldReference: 'H-12',
      heldOrder: { id: 12, version: 3, claimToken: 'a'.repeat(64) },
    });
    const { useAuth } = await import('@/pos/useAuth.js');
    await useAuth().logout();
    const urls = fetch.mock.calls.map(([url]) => url);
    expect(urls).toEqual(['api/pos/held_orders/12/release', 'api/auth/logout']);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ claim_token: 'a'.repeat(64), expected_version: 3 });
  });
});

describe('closeShiftAndPrint count guard', () => {
  const closePuts = (fetchMock) => fetchMock.mock.calls.filter(([url, opts]) => (
    String(url).includes('action=close') && opts?.method === 'PUT'
  ));

  async function setupClose({ starting_cash, expected_cash, actual, confirm = true }) {
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ success: false, message: 'invalid' }),
    });
    const showPosConfirm = vi.fn().mockResolvedValue(confirm);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    });
    vi.stubGlobal('window', {
      showPosConfirm,
      showPosAlert: vi.fn().mockResolvedValue(undefined),
    });

    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();
    auth.zReportData.value = { shift_id: 9, starting_cash, expected_cash };
    auth.actualCashInput.value = actual;
    await auth.closeShiftAndPrint();
    return { fetchMock, showPosConfirm };
  }

  it('asks for confirmation when the count equals sales-only', async () => {
    const { fetchMock, showPosConfirm } = await setupClose({
      starting_cash: 500,
      expected_cash: 900,
      actual: '400',
      confirm: false,
    });
    expect(showPosConfirm).toHaveBeenCalledOnce();
    expect(closePuts(fetchMock)).toHaveLength(0);
  });

  it('does not ask when the drawer is legitimately below the opening cash', async () => {
    const { fetchMock, showPosConfirm } = await setupClose({
      starting_cash: 100,
      expected_cash: 50,
      actual: '50',
    });
    expect(showPosConfirm).not.toHaveBeenCalled();
    expect(closePuts(fetchMock)).toHaveLength(1);
  });

  it('does not ask when starting cash is zero', async () => {
    const { fetchMock, showPosConfirm } = await setupClose({
      starting_cash: 0,
      expected_cash: 400,
      actual: '400',
    });
    expect(showPosConfirm).not.toHaveBeenCalled();
    expect(closePuts(fetchMock)).toHaveLength(1);
  });

  it('does not misdiagnose blank or negative input as sales-only', async () => {
    // Values chosen so the fingerprint WOULD match if the input were coerced:
    // blank -> 0 === 500 - 500 (no sales), '-5' -> -500 cents === 49500 - 50000.
    const blank = await setupClose({
      starting_cash: 500,
      expected_cash: 500,
      actual: '',
    });
    expect(blank.showPosConfirm).not.toHaveBeenCalled();
    expect(closePuts(blank.fetchMock)).toHaveLength(1);

    const negative = await setupClose({
      starting_cash: 500,
      expected_cash: 495,
      actual: '-5',
    });
    expect(negative.showPosConfirm).not.toHaveBeenCalled();
    expect(closePuts(negative.fetchMock)).toHaveLength(1);
  });

  it('matches decimal amounts exactly', async () => {
    // Note: Math.round(x*100) absorbs float subtraction error for any realistic
    // amount (verified over 1.1M pairs), so this cannot distinguish
    // cents(e) - cents(s) from cents(e - s); it only guards decimal handling.
    const { showPosConfirm } = await setupClose({
      starting_cash: 100.10,
      expected_cash: 250.30,
      actual: '150.20',
      confirm: false,
    });
    expect(showPosConfirm).toHaveBeenCalledOnce();
  });
});

describe('shift check recovery', () => {
  const ok = (body) => ({ json: vi.fn().mockResolvedValue(body) });
  async function load(fetchMock, win = {}) {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null), removeItem: vi.fn() });
    const drafts = new Map(POS_ORDER_SESSION_KEYS.map(key => [key, 'draft']));
    drafts.set('pos_cart', '[{"id":1,"qty":2}]');
    drafts.set('pos_order_note', 'window seat');
    vi.stubGlobal('localStorage', {
      getItem: key => drafts.get(key) ?? null,
      setItem: (key, value) => drafts.set(key, String(value)),
      removeItem: key => drafts.delete(key),
    });
    // Records which order-session drafts were still stored at the moment the page left.
    let href = '/pos';
    let draftsAtDeparture;
    const location = {
      reload: vi.fn(),
      get href() { return href; },
      set href(next) { href = next; draftsAtDeparture = POS_ORDER_SESSION_KEYS.filter(key => drafts.has(key)); },
      get draftsAtDeparture() { return draftsAtDeparture; },
    };
    vi.stubGlobal('window', { location, showPosAlert: vi.fn().mockResolvedValue(undefined), ...win });
    const { useAuth } = await import('@/pos/useAuth.js');
    const auth = useAuth();
    auth.activeUser.value = { id: 7, role: 'cashier', permissions: [] };
    return { auth, location, drafts };
  }

  it('marks a failed check as failed, not as "no shift", and retries only after a failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(ok({ success: true, data: { id: 41 } }));
    const { auth } = await load(fetchMock);
    await auth.checkActiveShift();
    expect(auth.shiftCheckFailed.value).toBe(true);
    await auth.retryFailedShiftCheck();
    expect(auth.shiftCheckFailed.value).toBe(false);
    expect(auth.activeShift.value).toEqual({ id: 41 });
    await auth.retryFailedShiftCheck();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an unsuccessful response as a failed check', async () => {
    const { auth } = await load(vi.fn().mockResolvedValue(ok({ success: false })));
    await auth.checkActiveShift();
    expect(auth.shiftCheckFailed.value).toBe(true);
  });

  it('bounds the shift check with a deadline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ success: true, data: null }));
    const { auth } = await load(fetchMock);
    await auth.checkActiveShift();
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('opens a shift in place without reloading the page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ success: true }))
      .mockResolvedValueOnce(ok({ success: true, data: { id: 50 } }));
    const { auth, location } = await load(fetchMock);
    await auth.openMyShift();
    expect(location.reload).not.toHaveBeenCalled();
    expect(auth.activeShift.value).toEqual({ id: 50 });
    expect(auth.isOpeningShift.value).toBe(false);
  });

  it('re-checks instead of only alerting when the server says a shift is already open', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ success: false, message: 'User already has an open shift.' }))
      .mockResolvedValueOnce(ok({ success: true, data: { id: 41 } }));
    const { auth } = await load(fetchMock);
    await auth.openMyShift();
    expect(auth.activeShift.value).toEqual({ id: 41 });
    expect(window.showPosAlert).not.toHaveBeenCalled();
  });

  it('goes straight to login after a successful close, clearing the order drafts, with no timer or reload', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(ok({ success: true }));
    const { auth, location, drafts } = await load(fetchMock);
    auth.activeShift.value = { id: 9 };
    auth.zReportData.value = { shift_id: 9, starting_cash: 0, expected_cash: 0 };
    await auth.closeShiftAndPrint();
    expect(location.href).toBe('/login');
    expect(location.reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(POS_ORDER_SESSION_KEYS.length).toBeGreaterThan(2);
    expect(location.draftsAtDeparture).toEqual([]);
  });

  it('asks the server to queue the spooler Z report with the close and sends no print request after it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ success: true, z_report_print_queued: false }));
    const { location } = await load(fetchMock);
    const { useAuth } = await import('@/pos/useAuth.js');
    const dispatchToNodeSpooler = vi.fn();
    useAuth({ dispatchToNodeSpooler, getPrintMethod: () => 'backend', getReceiptPrinterId: () => '5' });
    // The shift report dialog calls useAuth() without arguments; it must reuse the terminal callbacks.
    const admin = useAuth();
    admin.activeUser.value = { id: 1, role: 'admin', permissions: [] };
    admin.activeShift.value = { id: 9 };
    admin.zReportData.value = { shift_id: 9, starting_cash: 0, expected_cash: 0 };
    await admin.closeShiftAndPrint();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ shift_id: 9, print_z_report: true, receipt_printer_id: '5' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dispatchToNodeSpooler).not.toHaveBeenCalled();
    expect(window.showPosAlert).toHaveBeenCalledWith('Shift closed, but the Z report could not be sent to the printer. Print it from the shift reports.');
    expect(location.href).toBe('/login');
  });

  it('finishes the close when its answer was lost but the server revoked the session', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('Request timed out.', 'TimeoutError'))
      .mockResolvedValueOnce({ status: 401, ok: false, json: vi.fn().mockResolvedValue({ success: false, code: 'SESSION_INVALID' }) });
    const { auth, location } = await load(fetchMock);
    auth.activeShift.value = { id: 9 };
    auth.zReportData.value = { shift_id: 9, starting_cash: 0, expected_cash: 0 };
    await auth.closeShiftAndPrint();
    expect(fetchMock.mock.calls[1][0]).toContain('action=check');
    expect(location.href).toBe('/login');
    expect(POS_ORDER_SESSION_KEYS.length).toBeGreaterThan(2);
    expect(location.draftsAtDeparture).toEqual([]);
    expect(window.showPosAlert).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed close and keeps the order drafts when the same shift is still open', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ status: 200, ok: true, json: vi.fn().mockResolvedValue({ success: true, data: { id: 9 } }) });
    const { auth, location, drafts } = await load(fetchMock);
    auth.activeShift.value = { id: 9 };
    auth.zReportData.value = { shift_id: 9, starting_cash: 0, expected_cash: 0 };
    await auth.closeShiftAndPrint();
    expect(location.href).toBe('/pos');
    expect(window.showPosAlert).toHaveBeenCalledWith('The shift close was not confirmed. Check the connection and try again.');
    expect(auth.isClosingShift.value).toBe(false);
    expect(drafts.get('pos_cart')).toBe('[{"id":1,"qty":2}]');
    expect(drafts.get('pos_order_note')).toBe('window seat');
  });

  it('keeps the order drafts when the server refuses the close', async () => {
    const { auth, location, drafts } = await load(
      vi.fn().mockResolvedValue(ok({ success: false, message: 'Count the drawer first.' }))
    );
    auth.activeShift.value = { id: 9 };
    auth.zReportData.value = { shift_id: 9, starting_cash: 0, expected_cash: 0 };
    await auth.closeShiftAndPrint();
    expect(location.href).toBe('/pos');
    expect(drafts.get('pos_cart')).toBe('[{"id":1,"qty":2}]');
    expect(drafts.get('pos_order_note')).toBe('window seat');
  });
});

describe('logout on a stalled connection', () => {
  it('leaves for /login within a bound while the logout request is still sent with keepalive', async () => {
    vi.useFakeTimers();
    const store = () => ({ getItem: () => null, setItem: vi.fn(), removeItem: vi.fn(), key: () => null, length: 0 });
    vi.stubGlobal('sessionStorage', store());
    vi.stubGlobal('localStorage', store());
    const location = { href: '/pos' };
    vi.stubGlobal('window', { location });
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const { useAuth } = await import('@/pos/useAuth.js');
    void useAuth().logout();
    await vi.advanceTimersByTimeAsync(5000);
    expect(location.href).toBe('/login');
    const logoutCall = fetch.mock.calls.find(([url]) => url === 'api/auth/logout');
    expect(logoutCall[1]).toMatchObject({ method: 'POST', keepalive: true });
  });
});
