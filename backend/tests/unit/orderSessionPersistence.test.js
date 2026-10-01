import { describe, expect, it, vi } from 'vitest';

const loadPersistence = () => import('@/pos/stores/orderSession/orderSessionPersistence.js');

const memoryStorage = (values = {}) => ({
  getItem: vi.fn((key) => values[key] ?? null),
  setItem: vi.fn((key, value) => { values[key] = String(value); }),
  removeItem: vi.fn((key) => { delete values[key]; }),
});

describe('orderSessionPersistence', () => {
  it('round-trips a started empty call-center draft for only the same worker', async () => {
    const { readCallCenterOrderSnapshot, writeOrderContext } = await loadPersistence();
    const storage = memoryStorage();

    writeOrderContext(storage, {
      version: 2,
      scope: { kind: 'register', id: null },
      customerPhone: '0790000000',
      customerName: 'Maya',
      customerAddress: 'Amman',
      callCenter: { started: true, userId: 31, mode: 'new' },
    });

    expect(readCallCenterOrderSnapshot(31, storage)).toEqual(expect.objectContaining({
      cart: [],
      context: expect.objectContaining({
        callCenter: { started: true, userId: 31, mode: 'new' },
      }),
    }));
  });

  it('clears a call-center draft when it belongs to another worker', async () => {
    const { readCallCenterOrderSnapshot, writeOrderContext, POS_ORDER_KEYS } = await loadPersistence();
    const storage = memoryStorage();

    writeOrderContext(storage, {
      version: 2,
      scope: { kind: 'register', id: null },
      callCenter: { started: true, userId: 31, mode: 'new' },
    });

    expect(readCallCenterOrderSnapshot(32, storage)).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(POS_ORDER_KEYS.context);
    expect(storage.removeItem).toHaveBeenCalledWith(POS_ORDER_KEYS.cart);
  });

  it('reads persisted order fields and drops malformed JSON safely', async () => {
    const { readOrderSnapshot } = await loadPersistence();
    const storage = memoryStorage({ pos_cart: '{bad', pos_order_note: '', pos_order_discount: '{bad', pos_tax_exempt: '"true"' });

    expect(readOrderSnapshot(storage)).toEqual({ cart: [], note: '', discount: null, serviceChargeSnapshot: null, taxExempt: false, context: null });
    expect(storage.removeItem).toHaveBeenCalledWith('pos_cart');
    expect(storage.removeItem).toHaveBeenCalledWith('pos_order_discount');
  });

  it('persists only literal true and removes the exemption key for false', async () => {
    const { writeTaxExempt, readOrderSnapshot, POS_ORDER_KEYS } = await loadPersistence();
    const storage = memoryStorage();

    writeTaxExempt(storage, true);
    expect(storage.getItem(POS_ORDER_KEYS.taxExempt)).toBe('true');
    expect(readOrderSnapshot(storage).taxExempt).toBe(true);

    writeTaxExempt(storage, false);
    expect(storage.getItem(POS_ORDER_KEYS.taxExempt)).toBeNull();
    expect(readOrderSnapshot(storage).taxExempt).toBe(false);
  });

  it('discards retired subscription drafts instead of treating them as ordinary orders', async () => {
    const { readOrderSnapshot, writeOrderContext, POS_ORDER_KEYS } = await loadPersistence();
    const storage = memoryStorage();
    writeOrderContext(storage, {
      version: 2,
      scope: { kind: 'subscription', id: 12 },
      subscriptionPurchase: { plan_id: 12 }
    });
    expect(storage.getItem(POS_ORDER_KEYS.context)).toBeNull();
    expect(readOrderSnapshot(storage).context).toBeNull();
  });
  it.each([
    {
      scope: { kind: 'register', id: 'ignored' },
      restoredHeldReference: '',
      expectedScope: { kind: 'register', id: null },
    },
    {
      scope: { kind: 'held', id: 'REF-7' },
      restoredHeldReference: 'REF-7',
      expectedScope: { kind: 'held', id: 'REF-7' },
    },
  ])('retains $scope.kind scope behavior under version two', async ({ scope, restoredHeldReference, expectedScope }) => {
    const { readOrderSnapshot, writeOrderContext } = await loadPersistence();
    const storage = memoryStorage();

    writeOrderContext(storage, {
      version: 2,
      scope,
      restoredHeldReference,
      subscriptionPurchase: null,
    });

    expect(readOrderSnapshot(storage).context.scope).toEqual(expectedScope);
  });

  it('normalizes a version-two table scope to complete string identity', async () => {
    const { readOrderSnapshot, writeOrderContext, POS_ORDER_KEYS } = await loadPersistence();
    const storage = memoryStorage();

    writeOrderContext(storage, {
      version: 2,
      scope: { kind: 'table', id: 7, orderId: 707, splitCheckId: 77, tableNumber: ' A7 ' },
      selectedOrderType: 4,
      restoredHeldReference: '',
      subscriptionPurchase: null,
    });

    expect(JSON.parse(storage.getItem(POS_ORDER_KEYS.context)).scope).toEqual({
      kind: 'table',
      id: '7',
      orderId: '707',
      splitCheckId: '77',
      tableNumber: 'A7',
    });
    expect(readOrderSnapshot(storage).context.scope).toEqual({
      kind: 'table',
      id: '7',
      orderId: '707',
      splitCheckId: '77',
      tableNumber: 'A7',
    });
  });

  it('accepts a dynamic unsaved table identified only by its table number', async () => {
    const { readOrderSnapshot, writeOrderContext } = await loadPersistence();
    const storage = memoryStorage();

    writeOrderContext(storage, {
      version: 2,
      scope: { kind: 'table', id: null, orderId: null, splitCheckId: null, tableNumber: ' 41 ' },
      restoredHeldReference: '',
      subscriptionPurchase: null,
    });

    expect(readOrderSnapshot(storage).context.scope).toEqual({
      kind: 'table', id: null, orderId: null, splitCheckId: null, tableNumber: '41'
    });
  });

  it.each([
    { id: null, orderId: null, splitCheckId: null, tableNumber: '' },
    { id: 'bad', orderId: null, splitCheckId: null, tableNumber: '7' },
    { id: 7, orderId: 'bad', splitCheckId: null, tableNumber: '7' },
    { id: 7, orderId: null, splitCheckId: 'bad', tableNumber: '7' },
  ])('rejects an invalid table identity %#', async (scope) => {
    const { readOrderSnapshot, writeOrderContext, POS_ORDER_KEYS } = await loadPersistence();
    const storage = memoryStorage();

    writeOrderContext(storage, {
      version: 2,
      scope: { kind: 'table', ...scope },
      restoredHeldReference: '',
      subscriptionPurchase: null,
    });

    expect(storage.getItem(POS_ORDER_KEYS.context)).toBeNull();
    expect(readOrderSnapshot(storage).context).toBeNull();
  });

  it('rejects and removes an ambiguous version-one context', async () => {
    const { readOrderSnapshot, POS_ORDER_KEYS } = await loadPersistence();
    const storage = memoryStorage({
      [POS_ORDER_KEYS.context]: JSON.stringify({
        version: 1,
        scope: { kind: 'table', id: '7' },
        restoredHeldReference: '',
        subscriptionPurchase: null,
      })
    });

    expect(readOrderSnapshot(storage).context).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(POS_ORDER_KEYS.context);
  });

  it('matches only a complete table-order identity', async () => {
    const { matchesTableOrderContext } = await loadPersistence();
    const context = {
      version: 2,
      scope: { kind: 'table', id: '7', orderId: '707', splitCheckId: null, tableNumber: 'A7' }
    };

    expect(matchesTableOrderContext(context, {
      id: 7, current_order_id: 707, split_check_id: null, table_number: 'A7'
    })).toBe(true);
    expect(matchesTableOrderContext(context, {
      id: 7, current_order_id: 808, split_check_id: null, table_number: 'A7'
    })).toBe(false);
  });

  it('does not collide split checks on the same parent table', async () => {
    const { matchesTableOrderContext } = await loadPersistence();
    const context = {
      version: 2,
      scope: { kind: 'table', id: '7', orderId: null, splitCheckId: '77', tableNumber: 'A7' }
    };

    expect(matchesTableOrderContext(context, {
      id: 7, current_order_id: null, split_check_id: 77, table_number: 'A7'
    })).toBe(true);
    expect(matchesTableOrderContext(context, {
      id: 7, current_order_id: null, split_check_id: 78, table_number: 'A7'
    })).toBe(false);
  });

  it('matches unsaved dynamic tables by normalized number only', async () => {
    const { matchesTableOrderContext } = await loadPersistence();
    const context = {
      version: 2,
      scope: { kind: 'table', id: null, orderId: null, splitCheckId: null, tableNumber: '41' }
    };

    expect(matchesTableOrderContext(context, {
      id: null, current_order_id: null, split_check_id: null, table_number: 41
    })).toBe(true);
    expect(matchesTableOrderContext(context, {
      id: null, current_order_id: null, split_check_id: null, table_number: 42
    })).toBe(false);
    expect(matchesTableOrderContext({ scope: { kind: 'register', id: null } }, {
      id: null, table_number: 41
    })).toBe(false);
  });

  it('drops invalid context and non-array carts instead of exposing stale order data', async () => {
    const { readOrderSnapshot, POS_ORDER_KEYS } = await loadPersistence();
    const storage = memoryStorage({
      [POS_ORDER_KEYS.cart]: JSON.stringify({ id: 1 }),
      [POS_ORDER_KEYS.context]: JSON.stringify({
        version: 99,
        scope: { kind: 'unknown', id: 'x' },
        subscriptionPurchase: { plan_id: 0 }
      })
    });

    expect(readOrderSnapshot(storage)).toEqual({
      cart: [], note: '', discount: null, serviceChargeSnapshot: null, taxExempt: false, context: null
    });
    expect(storage.removeItem).toHaveBeenCalledWith(POS_ORDER_KEYS.context);
  });

  it('rejects a held context whose scope does not match its held reference', async () => {
    const { readOrderSnapshot, POS_ORDER_KEYS } = await loadPersistence();
    const storage = memoryStorage({
      [POS_ORDER_KEYS.context]: JSON.stringify({
        version: 2,
        scope: { kind: 'held', id: 'REF-1' },
        restoredHeldReference: 'REF-2',
        subscriptionPurchase: null
      })
    });

    expect(readOrderSnapshot(storage).context).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(POS_ORDER_KEYS.context);
  });

  it('consumes a handoff exactly once and detects pending table state', async () => {
    const { consumeStoredJson, hasPendingTableSession } = await loadPersistence();
    const storage = memoryStorage({ pos_restore_held_order: '{"items":[]}', pos_table_prefill: '{"id":1}' });

    expect(consumeStoredJson(storage, 'pos_restore_held_order')).toEqual({ items: [] });
    expect(consumeStoredJson(storage, 'pos_restore_held_order')).toBeNull();
    expect(hasPendingTableSession(storage, null)).toBe(true);
  });

  it('clears all order/session residue but retains terminal reference cache', async () => {
    const { clearPosOrderSession, POS_ORDER_SESSION_KEYS } = await loadPersistence();
    const storage = memoryStorage({ pos_backup_order_types: 'keep' });

    clearPosOrderSession(storage);

    expect(storage.removeItem.mock.calls.map(([key]) => key)).toEqual(POS_ORDER_SESSION_KEYS);
    expect(storage.removeItem).toHaveBeenCalledWith('pos_service_charge_snapshot');
    expect(storage.removeItem).toHaveBeenCalledWith('pos_tax_exempt');
    expect(storage.removeItem).toHaveBeenCalledWith('pos_order_context');
    expect(storage.removeItem).toHaveBeenCalledWith('pos_checkout_attempt');
    expect(storage.removeItem).not.toHaveBeenCalledWith('pos_backup_order_types');
  });

  it('treats unavailable browser storage as empty best-effort persistence', async () => {
    const persistence = await loadPersistence();
    const storage = {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
      removeItem: () => { throw new Error('storage blocked'); },
    };

    expect(persistence.readOrderSnapshot(storage)).toEqual({
      cart: [],
      note: '',
      discount: null,
      serviceChargeSnapshot: null,
      taxExempt: false,
      context: null,
    });
    expect(persistence.readActiveTable(storage)).toBeNull();
    expect(persistence.consumeStoredJson(storage, 'pos_restore_held_order')).toBeNull();
    expect(persistence.hasPendingTableSession(storage)).toBe(false);
    expect(() => persistence.writeCart(storage, [])).not.toThrow();
    expect(() => persistence.writeOrderNote(storage, '')).not.toThrow();
    expect(() => persistence.writeOrderDiscount(storage, null)).not.toThrow();
    expect(() => persistence.writeServiceChargeSnapshot(storage, null)).not.toThrow();
    expect(() => persistence.writeActiveTable(storage, null)).not.toThrow();
    expect(() => persistence.clearOrderData(storage)).not.toThrow();
    expect(() => persistence.clearPosOrderSession(storage)).not.toThrow();
  });

  it('persists a server-held identity separately from its display reference', async () => {
    const { readOrderSnapshot, writeOrderContext } = await loadPersistence();
    const storage = memoryStorage();
    writeOrderContext(storage, {
      version: 2,
      scope: { kind: 'held', id: 'Phone order' },
      restoredHeldReference: 'Phone order',
      heldOrder: {
        id: 17,
        version: 4,
        claimToken: 'a'.repeat(64),
        claimExpiresAt: '2026-08-10T12:00:00.000Z',
        kitchenFired: true, baselineUnknown: true,
        kitchenDispatchVersion: 2,
      },
      holdRequestId: null,
      subscriptionPurchase: null,
    });
    expect(readOrderSnapshot(storage).context.heldOrder).toMatchObject({
      id: 17,
      version: 4,
      claimToken: 'a'.repeat(64),
      kitchenFired: true, baselineUnknown: true,
      kitchenDispatchVersion: 2,
    });
  });
});
