import { describe, expect, it, vi } from 'vitest';
import {
  CHECKOUT_ATTEMPT_CACHE_KEY,
  resolveCheckoutAttemptKey
} from '@/pos/stores/checkoutAttemptCache.js';

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
};

describe('checkoutAttemptCache', () => {
  it('reuses only the same versioned checkout identity', () => {
    const storage = memoryStorage();
    const makeKey = vi.fn()
      .mockReturnValueOnce('attempt-1')
      .mockReturnValueOnce('attempt-2');
    const source = { actorId: 1, shiftId: 9, cart: [{ id: 2, qty: 1 }] };

    const first = resolveCheckoutAttemptKey({ storage, now: 100, fingerprintSource: source, makeKey });
    const retry = resolveCheckoutAttemptKey({ storage, now: 101, fingerprintSource: source, makeKey });
    const nextActor = resolveCheckoutAttemptKey({
      storage,
      now: 102,
      fingerprintSource: { ...source, actorId: 2 },
      makeKey
    });

    expect(retry).toBe(first);
    expect(nextActor).toBe('attempt-2');
    expect(makeKey).toHaveBeenCalledTimes(2);
  });

  it('drops a cache record from an older fingerprint version', () => {
    const storage = memoryStorage();
    storage.setItem(CHECKOUT_ATTEMPT_CACHE_KEY, JSON.stringify({
      version: 1,
      key: 'legacy-key',
      fingerprint: 'v1:abc',
      savedAt: 100
    }));

    const key = resolveCheckoutAttemptKey({
      storage,
      now: 101,
      fingerprintSource: { actorId: 1 },
      makeKey: () => 'fresh-key'
    });

    expect(key).toBe('fresh-key');
  });

  it('stores a hash, never raw cart or customer fields', () => {
    const storage = memoryStorage();
    resolveCheckoutAttemptKey({
      storage,
      now: 100,
      fingerprintSource: {
        actorId: 1,
        cart: [{ name: 'Secret Tea' }],
        customerPhone: '0790000000'
      },
      makeKey: () => 'attempt-1'
    });

    const raw = storage.getItem(CHECKOUT_ATTEMPT_CACHE_KEY);
    expect(raw).toContain('"fingerprint":"v2:');
    expect(raw).not.toContain('Secret Tea');
    expect(raw).not.toContain('0790000000');
  });

  it('still creates a current-tab key when browser storage is unavailable', () => {
    const storage = {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
      removeItem: () => { throw new Error('storage blocked'); }
    };

    expect(resolveCheckoutAttemptKey({
      storage,
      fingerprintSource: { actorId: 1, cart: [] },
      makeKey: () => 'current-tab-key'
    })).toBe('current-tab-key');
  });
});
