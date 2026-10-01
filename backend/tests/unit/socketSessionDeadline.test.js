const { EventEmitter } = require('events');
const { watchSessionDeadline } = require('../../services/socketSessionDeadline');

const MIN = 60_000;

function fakeSocket(expiresInMs) {
    const socket = new EventEmitter();
    socket.connected = true;
    socket.rawSessionToken = 't';
    socket.authSession = { expires_at: Date.now() + expiresInMs };
    socket.disconnect = vi.fn(() => { socket.connected = false; socket.emit('disconnect'); });
    return socket;
}

const healthy = () => ({
    idle_expires_at: new Date(Date.now() + 30 * MIN),
    absolute_expires_at: new Date(Date.now() + 600 * MIN),
});

describe('watchSessionDeadline', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('a healthy socket makes at most one session query in 10 minutes (the old interval made 10)', async () => {
        const findSession = vi.fn(async () => healthy());
        const socket = fakeSocket(30 * MIN);
        watchSessionDeadline(socket, { findSession });
        await vi.advanceTimersByTimeAsync(10 * MIN);
        expect(findSession.mock.calls.length).toBeLessThanOrEqual(1);
        expect(socket.connected).toBe(true);
    });

    it('re-arms instead of disconnecting when activity extended the session', async () => {
        const findSession = vi.fn(async () => healthy());
        const socket = fakeSocket(30 * MIN);
        watchSessionDeadline(socket, { findSession });
        await vi.advanceTimersByTimeAsync(30 * MIN + 1);
        expect(findSession).toHaveBeenCalledTimes(1);
        expect(socket.disconnect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(29 * MIN);
        expect(findSession).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2 * MIN);
        expect(findSession).toHaveBeenCalledTimes(2);
    });

    it('disconnects at the deadline when the session is gone, and clears the timer on disconnect', async () => {
        const findSession = vi.fn(async () => null);
        const socket = fakeSocket(5000);
        watchSessionDeadline(socket, { findSession });
        await vi.advanceTimersByTimeAsync(5001);
        expect(socket.disconnect).toHaveBeenCalledWith(true);

        const other = fakeSocket(5000);
        watchSessionDeadline(other, { findSession });
        other.emit('disconnect');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clamps huge, missing and past deadlines', async () => {
        const findSession = vi.fn(async () => null);
        const huge = fakeSocket(1e15);
        watchSessionDeadline(huge, { findSession });
        const missing = fakeSocket(0);
        missing.authSession = {};
        watchSessionDeadline(missing, { findSession });
        const past = fakeSocket(-5000);
        watchSessionDeadline(past, { findSession });
        await vi.advanceTimersByTimeAsync(999);
        expect(findSession).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);
        expect(missing.disconnect).toHaveBeenCalled();
        expect(past.disconnect).toHaveBeenCalled();
        expect(huge.disconnect).not.toHaveBeenCalled();
    });

    it('retries in a minute when the check fails', async () => {
        const findSession = vi.fn().mockRejectedValueOnce(new Error('db')).mockResolvedValue(null);
        const onError = vi.fn();
        const socket = fakeSocket(2000);
        watchSessionDeadline(socket, { findSession, onError });
        await vi.advanceTimersByTimeAsync(2001);
        expect(onError).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(MIN);
        expect(socket.disconnect).toHaveBeenCalled();
    });
});
