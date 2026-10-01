const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rendererPath = path.resolve(__dirname, '../renderDocument.js');
const renderer = fs.existsSync(rendererPath) ? require(rendererPath) : {};

assert.strictEqual(
    typeof renderer.renderReceiptDocument,
    'function',
    'renderReceiptDocument should be exported'
);
assert.strictEqual(
    typeof renderer.renderKitchenDocument,
    'function',
    'renderKitchenDocument should be exported'
);
assert.strictEqual(
    typeof renderer.renderCompiledDocument,
    'function',
    'renderCompiledDocument should be exported'
);
assert.strictEqual(
    typeof renderer.resolveCompiledDocument,
    'function',
    'resolveCompiledDocument should be exported'
);

const compiledReceipt = {
    version: 1,
    kind: 'compiled_document_v1',
    docType: 'receipt',
    widthPx: 576,
    templateRevisionId: 'builtin:receipt-v1',
    compilerVersion: 1,
    html: '<main class="compiled-document" data-doc-type="receipt" style="width:576px"><section class="pt-band" data-band="header"><div class="pt-text" data-node="trusted-text">Trusted receipt</div></section></main>',
    css: '.compiled-document{width:576px}'
};

assert.throws(
    () => renderer.resolveCompiledDocument({ compiled_document_v1: {
        ...compiledReceipt,
        html: compiledReceipt.html.replace('data-band="header"', 'data-band="header" style="background:url(https://example.test/image)"')
    } }, 'receipt'),
    { code: 'COMPILED_DOCUMENT_INVALID' },
    'positioned section styles must still reject external content'
);

const resolvedCompiledReceipt = renderer.resolveCompiledDocument({ compiled_document_v1: compiledReceipt }, 'receipt');
assert.strictEqual(resolvedCompiledReceipt, compiledReceipt, 'receipt artifacts should be accepted only for matching receipt jobs');
const parsedCompiledReceipt = renderer.resolveCompiledDocument({ compiled_document_v1: {
    ...compiledReceipt,
    html: compiledReceipt.html.replace('Trusted receipt', 'Trusted &amp; Arabic مرحبا')
} }, 'receipt', { includeTree: true });
assert.strictEqual(parsedCompiledReceipt.artifact.docType, 'receipt');
assert.deepStrictEqual(parsedCompiledReceipt.tree.attributes, {
    class: 'compiled-document',
    'data-doc-type': 'receipt',
    style: 'width:576px'
});
assert.strictEqual(parsedCompiledReceipt.tree.children[0].children[0].children[0].value, 'Trusted & Arabic مرحبا');
assert.doesNotThrow(
    () => renderer.resolveCompiledDocument({ compiled_document_v1: {
        ...compiledReceipt,
        html: '<main class="compiled-document" data-doc-type="receipt" style="width:576px"><img alt="ICO" width="1" height="1" src="data:image/ico;base64,AA=="></main>'
    } }, 'receipt'),
    'supported ICO data images should be accepted'
);
const compiledHtml = renderer.renderCompiledDocument(resolvedCompiledReceipt);
assert(compiledHtml.includes("Content-Security-Policy"), 'compiled documents should get a restrictive CSP wrapper');
assert(compiledHtml.includes("default-src 'none'; img-src data:; style-src 'unsafe-inline'"), 'compiled documents should allow only inline styles and data images');
assert(compiledHtml.includes('Trusted receipt'), 'compiled document HTML should be rendered directly');
assert(compiledHtml.includes('id="receipt-body"'), 'compiled documents should preserve the spooler clipping target');

assert.throws(
    () => renderer.resolveCompiledDocument({ compiled_document_v1: { ...compiledReceipt, docType: 'kitchen' } }, 'receipt'),
    error => error?.code === 'COMPILED_DOCUMENT_INVALID',
    'mismatched artifact types must fail closed'
);
assert.throws(
    () => renderer.resolveCompiledDocument({ compiled_document_v1: { ...compiledReceipt, html: '<script>print()</script>' } }, 'receipt'),
    error => error?.code === 'COMPILED_DOCUMENT_INVALID',
    'active artifact HTML must fail closed'
);
assert.throws(
    () => renderer.resolveCompiledDocument({ compiled_document_v1: { ...compiledReceipt, css: '@import url(https://example.test/print.css)' } }, 'receipt'),
    error => error?.code === 'COMPILED_DOCUMENT_INVALID',
    'remote artifact CSS must fail closed'
);
assert.throws(
    () => renderer.resolveCompiledDocument({ compiled_document_v1: { ...compiledReceipt, css: 'body{background:u\\72l(//example.test/print.png)}' } }, 'receipt'),
    error => error?.code === 'COMPILED_DOCUMENT_INVALID',
    'escaped external CSS URLs must fail closed'
);
assert.throws(
    () => renderer.resolveCompiledDocument({ compiled_document_v1: { ...compiledReceipt, css: '.compiled-document{color:#000}</style><div>forged</div>' } }, 'receipt'),
    error => error?.code === 'COMPILED_DOCUMENT_INVALID',
    'stylesheet breakout markup must be rejected before a browser preview receives the artifact'
);
for (const [name, html] of [
    ['unbalanced nested tag', '<main class="compiled-document" data-doc-type="receipt" style="width:576px"><div class="pt-text"></main>'],
    ['unclosed root', '<main class="compiled-document" data-doc-type="receipt" style="width:576px"><div class="pt-text">broken</div>'],
    ['forged second root', '<main class="compiled-document" data-doc-type="receipt" style="width:576px"></main><main class="compiled-document" data-doc-type="receipt" style="width:576px"></main>'],
    ['trailing markup', '<main class="compiled-document" data-doc-type="receipt" style="width:576px"></main><div class="pt-text">forged</div>']
]) {
    assert.throws(
        () => renderer.resolveCompiledDocument({ compiled_document_v1: { ...compiledReceipt, html } }, 'receipt'),
        error => error?.code === 'COMPILED_DOCUMENT_INVALID',
        `${name} must fail closed`
    );
}
assert.throws(
    () => renderer.resolveCompiledDocument({ compiled_document_v1: { ...compiledReceipt, templateRevisionId: 'preview:unpublished' } }, 'receipt'),
    error => error?.code === 'COMPILED_DOCUMENT_INVALID',
    'preview-only artifacts must never become printable spooler documents'
);
assert.throws(
    () => renderer.resolveCompiledDocument({ compiled_document_v1: compiledReceipt }, 'z_report'),
    error => error?.code === 'COMPILED_DOCUMENT_INVALID',
    'reports must reject compiled artifacts instead of rendering them'
);

