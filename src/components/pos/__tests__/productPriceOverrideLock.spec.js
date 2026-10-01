import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

const mocks = vi.hoisted(() => ({ cart: null, allowed: true }));
const refs = () => new Proxy({}, { get: (target, key) => (target[key] ??= Object.assign(vi.fn(), { value: null })) });
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => ({ activeUser: { value: { id: 1, role: 'cashier' } }, activeShift: { value: null } }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => mocks.cart }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => refs() }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => refs() }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: permission => permission === 'pos.price_override' && mocks.allowed }) }));
import PosCartWorkspace from '../PosCartWorkspace.vue';

let page, scope;
beforeEach(() => {
  mocks.allowed = true;
  const numpadMode = ref('qty');
  mocks.cart = Object.assign(refs(), {
    cart: ref([{ id: 1, name: 'Open price', price_override_locked: 0 }, { id: 2, name: 'Fixed price', price_override_locked: 1 }]),
    selectedCartIndex: ref(null),
    numpadMode,
    setNumpadMode: vi.fn(mode => { numpadMode.value = mode; }),
  });
  scope = effectScope();
  page = scope.run(() => PosCartWorkspace.setup({}, { expose: () => {}, emit: () => {} }));
});
afterEach(() => scope.stop());

describe('product price-override lock on the POS cart', () => {
  it('enables the Price key for an unlocked line when the cashier may override prices', () => {
    mocks.cart.selectedCartIndex.value = 0;
    expect(page.canEnterPrice.value).toBe(true);
  });

  it('disables the Price key for a locked line even with price-override permission', () => {
    mocks.cart.selectedCartIndex.value = 1;
    expect(page.canEnterPrice.value).toBe(false);
  });

  it('disables the Price key for an unlocked line without price-override permission', () => {
    mocks.allowed = false;
    mocks.cart.selectedCartIndex.value = 0;
    expect(page.canEnterPrice.value).toBe(false);
  });

  it('returns the numpad from price to quantity when a locked line is selected', async () => {
    mocks.cart.selectedCartIndex.value = 0;
    mocks.cart.setNumpadMode('price');
    await nextTick();
    mocks.cart.selectedCartIndex.value = 1;
    await nextTick();
    expect(mocks.cart.numpadMode.value).toBe('qty');
  });
});
