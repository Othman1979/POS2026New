import { fetchJsonResponseWithTimeout, fetchReadJsonResponse } from '@/shared/http.js';
import { setLanguage, t } from '@/shared/i18n.js';
import { isNoteProduct } from '@/pos/noteProductSelections.js';

import { ref, nextTick } from 'vue';
import { applyCatalogSettings } from '@/pos/catalogSettings.js';


// Module-scope state singletons for useTerminal
const barcodeEnabled = ref(false);
const scanMessage = ref("");
let scanMessageTimer = null;
// Cancel the previous clear so an old timer never wipes a newer message.
const showScanMessage = (message) => {
    scanMessage.value = message;
    clearTimeout(scanMessageTimer);
    scanMessageTimer = setTimeout(() => { scanMessage.value = ""; }, 2000);
};
const manualBarcode = ref("");
const barcodeInputRef = ref(null);
let barcodeBuffer = "";
let firstKeyTime = 0;
let lastKeyTime = 0;
let barcodeKeydownHandler = null;
const SCANNER_KEY_GAP_MS = 80;
const SCANNER_MIN_LENGTH = 4;
const SCANNER_MAX_TOTAL_MS = 900;

const showTerminalSettings = ref(false);
const receiptPrinters = ref([]);
const localPrinterId = ref(localStorage.getItem("pos_receipt_printer_id") || "");
const printMethod = ref("browser");
const isPrintingBackend = ref(false);
const receiptTaxInclusiveDisplay = ref(false);
const taxRegistrationType = ref('sales_tax');
const salesTaxNumber = ref('');
const incomeTaxNumber = ref('');
const useInvoiceNoOnly = ref(false);
const duplicateCustomerReceipt = ref(false);
const quickNumpadMode = ref(false);
const quantityPresetsEnabled = ref(true);
const tablesEnabledSetting = ref(false);
let settingsPromise = null;
let settingsRefreshRequested = false;
// A failed read gets three quick retries for a blip. After that nothing runs on
// a clock: recovery follows events that prove the server is reachable (socket
// heartbeat, reconnect, settings change, focus, Retry), and every one of them
// is a no-op while settings are fine.
const SETTINGS_RETRY_MS = [2000, 5000, 10000];
let settingsFailures = 0;
let settingsRetryTimer = null;
const cancelSettingsRecovery = () => {
    clearTimeout(settingsRetryTimer);
    settingsRetryTimer = null;
};
let receiptPrintersPromise = null;
const settingsLoaded = ref(false);
const settingsLoading = ref(false);
const settingsError = ref('');

const storeName = ref("Premium POS");
const storeAddress = ref("");
const storePhone = ref("");
const receiptData = ref(null);
const receiptConfig = ref({
    layout: ['header', 'meta', 'customer', 'items', 'totals', 'payment', 'footer'],
    customHeaderText: '',
    customFooterText: 'Thank you for your visit!'
});

const showReceiptModal = ref(false);
const lastOrder = ref(null);
let _barcodeProducts = null;
let _barcodeAddToCart = null;
let _beforeBarcodeAttempt = null;
let cartCoreRef = null;
let salesContextRef = null;

