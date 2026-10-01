import { createRouter, createWebHistory } from 'vue-router';
import { fetchReadJsonResponse } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';
import permissionPolicy from '@posapp/permission-policy';
import Login from './components/Login.vue';
import { hasActiveTableSession } from '@/pos/posSessionStorage.js';

export const loadPosTerminal = () => import('./components/PosTerminal.vue');
export const loadTableFloorPlan = () => import('./components/TableFloorPlan.vue');

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: Login
  },
  {
    path: '/device-enrollment',
    name: 'DeviceEnrollment',
    component: () => import('./components/DeviceEnrollment.vue')
  },
  {
    path: '/pos',
    name: 'POS',
    component: loadPosTerminal,
    meta: { requiresAuth: true }
  },
  {
    path: '/tables',
    name: 'Tables',
    component: loadTableFloorPlan,
    meta: { requiresAuth: true }
  },
  {
    path: '/order-notes',
    name: 'OrderNotes',
    component: () => import('./components/OrderNotes.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/table-splits',
    name: 'TableSplits',
    component: () => import('./components/TableSplits.vue'),
    meta: { requiresAuth: true }
  },
  // ACCEPTED RISK (2026-06-22 audit A2-HIGH): These redirects read client-editable sessionStorage role.
  // Assessed safe because: (a) target routes require real server auth via requiresAuth + beforeEach,
  // (b) PosTerminal and TableFloorPlan gate features by server-confirmed permissions, not client role.
  // A tampered role can only change which face the user is redirected to, not what they can access.
  {
    path: '/',
    redirect: to => {
      const user = sessionStorage.getItem('pos_user');
      if (user) {
        try {
          const parsedUser = JSON.parse(user);
          if (parsedUser.role === 'waiter') {
            return '/tables';
          }
        } catch (e) {}
      }
      return '/pos';
    }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: to => {
      const user = sessionStorage.getItem('pos_user');
      if (user) {
        try {
          const parsedUser = JSON.parse(user);
          if (parsedUser.role === 'waiter') {
            return '/tables';
          }
        } catch (e) {}
      }
      return '/pos';
    }
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

const SESSION_REVALIDATE_MS = 30 * 60 * 1000; // re-verify server session every 30 min

const AUTH_CHECK_TIMEOUT_MS = 8000;
const COLD_RETRY_DELAYS_MS = [1000, 2000, 4000];

let pendingAuthCheck = null; // Deduplicates concurrent session checks

// Resolves to the server user, null when the server rejected the session (401),
// or throws on a network error, timeout or 5xx (the session is unknown, not dead).
function checkSession() {
  if (!pendingAuthCheck) {
    pendingAuthCheck = fetchReadJsonResponse('api/auth/me', {}, AUTH_CHECK_TIMEOUT_MS)
      .then(({ response, data }) => {
        if (response.status === 401) {
          // The server rejected the session: drop the signed-in hint the index.html boot shell reads.
          try { localStorage.removeItem('pos_active_user_id'); } catch (_) {}
          return null;
        }
        if (!response.ok || !data?.success || !data.user) throw new Error(`Session check unavailable (${response.status})`);
        sessionStorage.setItem('pos_user', JSON.stringify(data.user));
        sessionStorage.setItem('pos_user_at', String(Date.now()));
        localStorage.setItem('pos_active_user_id', data.user.id);
        return data.user;
      })
      .finally(() => { pendingAuthCheck = null; });
  }
  return pendingAuthCheck;
}

// Bounded backoff, cut short when the connection comes back; after the last
// delay no timer runs: the next attempt waits for the connection to return or
// for the cashier to touch the screen (a kiosk may never lose focus or go offline).
const RETRY_EVENTS = ['online', 'focus', 'pointerdown', 'keydown'];
function waitForRetry(delayMs) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      for (const type of RETRY_EVENTS) window.removeEventListener(type, done);
      resolve();
    };
    const timer = delayMs == null ? null : setTimeout(done, delayMs);
    for (const type of RETRY_EVENTS) window.addEventListener(type, done);
  });
}

async function restoreColdSession() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await checkSession();
    } catch (e) {
      console.error('Failed to restore POS session', e);
      await waitForRetry(COLD_RETRY_DELAYS_MS[attempt]);
    }
  }
}

