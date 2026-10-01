import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';

const deps = vi.hoisted(() => ({}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => deps.auth }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => deps.cart }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => deps.tables }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => deps.terminal }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: permission => !deps.denied.includes(permission) }) }));
import PosCartWorkspace from '../PosCartWorkspace.vue';

// Any binding the cart workspace reads that a test does not set is an empty ref.
const withRefDefaults = values => new Proxy(values, { get: (target, key) => (key in target ? target[key] : (target[key] = ref(null))) });
// Render a one-line cart for a cashier under temporary manager access who holds every POS grant except hold,
// unless hold grants it, and return the Pay button if it renders.
async function payButton({ checkout = false, checkoutTable = false, hold = false, table = null, restoredHeldOrder = null }) {
  deps.denied = [...(checkout ? [] : ['pos.checkout']), ...(hold ? [] : ['pos.hold_orders'])];
  deps.auth = withRefDefaults({
    activeUser: ref({ role: 'cashier' }), isTempAdmin: ref(true), hasAdminPrivilege: ref(true), activeManagerPin: ref('4321'),
  });
  deps.cart = withRefDefaults({
    cart: ref([{ id: 1, name: 'Tea', price: 2, qty: 1, cartId: 'tea' }]), isCallCenter: ref(false), setNumpadMode: vi.fn(), cancelQuickAmount: vi.fn(), getItemTotalGross: () => 2,
    cartSubtotal: ref(2), cartTotal: ref(2), cartTax: ref(0), cartOrderDiscountAmount: ref(0), orderDiscount: ref({ value: 0, type: 'fixed' }),
    canCheckout: ref(checkout), canCheckoutTable: ref(checkoutTable), restoredHeldOrder: ref(restoredHeldOrder),
  });
  deps.tables = withRefDefaults({ restaurantTables: ref([]), activeTable: ref(table) });
  deps.terminal = withRefDefaults({ quickNumpadMode: ref(false) });
  const app = createSSRApp(PosCartWorkspace);
  app.config.globalProperties.$t = text => text;
  const html = await renderToString(app);
  return html.match(/<button[^>]*cart-final-action[^>]*>\s*Pay\s*<\/button>/)?.[0];
}

describe('cart workspace Pay button', () => {
  it('stays hidden without a checkout or hold grant, even under temporary manager access', async () => {
    expect(await payButton({ checkout: false })).toBeUndefined();
  });

  it('shows once the cashier holds the checkout grant', async () => {
    expect(await payButton({ checkout: true })).toBeDefined();
  });

  it('shows for a table checkout grant alone', async () => {
    expect(await payButton({ checkoutTable: true, table: { id: 5 } })).toBeDefined();
  });

  it('lets a hold-only grant open checkout to hold a walk-in order, but not a table order', async () => {
    expect(await payButton({ hold: true }), 'hold grant, no table').toBeDefined();
    expect(await payButton({ hold: true, table: { id: 5 } }), 'hold grant on a table').toBeUndefined();
  });

  it('hides Pay for a restored held order whose baseline is unknown, even with the checkout grant', async () => {
    expect(await payButton({ checkout: true, restoredHeldOrder: { id: 9, baselineUnknown: true } })).toBeUndefined();
    expect(await payButton({ checkout: true, restoredHeldOrder: { id: 9, baselineUnknown: false } })).toBeDefined();
  });
});
