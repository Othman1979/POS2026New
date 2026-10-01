import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onUnmounted: vi.fn() }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn() }));
vi.mock('@/shared/systemSettings.js', () => ({ getSystemSettings: vi.fn() }));
import Sidebar from '../Sidebar.vue';
let scope, state, props, emit;
beforeEach(() => {
    vi.stubGlobal('window', { innerWidth: 1280 });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    scope = effectScope(); emit = vi.fn();
    props = reactive({ currentPage: 'dashboard', userRole: 'programmer', lowStockCount: 0 });
    state = scope.run(() => Sidebar.setup(props, { expose: () => {}, emit }));
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });
describe('sidebar report navigation', () => {
    it('keeps catalog management but has no purchasing workspace', () => {
        const pages = () => state.navGroups.value.flatMap(group => group.items.map(item => item.page));
        expect(pages()).toContain('inventory');
        expect(pages()).not.toContain('receiving');
        state.recipeLedgerEnabled.value = true;
        expect(pages()).toContain('ingredients');
        expect(pages()).not.toContain('receiving');
    });
    it('expands without navigating, and opens automatically on a report route', async () => {
        state.toggleReports(); expect(state.reportsOpen.value).toBe(true); expect(emit).not.toHaveBeenCalled();
        state.toggleReports(); props.currentPage = 'reports-expenses'; await nextTick();
        expect(state.reportsOpen.value).toBe(true);
    });
    it('opens the full menu when Reports is selected in the collapsed sidebar', () => {
        state.isCollapsed.value = true; state.toggleReports();
        expect(state.isCollapsed.value).toBe(false); expect(state.reportsOpen.value).toBe(true);
        expect(emit).toHaveBeenCalledWith('toggle-collapse', false);
    });
    it('navigates and closes the mobile drawer, while preserving modified link clicks', () => {
        const event = { preventDefault: vi.fn(), button: 0 };
        state.followLink(event, 'reports-sales');
        expect(event.preventDefault).toHaveBeenCalled();
        expect(emit.mock.calls).toEqual([['navigate', 'reports-sales'], ['close']]);
        emit.mockClear(); state.followLink({ ...event, ctrlKey: true }, 'reports-sales');
        expect(emit).not.toHaveBeenCalled();
    });
    it('does not expose admin report navigation to a cashier', () => {
        props.userRole = 'cashier'; expect(state.navGroups.value).toEqual([]);
    });
});