const receiptHtml = renderer.renderReceiptDocument({
    storeInfo: {
        store_name: 'A&B <Store>',
        store_address: 'Amman',
        store_phone: '0790000000',
        receipt_config: JSON.stringify({
            layout: ['header', 'items', 'totals', 'payment', 'footer'],
            customHeaderText: 'Fresh',
            customFooterText: 'Thank you again!'
        })
    },
    items: [{ name: 'Burger', qty: 1, price: 10, tax_rate: 16 }],
    subtotal: 10,
    tax: 1.6,
    total: 11.6,
    payment_method: 'cash',
    amount_tendered: 20,
    change_due: 8.4
});
assert(receiptHtml.includes('<!DOCTYPE html>'), 'receipt should include the document shell');
assert(receiptHtml.includes('A&amp;B &lt;Store&gt;'), 'receipt header should preserve escaping');
assert(receiptHtml.includes('11.60 JD'), 'receipt should preserve totals');
assert(receiptHtml.includes('Thank you again!'), 'receipt should preserve the configured footer');

const platformReceiptHtml = renderer.renderReceiptDocument({
    ...JSON.parse(JSON.stringify({
        storeInfo: { receipt_config: JSON.stringify({ layout: ['payment'] }) },
        subtotal: 10, tax: 1.6, total: 11.6,
        payment_method: 'platform', amount_tendered: 0, change_due: 0
    }))
});
assert(platformReceiptHtml.includes('PLATFORM'), 'platform receipt should name its payment method');
assert(!platformReceiptHtml.includes('Tendered'), 'platform receipt must not display tendered cash');
assert(!platformReceiptHtml.includes('Change'), 'platform receipt must not display change');

const kitchenHtml = renderer.renderKitchenDocument({
    order_type_name: 'Dine In',
    order_display_no: 'B-12',
    order_id: '42',
    date: '2026-07-25 14:00:00',
    table_number: '7',
    items: [
        { name: 'Burger', qty: 1, note: 'No onion' },
        { name: 'Half portion', qty: 0.5 },
        { name: 'Three-quarter portion', qty: 0.75 },
        { name: 'One-and-a-half portions', qty: 1.5 },
        { name: 'Fries', qty: 2, _isOther: true }
    ]
});
assert(kitchenHtml.includes('KITCHEN TICKET'), 'kitchen document should preserve its heading');
assert(kitchenHtml.includes('Order: #B-12'), 'kitchen document should preserve the issued public order identity');
assert(!kitchenHtml.includes('Order: #42'), 'internal numeric ids must not replace the issued type prefix');
assert(kitchenHtml.includes('TABLE: 7'), 'kitchen document should preserve table identity');
assert(kitchenHtml.includes('-- ALSO ON ORDER --'), 'kitchen document should preserve secondary items');
assert(kitchenHtml.includes('0.50x'), 'kitchen document should preserve half quantities');
assert(kitchenHtml.includes('0.75x'), 'kitchen document should preserve three-quarter quantities');
assert(kitchenHtml.includes('1.50x'), 'kitchen document should preserve one-and-a-half quantities');
assert(kitchenHtml.includes('class="kitchen-item-qty"'), 'kitchen quantities should use the intrinsic non-wrapping column');
assert(kitchenHtml.includes('.kitchen-item-qty { flex: 0 0 auto; min-width: 75px; padding-right: 12px; white-space: nowrap; }'), 'fallback kitchen quantity layout should prevent overlap');

const heldHtml = renderer.renderReceiptDocument({
    storeInfo:{store_name:'Cafe',store_address:'',store_phone:''},
    held_order_receipt:true,provisional:true,payment_method:'held',order_id:17,order_display_no:'C-17',
    invoice_display_no:'FORGED-INVOICE',ticket_display_no:'FORGED-TICKET',table_number:'FORGED-REFERENCE',
    items:[{name:'Coffee',qty:1,price:5}],subtotal:5,tax:0,total:5,date:'2026-09-09 12:00:00',cashier:'Cashier'
});
assert(heldHtml.includes('Order: #C-17'));
assert(!/FORGED|GUEST CHECK|Payment<|Tendered<|Change</.test(heldHtml));
for (const flags of [{}, {void_ticket:true}, {follow_up:true}, {cancel_ticket:true}]) {
    const html = renderer.renderKitchenDocument({held_order:true,order_id:17,order_display_no:'C-17',
        date:'2026-09-09T09:00:00Z',items:[{name:'Coffee',qty:1}],...flags});
    assert(html.includes('Order: #C-17'), 'Every held kitchen variant must keep its order identity');
    assert(!/Ticket:|Invoice:/.test(html), 'Held kitchen variants must not invent another identity');
}
console.log('render-document tests passed');
