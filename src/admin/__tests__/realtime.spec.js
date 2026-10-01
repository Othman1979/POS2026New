import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/utils/businessDate.js', () => ({ retryFailedBusinessConfig: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: vi.fn() }));
import { io } from 'socket.io-client';
import { createAdminRealtimeBridge } from '../realtime.js';
import { retryFailedBusinessConfig } from '@/utils/businessDate.js';
import { SOCKET_CLIENT_OPTIONS } from '@/shared/socketRefusalRetry.js';
import { setSessionEnding } from '@/pos/sessionEnding.js';
import { getSystemSettings, invalidateSystemSettings } from '@/shared/systemSettings.js';

afterEach(() => {
    setSessionEnding(false);
    vi.unstubAllGlobals();
    invalidateSystemSettings();
});

function makeHarness() {
    const handlers = new Map();
    const socket = {
        active: false,
        on: vi.fn((type, handler) => handlers.set(type, handler)),
        connect: vi.fn(),
        disconnect: vi.fn(),
        io: { handlers: new Map(), on: vi.fn((type, handler) => socket.io.handlers.set(type, handler)), off: vi.fn(type => socket.io.handlers.delete(type)) }
    };
    const ioFactory = vi.fn(() => socket);
    const eventTarget = new EventTarget();
    const browserEvents = new Map();
    const watched = [
        'socket_connect', 'socket_disconnect', 'socket_auth_error',
        'socket_reconnected', 'admin:realtime',
        'inventory_changed', 'new_order', 'shifts_changed', 'table_update',
        'expenses_changed', 'settings_changed', 'printer_status_changed',
        'failed_print_jobs_count', 'stale_print_stations',
        'print_queue_updated', 'jofotara_operations_changed', 'ingredients_changed', 'device_access_changed'
    ];
    for (const type of watched) {
        browserEvents.set(type, []);
        eventTarget.addEventListener(type, event => browserEvents.get(type).push(event));
    }
    return {
        socket,
        ioFactory,
        eventTarget,
        browserEvents: type => browserEvents.get(type),
        emitSocket: (type, payload) => handlers.get(type)?.(payload)
    };
}

function productionBridgeOwners(root) {
    const owners = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== '__tests__') walk(fullPath);
                continue;
            }
            if (!/\.(js|ts|vue)$/.test(entry.name)
                || /\.(spec|test)\.[^.]+$/.test(entry.name)
                || fullPath.endsWith(path.join('admin', 'realtime.js'))) continue;
            const source = fs.readFileSync(fullPath, 'utf8');
            if (/createAdminRealtimeBridge\s*\(/.test(source)) owners.push(fullPath);
        }
    };
    walk(root);
    return owners;
}

