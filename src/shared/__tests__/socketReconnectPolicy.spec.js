import { afterEach, describe, expect, it, vi } from 'vitest';
import { Manager } from 'socket.io-client';
import { SOCKET_CLIENT_OPTIONS, applyReconnectPolicy, createRefusalRetry } from '../socketRefusalRetry.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const HOUR = 3600000;

describe('socket reconnect policy', () => {
    it('keeps a permanently failing client to a bounded attempt rate over 10 hours', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.99);
        const times = [];
        // Real Manager, Backoff and reconnect() logic; only the network open() is
        // replaced by a connection that always fails, as a banned IP or dead server does.
        const manager = new Manager('http://127.0.0.1:1', { ...SOCKET_CLIENT_OPTIONS, autoConnect: false });
        const socket = manager.socket('/');
        manager.open = function open(fn) {
            this._readyState = 'opening';
            times.push(Date.now());
            setTimeout(() => {
                this._readyState = 'closed';
                const err = new Error('websocket error');
                this.emitReserved('error', err);
                if (this._reconnection && !this.skipReconnect) this.reconnect();
                fn?.(err);
            }, 0);
            return this;
        };
        applyReconnectPolicy(socket);
        socket.connect();
        await vi.advanceTimersByTimeAsync(10 * HOUR);
        socket.disconnect();

        expect(times.length).toBeGreaterThan(100);
        let worst = 0;
        for (let i = 0, j = 0; i < times.length; i++) {
            while (times[i] - times[j] >= 600000) j++;
            worst = Math.max(worst, i - j + 1);
        }
        expect(worst).toBeLessThanOrEqual(25);
        // After the attempt budget (about 4 h at the cap) a fresh cycle starts
        // instead of going quiet: the last hour still retries at the capped rate.
        const lastHour = times.filter(t => t >= times[0] + 9 * HOUR).length;
        expect(lastHour).toBeGreaterThanOrEqual(100);
        const gaps = times.slice(1).map((t, i) => t - times[i]);
        expect(gaps.slice(500).filter(g => g <= 2000).length).toBeGreaterThan(2);
    });

    it('spreads refusal retries between half and the full backoff delay', async () => {
        vi.useFakeTimers();
        const delays = [];
        for (const r of [0, 0.5, 0.999999]) {
            vi.spyOn(Math, 'random').mockReturnValue(r);
            const socket = { active: false, connect: vi.fn() };
            createRefusalRetry(socket).refused();
            let waited = 0;
            while (!socket.connect.mock.calls.length) { await vi.advanceTimersByTimeAsync(10); waited += 10; }
            delays.push(waited);
            vi.restoreAllMocks();
        }
        expect(delays[0]).toBe(500);
        expect(delays[1]).toBe(750);
        expect(delays[2]).toBeGreaterThanOrEqual(990);
        expect(delays[2]).toBeLessThanOrEqual(1000);
    });
});
