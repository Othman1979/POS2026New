const { formatBusinessTime } = require('./businessTime');
const {
    escapeHtml,
    renderVoidKitchenHeader,
    renderSubscriptionKitchenHeader
} = require('./report-html');
const { renderReceiptItems, renderReceiptSummary } = require('./receipt-display.cjs');

const MAX_COMPILED_DOCUMENT_BYTES = 256 * 1024;
const MAX_TEMPLATE_REVISION_BYTES = 200;
const ALLOWED_COMPILED_TAGS = new Set(['main', 'section', 'div', 'span', 'img']);
const ALLOWED_COMPILED_ATTRIBUTES = {
    main: new Set(['class', 'data-doc-type', 'style']),
    section: new Set(['class', 'data-band', 'style']),
    div: new Set(['class', 'style', 'dir', 'data-node']),
    span: new Set(['class', 'style', 'dir']),
    img: new Set(['class', 'style', 'dir', 'alt', 'width', 'height', 'src'])
};

function compiledDocumentFailure(message) {
    const error = new Error(message);
    error.code = 'COMPILED_DOCUMENT_INVALID';
    throw error;
}

function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function requiredString(value, field, { maxBytes = MAX_COMPILED_DOCUMENT_BYTES } = {}) {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
        compiledDocumentFailure(`Compiled document ${field} is invalid`);
    }
}