export function useTerminal({ cartCore, salesContext } = {}) {
    if (cartCore) {
        cartCoreRef = cartCore;
    }
    if (salesContext) salesContextRef = salesContext;

    const fetchSettings = async () => {
        try {
            const { response, data } = await fetchReadJsonResponse("api/system/settings");
            if (!response.ok || !data?.success) throw new Error('Settings request failed.');
            barcodeEnabled.value = data.barcode_enabled === "1";
            quickNumpadMode.value = data.quick_numpad_mode === "1";
            quantityPresetsEnabled.value = data.quantity_presets_enabled !== "0";
            tablesEnabledSetting.value = data.tables_enabled === true || data.tables_enabled === "1";
            applyCatalogSettings(data);
            printMethod.value = data.print_method || "browser";
            receiptTaxInclusiveDisplay.value = data.tax_inclusive_pricing === "1";
            taxRegistrationType.value = data.tax_registration_type === 'income_tax' ? 'income_tax' : 'sales_tax';
            salesTaxNumber.value = String(data.jofotara_sales_tax_seller_tax_number || '').trim();
            incomeTaxNumber.value = String(data.jofotara_income_tax_seller_tax_number || '').trim();
            useInvoiceNoOnly.value = data.use_invoice_no_only === "1";
            duplicateCustomerReceipt.value = data.duplicate_customer_receipt === "1";
            storeName.value = data.store_name || "Premium POS";
            storeAddress.value = data.store_address || "";
            storePhone.value = data.store_phone || "";
            await setLanguage(data.admin_language || localStorage.getItem('pos_admin_language') || 'en');
            if (data.receipt_config) {
                try { receiptConfig.value = { ...receiptConfig.value, ...JSON.parse(data.receipt_config) }; }
                catch (e) { }
            }
            settingsLoaded.value = true;
            settingsError.value = '';
            return true;
        } catch (error) {
            // Without a snapshot checkout and printing wait, so say so at once. With
            // one, say so only when the automatic retry fails too: a blip that
            // recovers by itself stays silent.
            if (!settingsLoaded.value) settingsError.value = 'Settings could not be loaded. Retry before checkout or printing.';
            else if (settingsFailures > 0) settingsError.value = 'Settings could not be refreshed. Using the last loaded settings.';
            console.error("Failed to load terminal settings from server.", error);
            return false;
        }
    };

    const loadSettings = ({ force = false } = {}) => {
        if (settingsPromise) {
            if (force) settingsRefreshRequested = true;
            return settingsPromise;
        }
        settingsLoading.value = true;
        settingsPromise = (async () => {
            let loaded;
            do {
                settingsRefreshRequested = false;
                loaded = await fetchSettings();
            } while (settingsRefreshRequested);
            if (loaded) {
                settingsFailures = 0;
                cancelSettingsRecovery();
            } else {
                settingsFailures += 1;
                const delay = SETTINGS_RETRY_MS[settingsFailures - 1];
                if (delay && !settingsRetryTimer) {
                    settingsRetryTimer = setTimeout(() => {
                        settingsRetryTimer = null;
                        void loadSettings({ force: true });
                    }, delay);
                }
            }
            return loaded;
        })().finally(() => {
            settingsPromise = null;
            settingsLoading.value = false;
        });
        return settingsPromise;
    };

    const ensureSettings = async () => settingsLoaded.value || loadSettings();

    // Event-driven recovery once the quick retries are spent.
    const retryFailedSettings = () => {
        if (settingsFailures > 0 && !settingsRetryTimer && !settingsPromise) void loadSettings({ force: true });
    };

    const loadReceiptPrinters = () => {
        if (receiptPrintersPromise) return receiptPrintersPromise;
        receiptPrintersPromise = (async () => {
            try {
                const data = (await fetchReadJsonResponse("api/admin/printers")).data;
                if (data.success) receiptPrinters.value = data.data.filter((p) => p.role === "receipt");
                return !!data.success;
            } catch (e) {
                return false;
            }
        })().finally(() => {
            receiptPrintersPromise = null;
        });
        return receiptPrintersPromise;
    };

    const saveTerminalSettings = () => {
        localStorage.setItem("pos_receipt_printer_id", localPrinterId.value);
        showTerminalSettings.value = false;
    };



    const isEditableElement = (target) => {
        if (!target) return false;
        const tag = target.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
    };

    const clearScannedTextFromEditable = (target, scannedCode) => {
        if (!isEditableElement(target) || typeof target.value !== "string") return;

        const cursorPosition = typeof target.selectionStart === "number" ? target.selectionStart : null;
        if (cursorPosition !== null) {
            const start = cursorPosition - scannedCode.length;
            if (start >= 0 && target.value.slice(start, cursorPosition) === scannedCode) {
                target.value = target.value.slice(0, start) + target.value.slice(cursorPosition);
                try { target.setSelectionRange(start, start); } catch (error) { }
                target.dispatchEvent(new Event("input", { bubbles: true }));
                return;
            }
        }

        if (target.value.endsWith(scannedCode)) {
            target.value = target.value.slice(0, -scannedCode.length);
            target.dispatchEvent(new Event("input", { bubbles: true }));
        }
    };

    const resetBarcodeBuffer = () => {
        barcodeBuffer = "";
        firstKeyTime = 0;
    };

    const setupBarcodeListener = (products, addToCart, beforeBarcodeAttempt = null) => {
        _barcodeProducts = products;
        _barcodeAddToCart = addToCart;
        _beforeBarcodeAttempt = beforeBarcodeAttempt;

        if (barcodeKeydownHandler) {
            window.removeEventListener("keydown", barcodeKeydownHandler, true);
        }

        barcodeKeydownHandler = (e) => {
            if (!barcodeEnabled.value) return;
            if (e.ctrlKey || e.altKey || e.metaKey) return;

            const currentTime = Date.now();
            const gap = currentTime - lastKeyTime;
            const isPrintableKey = e.key.length === 1;

            if (isPrintableKey) {
                if (!barcodeBuffer || gap > SCANNER_KEY_GAP_MS) {
                    barcodeBuffer = "";
                    firstKeyTime = currentTime;
                }

                barcodeBuffer += e.key;
                lastKeyTime = currentTime;
                return;
            }

            if (e.key === "Enter") {
                const scannedCode = barcodeBuffer.trim();
                const totalTime = firstKeyTime ? currentTime - firstKeyTime : Number.MAX_SAFE_INTEGER;
                const looksLikeScannerInput = scannedCode.length >= SCANNER_MIN_LENGTH && totalTime <= SCANNER_MAX_TOTAL_MS;

                resetBarcodeBuffer();
                lastKeyTime = currentTime;

                if (looksLikeScannerInput) {
                    clearScannedTextFromEditable(e.target, scannedCode);
                    processBarcode(scannedCode, _barcodeProducts, _barcodeAddToCart, _beforeBarcodeAttempt);
                    e.preventDefault();
                    e.stopPropagation();
                }

                return;
            }

            if (e.key !== "Shift") resetBarcodeBuffer();
            lastKeyTime = currentTime;
        };

        window.addEventListener("keydown", barcodeKeydownHandler, true);
    };

    const teardownBarcodeListener = () => {
        if (barcodeKeydownHandler) {
            window.removeEventListener("keydown", barcodeKeydownHandler, true);
            barcodeKeydownHandler = null;
        }
    };

    const resolveProductList = (source) => Array.isArray(source) ? source : (source?.value || []);

    const processBarcode = async (scannedCode, products, addToCart, beforeBarcodeAttempt = null) => {
        beforeBarcodeAttempt?.();
        const lookupContext = salesContextRef?.value === 'table' ? 'table' : 'register';
        let product = resolveProductList(products).find((p) => p.barcode === scannedCode);
        let scaleTargetAmount = null;
        let invalidScaleMetadata = false;
        if (!product) {
            try {
                const data = (await fetchReadJsonResponse(`api/pos/product_lookup?barcode=${encodeURIComponent(scannedCode)}&sales_context=${lookupContext}`)).data;
                if (!data?.success) throw new Error('Barcode lookup failed');
                if (data.success && data.product) {
                    product = data.product;
                    if (data.scale_total_cents !== null && data.scale_total_cents !== undefined) {
                        if (Number.isInteger(data.scale_total_cents)
                            && data.scale_total_cents > 0
                            && data.scale_total_cents <= 99999) {
                            scaleTargetAmount = data.scale_total_cents / 100;
                        } else {
                            invalidScaleMetadata = true;
                        }
                    }
                }
            } catch (error) {
                if (salesContextRef && salesContextRef.value !== lookupContext) return;
                showScanMessage(t('Barcode lookup failed. Please try again.'));
                return;
            }
        }

        // A scan started in one workspace must never land in the other workspace's cart.
        if (salesContextRef && salesContextRef.value !== lookupContext) return;

        if (invalidScaleMetadata) {
            showScanMessage(`Unknown Code: ${scannedCode}`);
            return;
        }

        if (product) {
            if (isNoteProduct(product)) {
                showScanMessage(t('Note products must be added to an item.'));
                return;
            }
            const options = { source: "barcode" };
            if (scaleTargetAmount !== null) options.targetAmount = scaleTargetAmount;
            const added = await addToCart(product, options);
            showScanMessage(added === false
                ? `${t('Sold out')}: ${product.name}`
                : `Added: ${product.name}`);
        } else {
            showScanMessage(`Unknown Code: ${scannedCode}`);
        }
    };

    const submitManualBarcode = async () => {
        if (!manualBarcode.value.trim()) return;
        if (!_barcodeProducts || !_barcodeAddToCart) return;
        await processBarcode(manualBarcode.value.trim(), _barcodeProducts, _barcodeAddToCart, _beforeBarcodeAttempt);
        manualBarcode.value = "";
    };

    const dispatchToNodeSpooler = async (type, payloadData, { saved = false } = {}) => {
        const notifyFailure = (message, uncertain = false) => window.showPosToast?.(uncertain ? message : saved
            ? `${t('Transaction saved. Printing failed; check Printing before retrying.')} ${message}`
            : `${t('Print failed:')} ${message}`, saved || uncertain ? 'warning' : 'error');
        try {
            const { response: res, data } = await fetchJsonResponseWithTimeout('api/print/print', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ print_type: type, receipt_printer_id: localPrinterId.value, ...payloadData })
            }, 30000);
            if (!res.ok || !data.success) {
                const message = data.message || 'Unknown error. Check printer connection.';
                notifyFailure(message);
                return { success: false, message };
            }
            return { success: true, message: data.message || '' };
        } catch (e) {
            // A timeout, dropped connection or unreadable response can all occur
            // after admission. None establishes that the job failed to queue.
            const message = t('Printing was not confirmed. Check Printing before retrying.');
            notifyFailure(message, true);
            return { success: false, message };
        }
    };

    const closeReceiptModal = () => {
        showReceiptModal.value = false;
        lastOrder.value = null;
    };

    const printReceipt = async (order = lastOrder.value, context = {}) => {
        if (!order) return false;
        if (!await ensureSettings()) throw new Error(t(settingsError.value));
        if (printMethod.value === 'browser') {
            await nextTick();
            if (lastOrder.value?.invoice_id !== order.invoice_id) return false;
            document.body.classList.add('printing-thermal-receipt');
            try {
                window.print();
                return true;
            } finally {
                document.body.classList.remove('printing-thermal-receipt');
            }
        }

        isPrintingBackend.value = true;
        try {
            return (await dispatchToNodeSpooler('receipt', order, context)).success;
        } finally {
            isPrintingBackend.value = false;
        }
    };

    return {
        barcodeEnabled, scanMessage, manualBarcode, barcodeInputRef,
        showTerminalSettings, receiptPrinters, localPrinterId, printMethod, isPrintingBackend, receiptTaxInclusiveDisplay, taxRegistrationType, salesTaxNumber, incomeTaxNumber, duplicateCustomerReceipt, quickNumpadMode, quantityPresetsEnabled, tablesEnabledSetting,
        storeName, storeAddress, storePhone, receiptData, receiptConfig, useInvoiceNoOnly,
        showReceiptModal, lastOrder,
        loadSettings, ensureSettings, retryFailedSettings, cancelSettingsRecovery, settingsLoaded, settingsLoading, settingsError,
        loadReceiptPrinters, saveTerminalSettings, setupBarcodeListener,
        teardownBarcodeListener,
        processBarcode, submitManualBarcode, dispatchToNodeSpooler,
        closeReceiptModal, printReceipt
    };
}

