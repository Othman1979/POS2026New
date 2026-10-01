import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSSRApp, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';

const deps = vi.hoisted(() => ({}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => deps.auth }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => deps.cart }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => deps.tables }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => deps.terminal }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
import PosCartWorkspace from '../PosCartWorkspace.vue';

const read = path => readFileSync(resolve(process.cwd(), path), 'utf8');
const terminal = read('src/components/PosTerminal.vue');
const cart = read('src/components/pos/PosCartWorkspace.vue');
const catalog = read('src/components/pos/PosCatalogWorkspace.vue');
const checkout = read('src/components/pos/CheckoutModal.vue');
const api = read('src/pos/stores/orderSession/orderSessionApi.js');
const store = read('src/pos/stores/orderSessionStore.js');
const persistence = read('src/pos/stores/orderSession/orderSessionPersistence.js');
const idle = read('src/pos/useIdleTracker.js');
const styles = read('src/pos.css');

// Any binding the cart workspace reads that a test does not set is an empty ref.
const withRefDefaults = values => new Proxy(values, { get: (target, key) => (key in target ? target[key] : (target[key] = ref(null))) });
// Render the cart with one selected line for a user who holds every POS grant, and return the numpad key labelled `label`.
async function numpadKey(role, label) {
  deps.auth = withRefDefaults({ activeUser: ref({ role }) });
  deps.cart = withRefDefaults({
    cart: ref([{ id: 1, name: 'Tea', price: 2, qty: 1, cartId: 'tea' }]), selectedCartIndex: ref(0),
    isCallCenter: ref(role === 'call_center'), canApplyDiscount: ref(true), numpadMode: ref('qty'), numpadInput: ref(''),
    setNumpadMode: vi.fn(), cancelQuickAmount: vi.fn(), getItemTotalGross: () => 2,
    cartSubtotal: ref(2), cartTotal: ref(2), cartTax: ref(0), cartOrderDiscountAmount: ref(0), orderDiscount: ref({ value: 0, type: 'fixed' }),
  });
  deps.tables = withRefDefaults({ restaurantTables: ref([]) });
  deps.terminal = withRefDefaults({ quickNumpadMode: ref(false) });
  const app = createSSRApp(PosCartWorkspace);
  app.config.globalProperties.$t = text => text;
  const html = await renderToString(app);
  return html.match(new RegExp(`<button[^>]*>\\s*(?:<i[^>]*></i>|<!---->)${label}`))?.[0];
}

