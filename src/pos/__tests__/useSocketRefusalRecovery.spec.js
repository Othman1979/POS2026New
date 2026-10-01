import { ref } from 'vue';
import { io } from 'socket.io-client';
import { SOCKET_CLIENT_OPTIONS } from '@/shared/socketRefusalRetry.js';

// socket.io-client 4.8 does not retry a connection the server refused with a
// middleware error (checked against a real server): socket.active is false.
const logout = vi.fn();
const handlers = new Map();
const fakeSocket = {
    connected: false,
    io: { on: vi.fn() },
    active: false,
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
};

vi.mock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }));
let sessionEnding = false;
const checkPendingBrowserApproval = vi.fn(async () => {});
vi.mock('../useAuth.js', () => ({
    useAuth: () => ({ activeUser: ref({ id: 1, role: 'cashier' }), logout }),
}));
vi.mock('../sessionEnding.js', () => ({ isSessionEnding: () => sessionEnding }));
vi.mock('@/shared/browserDeviceClient.js', () => ({ checkPendingBrowserApproval }));

describe('useSocket recovery after a refused connection', () => {
    let socketState;
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(1);
        vi.stubGlobal('CustomEvent', class CustomEvent { constructor(type) { this.type = type; } });
        vi.stubGlobal('window', { dispatchEvent: vi.fn() });
        handlers.clear();
        fakeSocket.active = false;
        fakeSocket.connect.mockClear();
        fakeSocket.disconnect.mockClear();
        logout.mockClear();
        sessionEnding = false;
        checkPendingBrowserApproval.mockClear();
        vi.resetModules();
        socketState = (await import('../useSocket.js')).useSocket();
        socketState.initSocket();
    });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('opens the socket with the shared reconnect options and restarts after the attempt budget', () => {
        expect(io).toHaveBeenLastCalledWith({ ...SOCKET_CLIENT_OPTIONS, withCredentials: true });
        expect(fakeSocket.io.on).toHaveBeenCalledWith('reconnect_failed', expect.any(Function));
    });

    it('tears down a connected socket without throwing when disconnect emits synchronously', () => {
        fakeSocket.disconnect.mockImplementationOnce(() => handlers.get('disconnect')('io client disconnect'));
        expect(() => socketState.disconnectSocket()).not.toThrow();
        expect(socketState.socket.value).toBeNull();
    });

    it('reconnects with growing delays after the server refuses, and resets once connected', async () => {
        handlers.get('connect_error')(new Error('Server is starting.'));
        await vi.advanceTimersByTimeAsync(999);
        expect(fakeSocket.connect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
        handlers.get('connect_error')(new Error('Service unavailable.'));
        await vi.advanceTimersByTimeAsync(1999);
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fakeSocket.connect).toHaveBeenCalledTimes(2);
        handlers.get('connect')();
        handlers.get('connect_error')(new Error('Server is starting.'));
        await vi.advanceTimersByTimeAsync(1000);
        expect(fakeSocket.connect).toHaveBeenCalledTimes(3);
    });

    it('leaves transport failures to socket.io, which still retries them', async () => {
        fakeSocket.active = true;
        handlers.get('connect_error')(new Error('websocket error'));
        await vi.advanceTimersByTimeAsync(60000);
        expect(fakeSocket.connect).not.toHaveBeenCalled();
    });

    it('logs out without reconnecting when the session is unauthorized', async () => {
        await handlers.get('connect_error')(new Error('Unauthorized: Invalid or expired session.'));
        await vi.advanceTimersByTimeAsync(60000);
        expect(logout).toHaveBeenCalledWith('expired');
        expect(fakeSocket.connect).not.toHaveBeenCalled();
    });

    it('cancels a pending reconnect when the socket is torn down', async () => {
        handlers.get('connect_error')(new Error('Server is starting.'));
        socketState.disconnectSocket();
        await vi.advanceTimersByTimeAsync(60000);
        expect(fakeSocket.connect).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reconnects once after a server-forced disconnect so a new cookie or a refusal takes effect', () => {
        handlers.get('connect')();
        handlers.get('disconnect')('io server disconnect');
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
        handlers.get('disconnect')('io server disconnect');
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
        handlers.get('connect')();
        handlers.get('disconnect')('io server disconnect');
        expect(fakeSocket.connect).toHaveBeenCalledTimes(2);
    });

    it('does not reconnect while the user is logging out or closing the shift', () => {
        handlers.get('connect')();
        sessionEnding = true;
        handlers.get('disconnect')('io server disconnect');
        expect(fakeSocket.connect).not.toHaveBeenCalled();
    });

    it('leaves a transport close to socket.io', () => {
        handlers.get('connect')();
        handlers.get('disconnect')('transport close');
        expect(fakeSocket.connect).not.toHaveBeenCalled();
    });

    it('settles a pending browser approval on the push and on reconnect, not on first connect', () => {
        handlers.get('connect')();
        expect(checkPendingBrowserApproval).not.toHaveBeenCalled();
        handlers.get('device_request_changed')({ request_id: 'r1' });
        expect(checkPendingBrowserApproval).toHaveBeenCalledTimes(1);
        handlers.get('disconnect')('transport close');
        handlers.get('connect')();
        expect(checkPendingBrowserApproval).toHaveBeenCalledTimes(2);
    });
});
