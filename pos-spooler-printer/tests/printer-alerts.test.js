const assert = require('assert');

const {
    getKitchenBeepConfig,
    applyPrintAlerts,
} = require('../printer-alerts');

function createFakePrinter() {
    const calls = [];
    return {
        calls,
        beep(count, duration) {
            calls.push(['beep', count, duration]);
            return this;
        },
        cashdraw(pin) {
            calls.push(['cashdraw', pin]);
            return this;
        },
    };
}

assert.deepStrictEqual(getKitchenBeepConfig({}), {
    enabled: true,
    count: 3,
    duration: 5,
});

assert.deepStrictEqual(getKitchenBeepConfig({
    KITCHEN_BEEP_ENABLED: 'false',
    KITCHEN_BEEP_COUNT: '8',
    KITCHEN_BEEP_DURATION: '2',
}), {
    enabled: false,
    count: 8,
    duration: 2,
});

{
    const printer = createFakePrinter();
    applyPrintAlerts(printer, 'kitchen', {
        KITCHEN_BEEP_COUNT: '4',
        KITCHEN_BEEP_DURATION: '6',
    });
    assert.deepStrictEqual(printer.calls, [['beep', 4, 6]]);
}

{
    const printer = createFakePrinter();
    applyPrintAlerts(printer, 'receipt', {});
    assert.deepStrictEqual(printer.calls, [['cashdraw', 2]]);
}

{
    const printer = createFakePrinter();
    applyPrintAlerts(printer, 'receipt', {}, { provisional: true });
    assert.deepStrictEqual(printer.calls, []);
}

{
    const printer = createFakePrinter();
    applyPrintAlerts(printer, 'receipt', {
        RECEIPT_BEEP_ENABLED: 'true',
        RECEIPT_BEEP_COUNT: '2',
        RECEIPT_BEEP_DURATION: '3',
    });
    assert.deepStrictEqual(printer.calls, [['beep', 2, 3], ['cashdraw', 2]]);
}

{
    const printer = createFakePrinter();
    applyPrintAlerts(printer, 'z_report', {});
    assert.deepStrictEqual(printer.calls, []);
}

{
    const printer = createFakePrinter();
    applyPrintAlerts(printer, 'expense_slip', {}, { source: 'drawer' });
    assert.deepStrictEqual(printer.calls, [['cashdraw', 2]]);
}

{
    const printer = createFakePrinter();
    applyPrintAlerts(printer, 'expense_cancel_slip', {}, { source: 'drawer' });
    assert.deepStrictEqual(printer.calls, [['cashdraw', 2]]);
}

for (const [printType, printData] of [
    ['expense_slip', { source: 'outside' }],
    ['daily_expenses_report', { source: 'drawer' }],
]) {
    const printer = createFakePrinter();
    applyPrintAlerts(printer, printType, {}, printData);
    assert.deepStrictEqual(printer.calls, []);
}

console.log('printer-alerts tests passed');
