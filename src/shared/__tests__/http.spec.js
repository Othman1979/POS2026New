import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, fetchJsonResponse, fetchReadJsonResponse } from '../http.js';

describe('fetchJson', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('passes the resource and options to the current fetch and returns parsed JSON', async () => {
        const options = { method: 'POST', body: '{"ok":true}' };
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            json: () => Promise.resolve({ success: true })
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchJson('api/example', options)).resolves.toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledWith('api/example', options);
    });

    it('returns the exact response with parsed JSON without enforcing HTTP status', async () => {
        const options = { signal: new AbortController().signal };
        const response = {
            ok: false,
            status: 409,
            json: vi.fn().mockResolvedValue({ success: false, message: 'Conflict' })
        };
        const fetchMock = vi.fn().mockResolvedValue(response);
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchJsonResponse('api/example', options)).resolves.toEqual({
            response,
            data: { success: false, message: 'Conflict' }
        });
        expect(fetchMock).toHaveBeenCalledWith('api/example', options);
        expect(response.json).toHaveBeenCalledOnce();
    });

    it('propagates fetch failures unchanged', async () => {
        const failure = new Error('offline');
        const fetchMock = vi.fn().mockRejectedValue(failure);
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchJson('api/example')).rejects.toBe(failure);
        expect(fetchMock).toHaveBeenCalledWith('api/example', undefined);
    });

    it('propagates JSON parsing failures unchanged', async () => {
        const failure = new SyntaxError('invalid JSON');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            json: () => Promise.reject(failure)
        }));

        await expect(fetchJson('api/example')).rejects.toBe(failure);
        await expect(fetchJsonResponse('api/example')).rejects.toBe(failure);
    });

    it.each(['headers', 'body'])('bounds a stalled read through %s and aborts its transport', async stage => {
        vi.useFakeTimers();
        let signal;
        vi.stubGlobal('fetch', vi.fn((resource, options) => {
            signal = options.signal;
            return stage === 'headers' ? new Promise(() => {}) : Promise.resolve({ json: () => new Promise(() => {}) });
        }));
        const result = fetchReadJsonResponse('api/read', {}, 100).catch(error => error);
        await vi.advanceTimersByTimeAsync(100);
        expect((await result).name).toBe('TimeoutError');
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('honors caller cancellation while parsing a body even when a transport ignores abort', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        vi.stubGlobal('fetch', vi.fn(async () => ({ json: () => new Promise(() => {}) })));
        const result = fetchReadJsonResponse('api/read', { signal: controller.signal }, 100).catch(error => error);
        controller.abort();
        expect((await result).name).toBe('AbortError');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not start an already-cancelled read and clears successful deadlines', async () => {
        vi.useFakeTimers();
        const controller = new AbortController(); controller.abort();
        const response = { ok: false, status: 503, json: async () => ({ success: false }) };
        vi.stubGlobal('fetch', vi.fn(async () => response));
        await expect(fetchReadJsonResponse('api/read', { signal: controller.signal }, 100)).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetch).not.toHaveBeenCalled();
        await expect(fetchReadJsonResponse('api/read', {}, 100)).resolves.toEqual({ response, data: { success: false } });
        expect(vi.getTimerCount()).toBe(0);
    });
});
