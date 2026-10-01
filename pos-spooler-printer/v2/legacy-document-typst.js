const { formatBusinessTime } = require('../businessTime');
const { validateReceiptPresentation } = require('../receipt-display.cjs');

const WIDTH = 576;
const FONT = '("Noto Sans", "Noto Sans Arabic", "Noto Emoji")';
const MAX_ITEMS = 240;

function unsupported(message) {
    const error = new Error(message);
    error.code = 'TYPST_DOCUMENT_UNSUPPORTED';
    error.failureClass = 'permanent_safe';
    throw error;
}

function safe(value, limit = 2000) {
    const text = value == null ? '' : String(value);
    if (Buffer.byteLength(text, 'utf8') > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) unsupported('Legacy ticket text exceeds its limit.');
    return JSON.stringify(text.replace(/[\x21-\x7e]{19,}/g, token => [...token].join('\u200b')));
}

function fmt(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) unsupported('Legacy ticket money is invalid.');
    return `${amount.toFixed(2)} JD`;
}

function qty(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) unsupported('Legacy ticket quantity is invalid.');
    if (Math.abs(number * 1000 - Math.round(number * 1000)) > 1e-7) unsupported('Legacy ticket quantity precision is unsupported.');
    if (Number.isInteger(number)) return String(number);
    return Math.abs(number * 100 - Math.round(number * 100)) < 1e-7 ? number.toFixed(2) : number.toFixed(3);
}

function text(value, size = 25, weight = 400, align = 'left') {
    return `#block(width: 100%, below: 4pt)[#align(${align})[#text(font: ${FONT}, size: ${size}pt, weight: ${weight}, dir: auto)[#(${safe(value)})]]]`;
}

function pair(left, right, size = 25, weight = 600) {
    return `#block(width: 100%, below: 4pt)[#grid(columns: (1fr, auto), column-gutter: 8pt, [#text(font: ${FONT}, size: ${size}pt, weight: ${weight}, dir: auto)[#(${safe(left)})]], [#align(right)[#text(font: ${FONT}, size: ${size}pt, weight: ${weight}, dir: auto)[#(${safe(right)})]]])]`;
}

function itemRow(quantity, name, amount = '', { child = false, kitchen = false } = {}) {
    const size = kitchen ? 36 : child ? 30 : 25;
    const weight = kitchen ? 700 : 600;
    const first = kitchen ? `#context { let cell = [#text(font: ${FONT}, size: ${size}pt, weight: ${weight}, dir: auto)[#(${safe(quantity)})]]; box(width: calc.max(75pt, measure(cell).width + 12pt))[#cell] }`
        : `#text(font: ${FONT}, size: ${size}pt, weight: ${weight}, dir: auto)[#(${safe(quantity)})]`;
    const columns = kitchen ? '(auto, 1fr)' : '(65pt, 1fr, auto)';
    const cells = [
        `[${first}]`,
        `[#text(font: ${FONT}, size: ${size}pt, weight: ${weight}, dir: auto)[#(${safe(name)})]]`
    ];
    if (!kitchen) cells.push(`[#align(right)[#text(font: ${FONT}, size: ${size}pt, weight: ${weight}, dir: auto)[#(${safe(amount)})]]]`);
    return `#block(width: 100%, below: ${kitchen ? 8 : 4}pt)[#grid(columns: ${columns}, column-gutter: ${kitchen ? 0 : 4}pt, align: top, ${cells.join(', ')})]`;
}

function divider() { return '#block(width: 100%, above: 10pt, below: 10pt, height: 3pt)[#line(length: 100%, stroke: 2pt + black)]'; }
function time(data, value) { return formatBusinessTime(value, data.business_config?.business_sql_offset); }

