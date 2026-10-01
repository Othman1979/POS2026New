import { beforeEach, describe, expect, it } from 'vitest';
import * as clock from '../businessDate.js';
import { mergedCardsByTime } from '../orderNotesBoard.js';

describe('scheduled business-local time versus UTC events', () => {
    beforeEach(() => {
        clock.initBusinessConfig({ business_sql_offset: '+03:00', business_day_start_hour: 6 });
    });

    it('preserves entered clock time while resolving it to the venue instant', () => {
        expect(clock.scheduledDateTimeInput('2026-09-09 18:30:00')).toBe('2026-09-09T18:30');
        expect(clock.parseScheduledTimestamp('2026-09-09T18:30').toISOString()).toBe('2026-09-09T15:30:00.000Z');
        expect(clock.formatScheduledDateTime('2026-09-09T18:30')).toBe('2026-09-09 06:30 PM');
        expect(clock.formatBusinessDateTime('2026-09-09 18:30:00')).toBe('2026-09-09 09:30:00 PM');
    });
    it('keeps date-only fields unchanged and handles compact explicit offsets', () => {
        expect(clock.formatBusinessDate('2026-09-09')).toBe('2026-09-09');
        expect(clock.parseBackendTimestamp('2026-09-09T18:30:00+0300').toISOString()).toBe('2026-09-09T15:30:00.000Z');
        expect(clock.scheduledDateTimeInput(null)).toBe('');
        expect(clock.scheduledDateTimeInput('0000-00-00 00:00:00')).toBe('');
    });
    it('sorts schedules and creation instants on the same timeline', () => {
        const groups = { orders: [
            { id: 'scheduled', delivery_date: '2026-09-09 18:30:00' },
            { id: 'created', created_at: '2026-09-09T16:00:00Z' },
        ] };
        expect(mergedCardsByTime(groups, ['orders']).map(row => row.id)).toEqual(['scheduled', 'created']);
    });
});
