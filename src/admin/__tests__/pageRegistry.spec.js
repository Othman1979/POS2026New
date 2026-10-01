import { describe, expect, it } from 'vitest';
import { initialPage, preloadPage } from '../pageRegistry.js';

const store = (value) => () => ({ getItem: () => value });

describe('initialPage', () => {
    it('uses the first URL segment after /admin', () => {
        expect(initialPage('/admin/orders', store('users'))).toBe('orders');
        expect(initialPage('/admin/orders/', store(null))).toBe('orders');
        expect(initialPage('/orders', store(null))).toBe('orders');
    });

    it('falls back to the saved page on the bare admin path', () => {
        expect(initialPage('/admin', store('users'))).toBe('users');
        expect(initialPage('/admin/', store('users'))).toBe('users');
        expect(initialPage('/', store('shifts'))).toBe('shifts');
    });

    it('falls back to the dashboard when nothing is saved or storage throws', () => {
        expect(initialPage('/admin', store(null))).toBe('dashboard');
        expect(initialPage('/admin', () => { throw new Error('blocked'); })).toBe('dashboard');
        expect(initialPage('/admin', () => undefined)).toBe('dashboard');
    });
});

describe('preloadPage', () => {
    it('ignores names that are not pages, including inherited object keys', () => {
        for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'nope']) {
            expect(() => preloadPage(name)).not.toThrow();
        }
    });
});
