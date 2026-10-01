import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
const hooks = vi.hoisted(() => ({ mounted: [], unmounted: [] }));
const settings = vi.hoisted(() => ({ value: { success: true, jofotara_enabled: '1' } }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }),
    onMounted: fn => hooks.mounted.push(fn), onUnmounted: fn => hooks.unmounted.push(fn) }));
vi.mock('@/shared/systemSettings.js', () => ({ getSystemSettings: async () => settings.value }));
import Sidebar from '../Sidebar.vue';

let scope, pending;
const flush = async () => { for (let i = 0; i < 8; i++) await nextTick(); };
const signal = () => window.dispatchEvent(new CustomEvent('jofotara_operations_changed'));
const release = total => pending.splice(0).forEach(resolve => resolve({ json: async () => ({ success: true, total }) }));
beforeEach(async () => {
    hooks.mounted.length = 0; hooks.unmounted.length = 0; pending = [];
    settings.value = { success: true, jofotara_enabled: '1' };
    vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1440 }));
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => pending.push(resolve))));
    scope = effectScope();
    scope.run(() => Sidebar.setup({ currentPage: 'dashboard', userRole: 'admin' }, { emit: vi.fn(), expose: vi.fn() }));
    hooks.mounted.forEach(fn => fn());
    await flush();
});
afterEach(() => { hooks.unmounted.forEach(fn => fn()); release(0); scope.stop(); vi.unstubAllGlobals(); });

describe('Sidebar badge read ownership', () => {
    it('collapses a same-tick burst after the initial read', async () => {
        expect(fetch).toHaveBeenCalledTimes(1); release(1); await flush(); fetch.mockClear();
        for (let i = 0; i < 10; i++) signal(); await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('performs one trailing read for signals received while a read is pending', async () => {
        for (let i = 0; i < 10; i++) signal(); await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
        release(1); await flush(); expect(fetch).toHaveBeenCalledTimes(2);
        release(2); await flush(); expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('aborts on unmount and drops queued work after a late response', async () => {
        signal(); const options = fetch.mock.calls[0][1];
        hooks.unmounted.forEach(fn => fn());
        expect(options?.signal?.aborted).toBe(true);
        release(1); await flush(); signal(); await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('does no badge read while JoFotara is disabled and resumes after enablement', async () => {
        settings.value = { success: true, jofotara_enabled: '0' };
        window.dispatchEvent(new CustomEvent('settings_changed'));
        await flush();
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
        release(3); await flush(); fetch.mockClear();
        signal(); await flush();
        expect(fetch).not.toHaveBeenCalled();

        settings.value = { success: true, jofotara_enabled: '1' };
        window.dispatchEvent(new CustomEvent('settings_changed'));
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe('api/admin/jofotara/operations/count');
    });
    it('does not reload the badge for unrelated settings changes', async () => {
        release(2); await flush(); fetch.mockClear();
        settings.value = { success: true, jofotara_enabled: '1', store_name: 'Updated' };
        window.dispatchEvent(new CustomEvent('settings_changed'));
        await flush();
        expect(fetch).not.toHaveBeenCalled();
        window.dispatchEvent(new CustomEvent('socket_reconnected'));
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