function parseCompiledAttributes(rawAttributes, tag) {
    let cursor = 0;
    const attributes = new Map();
    const attributePattern = /\s+([a-z][a-z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
    let attribute;
    while ((attribute = attributePattern.exec(rawAttributes))) {
        if (rawAttributes.slice(cursor, attribute.index).trim()) compiledDocumentFailure('Compiled document attributes are malformed');
        cursor = attributePattern.lastIndex;
        const name = attribute[1].toLowerCase();
        const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
        if (!ALLOWED_COMPILED_ATTRIBUTES[tag].has(name) || attributes.has(name)) compiledDocumentFailure(`Compiled document attribute ${name} is not allowed`);
        if (/(?:javascript|file|https?|ftp):/i.test(value)) compiledDocumentFailure('Compiled document contains a forbidden URL');
        if (name === 'src' && !/^data:image\/(?:png|jpeg|webp|ico|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/]+={0,2}$/i.test(value)) {
            compiledDocumentFailure('Compiled document image source is not a supported data image');
        }
        if (name === 'style' && (/\\|@import\b|url\s*\(|expression\s*\(|-moz-binding\s*:|behavior\s*:|(?:javascript|file|https?|ftp):/i.test(value))) {
            compiledDocumentFailure('Compiled document style contains forbidden active content');
        }
        attributes.set(name, value);
    }
    if (rawAttributes.slice(cursor).trim()) compiledDocumentFailure('Compiled document attributes are malformed');
    return attributes;
}

function decodeCompiledText(value) {
    return value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'"
    })[entity]);
}

function validateCompiledMarkup(html, printType) {
    if (/<!--[\s\S]*?-->|<!|<\?/.test(html) || /<\/?\s*(?:script|iframe|object|embed|link|meta|form)\b/i.test(html) || /\son[a-z0-9_-]+\s*=/i.test(html)) {
        compiledDocumentFailure('Compiled document contains forbidden active markup');
    }
    const tagPattern = /<\/?\s*([a-z][a-z0-9-]*)\b([^>]*)>/gi;
    const stack = [];
    let root = null;
    let rootCount = 0;
    let rootClosed = false;
    let cursor = 0;
    let match;
    while ((match = tagPattern.exec(html))) {
        const [fullTag, tagName, rawAttributes] = match;
        const tag = tagName.toLowerCase();
        const text = html.slice(cursor, match.index);
        if (/[<>]/.test(text) || (stack.length === 0 && text.trim())) compiledDocumentFailure('Compiled document has markup outside its root');
        if (stack.length > 0 && text) stack.at(-1).children.push({ type: 'text', value: decodeCompiledText(text) });
        cursor = tagPattern.lastIndex;
        if (!ALLOWED_COMPILED_TAGS.has(tag)) compiledDocumentFailure(`Compiled document tag ${tag} is not allowed`);
        if (/^<\//.test(fullTag)) {
            if (rawAttributes.trim() || tag === 'img' || stack.at(-1)?.tag !== tag) compiledDocumentFailure('Compiled document tags are unbalanced');
            stack.pop();
            if (stack.length === 0) rootClosed = true;
            continue;
        }
        const attributes = parseCompiledAttributes(rawAttributes, tag);
        const node = { type: 'element', tag, attributes: Object.fromEntries(attributes), children: [] };
        if (stack.length === 0) {
            if (rootClosed || rootCount !== 0 || tag !== 'main' || attributes.get('class') !== 'compiled-document' ||
                attributes.get('data-doc-type') !== printType || attributes.get('style') !== 'width:576px') {
                compiledDocumentFailure('Compiled document root is invalid');
            }
            rootCount += 1;
            root = node;
        } else if (tag === 'main') {
            compiledDocumentFailure('Compiled document has multiple roots');
        } else {
            stack.at(-1).children.push(node);
        }
        if (tag !== 'img') stack.push(node);
    }
    const trailing = html.slice(cursor);
    if (/[<>]/.test(trailing) || trailing.trim() || stack.length !== 0 || rootCount !== 1 || !rootClosed) {
        compiledDocumentFailure('Compiled document tags are unbalanced');
    }
    return root;
}

function rejectActiveCss(css) {
    if (/[<>\\]|@import\b|url\s*\(|expression\s*\(|-moz-binding\s*:|behavior\s*:|(?:javascript|file|https?|ftp):/i.test(css)) {
        compiledDocumentFailure('Compiled document CSS contains forbidden active content');
    }
}

function resolveCompiledDocument(data, printType, options = {}) {
    const artifact = data?.compiled_document_v1;
    if (artifact === undefined) return null;
    if (!['receipt', 'kitchen'].includes(printType) || !plainObject(artifact) || artifact.version !== 1 ||
        artifact.kind !== 'compiled_document_v1' || artifact.docType !== printType || artifact.widthPx !== 576 || artifact.compilerVersion !== 1) {
        compiledDocumentFailure('Compiled document type or version is invalid');
    }
    requiredString(artifact.templateRevisionId, 'template revision', { maxBytes: MAX_TEMPLATE_REVISION_BYTES });
    if (artifact.templateRevisionId !== `builtin:${printType}-v1` && !/^revision:[1-9]\d*$/.test(artifact.templateRevisionId)) {
        compiledDocumentFailure('Compiled document template revision is not printable');
    }
    requiredString(artifact.html, 'HTML');
    requiredString(artifact.css, 'CSS');
    if (Buffer.byteLength(artifact.html, 'utf8') + Buffer.byteLength(artifact.css, 'utf8') > MAX_COMPILED_DOCUMENT_BYTES) {
        compiledDocumentFailure('Compiled document exceeds the 256KB limit');
    }
    rejectActiveCss(artifact.css);
    const tree = validateCompiledMarkup(artifact.html, printType);
    return options.includeTree === true ? { artifact, tree } : artifact;
}

function renderCompiledDocument(artifact) {
    return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>${artifact.css}</style></head><body id="receipt-body">${artifact.html}</body></html>`;
}

function formatQty(qty) {
    const num = parseFloat(qty);
    if (isNaN(num)) return qty;
    return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

function receiptItemDisplayTotal(item = {}, taxInclusive = false) {
    const qty = parseFloat(item.qty || 0);
    let total = parseFloat(item.price || 0) * qty;
    const discountValue = parseFloat(item.discountValue || 0);
    const discountType = item.discountType;

    if (discountValue > 0) {
        if (discountType === 'fixed') total -= discountValue * qty;
        if (discountType === 'percent') total -= total * (discountValue / 100);
    }
    total = Math.max(0, total);

    if (taxInclusive) {
        return total;
    }

    const savedTax = item.tax_amount;
    if (savedTax !== undefined && savedTax !== null && savedTax !== '') {
        return total + parseFloat(savedTax || 0);
    }

    const taxRate = parseFloat(item.tax_rate || 0);
    return total * (1 + taxRate / 100);
}



function documentStart() {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            /* 576 dots is the printable width of the supported 80 mm / 203 dpi receipt target. */
            @page { size: 80mm auto; margin: 0; }
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
                background: white; color: black; width: 576px;
                padding: 5px 10px 60px 10px; line-height: 1.2;
            }
            .text-center { text-align: center; } .text-right { text-align: right; }
            .font-black { font-weight: 800; letter-spacing: 0.02em; }
            .font-bold { font-weight: 600; letter-spacing: 0.01em; }
            .font-normal { font-weight: 400; }
            .italic { font-style: italic; } .uppercase { text-transform: uppercase; }
            .tracking-widest { letter-spacing: 0.06em; }
            .mt-1 { margin-top: 4px; } .mt-2 { margin-top: 8px; } .mt-4 { margin-top: 16px; }
            .mb-1 { margin-bottom: 4px; } .mb-2 { margin-bottom: 8px; }
            .flex { display: flex; } .justify-between { justify-content: space-between; } .items-start { align-items: flex-start; }
            .dashed-line { border-bottom: 2px dashed #000; margin: 10px 0; width: 100%; }
            .solid-line { border-bottom: 3px solid #000; margin: 10px 0; width: 100%; }
            .text-sm { font-size: 22px; } .text-base { font-size: 26px; } .text-lg { font-size: 30px; } .text-xl { font-size: 36px; } .text-2xl { font-size: 44px; }
            .item-header { display: flex; font-size: 22px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 8px; margin-bottom: 6px;}
            .item-row { display: flex; font-size: 25px; margin-bottom: 4px; align-items: flex-start; font-weight: 600; }
            .col-qty { width: 65px; flex-shrink: 0; text-align: left; }
            .col-name { flex: 1; padding-right: 15px; text-align: left; }
            .col-total { flex-shrink: 0; text-align: right; }
            .item-note { font-size: 24px; font-style: normal; margin-left: 65px; margin-bottom: 6px; font-weight: 600; color: #000; text-align: left; white-space: pre-wrap; }
            .kitchen-item-qty { flex: 0 0 auto; min-width: 75px; padding-right: 12px; white-space: nowrap; }
            .kitchen-item-name { flex: 1 1 auto; min-width: 0; text-align: left; }
            .text-lr { display: flex; justify-content: space-between; font-size: 25px; margin-bottom: 4px; }
            .total-box { color: black; padding: 12px; display: flex; justify-content: space-between; font-weight: 800; font-size: 34px; margin: 12px 0; border-radius: 4px; width: 100%; }
            .kitchen-header { color: black; padding: 10px; text-align: center; font-weight: 800; font-size: 48px; margin-bottom: 12px; border-radius: 4px; }
        </style>
    </head>
    <body id="receipt-body">`;
}

function renderReceiptDocument(data) {
    const formatDateTime = value => formatBusinessTime(value, data.business_config?.business_sql_offset);
    const config = data.storeInfo?.receipt_config ? JSON.parse(data.storeInfo.receipt_config) : {};
    const layout = config.layout || ['header', 'meta', 'customer', 'items', 'totals', 'payment', 'footer'];
    const legacyTaxInclusive = data.receipt_display_v1 === undefined && data.storeInfo?.tax_inclusive_pricing === '1';
    let htmlContent = documentStart();

    layout.forEach(block => {
        if (block === 'header') {
            htmlContent += `
                <div class="text-center">
                    <h1 class="font-black text-2xl uppercase tracking-widest" style="line-height: 1;">${escapeHtml(data.storeInfo.store_name)}</h1>
                    <p class="font-bold text-base mt-2">${escapeHtml(data.storeInfo.store_address)}</p>
                    <p class="font-bold text-base mt-1">${escapeHtml(data.storeInfo.store_phone)}</p>
                    ${config.customHeaderText ? `<p class="font-bold text-sm mt-2">${escapeHtml(config.customHeaderText)}</p>` : ''}
                </div><div class="dashed-line"></div>`;
        }
        if (block === 'meta') {
            htmlContent += ``;
            if (data.hash_number) {
                htmlContent += `<div class="text-center font-black text-2xl mb-2"><span>#${escapeHtml(data.hash_number)}</span></div>`;
            }
            const isGuestCheck = data.provisional === true || data.invoice_id === 'GUEST CHECK';
            if (data.held_order_receipt === true) {
                htmlContent += `<div class="text-lr font-black text-xl mb-1"><span>Order: #${escapeHtml(data.order_display_no)}</span><span class="font-bold text-base">${escapeHtml(formatDateTime(data.date))}</span></div>`;
            } else if (isGuestCheck) {
                // Guest check = provisional unpaid bill (no invoice/order number yet).
                // Show only the table identity + time; never an Invoice/Order line.
                htmlContent += `<div class="text-lr font-black text-xl mb-1"><span>GUEST CHECK</span><span class="font-bold text-base">${escapeHtml(formatDateTime(data.date))}</span></div>`;
                if (data.table_number) {
                    htmlContent += `<div class="text-lr font-black text-xl mb-1"><span>Table: ${escapeHtml(data.table_number)}</span></div>`;
                }
            } else {
                // Public identity only. Open-table reprints (no invoice number and no
                // order number yet) must show table + time only — never "Ticket: null"
                // or "Order: #null". Paid receipts keep the exact Invoice/Order layout.
                const displayNo = data.invoice_display_no || data.ticket_display_no || data.order_display_no || data.order_id;
                if (displayNo) {
                    htmlContent += `<div class="text-lr font-black text-xl mb-1"><span>${data.invoice_display_no ? 'Invoice' : 'Ticket'}: ${escapeHtml(displayNo)}</span></div>`;
                }
                htmlContent += `<div class="text-lr font-black text-xl mb-1"><span>${data.order_id ? `Order: #${escapeHtml(data.order_display_no || data.order_id)}` : ''}</span><span class="font-bold text-base">${escapeHtml(formatDateTime(data.date))}</span></div>`;
                if (data.table_number) {
                    htmlContent += `<div class="text-lr font-black text-xl mb-1"><span>Table: ${escapeHtml(data.table_number)}</span></div>`;
                }
            }
            htmlContent += `
                <div class="text-lr font-bold"><span class="font-normal">Cashier: ${escapeHtml(data.cashier)}</span><span class="font-normal">${escapeHtml(data.order_type_name || '')}</span></div>`;
            if (data.note || data.order_note) {
                htmlContent += `<div class="font-bold text-lg mt-2 mb-1 italic" style="white-space: pre-line; text-align: left;">Note: ${escapeHtml(data.note || data.order_note)}</div>`;
            }
        }
        if (block === 'customer' && (data.customer_name || data.customer_phone)) {
            htmlContent += `<div class="text-lr font-bold"><span>Customer: ${escapeHtml(data.customer_name || 'N/A')}</span></div>`;
            if (data.customer_phone) htmlContent += `<div class="text-lr font-bold"><span>Phone: ${escapeHtml(data.customer_phone)}</span></div>`;
            if (data.delivery_date) htmlContent += `<div class="text-lr font-bold"><span>Delivery: ${escapeHtml(formatBusinessTime(data.delivery_date, data.business_config?.business_sql_offset, true))}</span></div>`;
            htmlContent += `<div class="dashed-line"></div>`;
        }
        if (block === 'items') {
            if (data.receipt_display_v1 !== undefined) {
                htmlContent += renderReceiptItems(data.receipt_display_v1);
            } else {
                htmlContent += `<div class="item-header"><div class="col-qty">Qty</div><div class="col-name">Item</div><div class="col-total">Total</div></div><div class="solid-line"></div>`;
                data.items.forEach(item => {
                    const formattedQty = formatQty(item.qty);

                    if (item._isChild) {
                        // Bundle sub-item: indented, smaller, no price column.
                        htmlContent += `<div class="item-row" style="opacity: 0.8;"><div class="col-qty"></div><div class="col-name text-lg" style="padding-left: 16px;">&bull; ${escapeHtml(item.name)} x${escapeHtml(formattedQty)}</div><div class="col-total"></div></div>`;
                        if (item.note) {
                            const lines = item.note.split('\n').filter(Boolean).map(line => `- ${line.trim()}`).join('\n');
                            htmlContent += `<div class="item-note" style="padding-left: 16px;">${escapeHtml(lines)}</div>`;
                        }
                        return;
                    }

                    const displayTotal = receiptItemDisplayTotal(item, legacyTaxInclusive);
                    const roundedLineTotal = Math.round((displayTotal + Number.EPSILON) * 100) / 100;

                    htmlContent += `<div class="item-row"><div class="col-qty">${escapeHtml(formattedQty)}x</div><div class="col-name">${escapeHtml(item.name)}</div><div class="col-total">${roundedLineTotal.toFixed(2)} JD</div></div>`;
                    if (item.note) {
                        const lines = item.note.split('\n').filter(Boolean).map(line => `- ${line.trim()}`).join('\n');
                        htmlContent += `<div class="item-note">${escapeHtml(lines)}</div>`;
                    }
                });
                htmlContent += `<div class="dashed-line"></div>`;
            }
        }
        if (block === 'totals') {
            if (data.receipt_display_v1 !== undefined) {
                htmlContent += renderReceiptSummary(data.receipt_display_v1);
            } else {
                htmlContent += `
                    ${legacyTaxInclusive ? '' : `<div class="text-lr font-bold"><span class="font-normal">Subtotal</span><span>${parseFloat(data.subtotal || 0).toFixed(2)} JD</span></div>
                    <div class="text-lr font-bold"><span class="font-normal">Tax</span><span>${parseFloat(data.tax || 0).toFixed(2)} JD</span></div>`}
                    ${data.discount > 0 ? `<div class="text-lr font-bold"><span class="font-normal">Discount</span><span>-${parseFloat(data.discount).toFixed(2)} JD</span></div>` : ''}
                    <div class="total-box"><span class="tracking-widest uppercase">Total</span><span>${parseFloat(data.total || 0).toFixed(2)} JD</span></div>`;
            }
        }
        if (block === 'payment' && !data.provisional && data.payment_method !== 'held') {
            if (data.payment_method === 'receivable' && data.receipt_display_v1?.billing) {
                const billing = data.receipt_display_v1.billing;
                htmlContent += `
                    <div class="text-lr font-bold"><span class="font-normal">Payment</span><span>RECEIVABLE</span></div>
                    <div class="text-lr font-bold"><span class="font-normal">Issued</span><span>${escapeHtml(billing.issuedOn)}</span></div>
                    <div class="text-lr font-bold"><span class="font-normal">Due date</span><span>${escapeHtml(billing.dueOn)}</span></div>
                    <div class="text-lr font-bold"><span class="font-normal">Collected</span><span>${billing.collectedAmount.toFixed(2)} JD</span></div>
                    <div class="text-lr font-bold"><span class="font-normal">Outstanding</span><span>${billing.outstandingAmount.toFixed(2)} JD</span></div>
                    <div class="dashed-line"></div>`;
            } else if (data.payment_method === 'platform') {
                htmlContent += `
                    <div class="text-lr font-bold"><span class="font-normal">Payment</span><span>PLATFORM</span></div>
                    <div class="dashed-line"></div>`;
            } else if (data.payment_method === 'split') {
                htmlContent += `
                    <div class="text-lr font-bold"><span class="font-normal">Cash</span><span>${parseFloat(data.cash_amount || 0).toFixed(2)} JD</span></div>
                    <div class="text-lr font-bold"><span class="font-normal">Card</span><span>${parseFloat(data.card_amount || 0).toFixed(2)} JD</span></div>
                    ${Number(data.change_due || 0) > 0 ? `<div class="text-lr font-bold"><span class="font-normal">Change</span><span>${parseFloat(data.change_due).toFixed(2)} JD</span></div>` : ''}
                    <div class="dashed-line"></div>`;
            } else {
                htmlContent += `
                    <div class="text-lr font-bold"><span class="font-normal">Payment</span><span class="uppercase">${escapeHtml(data.payment_method || 'CASH')}</span></div>
                    <div class="text-lr font-bold"><span class="font-normal">Tendered</span><span class="font-normal">${parseFloat(data.amount_tendered || 0).toFixed(2)} JD</span></div>
                    <div class="text-lr font-bold"><span class="font-normal">Change</span><span class="font-normal">${parseFloat(data.change_due || 0).toFixed(2)} JD</span></div>
                    <div class="dashed-line"></div>`;
            }
        }
        if (block === 'footer') {
            htmlContent += `<div class="text-center font-bold text-sm mt-4 whitespace-pre-line">${escapeHtml(config.customFooterText || 'Thank you!')}</div>`;
        }
    });

    return `${htmlContent}</body></html>`;
}

function renderKitchenDocument(data) {
    const formatDateTime = value => formatBusinessTime(value, data.business_config?.business_sql_offset);
    let htmlContent = documentStart();
    const isVoidTicket = data.void_ticket === true;
    const isFollowUpTicket = data.follow_up === true;
    const isCancelTicket = data.cancel_ticket === true;
    const subscriptionRedemption = data.subscription_redemption || null;
    const safeKitchenText = escapeHtml;
    htmlContent += subscriptionRedemption
        ? renderSubscriptionKitchenHeader(data, { formatDateTime })
        : isCancelTicket
            ? '<div class="kitchen-header">إلغاء الطلب / ORDER CANCELLED</div>'
            : isFollowUpTicket
                ? `<div class="kitchen-header">إضافة على الطلب / FOLLOW UP</div><div class="text-center font-black text-xl mb-2">FOLLOW UP #${escapeHtml(data.follow_up_sequence || '')}</div>`
                : '<div class="kitchen-header">KITCHEN TICKET</div>';
    if (data.order_type_name && !subscriptionRedemption) {
        htmlContent += `<div class="text-center font-black text-2xl mb-2 uppercase">${escapeHtml(data.order_type_name)}</div>`;
    }
    if (data.hash_number) {
        htmlContent += `<div class="text-center font-black text-2xl mb-2"><span>#${escapeHtml(data.hash_number)}</span></div>`;
    }
    // Public identity only, mirroring the receipt meta. Register/paid tickets show
    // "Invoice: <public number>" + "Order: #<order_id>". Open-table tickets
    // (invoice_number + order_id both deferred) show TABLE + time only — no
    // "Invoice: <internal id>" leak and no "Order: #null".
    if (!subscriptionRedemption && isVoidTicket && !isCancelTicket && !isFollowUpTicket) {
        if (data.held_order === true) htmlContent += `<div class="text-center font-black text-xl mb-2">Order: #${escapeHtml(data.order_display_no || data.order_id)}</div>`;
        htmlContent += renderVoidKitchenHeader(data, { formatDateTime });
    } else if (!subscriptionRedemption) {
        const kDisplayNo = data.held_order === true ? null : data.invoice_display_no || data.ticket_display_no || data.order_display_no;
        htmlContent += `<div class="dashed-line"></div>`;
        if (kDisplayNo) {
            htmlContent += `<div class="text-lr font-black text-xl mb-1"><span>${data.invoice_display_no ? 'Invoice' : 'Ticket'}: ${escapeHtml(kDisplayNo)}</span></div>`;
        }
        htmlContent += `<div class="text-lr font-black text-xl mb-1"><span>${data.order_id ? `Order: #${escapeHtml(data.order_display_no || data.order_id)}` : ''}</span><span class="font-bold text-lg">${escapeHtml(formatDateTime(data.date))}</span></div>`;
        htmlContent += `${data.table_number ? `<div class="total-box" style="justify-content: center; margin-top: 8px;">TABLE: ${escapeHtml(data.table_number)}</div>` : '<div class="dashed-line"></div>'}`;
    }
    const primaryItems = data.items.filter(i => !i._isOther);
    const otherItems = data.items.filter(i => i._isOther);
    primaryItems.forEach(item => {
        const formattedQty = formatQty(item.qty);
        if (item._bundleLabel) {
            htmlContent += `<div class="font-bold text-lg mb-1" style="text-align: left; opacity: 0.7;">[${safeKitchenText(item._bundleLabel)}]</div>`;
        }
        htmlContent += `<div class="flex items-start font-black text-xl mb-2 leading-tight">
            <div class="kitchen-item-qty">${escapeHtml(formattedQty)}x</div>
            <div class="kitchen-item-name">${safeKitchenText(item.name)}</div>
        </div>`;
        if (item.note) {
            const lines = item.note.split('\n').filter(Boolean).map(line => `*** ${line.trim()} ***`).join('\n');
            htmlContent += `<div class="font-black text-lg mb-2 italic" style="margin-left: 75px; text-align: left; white-space: pre-wrap;">${safeKitchenText(lines)}</div>`;
        }
    });
    if (otherItems.length > 0) {
        htmlContent += `<div class="dashed-line"></div>
            <div class="text-center font-bold text-lg mb-2" style="letter-spacing: 1px;">-- ALSO ON ORDER --</div>`;
        otherItems.forEach(item => {
            const formattedQty = formatQty(item.qty);
            htmlContent += `<div class="flex items-start font-bold text-xl mb-1 leading-tight" style="opacity: 0.55;">
                <div class="kitchen-item-qty">${escapeHtml(formattedQty)}x</div>
                <div class="kitchen-item-name">${safeKitchenText(item.name)}</div>
            </div>`;
        });
    }

    return `${htmlContent}</body></html>`;
}

module.exports = { renderReceiptDocument, renderKitchenDocument, resolveCompiledDocument, renderCompiledDocument };
