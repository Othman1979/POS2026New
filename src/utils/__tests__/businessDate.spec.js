import { beforeAll, describe, expect, it } from 'vitest';
import * as bd from '../businessDate.js';

beforeAll(() => {
    bd.initBusinessConfig({ business_sql_offset: '+03:00', business_day_start_hour: 6 });
});

describe('frontend businessDate utility', () => {
    it('parseBackendTimestamp treats MySQL strings as UTC', () => {
        expect(bd.parseBackendTimestamp('2026-07-01 02:30:00').toISOString())
            .toBe('2026-07-01T02:30:00.000Z');
    });

    it('toBusinessDate applies the 06:00 cutoff at the fixed offset', () => {
        expect(bd.toBusinessDate('2026-07-01 02:30:00')).toBe('2026-06-30');
        expect(bd.toBusinessDate('2026-07-01 03:00:00')).toBe('2026-07-01');
    });

    it('formats backend timestamps at the fixed venue offset', () => {
        expect(bd.formatBusinessDateTime('2026-07-01 02:30:00')).toBe('2026-07-01 05:30:00 AM');
    });

    it('formats concise report timestamps without leaking ISO Z notation', () => {
        expect(bd.formatBusinessDateTimeShort('2026-09-01T10:05:00.000Z'))
            .toBe('2026-09-01 01:05 PM');
        expect(bd.formatBusinessDateTimeShort(null)).toBe('');
        expect(bd.formatBusinessDateTimeShort('not-a-timestamp')).toBe('not-a-timestamp');
    });

    it('exposes the loaded business clock configuration for a child print window', () => {
        bd.initBusinessConfig({ business_sql_offset: '+04:30', business_day_start_hour: 7 });
        expect(bd.getBusinessConfig()).toEqual({
            business_sql_offset: '+04:30',
            business_day_start_hour: 7,
        });
        bd.initBusinessConfig({ business_sql_offset: '+03:00', business_day_start_hour: 6 });
    });

    it('subtracts calendar days from a business date without browser timezone drift', () => {
        expect(bd.addBusinessDateDays('2026-07-01', -6)).toBe('2026-06-25');
    });

    it('proves businessDayWindowLabel formats correctly', () => {
        bd.initBusinessConfig({ business_sql_offset: '+03:00', business_day_start_hour: 6 });
        expect(bd.getBusinessDayStartHour()).toBe(6);
        expect(bd.businessDayWindowLabel('2026-07-14', '2026-07-14'))
            .toBe('2026-07-14 06:00 → 2026-07-15 05:59');
    });
});

describe('business config boot read', () => {
    it('gives up on a stalled read and retries once when triggered after a failure', async () => {
        const { vi } = await import('vitest');
        vi.useFakeTimers();
        vi.resetModules();
        const fetch = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal('fetch', fetch);
        const mod = await import('../businessDate.js');
        const load = mod.loadBusinessConfig();
        const settled = load.then(() => 'ok', () => 'failed');
        await vi.advanceTimersByTimeAsync(3000);
        expect(await settled).toBe('failed');

        fetch.mockImplementation(async () => ({ json: async () => ({ success: true, business_sql_offset: '+02:00', business_day_start_hour: 5 }) }));
        mod.retryFailedBusinessConfig();
        mod.retryFailedBusinessConfig();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(mod.getBusinessConfig()).toEqual({ business_sql_offset: '+02:00', business_day_start_hour: 5 });
        mod.retryFailedBusinessConfig();
        expect(fetch).toHaveBeenCalledTimes(2);
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });
});
