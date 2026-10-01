import { fetchJson } from '@/shared/http.js';
import { ref, onMounted, onUnmounted } from 'vue';
import { clearPosOrderSessionStorage } from '@/pos/posSessionStorage.js';
import { setSessionEnding } from '@/pos/sessionEnding.js';

export function useAdminSession() {
    const activeUser = ref(null);
    const userRole = ref('');

    // notifyServer=false: the server already refused this session (socket
    // Unauthorized), so only clean up locally. A late logout request from this
    // tab could otherwise revoke a newer login made in another tab.
    const logout = async (reason = null, { notifyServer = true } = {}) => {
        setSessionEnding(true);
        // Clearing the active user first tells sibling tabs (storage event) to
        // stand down before the server revokes the session and drops their
        // sockets, so they neither reconnect nor send a second logout.
        localStorage.removeItem('pos_active_user_id');
        if (notifyServer) {
            try { await fetch('api/auth/logout', { method: 'POST' }); } catch (_) {}
        }
        sessionStorage.removeItem('pos_user');
        sessionStorage.removeItem('pos_token');
        localStorage.removeItem('pos_token');
        localStorage.removeItem('admin_current_page');
        clearPosOrderSessionStorage();

        const redirectPath = reason ? `/login?reason=${reason}` : '/login';
        window.location.href = redirectPath;
    };

    const handleSocketAuthError = async () => {
        await logout('expired', { notifyServer: false });
    };

    const handleStorageChange = async (event) => {
        if (event.key === 'pos_active_user_id') {
            const storedUserId = event.newValue;
            const currentUserId = (() => {
                try {
                    const user = JSON.parse(sessionStorage.getItem('pos_user'));
                    return user ? String(user.id) : null;
                } catch (_) { return null; }
            })();

            if (!storedUserId) {
                setSessionEnding(true);
                sessionStorage.removeItem('pos_user');
                sessionStorage.removeItem('pos_token');
                localStorage.removeItem('pos_token');
                clearPosOrderSessionStorage();
                window.location.href = '/login';
            } else if (storedUserId !== currentUserId) {
                sessionStorage.removeItem('pos_user');
                window.location.reload();
            }
        }
    };

    // Restores the session into the reactive refs. Returns false if no session
    // could be established (caller must early-return — a redirect is underway).
    const bootstrap = async () => {
        let userStr = sessionStorage.getItem('pos_user');
        if (!userStr) {
            try {
                const data = await fetchJson('api/auth/me');
                if (data.success && data.user) {
                    sessionStorage.setItem('pos_user', JSON.stringify(data.user));
                    localStorage.setItem('pos_active_user_id', data.user.id);
                    userStr = JSON.stringify(data.user);
                }
            } catch (e) {
                console.error("Failed to restore admin session on App mount:", e);
            }
        }

        if (!userStr) {
            window.location.href = '/login';
            return false;
        }

        activeUser.value = JSON.parse(userStr);
        userRole.value = activeUser.value.role;
        return true;
    };

    onMounted(() => {
        window.addEventListener('storage', handleStorageChange);
        window.addEventListener('socket_auth_error', handleSocketAuthError);
    });

    onUnmounted(() => {
        window.removeEventListener('storage', handleStorageChange);
        window.removeEventListener('socket_auth_error', handleSocketAuthError);
    });

    return { activeUser, userRole, bootstrap, logout };
}
