const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');

describe('parseDailyReportPeriod', () => {
    it('defaults to one business day and shifts comparison seven days', () => {
        const p = parseDailyReportPeriod({ defaultDate: '2026-07-14' });
        expect(p.start_date).toBe('2026-07-14');
        expect(p.end_date).toBe('2026-07-14');
        expect(p.comparison_start_date).toBe('2026-07-07');
        expect(p.business_day_start_hour).toBe(6);
        expect(p.business_day_end_hour).toBe(5);
    });

    it('rejects malformed, reversed, and over-366-day ranges', () => {
        expect(() => parseDailyReportPeriod({ startDate: 'bad', endDate: '2026-07-14' })).toThrow('Invalid report date.');
        expect(() => parseDailyReportPeriod({ startDate: '2026-02-30', endDate: '2026-03-01' })).toThrow('Invalid report date.');
        expect(() => parseDailyReportPeriod({ startDate: '2026-07-15', endDate: '2026-07-14' })).toThrow('End date must not be before start date.');
        expect(() => parseDailyReportPeriod({ startDate: '2025-01-01', endDate: '2026-07-14' })).toThrow('Report range cannot exceed 366 days.');
    });
});
