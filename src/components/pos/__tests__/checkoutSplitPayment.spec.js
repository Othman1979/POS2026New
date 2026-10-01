import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSSRApp, effectScope, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';

const cartState = vi.hoisted(() => ({ values: null }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => cartState.values }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => ({ activeTable: { value: null }, holdCurrentOrder: () => {} }) }));
// Temporary manager access is on in every test; CheckoutModal must take payment rights only from the cart's checkout grants.
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => ({ isTempAdmin: ref(true), hasAdminPrivilege: ref(true), activeManagerPin: ref('4321') }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/pos/usePosDialogFocus.js', () => ({ usePosDialogFocus: () => {} }));
import CheckoutModal from '../CheckoutModal.vue';

const modal = readFileSync(resolve(__dirname, '../CheckoutModal.vue'), 'utf8');

// Any binding the modal reads that a test does not set is an empty ref.
const withRefDefaults = values => new Proxy(values, { get: (target, key) => (key in target ? target[key] : (target[key] = ref(null))) });
const scopes = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));
const setupCheckout = (values) => {
  cartState.values = withRefDefaults({ cart: ref([]), orderTypes: ref([]), ...values });
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => CheckoutModal.setup({}, { expose() {}, emit: vi.fn() }));
};
const splitCheckout = ({ total, card, cash }) => setupCheckout({
  cartTotal: ref(total), paymentMethod: ref('split'), splitCardAmount: ref(card), splitCashTendered: ref(cash),
});

// Render the real modal and report whether its confirm button is disabled.
const confirmDisabled = async (values) => {
  cartState.values = withRefDefaults({ cart: ref([]), orderTypes: ref([]), showCheckoutModal: ref(true), cartTotal: ref(10), changeDue: ref(0), splitBalanceDue: ref(0), ...values });
  const app = createSSRApp(CheckoutModal);
  app.config.globalProperties.$t = s => s;
  const html = await renderToString(app);
  const button = html.match(/<button[^>]*class="checkout-confirm[^"]*"[^>]*>/);
  expect(button, 'confirm button rendered').not.toBeNull();
  return /\sdisabled/.test(button[0]);
};

describe('checkout split-tender contract', () => {
  it('uses the Customer toggle instead of a redundant customer-panel header', () => {
    expect(modal).toContain('@click="setCustomerPanel(!showCustomerDrawer)"');
    expect(modal).not.toContain('customer-panel-heading');
    expect(modal).not.toContain("$t('Customer Details')");
    expect(modal).not.toContain('@click="setCustomerPanel(false)"');
  });

  it('enables split as a real payment mode', () => {
    expect(modal).toContain(":class=\"{ 'is-selected': paymentMethod === 'split' }\"");
    expect(modal).toContain(':aria-pressed="paymentMethod === \'split\'"');
    expect(modal).toContain('@click="paymentMethod = \'split\'"');
    expect(modal).not.toContain('<button type="button" class="payment-option" disabled>');
  });

  it('renders the platform settlement explanation and conditional controls', () => {
    expect(modal).toContain('isPlatformOrderType');
    expect(modal).toContain("$t('Platform')");
    expect(modal).toContain("$t('Platform sales are revenue, but they are not cash or card collected at the register.')");
    expect(modal).toContain('v-if="!isPlatformOrderType"');
  });

  it('collects card charge and physical cash received through existing state', () => {
    expect(modal).toContain('v-model.number="splitCardAmount"');
    expect(modal).toContain('v-model.number="splitCashTendered"');
    expect(modal).toContain("$t('Charge Card')");
    expect(modal).toContain("$t('Cash Tender')");
  });

  it('asks for the cash left after the card charge and blocks payment until it is tendered', () => {
    const shortByOneCent = splitCheckout({ total: 10, card: 6, cash: 3.99 });
    expect(shortByOneCent.splitCashDue.value).toBe(4);
    expect(shortByOneCent.paymentBlocked.value).toBe(true);

    expect(splitCheckout({ total: 10, card: 6, cash: 4 }).paymentBlocked.value).toBe(false);
  });

  it('blocks a split whose card charge covers none or all of the total', () => {
    expect(splitCheckout({ total: 10, card: 0, cash: 10 }).paymentBlocked.value).toBe(true);
    expect(splitCheckout({ total: 10, card: 10, cash: 0 }).paymentBlocked.value).toBe(true);
  });

  it('offers no payment without a checkout grant, even under temporary manager access', () => {
    expect(setupCheckout({ canCheckout: ref(false), canCheckoutTable: ref(false) }).canPay.value).toBe(false);
    expect(setupCheckout({ canCheckout: ref(true), canCheckoutTable: ref(false) }).canPay.value).toBe(true);
    expect(setupCheckout({ canCheckout: ref(false), canCheckoutTable: ref(true) }).canPay.value, 'table checkout grant alone').toBe(true);
  });

  it('disables the rendered confirm button for a short split and for a missing checkout grant', async () => {
    const split = cash => ({ canCheckout: ref(true), paymentMethod: ref('split'), splitCardAmount: ref(6), splitCashTendered: ref(cash) });
    expect(await confirmDisabled(split(3.99))).toBe(true);
    expect(await confirmDisabled(split(4))).toBe(false);
    expect(await confirmDisabled({ canCheckout: ref(false), canCheckoutTable: ref(false), paymentMethod: ref('cash'), cashTendered: ref(10) })).toBe(true);
    expect(await confirmDisabled({ canCheckout: ref(true), paymentMethod: ref('cash'), cashTendered: ref(10) })).toBe(false);
  });

  it('disables the rendered confirm button while a checkout or a hold is in flight', async () => {
    const payable = { canCheckout: ref(true), paymentMethod: ref('cash'), cashTendered: ref(10) };
    expect(await confirmDisabled({ ...payable, isProcessing: ref(true), isHolding: ref(false) }), 'while processing').toBe(true);
    expect(await confirmDisabled({ ...payable, isProcessing: ref(false), isHolding: ref(true) }), 'while holding').toBe(true);
  });
});
