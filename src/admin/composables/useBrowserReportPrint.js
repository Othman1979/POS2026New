import { ref } from 'vue';
import { getSystemSettings } from '@/shared/systemSettings.js';
import { t } from '@/shared/i18n.js';
import { getBusinessConfig } from '@/utils/businessDate.js';

const PRINT_STORE_INFO_KEYS = [
    'store_name',
    'store_address',
    'store_phone',
    'receipt_config',
    'tax_inclusive_pricing'
];
const READY_TIMEOUT_MS = 10000;
const PRINT_LAYOUTS = new Set(['thermal', 'a4']);
const ADMIN_REPORT_TYPES = new Set([
    'daily_summary_report',
    'daily_sales_report',
    'daily_refunds_report',
    'daily_expenses_report',
    'daily_ingredients_report',
    'x_report',
    'z_report',
    'audit_report',
    'category_items_report',
    'y_held_items_report'
]);

function printNonce() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    if (globalThis.crypto?.getRandomValues) {
        const bytes = globalThis.crypto.getRandomValues(new Uint32Array(4));
        return Array.from(bytes, value => value.toString(16).padStart(8, '0')).join('');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function pickPrintStoreInfo(...sources) {
    const merged = Object.assign({}, ...sources.filter(source => source && typeof source === 'object'));
    return Object.fromEntries(PRINT_STORE_INFO_KEYS.map(key => [key, merged[key] ?? '']));
}

async function showPrintFailure() {
    if (typeof window.showAdminAlert === 'function') {
        await window.showAdminAlert(t('Printing failed.'));
    }
}

export function useBrowserReportPrint() {
    const isPrinting = ref(false);

    const printReport = async (layout, provider) => {
        if (isPrinting.value || !PRINT_LAYOUTS.has(layout) || typeof provider !== 'function') return false;

        isPrinting.value = true;
        let popup = null;
        let removeReadyListener = () => {};

        try {
            popup = window.open('about:blank', '_blank');
            if (!popup) {
                await showPrintFailure();
                return false;
            }

            const nonce = printNonce();
            const language = localStorage.getItem('pos_admin_language') === 'ar' ? 'ar' : 'en';
            const direction = language === 'ar' ? 'rtl' : 'ltr';
            const printUrl = new URL('/print-receipt', window.location.origin);
            printUrl.searchParams.set('admin_report', nonce);
            printUrl.searchParams.set('layout', layout);
            printUrl.searchParams.set('lang', language);

            const ready = new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => reject(new Error('Print preview did not become ready.')), READY_TIMEOUT_MS);
                const onMessage = event => {
                    if (event.origin !== window.location.origin || event.source !== popup) return;
                    const message = event.data;
                    if (!message || message.type !== 'POS_ADMIN_PRINT_READY') return;
                    if (message.nonce !== nonce || message.layout !== layout) return;
                    clearTimeout(timeoutId);
                    window.removeEventListener('message', onMessage);
                    removeReadyListener = () => {};
                    resolve();
                };
                removeReadyListener = () => {
                    clearTimeout(timeoutId);
                    window.removeEventListener('message', onMessage);
                };
                window.addEventListener('message', onMessage);
            });

            popup.location.href = printUrl.toString();
            await ready;

            if (popup.closed) return false;
            const settings = await getSystemSettings();
            if (!settings?.success) throw new Error('System settings are unavailable.');
            window.focus();
            const pagePayload = await provider();
            if (pagePayload === false) {
                popup.close();
                return false;
            }
            if (!ADMIN_REPORT_TYPES.has(pagePayload?.print_type)) throw new Error('Unsupported admin report print type.');
            if (popup.closed) return false;

            const storeInfo = pickPrintStoreInfo(
                settings,
                pagePayload.storeInfo
            );
            const data = {
                ...pagePayload,
                storeInfo,
                business_config: getBusinessConfig(),
                language,
                direction
            };
            const transferableData = JSON.parse(JSON.stringify(data));

            popup.postMessage({
                type: 'POS_ADMIN_PRINT_PAYLOAD',
                nonce,
                layout,
                payload: {
                    type: pagePayload.print_type,
                    data: transferableData,
                    language,
                    direction
                }
            }, window.location.origin);
            return true;
        } catch (error) {
            console.error('Browser report printing failed:', error);
            if (popup && !popup.closed) popup.close();
            await showPrintFailure();
            return false;
        } finally {
            removeReadyListener();
            isPrinting.value = false;
        }
    };

    return { printReport, isPrinting };
}
