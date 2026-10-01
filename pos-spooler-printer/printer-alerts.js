function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnabled(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function getKitchenBeepConfig(env = process.env) {
    return {
        enabled: parseEnabled(env.KITCHEN_BEEP_ENABLED, true),
        count: parsePositiveInt(env.KITCHEN_BEEP_COUNT, 3),
        duration: parsePositiveInt(env.KITCHEN_BEEP_DURATION, 5),
    };
}

function getReceiptBeepConfig(env = process.env) {
    return {
        enabled: parseEnabled(env.RECEIPT_BEEP_ENABLED, false),
        count: parsePositiveInt(env.RECEIPT_BEEP_COUNT, 2),
        duration: parsePositiveInt(env.RECEIPT_BEEP_DURATION, 3),
    };
}

function applyBeep(printer, config) {
    if (config.enabled) {
        printer.beep(config.count, config.duration);
    }
}

function applyPrintAlerts(printer, printType, env = process.env, printData = {}) {
    if (printType === 'receipt') {
        applyBeep(printer, getReceiptBeepConfig(env));
        if (printData.provisional !== true) {
            printer.cashdraw(2);
        }
        return;
    }

    if (printType === 'kitchen') {
        applyBeep(printer, getKitchenBeepConfig(env));
        return;
    }

    if (['expense_slip', 'expense_cancel_slip'].includes(printType) && printData.source === 'drawer') {
        printer.cashdraw(2);
    }
}

module.exports = {
    getKitchenBeepConfig,
    getReceiptBeepConfig,
    applyPrintAlerts,
};
