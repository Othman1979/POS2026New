import { describe, expect, it } from 'vitest';
import { createKeepAliveRefreshTracker } from './keepAliveRefreshTracker.js';

const CLEAN = { recovery: false, catalog: false, stock: false, catalogIds: [], settings: false, held: false, shift: false, tables: false };
const EVERYTHING = { recovery: true, catalog: true, stock: false, catalogIds: [], settings: true, held: true, shift: true, tables: true };

describe('keepAliveRefreshTracker', () => {
  it('returns all-false when nothing changed within the same generation', () => {
    const tracker = createKeepAliveRefreshTracker();
    tracker.deactivate(3);
    expect(tracker.activate(3)).toEqual(CLEAN);
  });

  it.each(['catalog', 'settings', 'held', 'shift', 'tables'])('marks only the signaled kind: %s', kind => {
    const tracker = createKeepAliveRefreshTracker();
    tracker.deactivate(1);
    tracker.markDirty(kind);
    expect(tracker.activate(1)).toEqual({ ...CLEAN, [kind]: true });
  });

  it('forces everything on a generation change while inactive', () => {
    const tracker = createKeepAliveRefreshTracker();
    tracker.deactivate(1);
    expect(tracker.activate(2)).toEqual(EVERYTHING);
  });

  it('treats the first activate without a prior deactivate as recovery', () => {
    expect(createKeepAliveRefreshTracker().activate(5)).toEqual(EVERYTHING);
  });

  it('resets flags after activate', () => {
    const tracker = createKeepAliveRefreshTracker();
    tracker.deactivate(1);
    tracker.markDirty('catalog');
    tracker.activate(1);
    tracker.deactivate(1);
    expect(tracker.activate(1)).toEqual(CLEAN);
  });

  describe('inventory_changed while inactive', () => {
    const afterEvents = (payloads, generation = 1) => {
      const tracker = createKeepAliveRefreshTracker();
      tracker.deactivate(1);
      for (const payload of payloads) tracker.markInventoryChanged(payload);
      return tracker.activate(generation);
    };

    it('ignores availability, which has its own targeted event', () => {
      expect(afterEvents([{ scope: 'availability' }])).toEqual(CLEAN);
    });

    it('marks a stock burst as one row revalidation, not a full catalog reload', () => {
      expect(afterEvents([{ scope: 'stock' }, { scope: 'stock' }, { scope: 'stock' }])).toEqual({ ...CLEAN, stock: true });
    });

    it('collects the product ids of scoped catalog events', () => {
      expect(afterEvents([{ scope: 'catalog', productIds: [3, 7] }, { scope: 'catalog', productIds: ['7', 9] }]))
        .toEqual({ ...CLEAN, catalogIds: ['3', '7', '9'] });
    });

    it('keeps the full refresh for unknown or id-less events', () => {
      expect(afterEvents([undefined]).catalog).toBe(true);
      expect(afterEvents([{ scope: 'catalog', productIds: [] }]).catalog).toBe(true);
      expect(afterEvents([{ scope: 'stock' }, { scope: 'mystery' }]).catalog).toBe(true);
    });

    it('lets a reconnect win over scoped marks', () => {
      expect(afterEvents([{ scope: 'stock' }, { scope: 'catalog', productIds: [1] }], 2)).toEqual(EVERYTHING);
    });

    it('clears scoped marks after activate', () => {
      const tracker = createKeepAliveRefreshTracker();
      tracker.deactivate(1);
      tracker.markInventoryChanged({ scope: 'catalog', productIds: [1] });
      tracker.activate(1);
      tracker.deactivate(1);
      expect(tracker.activate(1)).toEqual(CLEAN);
    });
  });
});
