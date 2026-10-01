import '@/shared/authInterceptor.js';
import { createApp } from 'vue';
import App from './App.vue';
import router, { loadPosTerminal, loadTableFloorPlan } from './router.js';
import { createPosI18n, currentLanguage, prepareLanguage, setLanguage, deferLanguage } from '@/shared/i18n.js';
import { injectStoreFavicon } from '@/shared/faviconInjector.js';
import { createPinia } from 'pinia';
import { startPendingBrowserApprovalMonitor } from '@/shared/browserDeviceClient.js';
import { loadBusinessConfig } from './utils/businessDate.js';

// Init language and direction to prevent FOUC
(() => {
    const language = localStorage.getItem('pos_admin_language') || 'en';
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
})();

// Service worker removed: POS is online-only. Existing terminals may still have
// an old worker installed, so unregister it and clear its caches on next load.
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
        .then((registrations) => registrations.forEach((reg) => reg.unregister()))
        .catch(() => {});
    if (window.caches && typeof caches.keys === 'function') {
        caches.keys()
            .then((keys) => keys.forEach((key) => caches.delete(key)))
            .catch(() => {});
    }
}

const app = createApp(App);
if (import.meta.env.DEV) app.config.performance = true;

// ── Vue Global Error Handler ──────────────────────────────────────────────────
// Catches unhandled errors thrown inside any Vue component (setup, onMounted,
// template expressions, computed, etc.). Without this, a thrown error silently
// freezes the affected component with no user-visible feedback.
app.config.errorHandler = (err, _instance, info) => {
    console.error('[POS Vue Error]', info, err);
    // Show a non-blocking toast so the cashier knows something went wrong.
    // Uses the window polyfill defined in App.vue (safe to call at any time).
    if (typeof window.showPosToast === 'function') {
        window.showPosToast('An unexpected UI error occurred. Please refresh the page if the issue persists.', 'error');
    }
};

const readStoredRole = () => {
    try {
        return JSON.parse(sessionStorage.getItem('pos_user'))?.role;
    } catch (e) {
        return null;
    }
};

async function bootstrapPos() {
    try {
        const pathname = window.location.pathname;
        const isPublicRoute = pathname === '/login' || pathname === '/device-enrollment';
        if (!isPublicRoute) {
            // Warm the route chunk while the business config round trip is in flight.
            const wantsTables = pathname.startsWith('/tables') || (pathname === '/' && readStoredRole() === 'waiter');
            void (wantsTables ? loadTableFloorPlan : loadPosTerminal)().catch(() => {});
        }
        const businessConfigReady = isPublicRoute
            ? Promise.resolve()
            : loadBusinessConfig().catch(error => { console.warn('[POS Business Config]', error); });
        // Bounded: a stalled dictionary chunk falls back to English and is applied
        // when it arrives (or retried on the socket heartbeat after a failure).
        const wantedLanguage = currentLanguage.value;
        const languageReady = await Promise.race([
            prepareLanguage(wantedLanguage),
            new Promise(resolve => setTimeout(resolve, 3000, false)),
        ]);
        if (!languageReady) {
            await setLanguage('en', { persist: false, notify: false });
        }
        await businessConfigReady;
        app.use(createPinia());
        app.use(router);

        app.use(createPosI18n({
          rootSelector: '#app',
          titleKey: 'POS System',
          rtlBodyClass: 'pos-rtl'
        }));

        app.mount('#app');
        if (!languageReady && wantedLanguage !== 'en') deferLanguage(wantedLanguage);
        injectStoreFavicon();
        if (window.location.pathname !== '/login' && window.location.pathname !== '/device-enrollment') {
            startPendingBrowserApprovalMonitor();
        }
    } catch (err) {
        console.error('[POS Boot Error]', err);
        const root = document.getElementById('app');
        if (root) {
            root.innerHTML = '<div style="padding:2rem;text-align:center;font-family:sans-serif;color:#333">' +
                '<h2 style="color:#c00">POS System Failed to Start</h2>' +
                '<p>Please refresh the page. If the problem persists, contact your system administrator.</p>' +
                '</div>';
        }
    }
}
void bootstrapPos();
