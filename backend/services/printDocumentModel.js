const { validateReceiptPresentation } = require('./ReceiptPresentation');
const { validatePayments } = require('./CheckoutValidation');
const { sanitizePrintString } = require('./printText');
const { datePartsAtBusinessOffset, parseBackendTimestamp } = require('../utils/businessDate');

const KITCHEN_TICKET_TYPES = {
    normal: 'KITCHEN TICKET',
    void: 'KITCHEN TICKET',
    subscription: 'وجبة اشتراك / SUBSCRIPTION MEAL',
    subscription_void: 'تم إلغاء وجبة الاشتراك / SUBSCRIPTION MEAL VOID',
    follow_up: 'إضافة على الطلب / FOLLOW UP',
    cancel: 'إلغاء الطلب / ORDER CANCELLED'
};

const printable = (value, maxLen) => sanitizePrintString(value, maxLen);

function displayDateTime(value, scheduled = false) {
    const text = printable(value instanceof Date ? value.toISOString() : value, 100);
    if (!text || /^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    // Already formatted legacy print text is presentation, not an instant to reparse.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? [AP]M$/i.test(text)) return text;
    const local = scheduled && text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    let parts;
    if (local) {
        parts = { year: local[1], month: local[2], day: local[3], hour: Number(local[4]), minute: local[5], second: local[6] || '00' };
    } else {
        const date = parseBackendTimestamp(text);
        if (Number.isNaN(date.getTime())) return text;
        const zoned = datePartsAtBusinessOffset(date);
        parts = { ...zoned, month: String(zoned.month).padStart(2, '0'), day: String(zoned.day).padStart(2, '0'), minute: String(zoned.minute).padStart(2, '0'), second: String(zoned.second).padStart(2, '0') };
    }
    const suffix = parts.hour >= 12 ? 'PM' : 'AM';
    const hour = String(parts.hour % 12 || 12).padStart(2, '0');
    return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second} ${suffix}`;
}

function displayReceiptDateTime(value) {
    const dateTime = displayDateTime(value);
    const match = dateTime.match(/^(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2})(?::\d{2})?\s([AP]M)$/i);
    return match ? `${match[1]} ${match[2]} ${match[3].toUpperCase()}` : dateTime;
}

function receiptConfig(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function sanitizePresentation(presentation) {
    return {
        ...presentation,
        rows: presentation.rows.map(row => ({
            ...row,
            name: printable(row.name, 200),
            note: printable(row.note, 500),
            lineDiscountLabel: row.lineDiscountLabel == null ? null : printable(row.lineDiscountLabel, 200)
        })),
        summary: {
            ...presentation.summary,
            orderDiscountLabel: presentation.summary.orderDiscountLabel == null
                ? null
                : printable(presentation.summary.orderDiscountLabel, 200),
            taxLabel: presentation.summary.taxLabel == null ? null : printable(presentation.summary.taxLabel, 200)
        }
    };
}

function isProvisional(data) {
    return data.provisional === true || data.invoice_id === 'GUEST CHECK' || data.payment_method === 'held';
}

function nonPaidPayment() {
    return { method: null, cashAmount: 0, cardAmount: 0, amountTendered: 0, changeDue: 0 };
}

function receiptTaxNumber(data) {
    if (isProvisional(data)) return '';
    const profile = data.tax_registration_type_at_sale === 'income_tax'
        ? 'income_tax'
        : data.tax_registration_type_at_sale === 'sales_tax'
            ? 'sales_tax'
            : data.storeInfo?.tax_registration_type === 'income_tax' ? 'income_tax' : 'sales_tax';
    const key = profile === 'income_tax'
        ? 'jofotara_income_tax_seller_tax_number'
        : 'jofotara_sales_tax_seller_tax_number';
    return printable(data.storeInfo?.[key], 100);
}

function buildReceiptDocumentModel(data = {}, options = {}) {
    const presentation = data.receipt_display_v1;
    try {
        validateReceiptPresentation(presentation);
    } catch {
        return null;
    }

    const config = receiptConfig(data.storeInfo?.receipt_config);
    const provisional = isProvisional(data);
    // A held receipt has a queue identity, but never an invoice or a payment.
    // Render it in the numbered layout instead of the anonymous guest-check layout.
    const numberedHold = data.held_order_receipt === true && provisional && Number.isSafeInteger(Number(data.order_id)) && Number(data.order_id) > 0;
    if (!provisional && !['cash', 'card', 'split', 'receivable', 'platform'].includes(data.payment_method)) return null;
    const payment = provisional
        ? nonPaidPayment()
        : (['receivable', 'platform'].includes(data.payment_method)
          ? { method: data.payment_method, cashAmount: 0, cardAmount: 0, amountTendered: 0, changeDue: 0 }
          : (() => {
            const verified = validatePayments(data, presentation.summary.total);
            return {
                method: verified.paymentMethod,
                cashAmount: verified.cashAmount,
                cardAmount: verified.cardAmount,
                amountTendered: verified.amountTendered,
                changeDue: verified.changeDue
            };
          })());
    const trustedJofotara = !provisional && options.jofotara?.status === 'accepted' && options.jofotara.qrText
        ? { status: 'accepted', qrText: options.jofotara.qrText }
        : null;
    const sanitizedPresentation = sanitizePresentation(presentation);

    return {
        store: {
            name: printable(data.storeInfo?.store_name, 200),
            address: printable(data.storeInfo?.store_address, 300),
            phone: printable(data.storeInfo?.store_phone, 100),
            customHeaderText: printable(config.customHeaderText, 500),
            customFooterText: printable(config.customFooterText, 500)
        },
        meta: {
            invoiceDisplayNo: provisional ? null : printable(data.invoice_display_no, 100),
            ticketDisplayNo: provisional ? null : printable(data.ticket_display_no, 100),
            orderDisplayNo: provisional && !numberedHold ? null : printable(data.order_display_no, 100),
            internalInvoiceId: provisional ? null : (data.internal_invoice_id ?? data.invoice_id ?? null),
            date: displayReceiptDateTime(data.date),
            orderTakenAt: displayDateTime(data.order_taken_at),
            printRequestedAt: displayDateTime(options.printRequestedAt ?? new Date().toISOString()),
            cashier: printable(data.cashier, 200),
            taxNumber: receiptTaxNumber(data),
            orderTypeName: printable(data.order_type_name, 200),
            tableNumber: printable(data.table_number, 100),
            hashNumber: printable(data.hash_number, 100),
            provisional,
            heldOrderReceipt: numberedHold,
            guestCheck: provisional && !numberedHold,
            note: printable(data.note || data.order_note, 500)
        },
        customer: {
            name: printable(data.customer_name, 200),
            phone: printable(data.customer_phone, 100),
            address: printable(data.customer_address, 300),
            deliveryDate: displayDateTime(data.delivery_date, true)
        },
        payment,
        billing: presentation.billing ? {
            ...presentation.billing,
            issuedOn: displayDateTime(presentation.billing.issuedOn),
            dueOn: displayDateTime(presentation.billing.dueOn)
        } : null,
        jofotara: trustedJofotara,
        rows: sanitizedPresentation.rows,
        summary: sanitizedPresentation.summary,
        ...(sanitizedPresentation.taxExempt ? { taxExempt: true } : {}),
        taxMode: sanitizedPresentation.taxMode,
        status: sanitizedPresentation.status,
        currency: sanitizedPresentation.currency,
        decimals: sanitizedPresentation.decimals
    };
}

function kitchenTicketType(data) {
    if (data.cancel_ticket === true) return 'cancel';
    if (data.follow_up === true) return 'follow_up';
    if (data.subscription_redemption) {
        return data.subscription_redemption.is_void === true || data.void_ticket === true
            ? 'subscription_void'
            : 'subscription';
    }
    return data.void_ticket === true ? 'void' : 'normal';
}

// A plain kitchen ticket is headed by the store name, the way the receipt is.
// The other ticket types keep the functional heading the template supplies as a
// variant, so the kitchen can still tell a void or a follow-up at a glance.
// MySQL DECIMAL columns come back as strings ("1.000000"). The template engine rejects
// a non-finite numeric binding, and that rejection fails the whole document - which the
// caller then swallows, dropping every kitchen ticket back to the legacy layout. Coerce
// here so one un-parsed column cannot silently disable the template.
function finiteQuantity(value) {
    const quantity = Number(value);
    return Number.isFinite(quantity) ? quantity : 0;
}

function kitchenHeading(ticketType, storeInfo) {
    if (ticketType !== 'normal' && ticketType !== 'void') return KITCHEN_TICKET_TYPES[ticketType];
    return printable(storeInfo?.store_name, 200) || KITCHEN_TICKET_TYPES[ticketType];
}

function buildKitchenDocumentModel(data = {}, options = {}) {
    const ticketType = kitchenTicketType(data);
    const redemption = data.subscription_redemption;
    const items = Array.isArray(data.items) ? data.items : [];
    return {
        meta: {
            ...(data.held_order === true ? { numberedHold: true } : {}),
            ticketType,
            ticketTypeLabel: kitchenHeading(ticketType, options.storeInfo || data.storeInfo),
            invoiceDisplayNo: printable(data.invoice_display_no, 100),
            ticketDisplayNo: printable(data.held_order === true || data.invoice_display_no ? '' : (data.ticket_display_no || data.order_display_no), 100),
            orderDisplayNo: printable(data.order_display_no, 100),
            date: displayDateTime(data.date),
            orderTakenAt: displayDateTime(data.order_taken_at),
            printRequestedAt: displayDateTime(options.printRequestedAt ?? new Date().toISOString()),
            orderTypeName: printable(data.order_type_name, 200),
            tableNumber: printable(data.table_number, 100),
            hashNumber: printable(data.hash_number, 100),
            voidWarning: ticketType === 'void' ? 'تم إلغاء هذا الصنف' :
                ticketType === 'cancel' ? 'تم إلغاء الطلب بالكامل' : '',
            followUpSequence: ticketType === 'follow_up' ? Math.max(1, Number(data.follow_up_sequence) || 1) : 0
        },
        items: items.map(item => ({
            name: printable(item.name ?? item.product_name, 200),
            qty: finiteQuantity(item.qty ?? item.quantity),
            note: printable(item.note, 500),
            bundleLabel: printable(item._bundleLabel, 200),
            isOther: item._isOther === true
        })),
        voidTicket: data.void_ticket === true,
        hasOtherItems: items.some(item => item?._isOther === true),
        subscriptionRedemption: redemption ? {
            reference: printable(redemption.reference, 100),
            customerName: printable(redemption.customer_name, 200),
            customerPhone: printable(redemption.customer_phone, 100),
            isVoid: redemption.is_void === true
        } : null,
        printerLabel: printable(data.printer_label, 200)
    };
}

module.exports = { buildReceiptDocumentModel, buildKitchenDocumentModel };
