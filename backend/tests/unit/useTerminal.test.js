import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map();
global.localStorage = {
  getItem: vi.fn(key => storage.get(key) ?? null),
  setItem: vi.fn((key, value) => storage.set(key, String(value))),
  removeItem: vi.fn(key => storage.delete(key)),
  clear: vi.fn(() => storage.clear())
};
global.window = {
  print: vi.fn(),
  showPosToast: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
};
global.document = {
  createElement: vi.fn(() => ({})),
  createElementNS: vi.fn(() => ({})),
  body: { classList: { add: vi.fn(), remove: vi.fn() } }
};

vi.mock('@/shared/i18n.js', () => ({ setLanguage: vi.fn(), t: key => key }));

let useTerminal;

beforeEach(async () => {
  vi.resetModules();
  ({ useTerminal } = await import('@/pos/useTerminal.js'));
  storage.clear();
  vi.clearAllMocks();
  global.fetch = vi.fn();
  const terminal = useTerminal();
  terminal.lastOrder.value = null;
  terminal.printMethod.value = 'browser';
  terminal.isPrintingBackend.value = false;
  terminal.quickNumpadMode.value = false;
});
afterEach(() => vi.useRealTimers());

const settingsReply = data => ({ ok: true, json: async () => ({ success: true, ...data }) });

describe('useTerminal print outcomes', () => {
  it('returns false and clears backend busy state when the spooler rejects', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(settingsReply({ print_method: 'backend' })).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: false, message: 'offline' })
    });
    const terminal = useTerminal();
    terminal.printMethod.value = 'backend';
    terminal.lastOrder.value = { total: 5 };

    await expect(terminal.printReceipt()).resolves.toBe(false);

    expect(terminal.isPrintingBackend.value).toBe(false);
  });

  it('returns true after browser print invocation', async () => {
    vi.useFakeTimers();
    global.fetch.mockResolvedValue(settingsReply({ print_method: 'browser' }));
    const terminal = useTerminal();
    terminal.printMethod.value = 'browser';
    terminal.lastOrder.value = { total: 5 };

    const printed = terminal.printReceipt();
    await vi.runAllTimersAsync();

    await expect(printed).resolves.toBe(true);
    expect(window.print).toHaveBeenCalledOnce();
  });
});

describe('useTerminal barcode outcomes', () => {
  it('clears one-shot keypad intent before every barcode outcome', async () => {
    const terminal = useTerminal();
    const beforeAttempt = vi.fn();
    const addToCart = vi.fn();

    await terminal.processBarcode('unknown', [], addToCart, beforeAttempt);
    await terminal.processBarcode(
      '1234',
      [{ id: 91, barcode: '1234', name: 'Extra sauce', category_is_notes: 1 }],
      addToCart,
      beforeAttempt
    );

    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(addToCart).not.toHaveBeenCalled();
  });

  it('does not claim a sold-out product was added', async () => {
    const terminal = useTerminal();
    const addToCart = vi.fn().mockResolvedValue(false);

    await terminal.processBarcode('1234', [{ id: 1, barcode: '1234', name: 'Burger', can_sell: 0 }], addToCart);

    expect(addToCart).toHaveBeenCalledOnce();
    expect(terminal.scanMessage.value).toBe('Sold out: Burger');
  });

  it('keeps an exact local barcode on the ordinary quantity-one path', async () => {
    const terminal = useTerminal();
    const product = { id: 1, barcode: '0100000040591', name: 'Ordinary exact item' };
    const addToCart = vi.fn().mockResolvedValue(true);

    await terminal.processBarcode(product.barcode, [product], addToCart);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(addToCart).toHaveBeenCalledWith(product, { source: 'barcode' });
  });

  it('forwards a validated scale total from server lookup', async () => {
    const terminal = useTerminal();
    const product = { id: 7, barcode: '100000', name: 'Scale beef', price: 11 };
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, product, scale_total_cents: 4059 })
    });
    const addToCart = vi.fn().mockResolvedValue(true);

    await terminal.processBarcode('0100000040591', [], addToCart);

    expect(addToCart).toHaveBeenCalledWith(product, { source: 'barcode', targetAmount: 40.59 });
  });

  it.each(['network', 'server'])('does not misreport a %s lookup failure as an unknown barcode', async (failure) => {
    const terminal = useTerminal();
    global.fetch = failure === 'network'
      ? vi.fn().mockRejectedValue(new Error('offline'))
      : vi.fn().mockResolvedValue({ json: async () => ({success:false}) });
    const addToCart = vi.fn();
    await terminal.processBarcode('0100000040591', [], addToCart);
    expect(addToCart).not.toHaveBeenCalled();
    expect(terminal.scanMessage.value).toBe('Barcode lookup failed. Please try again.');
  });

  it.each([-1, 0, 4059.5, 100000, '4059'])('rejects malformed scale metadata %s without adding', async (scaleTotalCents) => {
    const terminal = useTerminal();
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        product: { id: 7, barcode: '100000', name: 'Scale beef', price: 11 },
        scale_total_cents: scaleTotalCents
      })
    });
    const addToCart = vi.fn();

    await terminal.processBarcode('0100000040591', [], addToCart);

    expect(addToCart).not.toHaveBeenCalled();
    expect(terminal.scanMessage.value).toBe('Unknown Code: 0100000040591');
  });

  it('refuses a scanned note product before it can enter the cart', async () => {
    const terminal = useTerminal();
    const addToCart = vi.fn();

    await terminal.processBarcode('1234', [{ id: 91, barcode: '1234', name: 'Extra sauce', category_is_notes: 1 }], addToCart);

    expect(addToCart).not.toHaveBeenCalled();
    expect(terminal.scanMessage.value).toBe('Note products must be added to an item.');
  });

  it('uses the live table context for barcode lookup', async () => {
    const salesContext = { value: 'table' };
    const terminal = useTerminal({ salesContext });
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, product: { id: 1, name: 'Water' } })
    });
    const addToCart = vi.fn().mockResolvedValue(true);

    await terminal.processBarcode('9988', [], addToCart);

    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('sales_context=table'), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(addToCart).toHaveBeenCalledOnce();
  });

  it('drops a barcode result when the sales context changes during lookup', async () => {
    const salesContext = { value: 'register' };
    const terminal = useTerminal({ salesContext });
    let resolveLookup;
    global.fetch = vi.fn().mockReturnValue(new Promise(resolve => { resolveLookup = resolve; }));
    const addToCart = vi.fn();

    const pending = terminal.processBarcode('9988', [], addToCart);
    salesContext.value = 'table';
    resolveLookup({ json: () => Promise.resolve({ success: true, product: { id: 1, name: 'Water' } }) });
    await pending;

    expect(addToCart).not.toHaveBeenCalled();
  });
});

