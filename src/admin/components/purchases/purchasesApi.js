import { fetchJsonResponseWithTimeout, isUnansweredRequest } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';

const BASE = 'api/admin/purchases';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class PurchaseApiError extends Error {
    constructor(message, { code = null, status = 0 } = {}) {
        super(message || 'Something went wrong. Try again.');
        this.name = 'PurchaseApiError';
        this.code = code;
        this.status = status;
    }
}

const ERROR_MESSAGES = {
    PURCHASE_INVOICE_DUPLICATE: 'This supplier invoice number was already entered for this supplier.',
    PURCHASE_SUPPLIER_DUPLICATE: 'A supplier with this name already exists.',
    PURCHASE_INVOICE_LINES_INVALID: 'An invoice needs 1 to 100 lines, and each item can appear only once.',
    PURCHASE_INVOICE_STALE: 'This invoice was changed somewhere else. Reload it before saving again.',
    PURCHASE_INVOICE_BUSY: 'Stock is busy right now. Nothing was posted. Try again in a moment.',
    PURCHASE_INVOICE_NOT_FOUND: 'This invoice no longer exists.',
    PURCHASE_INVOICE_NOT_DRAFT: 'Only draft invoices can be changed.',
    PURCHASE_INVOICE_NOT_POSTED: 'Only posted invoices can be reversed.',
    PURCHASE_INVOICE_REVERSE_BLOCKED: "Some of these items were already sold or used, so reversing would take stock below zero. Correct it with a stock count instead.",
    PURCHASE_ITEM_UNSUPPORTED: "This item is part of a combined product and can't be received on a purchase invoice yet.",
    PURCHASE_INVOICE_KEY_REUSED: "This request was already used for a different action. Reload the invoice and try again.",
    PURCHASE_INVOICE_INVALID: "Check the invoice details: supplier, invoice number and date are required.",
    PURCHASE_ITEM_INVALID: "One of the items can't be used for stock. Remove it and try again.",
    PURCHASE_SUPPLIER_INVALID: "Enter a valid supplier name.",
    PURCHASE_REQUEST_INVALID: "Something in this request was not valid. Reload and try again.",
    PURCHASE_STOCK_TOO_LARGE: "This receipt would take an item above the largest stock quantity the system supports.",
};

// Same code as the below-zero refusal, with its own text.
const STOCK_RECORD_CHANGED = "This item's stock record changed after the invoice was posted. Correct it with a stock count instead.";

// One place turns any failure into text in the selected language. Network and
// browser errors never reach the screen as raw English browser messages.
export function describeError(error) {
    if (isUnansweredRequest(error)) return t('Network error. Check the connection and try again.');
    if (error?.code === 'PURCHASE_INVOICE_REVERSE_BLOCKED' && error.message === STOCK_RECORD_CHANGED) return t(STOCK_RECORD_CHANGED);
    if (error?.code && ERROR_MESSAGES[error.code]) return t(ERROR_MESSAGES[error.code]);
    if (error instanceof PurchaseApiError && error.message) return t(error.message);
    return t('Something went wrong. Try again.');
}

async function call(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
    const options = { method };
    if (body !== undefined) {
        options.headers = JSON_HEADERS;
        options.body = JSON.stringify(body);
    }
    const { response, data } = await fetchJsonResponseWithTimeout(`${BASE}${path}`, options, timeoutMs);
    if (!response.ok || !data || data.success === false) {
        throw new PurchaseApiError(data?.message, { code: data?.code, status: response.status });
    }
    return data;
}

const query = (params) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== '' && value !== null && value !== undefined) search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
};

export const purchasesApi = {
    async listSuppliers() {
        return (await call(`/suppliers${query({ active: 1 })}`)).data || [];
    },
    async createSupplier(supplier) {
        return (await call('/suppliers', { method: 'POST', body: supplier })).data;
    },
    // `kind` is 'product' or 'ingredient': a purchase invoice holds one kind of item.
    async searchItems({ kind, q, supplierId, barcode, categoryId, limit = 30 }) {
        return (await call(`/items${query({ kind, q, supplier_id: supplierId, barcode, category_id: categoryId, limit })}`)).data || [];
    },
    async itemInsights({ kind, itemKeys, supplierId }) {
        if (!itemKeys.length) return [];
        return (await call(`/items/insights${query({ kind, keys: itemKeys.join(','), supplier_id: supplierId })}`)).data || [];
    },
    async listCategories() {
        return (await call('/categories')).data || [];
    },
    async listInvoices({ kind, status, supplierId, q, beforeId, beforeGroup, limit = 30 }) {
        const body = await call(`/invoices${query({ kind, status, supplier_id: supplierId, q, before_id: beforeId, before_group: beforeGroup, limit })}`);
        return { invoices: body.data || [], nextBeforeId: body.next_before_id ?? null, nextBeforeGroup: body.next_before_group ?? null };
    },
    async getInvoice(id) {
        return (await call(`/invoices/${encodeURIComponent(id)}`)).data;
    },
    async lastInvoice(supplierId, kind) {
        return (await call(`/invoices/last${query({ kind, supplier_id: supplierId })}`)).data || null;
    },
    // `body.kind` is required here; an update keeps the invoice's stored kind.
    async createInvoice(body) {
        return (await call('/invoices', { method: 'POST', body, timeoutMs: 30000 })).data;
    },
    async updateInvoice(id, body) {
        return (await call(`/invoices/${encodeURIComponent(id)}`, { method: 'PUT', body, timeoutMs: 30000 })).data;
    },
    async deleteInvoice(id, expectedVersion) {
        return (await call(`/invoices/${encodeURIComponent(id)}`, { method: 'DELETE', body: { expected_version: expectedVersion }, timeoutMs: 30000 })).data;
    },
    async postInvoice(id, expectedVersion, requestKey) {
        return (await call(`/invoices/${encodeURIComponent(id)}/post`, { method: 'POST', body: { expected_version: expectedVersion, request_key: requestKey }, timeoutMs: 45000 })).data;
    },
    async reverseInvoice(id, requestKey) {
        return (await call(`/invoices/${encodeURIComponent(id)}/reverse`, { method: 'POST', body: { request_key: requestKey }, timeoutMs: 45000 })).data;
    },
};
