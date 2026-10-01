// socket.io-client never retries a connection the server refused with a
// middleware error (still starting, or its database check failed): after such
// a refusal socket.active is false and realtime stays dead until a reload.
// Callers report refusals that are not "Unauthorized:"; this reconnects with
// backoff (1, 2, 4 ... 30 s) with equal jitter (between half and the full delay)
// so clients don't return in one burst. Transport failures keep socket.io's own
// retry, configured by SOCKET_CLIENT_OPTIONS and applyReconnectPolicy below.

// One reconnect policy for every realtime client (POS, admin, menu). Capped
// backoff with jitter keeps a venue behind a banned IP or a down server from
// hammering it. 500 attempts is well under socket.io's backoff overflow.
export const SOCKET_CLIENT_OPTIONS = Object.freeze({
    transports: ['websocket'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    reconnectionAttempts: 500,
});

// When socket.io gives up after its attempt budget, start a fresh cycle: the
// manager has already reset its backoff, so connect() begins again at 1 s.
export function applyReconnectPolicy(socket) {
    socket.io?.on('reconnect_failed', () => socket.connect());
}

export function createRefusalRetry(socket) {
    let timer = null;
    let refusals = 0;
    let serverDisconnectRetried = false;
    const cancel = () => {
        clearTimeout(timer);
        timer = null;
    };
    return {
        // socket.io never reconnects a server-forced disconnect; retry the
        // handshake once (it succeeds, or is refused and handled by the caller).
        serverDisconnected(reason) {
            if (reason !== 'io server disconnect' || serverDisconnectRetried) return;
            serverDisconnectRetried = true;
            socket.connect();
        },
        connected() {
            serverDisconnectRetried = false;
            refusals = 0;
            cancel();
        },
        refused() {
            if (socket.active || timer) return;
            const base = Math.min(30000, 1000 * 2 ** refusals);
            const delay = base / 2 + Math.random() * (base / 2);
            refusals += 1;
            timer = setTimeout(() => {
                timer = null;
                socket.connect();
            }, delay);
        },
        cancel,
    };
}
