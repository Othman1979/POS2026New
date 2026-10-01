import { describe, expect, it } from 'vitest';

describe('Orders overlay dismissal', () => {
    it('dismisses the topmost visible order layer first', async () => {
        let overlayState;
        try {
            overlayState = await import('../../../utils/orderOverlayState.js');
        } catch {
            overlayState = null;
        }

        expect(typeof overlayState?.topmostDismissibleOrderLayer).toBe('function');

        const topmost = overlayState?.topmostDismissibleOrderLayer;
        expect(topmost?.({ details: true, delivery: true, refund: true })).toBe('refund');
        expect(topmost?.({ details: true, delivery: true, refund: false })).toBe('delivery');
        expect(topmost?.({ details: true, summary: true })).toBe('summary');
        expect(topmost?.({ details: true, delivery: false, refund: false })).toBe('details');
        expect(topmost?.({ details: false, delivery: false, refund: false })).toBe(null);
    });
});
