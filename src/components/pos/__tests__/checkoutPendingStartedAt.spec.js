import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';

const composables = vi.hoisted(() => ({ cart: null }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => composables.cart }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => ({}) }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => ({ activeTable: { value: null }, holdCurrentOrder: () => {} }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/pos/usePosDialogFocus.js', () => ({ usePosDialogFocus: () => {} }));
import CheckoutModal from '../CheckoutModal.vue';

const withRefDefaults = values => new Proxy(values, { get: (target, key) => (key in target ? target[key] : (target[key] = ref(null))) });
const setup = pending => {
  composables.cart = withRefDefaults({ pendingCheckout: ref(pending), cart: ref([]), orderTypes: ref([]) });
  const scope = effectScope();
  let bindings;
  scope.run(() => { bindings = CheckoutModal.setup({}, { expose() {}, emit: vi.fn() }); });
  scope.stop();
  return bindings;
};
const startedAtFor = savedAt => setup(savedAt == null ? null : { savedAt }).pendingStartedAt.value;

afterEach(() => vi.useRealTimers());

describe('unconfirmed sale start time in the recovery panel', () => {
  it('shows only the time for a sale started today and the date for an older one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
    const today = startedAtFor(new Date('2026-09-29T10:00:00Z').getTime());
    const older = startedAtFor(new Date('2026-09-20T10:00:00Z').getTime());
    expect(today).toMatch(/^\d{2}:\d{2} (AM|PM)$/);
    expect(older).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (AM|PM)$/);
  });

  it('shows nothing for a record without a start time', () => {
    expect(startedAtFor(undefined)).toBe('');
  });

  it('lists the frozen sale lines, capped at six with the remainder counted', () => {
    const cartSnapshot = Array.from({ length: 8 }, (_, i) => ({ name: `Item ${i + 1}`, qty: i + 1 }));
    const bindings = setup({ savedAt: 1, frozen: { cartSnapshot } });
    expect(bindings.pendingLines.value).toEqual(cartSnapshot.slice(0, 6));
    expect(bindings.pendingMoreCount.value).toBe(2);
    expect(setup({ savedAt: 1, frozen: { cartSnapshot: cartSnapshot.slice(0, 2) } }).pendingMoreCount.value).toBe(0);
  });
});
