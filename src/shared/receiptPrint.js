import { fetchJson } from '@/shared/http.js';
// Shared receipt-print helpers for the ADMIN reprint flows.
//
// buildReceiptPayload — the canonical `print_type: "receipt"` payload. It always
//   carries the public display-number fields (invoice_display_no / order_display_no
//   / ticket_display_no) so the spooler prints "Invoice: <number>" instead of
//   falling back to "Ticket: <order_id>", and the full per-item tax/discount fields
//   so line discounts render on reprints. Pure — no Vue refs, no I/O.
//
// printJob — POST a print job to the local bridge and surface the admin toast.
//   The success/error/throw messages match the previous inline admin behavior.
//
// Out of scope by design: the POS reprint paths (OrderNotes, TableSplits) use a
// success *toast* (window.showPosToast) and, for splits, a provisional payload;
// they intentionally keep their own flows and do not consume these helpers.

import { validateReceiptPresentation } from '@/utils/receiptPresentation.js';

export function buildReceiptPayload(order, items, { storeInfo, receiptPrinterId = '' } = {}) {
    const src = order || {};
    const payload = {
        print_type: 'receipt',
        receipt_printer_id: receiptPrinterId,
        storeInfo,
        order_id: src.order_id,
        invoice_id: src.invoice_id,
        invoice_display_no: src.invoice_display_no || null,
        order_display_no: src.order_display_no || null,
        ticket_display_no: src.ticket_display_no || null,
        date: src.created_at,
        cashier: src.cashier_name,
        tax_registration_type_at_sale: src.tax_registration_type_at_sale || null,
        order_type_name: src.order_type_name,
        customer_name: src.customer_name,
        customer_phone: src.customer_phone,
        customer_address: src.customer_address,
        items: (items || []).map((i) => ({
            qty: i.quantity,
            name: i.product_name,
            price: i.price_at_sale,
            tax_rate: i.tax_rate || 0,
            tax_amount: i.tax_amount ?? null,
            discountType: i.discount_type || null,
            discountValue: Number(i.discount_value || 0),
            note: i.note,
        })),
        subtotal: src.subtotal,
        tax: src.tax,
        discount: src.discount_value,
        discount_type: src.discount_type || null,
        total: src.total,
        payment_method: src.payment_method,
        amount_tendered: src.amount_tendered,
        change_due: src.change_due,
        cash_amount: src.cash_amount,
        card_amount: src.card_amount,
    };
    if (src.jofotara?.status === 'accepted' && src.jofotara.qrText) {
        payload.jofotara = { status: 'accepted', uuid: src.jofotara.uuid, qrText: src.jofotara.qrText };
    }
    if (src.receipt_display_v1) {
        validateReceiptPresentation(src.receipt_display_v1);
        payload.receipt_display_v1 = src.receipt_display_v1;
    }
    if (src.receipt_display_legacy_reason) {
        payload.receipt_display_legacy_reason = src.receipt_display_legacy_reason;
    }
    return payload;
}

export async function printJob(payload, { alert, t = (s) => s, successKey = 'Receipt reprinted successfully!' } = {}) {
    const notify = alert
        || (typeof window !== 'undefined' ? window.showAdminAlert : null)
        || (() => {});
    try {
        const data = await fetchJson('api/print/print', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (data.success) {
            await notify(t(successKey));
        } else {
            await notify(t('Print Bridge Error:') + ' ' + (data.message || t('Unknown error')));
        }
        return data;
    } catch (e) {
        console.error(e);
        await notify(t('Failed to print. Is your Node.js Spooler running?'));
        return { success: false, error: e };
    }
}
