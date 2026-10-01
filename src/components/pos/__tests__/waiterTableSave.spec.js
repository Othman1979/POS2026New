import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';

const mocks = vi.hoisted(() => ({ push: vi.fn(), tables: null, role: 'waiter' }));
const refs = () => new Proxy({}, { get: (target, key) => (target[key] ??= Object.assign(vi.fn(), { value: null })) });
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => ({ activeUser: { get value() { return { id: 1, role: mocks.role }; } }, activeShift: { value: null } }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => refs() }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => mocks.tables }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => refs() }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
import PosCartWorkspace from '../PosCartWorkspace.vue';

let page;
beforeEach(() => {
  mocks.push.mockReset().mockResolvedValue(undefined);
  mocks.tables = Object.assign(refs(), {
    activeTable: ref({ id: 7, current_order_id: 99 }),
    restaurantTables: ref([]),
    updateActiveTableOrder: vi.fn(async () => true),
    loadActiveTableOrder: vi.fn(async () => {}),
    clearActiveTableSession: vi.fn(),
  });
  page = effectScope().run(() => PosCartWorkspace.setup({}, { expose: () => {}, emit: () => {} }));
});

describe('waiter Save Table', () => {
  it('saves as leaving, goes to the floor and ends the session without any reload', async () => {
    mocks.role = 'waiter';
    await page.handleUpdateTableOrder();
    expect(mocks.tables.updateActiveTableOrder).toHaveBeenCalledWith({ keepProcessingOnSuccess: true, leaving: true });
    expect(mocks.push).toHaveBeenCalledWith('/tables');
    expect(mocks.tables.clearActiveTableSession).toHaveBeenCalledWith({ clearCart: true });
    expect(mocks.tables.loadActiveTableOrder).not.toHaveBeenCalled();
  });

  it('reloads the saved table when navigation to the floor is blocked', async () => {
    mocks.role = 'waiter';
    mocks.push.mockResolvedValue({ type: 4 });
    await page.handleUpdateTableOrder();
    expect(mocks.tables.clearActiveTableSession).not.toHaveBeenCalled();
    expect(mocks.tables.loadActiveTableOrder).toHaveBeenCalledWith(mocks.tables.activeTable.value, { preserveDraft: true, keepQrDraft: true });
  });

  it('keeps a cashier on the table with the full refresh', async () => {
    mocks.role = 'cashier';
    await page.handleUpdateTableOrder();
    expect(mocks.tables.updateActiveTableOrder).toHaveBeenCalledWith({ keepProcessingOnSuccess: false, leaving: false });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.tables.clearActiveTableSession).not.toHaveBeenCalled();
  });
});
