const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderReceiptItems, renderReceiptSummary } = require('../receipt-display.cjs');

const model = {
    version: 1,
    currency: 'JD',
    decimals: 2,
    taxMode: 'exclusive',
    status: 'original',
    rows: [{
        key: 'item:1',
        kind: 'item',
        name: '<img src=x onerror=alert(1)>',
        note: 'First line\n& second line',
        qty: 1,
        unitPrice: 10,
        extendedPrice: 10,
        lineDiscountAmount: 0,
        lineDiscountLabel: null,
        netAmount: 10
    }],
    summary: {
        subtotal: 10,
        orderDiscountAmount: 0,
        orderDiscountLabel: null,
        taxAmount: 1.6,
        taxLabel: null,
        roundingAdjustment: 0,
        total: 11.6
    }
};

const itemHtml = renderReceiptItems(model);
assert(!itemHtml.includes('<img'), 'receipt item markup must never execute');
assert(itemHtml.includes('&lt;img src=x onerror=alert(1)&gt;'), 'item markup should print as text');
assert(itemHtml.includes('First line\n- &amp; second line'), 'multiline notes should remain separate and escaped');
assert(renderReceiptSummary(model).includes('11.60 JD'), 'summary should print backend-computed total');
const exemptModel = { ...model, taxExempt: true, summary: { ...model.summary, taxAmount: 0, taxLabel: '(معفي من الضريبة)', total: 10 } };
assert(renderReceiptSummary(exemptModel).includes('(معفي من الضريبة)'), 'exempt receipts should print the supplied label');
assert(!renderReceiptSummary(exemptModel).includes('<span>0.00 JD</span>'), 'exempt receipts should not print numeric zero tax');
assert.throws(() => renderReceiptSummary({ version: 1 }), /invalid receipt presentation/i);

const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
const rendererSource = fs.readFileSync(path.resolve(__dirname, '../renderDocument.js'), 'utf8');
assert.strictEqual((rendererSource.match(/data\.receipt_display_v1 !== undefined/g) || []).length, 2);
assert(rendererSource.includes('renderReceiptItems(data.receipt_display_v1)'));
assert(rendererSource.includes('renderReceiptSummary(data.receipt_display_v1)'));
assert(serverSource.includes("require('./v2/typst-renderer')"));

console.log('receipt-display tests passed');
