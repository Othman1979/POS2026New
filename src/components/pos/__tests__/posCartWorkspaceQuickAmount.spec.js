import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { nextTick, ref } from 'vue';

const deps = vi.hoisted(() => ({}));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => deps.auth }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => deps.cart }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => deps.tables }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => deps.terminal }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
import PosCartWorkspace from '../PosCartWorkspace.vue';
import { findButton, mountClient, textOf } from './clientTemplateHarness.js';

// Any binding the cart workspace reads that a test does not set is an empty ref.
const withRefDefaults = values => new Proxy(values, { get: (target, key) => (key in target ? target[key] : (target[key] = ref(null))) });

const cartWorkspace = resolve(__dirname, '../PosCartWorkspace.vue');

describe('cart workspace quick-amount numpad', () => {
  it('arms the typed amount when the cashier presses the multiplier button', async () => {
    const numpadInput = ref('');
    const quickTargetAmount = ref(null);
    const armQuickAmount = vi.fn(() => { quickTargetAmount.value = Number(numpadInput.value); return true; });
    deps.auth = withRefDefaults({ activeUser: ref({ role: 'cashier' }) });
    deps.cart = withRefDefaults({
      cart: ref([]), selectedCartIndex: ref(null), numpadInput, quickTargetAmount, isCallCenter: ref(false), getItemTotalGross: () => 0,
      appendNumpad: digit => { numpadInput.value += digit; }, armQuickAmount, cancelQuickAmount: vi.fn(), setNumpadMode: vi.fn(),
      orderDiscount: ref({ value: 0, type: 'fixed' }), cartSubtotal: ref(0), cartTotal: ref(0), cartTax: ref(0), cartOrderDiscountAmount: ref(0),
    });
    deps.tables = withRefDefaults({ restaurantTables: ref([]) });
    deps.terminal = withRefDefaults({ quickNumpadMode: ref(true) });
    const { root, app } = mountClient(PosCartWorkspace, cartWorkspace);

    expect(['% Disc', 'Price'].map(label => findButton(root, label)), 'quick mode hides the discount and price keys').toEqual([undefined, undefined]);
    findButton(root, '1').props.onClick();
    findButton(root, '2').props.onClick();
    await nextTick();
    expect(textOf(root), 'readout labels the typed value as an amount before arming').toContain('· Amount');
    const multiply = findButton(root, '×');
    expect(multiply, 'multiplier button rendered in quick numpad mode').toBeDefined();
    expect(multiply.props.disabled).toBe(false);
    expect(multiply.props.onClick, 'multiplier button has a click handler').toBeTypeOf('function');
    multiply.props.onClick();

    expect(armQuickAmount).toHaveBeenCalledTimes(1);
    expect(numpadInput.value).toBe('12');
    await nextTick();
    expect(textOf(root), 'readout switches to quantity once the amount is armed').toContain('· Qty');
    expect(textOf(root)).not.toContain('· Amount');
    app.unmount();
  });
  it('shows the line pre-tax amount, routes a quantity preset through the store, and reads out the gross line price in price mode', async () => {
    const numpadMode = ref('qty');
    const applyQuantityPreset = vi.fn();
    const line = { id: 1, name: 'Tea', price: 2, qty: 3, cartId: 'tea' };
    deps.auth = withRefDefaults({ activeUser: ref({ role: 'cashier' }) });
    deps.cart = withRefDefaults({
      cart: ref([line]), selectedCartIndex: ref(0), numpadInput: ref(''), numpadMode, isCallCenter: ref(false), getItemTotalGross: () => 7.25,
      cartReceiptPresentation: ref({ rows: [{ key: 'tea', netAmount: 5.5 }] }), applyQuantityPreset, cancelQuickAmount: vi.fn(), setNumpadMode: vi.fn(),
      orderDiscount: ref({ value: 0, type: 'fixed' }), cartSubtotal: ref(0), cartTotal: ref(0), cartTax: ref(0), cartOrderDiscountAmount: ref(0),
    });
    deps.tables = withRefDefaults({ restaurantTables: ref([]) });
    deps.terminal = withRefDefaults({ quickNumpadMode: ref(false), quantityPresetsEnabled: ref(true) });
    const { root, app } = mountClient(PosCartWorkspace, cartWorkspace);
    const findTag = (el, tag) => (el.tag === tag ? el : el.children.map(child => findTag(child, tag)).find(Boolean));

    expect(textOf(root), 'cart price column shows the pre-tax line amount').toContain('5.50');
    expect(['% Disc', 'Price'].every(label => findButton(root, label)), 'plain mode shows the discount and price keys').toBe(true);
    findButton(root, '0.25').props.onClick();
    expect(applyQuantityPreset).toHaveBeenCalledWith('0.25');
    numpadMode.value = 'price';
    await nextTick();
    expect(textOf(findTag(root, 'output')).trim()).toBe('7.25');
    app.unmount();
  });
});
