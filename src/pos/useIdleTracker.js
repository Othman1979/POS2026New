import { clearPosOrderSessionStorage } from './posSessionStorage.js';
import { waitAtMost } from '@/shared/http.js';
import { setSessionEnding } from './sessionEnding.js';

/**
 * useIdleTracker — Frontend idle session management
 *
 * Tracks user inactivity using DOM events. At WARN_AT milliseconds of idle,
 * shows a warning modal. At LOGOUT_AT milliseconds, forces logout.
 *
 * Designed to align with the server-side SESSION_IDLE_TIMEOUT_MS (30 minutes).
 * Every server request already resets the server TTL. The warning modal gives
 * the user a chance to ping the server before the server evicts their token.
 *
 * Usage: call startIdleTracker(activeUser) once, after login.
 *        call stopIdleTracker() in onUnmounted.
 */

const WARN_AT  = 25 * 60 * 1000; // 25 minutes — show warning
const LOGOUT_AT = 30 * 60 * 1000; // 30 minutes — force logout (matches server TTL)

let idleTimer   = null;
let countdownInterval = null;
let lastActivity = 0;
let modalEl     = null;
let activeUserId = null;

// Listeners only stamp the time; one timeout re-arms for the remainder on
// expiry, so mousemove never churns timers. Activity outside the warning card
// dismisses the warning, so an active user is never logged out; pointer moves
// inside the card are left alone so its buttons stay reachable.
function recordActivity(event) {
    if (modalEl && event?.target?.closest?.('#idle-warning-card')) return;
    lastActivity = Date.now();
    if (modalEl) void keepAlive();
}

function checkIdle() {
    const idle = Date.now() - lastActivity;
    if (idle >= LOGOUT_AT) {
        idleTimer = null;
        forceLogout();
        return;
    }
    if (idle >= WARN_AT) showWarning();
    idleTimer = setTimeout(checkIdle, (idle >= WARN_AT ? LOGOUT_AT : WARN_AT) - idle);
}

function resetTimers() {
    lastActivity = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(checkIdle, WARN_AT);
}

// Ping the server (any authenticated request resets its sliding TTL) and
// restart the local idle window.
async function keepAlive() {
    dismissModal();
    resetTimers();
    try {
        if (activeUserId) await waitAtMost(fetch('api/auth/me'), 3000);
    } catch (_) {
        // Network error — session will expire naturally
    }
}

function showWarning() {
    if (modalEl) return; // already shown

    modalEl = document.createElement('div');
    modalEl.id = 'idle-warning-modal';
    modalEl.innerHTML = `
        <div style="
            position: fixed; inset: 0; z-index: 99999;
            background: rgba(15, 23, 42, 0.75);
            display: flex; align-items: center; justify-content: center;
            font-family: system-ui, -apple-system, sans-serif;
        ">
            <div id="idle-warning-card" style="
                background: #1a1a2e; border: 1px solid rgba(255,255,255,0.12);
                border-radius: 12px; padding: 32px; max-width: 380px; width: 90%;
                box-shadow: 0 24px 48px rgba(0,0,0,0.5); text-align: center;
            ">
                <div style="
                    width: 56px; height: 56px; border-radius: 50%;
                    background: rgba(251,191,36,0.15); border: 1px solid rgba(251,191,36,0.3);
                    display: flex; align-items: center; justify-content: center;
                    margin: 0 auto 16px; font-size: 24px;
                ">⏳</div>
                <h3 style="color: #f1f5f9; font-size: 18px; font-weight: 600; margin: 0 0 8px;">
                    Still there?
                </h3>
                <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px; line-height: 1.6;">
                    You've been idle for 25 minutes.<br>
                    You'll be logged out automatically in <strong id="idle-countdown" style="color: #fbbf24;">5:00</strong>.
                </p>
                <div style="display: flex; gap: 12px; justify-content: center;">
                    <button id="idle-logout-btn" style="
                        padding: 10px 20px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12);
                        background: transparent; color: #94a3b8; font-size: 14px; font-weight: 500;
                        cursor: pointer; transition: all 0.2s;
                    ">Log Out Now</button>
                    <button id="idle-stay-btn" style="
                        padding: 10px 20px; border-radius: 8px; border: none;
                        background: linear-gradient(135deg, #6366f1, #8b5cf6);
                        color: #fff; font-size: 14px; font-weight: 600;
                        cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 12px rgba(99,102,241,0.4);
                    ">Keep Me Logged In</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modalEl);

    // Countdown display — updates every second until logout
    const countdownEl = document.getElementById('idle-countdown');
    countdownInterval = setInterval(() => {
        const remaining = LOGOUT_AT - (Date.now() - lastActivity);
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            return;
        }
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        if (countdownEl) {
            countdownEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }
    }, 1000);

    // "Keep Me Logged In" — ping the server (resets server-side TTL), dismiss modal
    document.getElementById('idle-stay-btn')?.addEventListener('click', () => { void keepAlive(); });

    // "Log Out Now" — immediate logout
    document.getElementById('idle-logout-btn')?.addEventListener('click', () => { void forceLogout(); });
}

function dismissModal() {
    clearInterval(countdownInterval);
    countdownInterval = null;
    if (modalEl) {
        document.body.removeChild(modalEl);
        modalEl = null;
    }
}

async function forceLogout() {
    setSessionEnding(true);
    stopIdleTracker();
    dismissModal();

    // Call server first to invalidate token
    await waitAtMost(fetch('api/auth/logout', { method: 'POST', keepalive: true }), 3000);

    sessionStorage.removeItem("pos_user");
    sessionStorage.removeItem("pos_token");
    sessionStorage.removeItem("pos_browser_approval_request_id");
    localStorage.removeItem("pos_token");
    localStorage.removeItem("pos_active_user_id");
    clearPosOrderSessionStorage();
    localStorage.removeItem("admin_current_page");

    window.location.href = '/login?reason=expired';
}

const TRACKED_EVENTS = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];

/**
 * Start tracking idle time. Call once after the user is authenticated.
 * @param {object} user - The active user object (must have an `id` property)
 */
export function startIdleTracker(user) {
    if (!user?.id) return;
    activeUserId = user.id;

    // Reset timers on any user interaction
    TRACKED_EVENTS.forEach(evt => window.addEventListener(evt, recordActivity, { passive: true }));

    resetTimers(); // Start the initial timers
}

/**
 * Stop tracking and clean up all listeners. Call in onUnmounted.
 */
export function stopIdleTracker() {
    TRACKED_EVENTS.forEach(evt => window.removeEventListener(evt, recordActivity));
    clearTimeout(idleTimer);
    idleTimer = null;
    activeUserId = null;
}