describe('admin realtime bridge', () => {
    it('forwards the device access event so the panel refreshes without polling', () => {
        const harness = makeHarness();
        createAdminRealtimeBridge(harness);
        harness.emitSocket('device_access_changed', {});
        expect(harness.browserEvents('device_access_changed')).toHaveLength(1);
    });

    it('invalidates settings before notifying consumers and reconciles after reconnect', async () => {
        let storeName = 'Original';
        vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, store_name: storeName }) })));
        const harness = makeHarness();
        createAdminRealtimeBridge(harness);
        const reads = [];
        harness.eventTarget.addEventListener('admin:realtime', event => {
            if (['settings_changed', 'socket_reconnected'].includes(event.detail.type)) {
                reads.push(getSystemSettings());
            }
        });
        expect((await getSystemSettings()).store_name).toBe('Original');
        storeName = 'Saved remotely';
        harness.emitSocket('settings_changed', { keys: ['store_name'] });
        expect((await reads.at(-1)).store_name).toBe('Saved remotely');
        storeName = 'Changed while offline';
        harness.emitSocket('disconnect');
        harness.emitSocket('connect');
        expect((await reads.at(-1)).store_name).toBe('Changed while offline');
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('defaults to the bundled socket.io client, not a page global', () => {
        const harness = makeHarness();
        io.mockReturnValueOnce(harness.socket);
        createAdminRealtimeBridge({ eventTarget: harness.eventTarget });
        expect(io).toHaveBeenCalledTimes(1);
        expect(io).toHaveBeenCalledWith({ ...SOCKET_CLIENT_OPTIONS, withCredentials: true });
    });

    it('owns one socket, forwards compatibility events once, and emits honest recovery', () => {
        const harness = makeHarness();
        const stop = createAdminRealtimeBridge(harness);

        expect(harness.ioFactory).toHaveBeenCalledTimes(1);
        expect(harness.ioFactory).toHaveBeenCalledWith({
            ...SOCKET_CLIENT_OPTIONS,
            withCredentials: true
        });
        expect(harness.socket.io.handlers.has('reconnect_failed')).toBe(true);

        harness.emitSocket('connect');
        expect(harness.browserEvents('socket_connect')).toHaveLength(1);
        expect(harness.browserEvents('socket_reconnected')).toHaveLength(0);

        harness.emitSocket('disconnect');
        harness.emitSocket('connect');
        expect(harness.browserEvents('socket_reconnected')).toHaveLength(1);
        harness.emitSocket('connect');
        expect(harness.browserEvents('socket_reconnected')).toHaveLength(1);

        for (const type of [
            'inventory_changed', 'new_order', 'shifts_changed', 'table_update',
            'expenses_changed', 'settings_changed', 'printer_status_changed',
            'failed_print_jobs_count', 'stale_print_stations',
            'print_queue_updated', 'jofotara_operations_changed', 'ingredients_changed'
        ]) {
            const payload = { marker: type };
            harness.emitSocket(type, payload);
            expect(harness.browserEvents('admin:realtime').at(-1).detail)
                .toEqual({ type, payload });
            expect(harness.browserEvents(type)).toHaveLength(1);
            expect(harness.browserEvents(type)[0].detail).toEqual(payload);
        }

        stop();
        stop();
        expect(harness.socket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('treats recovery from an initial non-auth connection failure as a reconnection', () => {
        const harness = makeHarness();
        createAdminRealtimeBridge(harness);

        harness.socket.active = true; // socket.io keeps retrying transport failures itself
        harness.emitSocket('connect_error', new Error('websocket error'));
        harness.emitSocket('connect');

        expect(harness.browserEvents('socket_reconnected')).toHaveLength(1);
    });

    it('reconnects exactly once after a server-forced disconnect until the next connect', () => {
        const harness = makeHarness();
        createAdminRealtimeBridge(harness);
        harness.emitSocket('connect');
        harness.emitSocket('disconnect', 'transport close');
        expect(harness.socket.connect).not.toHaveBeenCalled();
        harness.emitSocket('disconnect', 'io server disconnect');
        harness.emitSocket('disconnect', 'io server disconnect');
        expect(harness.socket.connect).toHaveBeenCalledTimes(1);
        harness.emitSocket('connect');
        harness.emitSocket('disconnect', 'io server disconnect');
        expect(harness.socket.connect).toHaveBeenCalledTimes(2);
    });

    it('reconnects after the server refuses a connection, and stops retrying once stopped', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(1);
        try {
            const harness = makeHarness();
            const stop = createAdminRealtimeBridge(harness);
            harness.emitSocket('connect_error', new Error('Server is starting.'));
            await vi.advanceTimersByTimeAsync(999);
            expect(harness.socket.connect).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(harness.socket.connect).toHaveBeenCalledTimes(1);
            harness.emitSocket('connect_error', new Error('Service unavailable.'));
            stop();
            await vi.advanceTimersByTimeAsync(60000);
            expect(harness.socket.connect).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
            vi.restoreAllMocks();
        }
    });

    it('retries a failed business-config read on connect and on the heartbeat, and unbinds when stopped', () => {
        retryFailedBusinessConfig.mockClear();
        const harness = makeHarness();
        const stop = createAdminRealtimeBridge(harness);
        harness.emitSocket('connect');
        harness.socket.io.handlers.get('ping')();
        expect(retryFailedBusinessConfig).toHaveBeenCalledTimes(2);
        stop();
        expect(harness.socket.io.handlers.has('ping')).toBe(false);
    });

    it('announces each socket heartbeat so failed admin reads can retry on it', () => {
        const harness = makeHarness();
        const beats = [];
        harness.eventTarget.addEventListener('admin:socket-heartbeat', () => beats.push(1));
        const stop = createAdminRealtimeBridge(harness);
        harness.socket.io.handlers.get('ping')();
        harness.socket.io.handlers.get('ping')();
        expect(beats).toHaveLength(2);
        stop();
    });

    it('does not reconnect or log out again while this admin session is ending', () => {
        const harness = makeHarness();
        createAdminRealtimeBridge(harness);
        harness.emitSocket('connect');
        setSessionEnding(true);
        harness.emitSocket('disconnect', 'io server disconnect');
        expect(harness.socket.connect).not.toHaveBeenCalled();
        harness.emitSocket('connect_error', new Error('Unauthorized: expired'));
        expect(harness.browserEvents('socket_auth_error')).toHaveLength(0);
    });

    it('disconnects unauthorized sockets without inventing a recovery event', () => {
        const harness = makeHarness();
        createAdminRealtimeBridge(harness);

        harness.emitSocket('connect_error', new Error('Unauthorized: expired'));
        expect(harness.socket.disconnect).toHaveBeenCalledTimes(1);
        expect(harness.browserEvents('socket_auth_error')[0].detail).toBe('Unauthorized: expired');
        expect(harness.browserEvents('socket_reconnected')).toHaveLength(0);
    });

    it('keeps bridge ownership in the authenticated shell and prevents late startup', () => {
        const root = path.join(process.cwd(), 'src', 'admin');
        const appPath = path.join(root, 'App.vue');
        const appSource = fs.readFileSync(appPath, 'utf8');
        const stockAlertsSource = fs.readFileSync(
            path.join(root, 'composables', 'useStockAlerts.js'),
            'utf8'
        );
        const tableMapSource = fs.readFileSync(path.join(root, 'pages', 'TableMapEditor.vue'), 'utf8');

        expect(appSource).toContain('createAdminRealtimeBridge');
        expect(stockAlertsSource).not.toContain('createAdminRealtimeBridge');
        expect(tableMapSource).not.toContain("addEventListener('table_update'");
        expect(productionBridgeOwners(root)).toEqual([appPath]);

        const bootstrapIndex = appSource.indexOf('const ok = await session.bootstrap()');
        const aliveIndex = appSource.indexOf('if (!shellAlive || !ok) return');
        const roleIndex = appSource.indexOf("if (userRole.value !== 'admin'");
        const alertsIndex = appSource.indexOf('alerts.start()');
        const bridgeIndex = appSource.lastIndexOf('createAdminRealtimeBridge()');
        for (const index of [bootstrapIndex, aliveIndex, roleIndex, alertsIndex, bridgeIndex]) {
            expect(index).toBeGreaterThanOrEqual(0);
        }
        expect(bootstrapIndex).toBeLessThan(aliveIndex);
        expect(aliveIndex).toBeLessThan(roleIndex);
        // The socket subscribes before the first alerts read, so a change after that read arrives as an event.
        expect(roleIndex).toBeLessThan(bridgeIndex);
        expect(bridgeIndex).toBeLessThan(alertsIndex);
        expect(appSource).toContain('let shellAlive = true');

        const unmountIndex = appSource.indexOf('onUnmounted(() =>');
        const stopIndex = appSource.indexOf('stopRealtime?.()', unmountIndex);
        const deadIndex = appSource.indexOf('shellAlive = false', unmountIndex);
        expect(unmountIndex).toBeGreaterThanOrEqual(0);
        expect(deadIndex).toBeGreaterThan(unmountIndex);
        expect(deadIndex).toBeLessThan(stopIndex);
    });
});
