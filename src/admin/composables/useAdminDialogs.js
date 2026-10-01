import { ref } from 'vue';
import { t } from '@/shared/i18n.js';

// Module-scoped singletons: the admin shell mounts exactly one set of dialogs
// for the app's lifetime. Mirrors the singleton pattern in systemSettings.js.
export const customAlert = ref({ show: false, message: '', title: '', resolve: null });
export const customConfirm = ref({ show: false, message: '', title: '', resolve: null });
export const customPrompt = ref({ show: false, message: '', title: '', defaultValue: '', placeholder: '', value: '', resolve: null });
export const customToast = ref({ show: false, message: '', type: 'info' });

let toastTimeout = null;
let installed = false;

// Installs the global window.* dialog API consumed across ~16 admin modules
// (152 call sites). Idempotent — safe to call once from the shell's setup().
export function installAdminDialogGlobals() {
    if (installed) return;
    installed = true;

    window.showAdminAlert = (message, title = '') => new Promise((resolve) => {
        customAlert.value = { show: true, message, title: title || t('Alert'), resolve };
    });

    window.showAdminConfirm = (message, title = '') => new Promise((resolve) => {
        customConfirm.value = { show: true, message, title: title || t('Confirm'), resolve };
    });

    window.showAdminPrompt = (message, defaultValue = '', placeholder = '', title = '') => new Promise((resolve) => {
        customPrompt.value = {
            show: true, message, title: title || t('Prompt'),
            defaultValue, placeholder, value: defaultValue, resolve
        };
    });

    window.showAdminToast = (message, type = 'info') => {
        customToast.value = { show: true, message, type };
        if (toastTimeout) clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => { customToast.value.show = false; }, 3000);
    };

    // Fallback: route native alert() through the styled dialog.
    window.alert = (message) => { window.showAdminAlert(message); };
}
