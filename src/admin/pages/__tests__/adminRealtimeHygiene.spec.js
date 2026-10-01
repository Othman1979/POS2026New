import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';

const hooks = vi.hoisted(() => ({ mounted: [], unmounted: [] }));
const access = vi.hoisted(() => ({ load: null }));
vi.mock('vue', async original => ({
    ...await original(),
    useSSRContext: () => ({ modules: new Set() }),
    onMounted: fn => hooks.mounted.push(fn),
    onUnmounted: fn => hooks.unmounted.push(fn),
}));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));
vi.mock('../../components/IngredientRecipes.vue', () => ({ default: {} }));
vi.mock('../../components/ModalShell.vue', () => ({ default: {} }));
vi.mock('@/admin/composables/useDeviceAccess.js', () => ({
    useDeviceAccess: () => ({
        state: ref({ mode: 'staged', users: [] }), loading: ref(false), error: ref(''), load: access.load,
        bootstrap: vi.fn(), enroll: vi.fn(), approveEnrollment: vi.fn(), cancelEnrollment: vi.fn(), revoke: vi.fn(), setMode: vi.fn(),
    }),
}));
import { fetchJson } from '@/shared/http.js';
import DeviceAccessSettings from '../../components/settings/DeviceAccessSettings.vue';
import TableMapEditor from '../TableMapEditor.vue';
import Ingredients from '../Ingredients.vue';

let scope;
function mount(component) {
    hooks.mounted.length = 0;
    hooks.unmounted.length = 0;
    scope = effectScope();
    let bindings;
    scope.run(() => { bindings = component.setup({}, { expose() {}, emit() {} }); });
    hooks.mounted.forEach(fn => fn());
    return bindings;
}
function unmount() {
    hooks.unmounted.forEach(fn => fn());
    scope?.stop();
}
const realtime = (win, type, payload = {}) => win.dispatchEvent(new CustomEvent('admin:realtime', { detail: { type, payload } }));

beforeEach(() => {
    vi.useFakeTimers();
    const win = Object.assign(new EventTarget(), {
        setInterval: (...args) => setInterval(...args),
        clearInterval: (...args) => clearInterval(...args),
    });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ id: 1, role: 'admin' }) });
    fetchJson.mockReset();
    access.load = vi.fn();
});
afterEach(() => {
    unmount();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('device access panel', () => {
    it('sends no request while idle and refreshes on the device event and on reconnect', async () => {
        mount(DeviceAccessSettings);
        expect(access.load).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(access.load).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new CustomEvent('device_access_changed'));
        expect(access.load).toHaveBeenCalledTimes(2);
        expect(access.load).toHaveBeenLastCalledWith({ silent: true });
        await vi.advanceTimersByTimeAsync(0);

        window.dispatchEvent(new CustomEvent('socket_reconnected'));
        expect(access.load).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(0);

        unmount();
        window.dispatchEvent(new CustomEvent('device_access_changed'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(access.load).toHaveBeenCalledTimes(3);
    });

    it('coalesces event refreshes that arrive while a read is in flight into one follow-up', async () => {
        let release;
        access.load = vi.fn(() => new Promise(resolve => { release = resolve; }));
        mount(DeviceAccessSettings);
        release(); // the mount read
        await vi.advanceTimersByTimeAsync(0);
        expect(access.load).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new CustomEvent('device_access_changed'));
        window.dispatchEvent(new CustomEvent('device_access_changed'));
        window.dispatchEvent(new CustomEvent('socket_reconnected'));
        expect(access.load).toHaveBeenCalledTimes(2);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(access.load).toHaveBeenCalledTimes(3);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(access.load).toHaveBeenCalledTimes(3);
    });
});

describe('device access panel expiry', () => {
    it('hides a lapsed pending request on the clock alone, with no event', async () => {
        const panel = mount(DeviceAccessSettings);
        const user = { pending_enrollment: { id: 'r1', expires_at: new Date(Date.now() + 3000).toISOString() } };
        expect(panel.pendingOf(user)).toBe(user.pending_enrollment);
        await vi.advanceTimersByTimeAsync(4000);
        expect(panel.pendingOf(user)).toBeNull();
    });
});

describe('table map editor', () => {
    it('ignores single-table status updates and reloads for list and structure changes', async () => {
        fetchJson.mockResolvedValue({ success: true, sections: [], tables: [] });
        mount(TableMapEditor);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchJson).toHaveBeenCalledTimes(1);

        realtime(window, 'table_update', { action: 'update_single_table', table: { id: 7, status: 'occupied' } });
        realtime(window, 'table_update', { action: 'update_single_table', table: { id: 8, status: 'available' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchJson).toHaveBeenCalledTimes(1);

        realtime(window, 'table_update', { action: 'refresh_tables' });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchJson).toHaveBeenCalledTimes(2);

        realtime(window, 'table_update', { action: 'refresh_sections' });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchJson).toHaveBeenCalledTimes(3);
    });
});

describe('ingredients page realtime reads', () => {
    const changed = () => window.dispatchEvent(new CustomEvent('ingredients_changed', { detail: { ingredientIds: [1] } }));
    async function mountSettled() {
        fetchJson.mockResolvedValue({ success: true, ingredients: [] });
        mount(Ingredients);
        await vi.advanceTimersByTimeAsync(200);
        fetchJson.mockClear();
    }

    it('turns a burst of changes into one read about a second later', async () => {
        await mountSettled();
        changed(); changed(); changed();
        await vi.advanceTimersByTimeAsync(900);
        expect(fetchJson).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(300);
        expect(fetchJson).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    it('reads nothing while hidden and refreshes once when the page is visible again', async () => {
        await mountSettled();
        document.hidden = true;
        changed(); changed();
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetchJson).not.toHaveBeenCalled();

        document.hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(200);
        expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    it('reads nothing while purchase invoices or recipes cover the list and refreshes once on return', async () => {
        fetchJson.mockResolvedValue({ success: true, ingredients: [] });
        const page = mount(Ingredients);
        await vi.advanceTimersByTimeAsync(200);
        fetchJson.mockClear();
        for (const view of [page.showPurchases, page.showRecipes]) {
            view.value = true;
            changed(); changed();
            await vi.advanceTimersByTimeAsync(5000);
            expect(fetchJson).not.toHaveBeenCalled();
            view.value = false;
            await vi.advanceTimersByTimeAsync(200);
            expect(fetchJson).toHaveBeenCalledTimes(1);
            fetchJson.mockClear();
        }
        // A read already scheduled when the screen opens waits for the return as well.
        changed();
        page.showRecipes.value = true;
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetchJson).not.toHaveBeenCalled();
        page.showRecipes.value = false;
        await vi.advanceTimersByTimeAsync(200);
        expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    it('does not refresh on becoming visible when nothing changed', async () => {
        await mountSettled();
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it('drops a pending read and its listeners on unmount', async () => {
        await mountSettled();
        changed();
        unmount();
        await vi.advanceTimersByTimeAsync(5000);
        changed();
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetchJson).not.toHaveBeenCalled();
    });
});
