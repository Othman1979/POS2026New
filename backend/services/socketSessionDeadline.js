// One timeout per staff socket, armed for the session's next expiry. Every
// in-app revocation already disconnects sockets by room, so the only job left
// is time-based expiry. When the timer fires the session is checked once:
// gone -> disconnect, still active (activity extended it) -> re-arm.
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 2 ** 31 - 1;

// Earlier of idle and absolute expiry, the same rule staffSessions applies.
// The cached socket binding carries the precomputed value as expires_at.
function sessionDeadlineMs(session) {
    if (!session) return NaN;
    if (session.expires_at != null) return new Date(session.expires_at).getTime();
    return Math.min(new Date(session.idle_expires_at).getTime(), new Date(session.absolute_expires_at).getTime());
}

function clampDelay(deadlineMs, now = Date.now()) {
    const delay = deadlineMs - now;
    if (!Number.isFinite(delay)) return MIN_DELAY_MS;
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, delay));
}

function watchSessionDeadline(socket, { findSession, onError = () => {} }) {
    let timer = null;
    const arm = (deadlineMs) => {
        timer = setTimeout(async () => {
            timer = null;
            if (!socket.connected) return;
            try {
                const session = await findSession(socket.rawSessionToken);
                if (!socket.connected) return;
                if (!session) return socket.disconnect(true);
                arm(sessionDeadlineMs(session));
            } catch (error) {
                onError(error);
                if (socket.connected) arm(Date.now() + 60_000);
            }
        }, clampDelay(deadlineMs));
        timer.unref?.();
    };
    arm(sessionDeadlineMs(socket.authSession));
    socket.once('disconnect', () => { clearTimeout(timer); timer = null; });
}

module.exports = { watchSessionDeadline, sessionDeadlineMs };
