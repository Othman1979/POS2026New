import { createApp } from 'vue';
import MenuApp from './menu/MenuApp.vue';
import { currentLanguage, initI18n, prepareLanguage, setLanguage } from '@/shared/i18n.js';
import '@/shared/authInterceptor.js';
import { injectStoreFavicon } from '@/shared/faviconInjector.js';

// Init language and direction to prevent FOUC
(() => {
    try {
        const language = localStorage.getItem('pos_admin_language') || 'en';
        document.documentElement.lang = language;
        document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    } catch (e) {}
})();

async function bootstrapMenu() {
    const languageReady = await prepareLanguage(currentLanguage.value);
    if (!languageReady) await setLanguage('en', { persist: false, notify: false });
    const app = createApp(MenuApp);
    initI18n(app, {
        rootSelector: '#menu-app',
        titleKey: 'Our Digital Menu',
        rtlBodyClass: 'menu-rtl'
    });
    app.mount('#menu-app');
    injectStoreFavicon();
}

bootstrapMenu().catch((error) => {
    console.error('[Menu Boot Error]', error);
    const root = document.getElementById('menu-app');
    if (root) root.textContent = 'The menu could not be loaded. Please refresh and try again.';
});
