import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, ref } from 'vue';
import { resolve } from 'node:path';
import { renderToString } from '@vue/server-renderer';

const deps = vi.hoisted(() => ({}));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ currentLanguage: { value: 'en' }, getDirection: () => 'ltr', t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => deps.auth }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => deps.cart }));
vi.mock('@/pos/useProducts.js', () => ({ useProducts: () => deps.products }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => deps.tables }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => deps.terminal }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/pos/useSocket.js', () => ({ useSocket: () => ({ isSocketConnected: ref(true) }) }));
vi.mock('../FailedPrintsBell.vue', () => ({ default: { render: () => null } }));
vi.mock('../PosMobileCartSummary.vue', () => ({ default: { render: () => null } }));
import Catalog from '../PosCatalogWorkspace.vue';
import { findButton, mountClient } from './clientTemplateHarness.js';

// Any binding the catalog reads that a test does not set is an empty ref.
const withRefDefaults = values => new Proxy(values, { get: (target, key) => (key in target ? target[key] : (target[key] = ref(null))) });

function setDeps({ role = 'cashier', tableActionError = '', printGuestCheck = vi.fn(), closeTable = vi.fn() } = {}) {
  deps.auth = withRefDefaults({ activeUser: ref({ role }), showUserSidebar: ref(false), userInitials: ref('AB') });
  deps.cart = withRefDefaults({ cart: ref([{ id: 1, qty: 1 }]), canPrintCheck: ref(true), guestCheckInFlight: ref(false), getQtyInCart: () => 0, printGuestCheck });
  deps.products = withRefDefaults({ filteredProducts: ref([]), mainCategories: ref([]), currentSubcategories: ref([]), categories: ref([]), settings: ref({}) });
  deps.tables = withRefDefaults({ activeTable: ref({ id: 5, table_number: 12, current_order_id: 90 }), tableActionError: ref(tableActionError), tablesEnabled: ref(true), closeTable });
  deps.terminal = withRefDefaults({ quickNumpadMode: ref(false) });
}

async function renderCatalog(options) {
  setDeps(options);
  const app = createSSRApp(Catalog);
  app.config.globalProperties.$t = text => text;
  return renderToString(app);
}

describe('catalog navbar during a table session', () => {
  it('shows the table number, Print Check, Floor Plan and the user drawer trigger, and raises a table action error as an alert', async () => {
    const html = await renderCatalog({ tableActionError: 'Table is locked' });
    expect(html).toContain('#12');
    expect(html).toMatch(/<button[^>]*aria-label="Print Check"(?![^>]*disabled)/);
    expect(html).toMatch(/<button[^>]*aria-label="Floor Plan"/);
    expect(html).toMatch(/role="alert"[^>]*aria-label="Table is locked"/);
    expect(html).toMatch(/<button[^>]*aria-controls="pos-user-sidebar"/);
    expect(await renderCatalog()).not.toContain('role="alert"');
  });

  it('prints the guest check and returns to the floor plan when the cashier clicks the table controls', () => {
    const printGuestCheck = vi.fn(), closeTable = vi.fn();
    setDeps({ printGuestCheck, closeTable });
    const { root, app } = mountClient(Catalog, resolve(__dirname, '../PosCatalogWorkspace.vue'));
    const printCheck = findButton(root, 'Print Check'), floorPlan = findButton(root, 'Floor Plan');
    expect([printCheck?.props.onClick, floorPlan?.props.onClick].map(handler => typeof handler), 'table controls rendered with click handlers').toEqual(['function', 'function']);

    printCheck.props.onClick(new Event('click'));
    expect(printGuestCheck, 'Print Check click prints the guest check').toHaveBeenCalledOnce();
    expect(closeTable).not.toHaveBeenCalled();
    floorPlan.props.onClick(new Event('click'));
    expect(closeTable, 'Floor Plan click closes the table and navigates to the floor plan').toHaveBeenCalledOnce();
    app.unmount();
  });

  it('keeps the table controls away from call-center users', async () => {
    const html = await renderCatalog({ role: 'call_center' });
    expect(html).not.toContain('Print Check');
    expect(html).not.toContain('Floor Plan');
    expect(html).toMatch(/<button[^>]*aria-controls="pos-user-sidebar"/);
  });
});
