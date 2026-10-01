import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrderTypes } from './orderSessionApi.js';

describe('order types read', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('rejects a stalled read at its deadline instead of hanging recovery', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        const read = getOrderTypes();
        const outcome = expect(read).rejects.toMatchObject({ name: 'TimeoutError' });
        await vi.advanceTimersByTimeAsync(15000);
        await outcome;
    });
});
