import { createApp } from 'vue';
import PrintReceiptApp from './print/PrintReceiptApp.vue';
import { currentLanguage, initI18n, prepareLanguage, setLanguage } from '@/shared/i18n.js';

// Init language and direction to prevent FOUC
(() => {
    try {
        const language = localStorage.getItem('pos_admin_language') || 'en';
        document.documentElement.lang = language;
        document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    } catch (e) {}
})();

async function bootstrapPrintReceipt() {
    const languageReady = await prepareLanguage(currentLanguage.value);
    if (!languageReady) await setLanguage('en', { persist: false, notify: false });
    const app = createApp(PrintReceiptApp);
    initI18n(app, {
        rootSelector: '#printApp',
        titleKey: 'POS Print Spooler',
        rtlBodyClass: 'print-rtl'
    });
    app.mount('#printApp');
}

bootstrapPrintReceipt().catch((error) => {
    console.error('[Receipt Boot Error]', error);
    const root = document.getElementById('printApp');
    if (root) root.textContent = 'The receipt preview could not be loaded. Please refresh and try again.';
});