describe('call-center POS workflow contract', () => {
  it('uses the existing context key and a single claim-token owner', () => {
    expect(persistence).toContain('callCenter');
    expect(persistence).toContain('createHeldClaimToken');
    expect(persistence).not.toContain('pos_call_center_');
    expect(store).toContain('createHeldClaimToken');
  });

  it('keeps phone values in POST bodies and includes the searched phone in claims', () => {
    expect(api).toContain("timedJsonRequest('api/pos/customer_lookup', 'POST'");
    expect(api).toContain("timedJsonRequest('api/pos/held_orders/phone-matches', 'POST'");
    const claimApi = api.slice(
      api.indexOf('export const claimHeldOrder'),
      api.indexOf('export const updateHeldOrder'),
    );
    expect(claimApi).toContain('{ phone: customerPhone }');
    expect(claimApi).not.toContain('customer_phone');
    expect(api).not.toContain('phone-matches?phone=');
  });

  it('authenticates the fixed role before generic restore and shift lookup', () => {
    expect(terminal).toContain("activeUser.value?.role === 'call_center'");
    expect(terminal.indexOf('initializeCallCenterSession')).toBeLessThan(terminal.indexOf('cart.loadSavedOrder()'));
    expect(idle).toContain("fetch('api/auth/me')");
    expect(idle).not.toContain('shifts?action=check');
  });

  it('hides privileged POS surfaces', () => {
    expect(cart).toContain('isCallCenter');
    expect(catalog).toContain('!isCallCenter');
    expect(checkout).toContain('isCallCenter');
    expect(terminal).toMatch(/customerPhone, customerName, customerAddress, orderDate, callCenterSession,\s+isCallCenter,/);
    expect(terminal).toContain('v-if="!isCallCenter && showMoreActionsModal"');
    expect(terminal).toContain('<SplitCheckModal v-if="!isCallCenter && showSplitModal"');
    expect(terminal).toContain('<PrivilegesModal v-if="!isCallCenter && showOverrideModal"');
  });

  it('keeps the discount and price keys visible but disabled for call-center users', async () => {
    for (const label of ['% Disc', 'Price']) {
      expect(await numpadKey('call_center', label)).toMatch(/^<button[^>]* disabled/);
      expect(await numpadKey('cashier', label)).not.toMatch(/^<button[^>]* disabled/);
    }
  });

  it('enables tax-inclusive price entry through the configured POS permission', () => {
    expect(cart).toContain("can('pos.price_override') && selectedCartItem.value && !selectedCartItemPriceLocked.value");
    expect(cart).not.toMatch(/setNumpadMode\('price'\)[^>]+hasAdminPrivilege/);
  });

  it('uses compact call-center layouts for intake and order editing', () => {
    expect(terminal).toContain('class="call-center-field call-center-field--phone"');
    expect(terminal).toContain('class="call-center-field call-center-field--schedule"');
    expect(terminal.indexOf('call-center-field--schedule')).toBeLessThan(terminal.indexOf('call-center-field--address'));
    expect(checkout).toContain("'is-call-center': isCallCenter");
    expect(styles).toMatch(/\.pos-polish \.checkout-dialog\.is-call-center\.has-order-types \.checkout-layout \{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(styles).toMatch(/\.pos-polish \.checkout-dialog\.is-call-center\.has-customer\.has-order-types \.checkout-layout \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) 19rem;/);
    expect(styles).toMatch(/\.call-center-intake-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  });

  it('routes phone work through safe store actions, never checkout', () => {
    expect(store).toContain('startCallCenterOrder');
    expect(store).toContain('sendCallCenterOrder');
    expect(store).toContain('cancelCallCenterEdits');
    expect(store).toContain('cancelCallCenterOrder');
    expect(checkout).toContain('callCenterCommands');
  });

  it('gives cashiers one held-count badge and one idempotent phone-order listener', () => {
    expect(terminal).toContain('fetchHeldOrderSummary');
    expect(terminal).toContain("s.off('held_orders_changed', onHeldOrdersChanged)");
    expect(terminal).toContain("s.on('held_orders_changed', onHeldOrdersChanged)");
    expect(terminal).toContain("payload?.source === 'call_center'");
    const reconnectHandler = terminal.slice(
      terminal.indexOf('const handleSocketReconnected'),
      terminal.indexOf('const handleWindowFocus'),
    );
    // Reconnect starts a fresh held-count read (it runs alongside the other recovery reads).
    expect(reconnectHandler).toContain('fetchHeldOrderSummary({ fresh: true })');
    const activationHandler = terminal.slice(
      terminal.indexOf('onActivated(async () =>'),
      terminal.indexOf('onDeactivated(() =>'),
    );
    expect(activationHandler).toContain('fetchHeldOrderSummary()');
    expect(cart).toContain('activeHeldCount');
    expect(cart).toContain('held-count-badge');
  });

  it('keeps operator and cancellation context visible in both themes', () => {
    const ar = JSON.parse(read('src/shared/i18n/ar.json'));
    expect(terminal).toContain('match.call_center_user_name');
    expect(terminal).toContain('match.kitchen_dispatch_version');
    expect(terminal).toContain('match.claim_owner_name');
    expect(cart).toContain('call-center-cart-identity');
    expect(cart).toContain('editCallCenterCustomer');
    expect(checkout).toContain('call-center-cancel-context');
    expect(checkout).toContain('restoredHeldReference');
    expect(checkout).toContain("label: 'Customer changed mind'");
    expect(checkout).toContain("label: 'Order entered incorrectly'");
    expect(ar['Call taken by']).toBe('استلم المكالمة');
    expect(ar['Customer changed mind']).toBe('العميل غيّر رأيه');
    expect(ar['Order entered incorrectly']).toBe('أُدخل الطلب بالخطأ');
    expect(ar).not.toHaveProperty('Customer changed their mind');
    expect(ar).not.toHaveProperty('Entered by mistake');
  });
});