function receipt(data, lines) {
    let config = {};
    if (data.storeInfo?.receipt_config) {
        try { config = JSON.parse(data.storeInfo.receipt_config); } catch { unsupported('Legacy receipt configuration is invalid.'); }
    }
    const layout = config.layout || ['header', 'meta', 'customer', 'items', 'totals', 'payment', 'footer'];
    if (!Array.isArray(layout) || layout.some(block => !['header', 'meta', 'customer', 'items', 'totals', 'payment', 'footer'].includes(block))) unsupported('Legacy receipt layout is invalid.');
    const model = data.receipt_display_v1;
    if (model !== undefined) {
        try { validateReceiptPresentation(model); } catch { unsupported('Legacy receipt presentation is invalid.'); }
    }
    const inclusive = model ? model.taxMode === 'inclusive' : data.storeInfo?.tax_inclusive_pricing === '1';
    for (const block of layout) {
        if (block === 'header') {
            lines.push(text(data.storeInfo?.store_name, 44, 800, 'center'));
            if (data.storeInfo?.store_address) lines.push(text(data.storeInfo.store_address, 26, 600, 'center'));
            if (data.storeInfo?.store_phone) lines.push(text(data.storeInfo.store_phone, 26, 600, 'center'));
            if (config.customHeaderText) lines.push(text(config.customHeaderText, 22, 600, 'center'));
            lines.push(divider());
        }
        if (block === 'meta') {
            if (data.hash_number) lines.push(text(`#${data.hash_number}`, 44, 800, 'center'));
            if (data.held_order_receipt === true) lines.push(pair(`Order: #${data.order_display_no || data.order_id || ''}`, time(data, data.date), 34, 800));
            else if (data.provisional === true || data.invoice_id === 'GUEST CHECK') {
                lines.push(pair('GUEST CHECK', time(data, data.date), 34, 800));
                if (data.table_number) lines.push(text(`Table: ${data.table_number}`, 34, 800));
            } else {
                const number = data.invoice_display_no || data.ticket_display_no || data.order_display_no || data.order_id;
                if (number) lines.push(text(`${data.invoice_display_no ? 'Invoice' : 'Ticket'}: ${number}`, 34, 800));
                lines.push(pair(data.order_id ? `Order: #${data.order_display_no || data.order_id}` : '', time(data, data.date), 34, 800));
                if (data.table_number) lines.push(text(`Table: ${data.table_number}`, 34, 800));
            }
            lines.push(pair(`Cashier: ${data.cashier || ''}`, data.order_type_name || ''));
            if (data.note || data.order_note) lines.push(text(`Note: ${data.note || data.order_note}`, 30, 600));
        }
        if (block === 'customer' && (data.customer_name || data.customer_phone)) {
            lines.push(text(`Customer: ${data.customer_name || 'N/A'}`));
            if (data.customer_phone) lines.push(text(`Phone: ${data.customer_phone}`));
            if (data.delivery_date) lines.push(text(`Delivery: ${formatBusinessTime(data.delivery_date, data.business_config?.business_sql_offset, true)}`));
            lines.push(divider());
        }
        if (block === 'items') {
            lines.push(itemRow('Qty', 'Item', 'Total'), divider());
            const rows = model ? model.rows : data.items;
            if (!Array.isArray(rows) || rows.length > MAX_ITEMS) unsupported('Legacy receipt items are invalid or exceed the limit.');
            for (const row of rows) {
                const child = model ? row.kind === 'bundle_child' : row._isChild;
                const name = child ? `• ${row.name} x${qty(row.qty)}` : row.name;
                let amount = '';
                if (!child && model) amount = fmt(row.netAmount);
                else if (!child) {
                    const quantity = Number(row.qty);
                    let total = Number(row.price || 0) * quantity;
                    const discount = Number(row.discountValue || 0);
                    if (row.discountType === 'fixed') total -= discount * quantity;
                    if (row.discountType === 'percent') total -= total * discount / 100;
                    total = Math.max(0, total);
                    if (!inclusive) total = row.tax_amount != null && row.tax_amount !== '' ? total + Number(row.tax_amount) : total * (1 + Number(row.tax_rate || 0) / 100);
                    amount = fmt(Math.round((total + Number.EPSILON) * 100) / 100);
                }
                lines.push(itemRow(child ? '' : `${qty(row.qty)}x`, name, amount, { child }));
                if (row.note && row.note !== 'Auto-Gratuity') for (const note of String(row.note).split('\n').filter(Boolean)) lines.push(text(`- ${note.trim()}`, 24, 600));
                if (model && row.lineDiscountAmount > 0) lines.push(text(`${row.lineDiscountLabel} Off (-${fmt(row.lineDiscountAmount)})`, 24, 600));
                if (!model && !child && Number(row.discountValue) > 0) {
                    const base = Number(row.price || 0) * Number(row.qty);
                    const discount = row.discountType === 'fixed' ? Number(row.discountValue) * Number(row.qty)
                        : row.discountType === 'percent' ? base * Number(row.discountValue) / 100 : 0;
                    if (discount > 0) lines.push(text(`Discount Off (-${fmt(Math.min(base, discount))})`, 24, 600));
                }
            }
            lines.push(divider());
        }
        if (block === 'totals') {
            const summary = model?.summary;
            if (!inclusive) {
                lines.push(pair('Subtotal', fmt(summary?.subtotal ?? data.subtotal)));
                lines.push(pair('Tax', summary?.taxLabel || fmt(summary?.taxAmount ?? data.tax)));
            }
            const discount = summary?.orderDiscountAmount ?? Number(data.discount || 0);
            if (discount > 0) lines.push(pair(summary?.orderDiscountLabel ? `Discount (${summary.orderDiscountLabel})` : 'Discount', `-${fmt(discount)}`));
            if (summary?.roundingAdjustment) lines.push(pair('Rounding', `${summary.roundingAdjustment > 0 ? '+' : ''}${fmt(summary.roundingAdjustment)}`));
            lines.push(pair('TOTAL', fmt(summary?.total ?? data.total), 34, 800));
        }
        if (block === 'payment' && !data.provisional && data.payment_method !== 'held') {
            if (data.payment_method === 'receivable' && model?.billing) {
                const billing = model.billing;
                lines.push(pair('Payment', 'RECEIVABLE'), pair('Issued', billing.issuedOn), pair('Due date', billing.dueOn), pair('Collected', fmt(billing.collectedAmount)), pair('Outstanding', fmt(billing.outstandingAmount)));
            } else if (data.payment_method === 'platform') lines.push(pair('Payment', 'PLATFORM'));
            else if (data.payment_method === 'split') {
                lines.push(pair('Cash', fmt(data.cash_amount)), pair('Card', fmt(data.card_amount)));
                if (Number(data.change_due) > 0) lines.push(pair('Change', fmt(data.change_due)));
            } else lines.push(pair('Payment', String(data.payment_method || 'CASH').toUpperCase()), pair('Tendered', fmt(data.amount_tendered)), pair('Change', fmt(data.change_due)));
            lines.push(divider());
        }
        if (block === 'footer') lines.push(text(config.customFooterText || 'Thank you!', 22, 600, 'center'));
    }
}