router.beforeEach(async (to) => {
  let user = sessionStorage.getItem('pos_user');
  const storedAt = parseInt(sessionStorage.getItem('pos_user_at') || '0', 10);
  const isStale = user && storedAt > 0 && (Date.now() - storedAt > SESSION_REVALIDATE_MS);

  if (to.meta.requiresAuth && !user) {
    const restored = await restoreColdSession();
    user = restored ? JSON.stringify(restored) : null;
  } else if (isStale && to.path === '/login') {
    // Login decides between the form and the terminal, so it waits for the answer.
    try {
      const restored = await checkSession();
      if (restored) user = JSON.stringify(restored);
      else {
        sessionStorage.removeItem('pos_user');
        sessionStorage.removeItem('pos_user_at');
        user = null;
      }
    } catch (e) {
      console.error('Failed to revalidate POS session', e);
    }
  } else if (isStale) {
    // Every API call enforces the session server-side and a 401 SESSION_*
    // already redirects through authInterceptor, so navigation never waits and
    // a hiccup never signs the cashier out.
    checkSession().catch(e => console.error('Failed to revalidate POS session', e));
  }

  if (to.meta.requiresAuth && !user) {
    window.location.href = '/login';
    return false;
  }

  if (to.path === '/login' && user) {
    try {
      const parsedUser = JSON.parse(user);
      if (parsedUser.role === 'admin' || parsedUser.role === 'programmer') {
        window.location.href = '/admin/dashboard';
        return false;
      }
      if (parsedUser.role === 'waiter') {
        return '/tables';
      }
    } catch (e) {
      sessionStorage.removeItem('pos_user');
      sessionStorage.removeItem('pos_user_at');
      return '/login';
    }
    return '/pos';
  }

  if (user) {
    try {
      const parsedUser = JSON.parse(user);
      if (parsedUser.role === 'call_center' && ['/tables', '/table-splits', '/order-notes'].includes(to.path)) {
        return '/pos';
      }
      const has = key => permissionPolicy.userHas(parsedUser, key);
      if (to.path === '/order-notes' && !(has('pos.hold_orders') || has('orders.view'))) {
        return parsedUser.role === 'waiter' ? '/tables' : '/pos';
      }
      if (to.path === '/tables' && !has('tables.access')) {
        return '/pos';
      }
      if (to.path === '/table-splits' && !has('pos.split_checks')) {
        return parsedUser.role === 'waiter' ? '/tables' : '/pos';
      }
      if (parsedUser.role === 'waiter') {
        if (to.path === '/pos' && !hasActiveTableSession(localStorage)) {
          return '/tables';
        }
      }
    } catch (e) {
      sessionStorage.removeItem('pos_user');
      sessionStorage.removeItem('pos_user_at');
      return '/login';
    }
  }
});

// A route chunk (JS or its CSS preload) failed to load: transient network loss,
// or a deployment replaced the hashed chunks. Keep an already-mounted order
// screen intact. On a cold boot there is nothing to preserve: reload once at
// once, and after that only when the connection returns or the user acts, so a
// boot during an outage recovers by itself without a reload loop.
const CHUNK_ERROR_MESSAGES = [
  'Failed to fetch dynamically imported module',
  'failed to fetch dynamically imported module',
  'Importing a module script failed',
  'Unable to preload CSS',
];
const CHUNK_RELOAD_KEY = 'pos_chunk_reload_attempted_at';
// One module-level handler, so repeated failures never stack listeners.
function reloadForChunk() {
  // Reloading while offline would replace the app with the browser's error page.
  if (navigator.onLine === false) return;
  for (const type of RETRY_EVENTS) window.removeEventListener(type, reloadForChunk);
  sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  window.location.reload();
}
router.onError((error) => {
  if (!CHUNK_ERROR_MESSAGES.some(text => error?.message?.includes(text))) return;
  // Offline is a connection problem; online it may be a deployment that replaced the chunks.
  window.showPosToast?.(t(navigator.onLine === false
    ? 'Connection problem. Check the connection and try again.'
    : 'Could not load this screen. Check the connection, or refresh when the current order is complete.'), 'warning');
  const hasMountedRoute = Boolean(router.currentRoute?.value?.matched?.length);
  if (hasMountedRoute || typeof sessionStorage === 'undefined') return;
  if (Date.now() - Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0) > 60_000) reloadForChunk();
  else for (const type of RETRY_EVENTS) window.addEventListener(type, reloadForChunk);
});

export default router;