it('loads the authoritative tax-registration profile', async () => {
  global.fetch = vi.fn().mockResolvedValue(settingsReply({ tax_registration_type: 'income_tax' }));
  const terminal = useTerminal();
  await terminal.loadSettings();
  expect(terminal.taxRegistrationType.value).toBe('income_tax');
});

describe('useTerminal numpad settings', () => {
  it('loads and retains persistent numpad settings after a failure', async () => {
    global.fetch = vi.fn().mockResolvedValue(settingsReply({ quick_numpad_mode: '1', quantity_presets_enabled: '0' }));
    const terminal = useTerminal();

    await expect(terminal.loadSettings()).resolves.toBe(true);
    expect(terminal.quickNumpadMode.value).toBe(true);
    expect(terminal.quantityPresetsEnabled.value).toBe(false);

    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(terminal.loadSettings()).resolves.toBe(false);
    expect(terminal.quickNumpadMode.value).toBe(true);
    expect(terminal.quantityPresetsEnabled.value).toBe(false);
  });

  it.each([
    ['0', '1', true],
    ['1', '0', false]
  ])('refreshes old %s to new %s when settings change during a read', async (oldMode, newMode, expected) => {
    const terminal = useTerminal();
    const old=Promise.withResolvers(), newer=Promise.withResolvers(), followup=Promise.withResolvers();
    global.fetch = vi.fn()
      .mockReturnValueOnce(old.promise)
      .mockImplementationOnce(() => {followup.resolve();return newer.promise;});

    const oldRequest = terminal.loadSettings();
    const newRequest = terminal.loadSettings({ force: true });
    expect(global.fetch).toHaveBeenCalledOnce();
    old.resolve(settingsReply({ quick_numpad_mode: oldMode, quantity_presets_enabled: oldMode }));
    await followup.promise;
    newer.resolve(settingsReply({ quick_numpad_mode: newMode, quantity_presets_enabled: newMode }));
    await expect(newRequest).resolves.toBe(true);
    await expect(oldRequest).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    expect(terminal.quickNumpadMode.value).toBe(expected);
    expect(terminal.quantityPresetsEnabled.value).toBe(expected);
  });

  it('retains the successful snapshot after a forced follow-up fails and then recovers', async () => {
    const terminal = useTerminal();
    const old=Promise.withResolvers(), newer=Promise.withResolvers(), followup=Promise.withResolvers();
    global.fetch = vi.fn()
      .mockReturnValueOnce(old.promise)
      .mockImplementationOnce(() => {followup.resolve();return newer.promise;});

    const oldRequest = terminal.loadSettings();
    const newRequest = terminal.loadSettings({ force: true });
    old.resolve(settingsReply({ quick_numpad_mode: '1', quantity_presets_enabled: '0' }));
    await followup.promise;
    newer.reject(new Error('offline'));
    await expect(newRequest).resolves.toBe(false);
    await expect(oldRequest).resolves.toBe(false);
    expect(terminal.quickNumpadMode.value).toBe(true);
    expect(terminal.quantityPresetsEnabled.value).toBe(false);

    global.fetch = vi.fn().mockResolvedValue(settingsReply({ quick_numpad_mode: '0', quantity_presets_enabled: '1' }));
    await expect(terminal.loadSettings()).resolves.toBe(true);
    expect(terminal.quickNumpadMode.value).toBe(false);
    expect(terminal.quantityPresetsEnabled.value).toBe(true);
  });
});
