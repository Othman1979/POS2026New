import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/i18n.js', () => ({ t: key => globalThis.__testDictionary?.[key] ?? key }));
vi.mock('@/shared/http.js', async original => ({ ...await original(), fetchJsonResponseWithTimeout: vi.fn() }));
import { fetchJsonResponseWithTimeout } from '@/shared/http.js';
import { CountApiError, countsApi, describeError } from '../counts/countsApi.js';

const NETWORK = 'Network error. Check the connection and try again.';
const reply = (data, ok = true, status = 200) => ({ response: { ok, status }, data });

beforeEach(() => fetchJsonResponseWithTimeout.mockReset());

describe('stock counts api errors', () => {
    it('maps every unanswered-request error to the translated network message', () => {
        for (const name of ['TypeError', 'AbortError', 'TimeoutError', 'SyntaxError']) {
            expect(describeError(Object.assign(new Error('Failed to fetch'), { name }))).toBe(NETWORK);
        }
    });

    it('maps server codes to translated text and falls back to a generic message', () => {
        expect(describeError(new CountApiError('x', { code: 'STOCK_COUNT_BUSY' }))).toBe('Stock is busy right now. Nothing was posted. Try again in a moment.');
        expect(describeError(new CountApiError('x', { code: 'STOCK_COUNT_EMPTY' }))).toContain('Nothing has been counted yet');
        expect(describeError(new CountApiError('Stock count operation failed.', { code: 'STOCK_COUNT_SOMETHING_NEW' }))).toBe('Something went wrong. Try again.');
        expect(describeError(new CountApiError('Stock count operation failed.', { status: 500 }))).toBe('Something went wrong. Try again.');
        expect(describeError(new Error('raw browser text'))).toBe('Something went wrong. Try again.');
    });
});

describe('stock counts api in Arabic', () => {
    const ar = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));
    beforeEach(() => { globalThis.__testDictionary = ar; });
    afterEach(() => { delete globalThis.__testDictionary; });

    it('shows the Arabic generic message for an unmapped code or a bare 500, never the English server text', () => {
        for (const error of [new CountApiError('Stock count operation failed.', { code: 'STOCK_COUNT_SOMETHING_NEW', status: 500 }), new CountApiError('Stock count operation failed.', { status: 500 })]) {
            const text = describeError(error);
            expect(text).toBe(ar['Something went wrong. Try again.']);
            expect(text).toMatch(/[؀-ۿ]/);
        }
    });

    it('keeps the general and the too-large messages apart', () => {
        expect(describeError(new CountApiError('x', { code: 'STOCK_COUNT_INVALID' }))).toBe(ar['Check the count details and try again. A count holds at most 1000 items.']);
        expect(describeError(new CountApiError('x', { code: 'STOCK_COUNT_VALUE_TOO_LARGE' }))).toBe(ar['A difference value is too large to record. Check the quantities and unit costs.']);
    });

    it('translates every mapped code', () => {
        for (const code of ['STOCK_COUNT_ALREADY_OPEN', 'STOCK_COUNT_NOT_FOUND', 'STOCK_COUNT_NOT_DRAFT', 'STOCK_COUNT_EMPTY', 'STOCK_COUNT_BUSY', 'STOCK_COUNT_LINES_INVALID', 'STOCK_COUNT_ITEM_UNSUPPORTED', 'STOCK_COUNT_KEY_REUSED', 'STOCK_COUNT_INVALID', 'STOCK_COUNT_VALUE_TOO_LARGE', 'STOCK_COUNT_RECOUNT_NEEDED']) {
            expect(describeError(new CountApiError('x', { code }))).toMatch(/[؀-ۿ]/);
        }
    });
});

describe('stock counts api calls', () => {
    it('builds the list query and returns the cursor', async () => {
        fetchJsonResponseWithTimeout.mockResolvedValue(reply({ success: true, data: [{ id: 3 }], next_before_id: 2 }));
        expect(await countsApi.listCounts({ status: 'draft', beforeId: 5 })).toEqual({ counts: [{ id: 3 }], nextBeforeId: 2 });
        expect(fetchJsonResponseWithTimeout.mock.calls[0][0]).toBe('api/admin/stock-counts?status=draft&before_id=5&limit=30');
        expect(fetchJsonResponseWithTimeout.mock.calls[0][2]).toBeGreaterThan(0);
    });

    it('sends line saves as PUT with a deadline', async () => {
        fetchJsonResponseWithTimeout.mockResolvedValue(reply({ success: true, data: { lines: [], counted_count: 0 } }));
        await countsApi.saveLines(7, [{ id: 1, qty: null, unit_label: 'g', unit_factor: '1' }]);
        const [url, options, timeout] = fetchJsonResponseWithTimeout.mock.calls[0];
        expect(url).toBe('api/admin/stock-counts/7/lines');
        expect(options.method).toBe('PUT');
        expect(JSON.parse(options.body).lines).toHaveLength(1);
        expect(timeout).toBeGreaterThan(0);
    });

    it('raises a typed error carrying the code and open_id of a refused start', async () => {
        fetchJsonResponseWithTimeout.mockResolvedValue(reply({ success: false, code: 'STOCK_COUNT_ALREADY_OPEN', message: 'open', data: { open_id: 4 } }, false, 409));
        const error = await countsApi.createCount({ count_date: '2026-09-30', groups: ['all'], request_key: 'k' }).catch(caught => caught);
        expect(error).toBeInstanceOf(CountApiError);
        expect(error.code).toBe('STOCK_COUNT_ALREADY_OPEN');
        expect(error.status).toBe(409);
        expect(error.data.open_id).toBe(4);
    });

    it('posts with the request key in the body', async () => {
        fetchJsonResponseWithTimeout.mockResolvedValue(reply({ success: true, data: { id: 7, status: 'posted' } }));
        await countsApi.postCount(7, 'abc');
        expect(JSON.parse(fetchJsonResponseWithTimeout.mock.calls[0][1].body)).toEqual({ request_key: 'abc' });
    });
});
