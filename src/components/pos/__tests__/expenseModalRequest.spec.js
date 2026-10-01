import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/http.js', () => ({ fetchJsonResponseWithTimeout: vi.fn(), fetchReadJsonResponse: vi.fn() }));
vi.mock('@/pos/usePosDialogFocus.js', () => ({ usePosDialogFocus: () => {} }));
import Component from '../ExpenseModal.vue';
import { fetchJsonResponseWithTimeout, fetchReadJsonResponse } from '@/shared/http.js';

const ok = data => ({ response: { ok: true, status: 200 }, data });
let scope, props, state, emit;
const flush = async () => { await Promise.resolve(); await nextTick(); };

beforeEach(async () => {
    fetchReadJsonResponse.mockReset().mockImplementation(async url => ok(url === 'api/pos/expense-categories'
        ? { success: true, categories: [{ id: 3, name: 'Supplies' }] }
        : { success: true, categories: [] }));
    fetchJsonResponseWithTimeout.mockReset();
    scope = effectScope();
    props = reactive({ open: true });
    emit = vi.fn();
    state = scope.run(() => Component.setup(props, { expose() {}, emit }));
    await flush();
    state.amount.value = '5';
});
afterEach(() => scope.stop());

describe('expense submit', () => {
    it('records only the chosen category, amount and note, then clears the form', async () => {
        props.receiptPrinterId = 4;
        state.amount.value = '12.5';
        state.note.value = 'Ice';
        fetchJsonResponseWithTimeout.mockResolvedValueOnce(ok({ success: true, expense: { id: 9 } }));
        await state.submit();

        const [url, request] = fetchJsonResponseWithTimeout.mock.calls[0];
        const { request_id: requestId, ...body } = JSON.parse(request.body);
        expect(url).toBe('api/pos/expenses');
        expect(requestId).toBeTruthy();
        expect(body).toEqual({ category_id: 3, amount: 12.5, note: 'Ice', receipt_printer_id: 4, language: 'en' });
        expect([state.amount.value, state.note.value]).toEqual(['', '']);
    });
});

describe('expense submit recovery', () => {
    it('opens and sends a valid request_id on plain-HTTP terminals without crypto.randomUUID', async () => {
        scope.stop();
        vi.stubGlobal('crypto', { getRandomValues: bytes => bytes.fill(7) });
        try {
            scope = effectScope();
            state = scope.run(() => Component.setup(props, { expose() {}, emit }));
            await flush();
            state.amount.value = '5';
            fetchJsonResponseWithTimeout.mockResolvedValueOnce(ok({ success: true, expense: { id: 3 } }));
            await state.submit();
            expect(JSON.parse(fetchJsonResponseWithTimeout.mock.calls[0][1].body).request_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        } finally { vi.unstubAllGlobals(); }
    });

    it('bounds a stalled submit, stays closable, and retries with the same request_id', async () => {
        fetchJsonResponseWithTimeout.mockRejectedValueOnce(new DOMException('Request timed out.', 'TimeoutError'));
        await state.submit();
        expect(state.saving.value).toBe(false);
        expect(state.error.value).toMatch(/not confirmed/i);
        // Frozen so a retry cannot replay a different amount than the one that may have saved.
        expect(state.unconfirmed.value).toBe(true);
        const firstId = JSON.parse(fetchJsonResponseWithTimeout.mock.calls[0][1].body).request_id;
        expect(firstId).toBeTruthy();

        fetchJsonResponseWithTimeout.mockResolvedValueOnce(ok({ success: true, expense: { id: 9 }, print_queued: true }));
        await state.submit();
        expect(JSON.parse(fetchJsonResponseWithTimeout.mock.calls[1][1].body).request_id).toBe(firstId);
        expect(emit).toHaveBeenCalledWith('saved', { id: 9 }, true);
    });

    it('starts a new request_id after the form closes', async () => {
        fetchJsonResponseWithTimeout.mockRejectedValue(new TypeError('Failed to fetch'));
        await state.submit();
        const firstId = JSON.parse(fetchJsonResponseWithTimeout.mock.calls[0][1].body).request_id;
        state.close();
        expect(emit).toHaveBeenCalledWith('close');
        props.open = false; await flush();
        props.open = true; await flush();
        expect(state.unconfirmed.value).toBe(false);
        state.amount.value = '5';
        await state.submit();
        expect(JSON.parse(fetchJsonResponseWithTimeout.mock.calls[1][1].body).request_id).not.toBe(firstId);
    });
});