function kitchen(data, lines) {
    const redemption = data.subscription_redemption;
    const title = redemption ? redemption.is_void ? 'تم إلغاء وجبة الاشتراك / SUBSCRIPTION MEAL VOID' : 'وجبة اشتراك / SUBSCRIPTION MEAL'
        : data.cancel_ticket ? 'إلغاء الطلب / ORDER CANCELLED' : data.follow_up ? 'إضافة على الطلب / FOLLOW UP' : 'KITCHEN TICKET';
    lines.push(text(title, 48, 800, 'center'));
    if (redemption) {
        lines.push(divider(), text(redemption.reference, 36, 800, 'center'));
        if (redemption.customer_name) lines.push(text(redemption.customer_name, 30, 600, 'center'));
        if (redemption.customer_phone) lines.push(text(redemption.customer_phone, 30, 600, 'center'));
        lines.push(text(time(data, data.date), 30, 600, 'center'), divider());
    } else {
        if (data.follow_up) lines.push(text(`FOLLOW UP #${data.follow_up_sequence || ''}`, 36, 800, 'center'));
        if (data.order_type_name) lines.push(text(data.order_type_name, 44, 800, 'center'));
        if (data.hash_number) lines.push(text(`#${data.hash_number}`, 44, 800, 'center'));
        if (data.void_ticket && !data.cancel_ticket && !data.follow_up) {
            if (data.held_order) lines.push(text(`Order: #${data.order_display_no || data.order_id || ''}`, 36, 800, 'center'));
            lines.push(divider(), text(`TABLE: ${data.table_number || ''}`, 34, 800, 'center'));
            lines.push(pair('وقت الطباعة', time(data, new Date())), pair('وقت الطلب', time(data, data.order_taken_at)), divider(), text('تم إلغاء هذا الصنف', 44, 800, 'center'));
        } else {
            lines.push(divider());
            const number = data.held_order ? null : data.invoice_display_no || data.ticket_display_no || data.order_display_no;
            if (number) lines.push(text(`${data.invoice_display_no ? 'Invoice' : 'Ticket'}: ${number}`, 36, 800));
            lines.push(pair(data.order_id ? `Order: #${data.order_display_no || data.order_id}` : '', time(data, data.date), 36, 800));
            if (data.table_number) lines.push(text(`TABLE: ${data.table_number}`, 34, 800, 'center'));
            else lines.push(divider());
        }
    }
    if (!Array.isArray(data.items) || data.items.length > MAX_ITEMS) unsupported('Legacy kitchen items are invalid or exceed the limit.');
    for (const row of data.items.filter(item => !item._isOther)) {
        if (row._bundleLabel) lines.push(text(`[${row._bundleLabel}]`, 30, 600));
        lines.push(itemRow(`${qty(row.qty)}x`, row.name, '', { kitchen: true }));
        if (row.note) for (const note of String(row.note).split('\n').filter(Boolean)) lines.push(text(`*** ${note.trim()} ***`, 30, 800));
    }
    const other = data.items.filter(item => item._isOther);
    if (other.length) {
        lines.push(divider(), text('-- ALSO ON ORDER --', 30, 600, 'center'));
        for (const row of other) lines.push(itemRow(`${qty(row.qty)}x`, row.name, '', { kitchen: true }));
    }
}

