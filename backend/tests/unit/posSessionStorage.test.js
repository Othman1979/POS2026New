import { describe, expect, it, vi } from 'vitest';
import {
  clearHeldOrderHandoff,
  clearPosOrderSessionStorage,
  consumeHeldOrderHandoff,
  readHeldOrderHandoff,
  getHeldOperationId,
  clearHeldOperationId,
  hasActiveTableSession,
  hasPendingTableSession,
  isHeldKitchenFired,
  POS_ORDER_SESSION_KEYS,
  readActiveTableSession,
  setHeldKitchenFired,
  storeHeldOrderHandoff,
} from '@/pos/posSessionStorage.js';

const memoryStorage = (values = {}) => ({
  getItem: vi.fn((key) => values[key] ?? null),
  setItem: vi.fn((key, value) => { values[key] = String(value); }),
  removeItem: vi.fn((key) => { delete values[key]; }),
});

describe('posSessionStorage', () => {
  it('clears every POS order/session storage key, including kitchen-fired residue', () => {
    const removed = [];
    const storage = {
      removeItem: vi.fn((key) => removed.push(key)),
    };

    clearPosOrderSessionStorage(storage);

    expect(removed).toEqual(POS_ORDER_SESSION_KEYS);
    expect(storage.removeItem).toHaveBeenCalledWith('pos_held_kitchen_fired');
  });

  it('owns held-order handoff and kitchen-fired storage semantics', () => {
    const storage = memoryStorage();
    const heldOrder = { items: [{ id: 1, qty: 2 }] };

    storeHeldOrderHandoff(heldOrder, storage);
    setHeldKitchenFired(true, storage);

    expect(consumeHeldOrderHandoff(storage)).toEqual(heldOrder);
    expect(consumeHeldOrderHandoff(storage)).toBeNull();
    expect(isHeldKitchenFired(storage)).toBe(true);

    clearHeldOrderHandoff(storage);
    setHeldKitchenFired(false, storage);
    expect(isHeldKitchenFired(storage)).toBe(false);
  });

  it('keeps a recovery handoff until the caller explicitly clears it', () => {
    const storage = memoryStorage();
    const handoff = { heldOrderId: 17, expectedVersion: 3, claimToken: 'a'.repeat(64) };

    storeHeldOrderHandoff(handoff, storage);

    expect(readHeldOrderHandoff(storage)).toEqual(handoff);
    expect(readHeldOrderHandoff(storage)).toEqual(handoff);
    clearHeldOrderHandoff(storage);
    expect(readHeldOrderHandoff(storage)).toBeNull();
  });

  it('reuses one held-operation id after an uncertain response and clears it after confirmation', () => {
    const storage = memoryStorage();
    const first = getHeldOperationId('save', 17, storage);

    expect(getHeldOperationId('save', 17, storage)).toBe(first);
    expect(getHeldOperationId('follow-up', 17, storage)).not.toBe(first);
    clearHeldOperationId('follow-up', 17, storage);
    expect(getHeldOperationId('follow-up', 17, storage)).not.toBe(first);
  });

  it('keeps independent retries for simultaneous held-order operations', () => {
    const storage = memoryStorage();
    const fire = getHeldOperationId('fire', 17, storage);
    const cancel = getHeldOperationId('cancel', 22, storage);

    expect(getHeldOperationId('fire', 17, storage)).toBe(fire);
    expect(getHeldOperationId('cancel', 22, storage)).toBe(cancel);
    clearHeldOperationId('cancel', 22, storage);
    expect(getHeldOperationId('fire', 17, storage)).toBe(fire);
  });

  it('generates a UUID-shaped operation id when randomUUID is unavailable', () => {
    const storage = memoryStorage();
    vi.stubGlobal('crypto', {
      getRandomValues: vi.fn((bytes) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
        return bytes;
      }),
    });

    try {
      expect(getHeldOperationId('save', 17, storage)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('owns active and pending table-session reads', () => {
    const storage = memoryStorage({ pos_active_table: '{"id":7}' });

    expect(readActiveTableSession(storage)).toEqual({ id: 7 });
    expect(hasActiveTableSession(storage)).toBe(true);
    expect(hasPendingTableSession(storage)).toBe(true);
  });
});
