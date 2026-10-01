import { fetchJsonResponseWithTimeout, isUnansweredRequest } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';

const BASE = 'api/admin/stock-counts';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class CountApiError extends Error {
    constructor(message, { code = null, status = 0, data = null } = {}) {
        super(message || 'Something went wrong. Try again.');
        this.name = 'CountApiError';
        this.code = code;
        this.status = status;
        this.data = data;
    }
}

const ERROR_MESSAGES = {
    STOCK_COUNT_ALREADY_OPEN: 'A stock count is already open. Finish or delete it before starting another.',
    STOCK_COUNT_NOT_FOUND: 'This stock count no longer exists.',
    STOCK_COUNT_NOT_DRAFT: 'This stock count was already posted and cannot be changed.',
    STOCK_COUNT_EMPTY: 'Nothing has been counted yet. Count at least one item before posting.',
    STOCK_COUNT_BUSY: 'Stock is busy right now. Nothing was posted. Try again in a moment.',
    STOCK_COUNT_LINES_INVALID: 'Some counted quantities are not valid. Check the marked lines.',
    STOCK_COUNT_ITEM_UNSUPPORTED: "This item can't be counted. It is part of a combined product.",
    STOCK_COUNT_KEY_REUSED: 'This request was already used for a different action. Reload the count and try again.',
    STOCK_COUNT_INVALID: 'Check the count details and try again. A count holds at most 1000 items.',
    STOCK_COUNT_RECOUNT_NEEDED: 'An item was counted somewhere else after it was counted here. Enter its quantity again.',
    STOCK_COUNT_VALUE_TOO_LARGE: 'A difference value is too large to record. Check the quantities and unit costs.',
};

// One place turns any failure into text in the selected language. Network and
// browser errors never reach the screen as raw English browser messages.
export function describeError(error) {
    if (isUnansweredRequest(error)) return t('Network error. Check the connection and try again.');
    if (error?.code && ERROR_MESSAGES[error.code]) return t(ERROR_MESSAGES[error.code]);
    // An unmapped code carries the server's English text, which has no translation: never show it.
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
        throw new CountApiError(data?.message, { code: data?.code, status: response.status, data: data?.data ?? null });
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
const id = (value) => encodeURIComponent(value);

export const countsApi = {
    async listCounts({ status, beforeId, limit = 30 } = {}) {
        const body = await call(`${query({ status, before_id: beforeId, limit })}`);
        return { counts: body.data || [], nextBeforeId: body.next_before_id ?? null };
    },
    async listGroups() {
        return (await call('/groups')).data || [];
    },
    async searchItems({ q, limit = 30 }) {
        return (await call(`/items${query({ q, limit })}`)).data || [];
    },
    async createCount(body) {
        return (await call('/', { method: 'POST', body, timeoutMs: 30000 })).data;
    },
    async getCount(countId) {
        return (await call(`/${id(countId)}`, { timeoutMs: 30000 })).data;
    },
    async saveLines(countId, lines) {
        return (await call(`/${id(countId)}/lines`, { method: 'PUT', body: { lines }, timeoutMs: 30000 })).data;
    },
    async addLine(countId, itemKey) {
        return (await call(`/${id(countId)}/lines`, { method: 'POST', body: { item_key: itemKey } })).data;
    },
    async getReview(countId) {
        return (await call(`/${id(countId)}/review`, { timeoutMs: 30000 })).data;
    },
    async postCount(countId, requestKey) {
        return (await call(`/${id(countId)}/post`, { method: 'POST', body: { request_key: requestKey }, timeoutMs: 45000 })).data;
    },
    async deleteCount(countId) {
        return (await call(`/${id(countId)}`, { method: 'DELETE', timeoutMs: 30000 })).data;
    },
};
