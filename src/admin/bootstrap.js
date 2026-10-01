import { createApp } from 'vue';
import { isNavigationFailure } from 'vue-router';
import { createAdminRouter } from './router.js';
import { initialPage, preloadPage } from './pageRegistry.js';
import '@/shared/authInterceptor.js';
// Arabic subset only: the two weights the admin actually uses, bundled rather
// than fetched, because these machines run offline.
import '@fontsource/amiri/arabic-400.css';
import '@fontsource/amiri/arabic-700.css';
import './styles.css';
import { injectStoreFavicon } from '@/shared/faviconInjector.js';
import { loadBusinessConfig } from '../utils/businessDate.js';
import { startPendingBrowserApprovalMonitor } from '@/shared/browserDeviceClient.js';

// Init language and direction to prevent FOUC
(() => {
    try {
        var savedLanguage = localStorage.getItem('pos_admin_language') || 'en';
        var isArabic = savedLanguage === 'ar';
        document.documentElement.lang = isArabic ? 'ar' : 'en';
        document.documentElement.dir = isArabic ? 'rtl' : 'ltr';
    } catch (error) {
        document.documentElement.lang = 'en';
        document.documentElement.dir = 'ltr';
    }
})();

async function bootstrapAdmin() {
    // Start everything the first render needs at once: the page chunk the router
    // will ask for, the business config, and the language dictionary.
    preloadPage(initialPage(window.location.pathname, () => localStorage));
    const businessConfigReady = loadBusinessConfig().catch(error => {
        console.warn('Failed to load business date config; using fixed defaults.', error);
    });
    const i18nReady = import('@/shared/i18n.js').then(async (i18n) => {
        const languageReady = await i18n.prepareLanguage(i18n.currentLanguage.value);
        if (!languageReady) await i18n.setLanguage('en', { persist: false, notify: false });
        return i18n;
    });
    const [{ default: App }, { createPosI18n }] = await Promise.all([
        import('./App.vue'),
        i18nReady
    ]);
    await businessConfigReady;

    const app = createApp(App);
    const router = createAdminRouter();

    // ── Vue Global Error Handler ──────────────────────────────────────────────
    // Catches runtime errors thrown inside any Vue component after mount.
    // The bootstrap-level .catch() handles pre-mount boot failures separately.
    app.config.errorHandler = (err, _instance, info) => {
        console.error('[Admin Vue Error]', info, err);
        // Dispatch a CustomEvent so the admin shell's socket status bar or
        // any mounted toast mechanism can pick it up without a hard dependency.
        window.dispatchEvent(new CustomEvent('admin:vue_error', {
            detail: { message: err?.message || 'An unexpected UI error occurred.', info }
        }));
    };

    app.use(router);
    app.use(createPosI18n({
        rootSelector: '#admin-app',
        titleKey: 'POS - Admin',
        rtlBodyClass: 'admin-rtl'
    }));

    await router.isReady();
    app.mount('#admin-app');
    injectStoreFavicon();
    startPendingBrowserApprovalMonitor();

}

bootstrapAdmin().catch((error) => {
    if (isNavigationFailure(error)) {
        return;
    }
    console.error('Failed to boot admin app', error);
    const root = document.getElementById('admin-app');
    if (root) {
        root.innerHTML = `
            <div class="h-full flex items-center justify-center text-center p-6 bg-background text-muted-foreground">
                <div>
                    <i class="fa-solid fa-triangle-exclamation text-4xl text-destructive mb-4"></i>
                    <p class="font-semibold text-foreground">Admin failed to load.</p>
                    <p class="text-sm text-muted-foreground mt-2">Refresh the page and try again.</p>
                </div>
            </div>
        `;
    }
});
