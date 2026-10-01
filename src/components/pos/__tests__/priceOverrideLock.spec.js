import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

const mocks = vi.hoisted(() => ({ cart: null }));
const refs = () => new Proxy({}, { get: (target, key) => (target[key] ??= Object.assign(vi.fn(), { value: null })) });
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => ({ activeUser: { value: { id: 1, role: 'cashier' } }, activeShift: { value: null } }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => mocks.cart }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => refs() }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => refs() }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: permission => permission === 'pos.price_override' }) }));
import PosCartWorkspace from '../PosCartWorkspace.vue';

let page;
beforeEach(() => {
  const numpadMode = ref('qty');
  mocks.cart = Object.assign(refs(), {
    cart: ref([
      { id: 1, name: 'Open price', price: 5, qty: 1, price_override_locked: 0 },
      { id: 2, name: 'Fixed price', price: 5, qty: 1, price_override_locked: 1 },
    ]),
    selectedCartIndex: ref(0),
    numpadMode,
    setNumpadMode: mode => { numpadMode.value = mode; },
  });
  page = effectScope().run(() => PosCartWorkspace.setup({}, { expose: () => {}, emit: () => {} }));
});

describe('price override lock', () => {
  it('lets a price-override user enter a price on an unlocked line', () => {
    expect(page.canEnterPrice.value).toBe(true);
  });

  it('refuses the Price key on a line the catalog locks', () => {
    mocks.cart.selectedCartIndex.value = 1;
    expect(page.canEnterPrice.value).toBe(false);
  });

  it('drops out of price entry when a locked line is selected', async () => {
    mocks.cart.setNumpadMode('price');
    mocks.cart.selectedCartIndex.value = 1;
    await nextTick();
    expect(mocks.cart.numpadMode.value).toBe('qty');
  });
});
