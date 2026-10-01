import { ref } from 'vue';

const activeUser = ref({ id: 20, role: 'call_center' });
const handlers = new Map();
const fakeSocket = {
    connected: true,
    io: { on: vi.fn() },
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    emit: vi.fn(),
    disconnect: vi.fn()
};

vi.mock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }));
vi.mock('../useAuth.js', () => ({
    useAuth: () => ({ activeUser, logout: vi.fn() })
}));

describe('useSocket call-center boundary', () => {
    beforeEach(() => {
        vi.stubGlobal('CustomEvent', class CustomEvent {
            constructor(type) {
                this.type = type;
            }
        });
        vi.stubGlobal('window', { dispatchEvent: vi.fn() });
        fakeSocket.emit.mockClear();
        fakeSocket.disconnect.mockClear();
        handlers.clear();
        activeUser.value = { id: 20, role: 'call_center' };
        vi.resetModules();
    });

    it('ignores printer metadata for call center', async () => {
        const { useSocket } = await import('../useSocket.js');
        const socketState = useSocket();
        socketState.initSocket();

        handlers.get('printer_status_changed')?.([{ id: 1, online: true }]);
        handlers.get('failed_print_jobs_count')?.(3);

        expect(socketState.printerStatuses.value).toEqual([]);
        expect(socketState.failedPrintJobsCount.value).toBe(0);
    });

    it('refreshes once when the initial connection recovers from a connection error', async () => {
        const { useSocket } = await import('../useSocket.js');
        const socketState = useSocket();
        socketState.initSocket();

        handlers.get('connect')?.();
        expect(window.dispatchEvent).not.toHaveBeenCalled();

        handlers.get('connect_error')?.(new Error('websocket error'));
        handlers.get('connect')?.();
        handlers.get('connect')?.();

        expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
        expect(window.dispatchEvent.mock.calls[0][0].type).toBe('socket_reconnected');
    });
});