function buildLegacyDocument(job) {
    if (!['receipt', 'kitchen'].includes(job?.print_type) || !job.data || typeof job.data !== 'object') unsupported('Legacy ticket payload is invalid.');
    const artifact = job.data.compiled_document_v1;
    if (artifact && artifact.nativeLayout !== undefined) unsupported('Malformed native layout cannot use legacy rendering.');
    if (artifact && (artifact.version !== 1 || artifact.kind !== 'compiled_document_v1' ||
        artifact.docType !== job.print_type || artifact.widthPx !== WIDTH || artifact.compilerVersion !== 1)) {
        unsupported('Legacy compiled document metadata is invalid.');
    }
    if (artifact && artifact.templateRevisionId !== `builtin:${job.print_type}-v1`) unsupported('Legacy saved custom templates require a native layout.');
    if (!Array.isArray(job.data.items) || (job.print_type === 'receipt' && !job.data.storeInfo)) unsupported('Legacy ticket has no complete structured payload.');
    const lines = [];
    if (job.print_type === 'receipt') receipt(job.data, lines);
    else kitchen(job.data, lines);
    const bottomMargin = job.print_type === 'kitchen' ? 200 : 60;
    return {
        width: WIDTH, assets: [], bottomMargin,
        source: `#set page(width: 576pt, height: auto, margin: (left: 10pt, right: 10pt, top: ${job.print_type === 'kitchen' ? 120 : 5}pt, bottom: ${bottomMargin}pt), fill: white)\n#set text(font: ${FONT}, size: 25pt, fill: black)\n#set par(leading: 5pt)\n${lines.join('\n')}`
    };
}

module.exports = { buildLegacyDocument };
