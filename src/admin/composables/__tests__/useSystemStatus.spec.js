import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ mounted: [], unmounted: [] }));
vi.mock('vue', async original => ({
    ...await original(),
    onMounted: callback => hooks.mounted.push(callback),
    onUnmounted: callback => hooks.unmounted.push(callback),
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));

import { useSystemStatus } from '../useSystemStatus.js';

function mountStatus() {
    const status = useSystemStatus();
    hooks.mounted.forEach(fn => fn());
    return status;
}

function dispatch(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
}

describe('console system health', () => {
    beforeEach(() => {
        hooks.mounted.length = 0;
        hooks.unmounted.length = 0;
        vi.stubGlobal('window', new EventTarget());
    });
    afterEach(() => {
        hooks.unmounted.forEach(fn => fn());
        vi.unstubAllGlobals();
    });

    it('is live when the socket is up and nothing is stale or failing', () => {
        const { systemHealth } = mountStatus();
        dispatch('socket_connect');
        expect(systemHealth.value.level).toBe('ok');
    });

    it('warns when a print station has gone stale', () => {
        const { systemHealth } = mountStatus();
        dispatch('socket_connect');
        dispatch('stale_print_stations', { stations: [{ id: 4, name: 'Bar' }] });
        expect(systemHealth.value.level).toBe('warn');
    });

    it('stays down, not warn, when failed jobs and stale stations coincide', () => {
        const { systemHealth } = mountStatus();
        dispatch('socket_connect');
        dispatch('stale_print_stations', { stations: [{ id: 4, name: 'Bar' }] });
        dispatch('failed_print_jobs_count', 2);
        expect(systemHealth.value.level).toBe('down');
    });

    it('stays down, not warn, when stations are stale and the socket is disconnected', () => {
        const { systemHealth } = mountStatus();
        dispatch('socket_connect');
        dispatch('stale_print_stations', { stations: [{ id: 4, name: 'Bar' }] });
        dispatch('socket_disconnect');
        expect(systemHealth.value.level).toBe('down');
    });

    it('stays down, not warn, when stations are stale and every printer is offline', () => {
        const { systemHealth } = mountStatus();
        dispatch('socket_connect');
        dispatch('stale_print_stations', { stations: [{ id: 4, name: 'Bar' }] });
        dispatch('printer_status_changed', [{ id: 1, online: false }, { id: 2, online: false }]);
        expect(systemHealth.value.level).toBe('down');
    });

    it('returns to live once the stale stations clear', () => {
        const { systemHealth } = mountStatus();
        dispatch('socket_connect');
        dispatch('stale_print_stations', { stations: [{ id: 4, name: 'Bar' }] });
        dispatch('stale_print_stations', { stations: [] });
        expect(systemHealth.value.level).toBe('ok');
    });
});
