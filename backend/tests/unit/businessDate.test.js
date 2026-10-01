const { execFileSync } = require('child_process');
const path = require('path');
const bd = require('../../utils/businessDate');

describe('businessDate utilities', () => {
    it('separates calendar issue dates from the 06:00 business-day boundary', () => {
        expect(bd.getBusinessCalendarDate('2026-09-09 23:30:00')).toBe('2026-09-10');
        expect(bd.getBusinessDate(bd.parseBackendTimestamp('2026-09-09 23:30:00'))).toBe('2026-09-09');
        expect(bd.parseBackendTimestamp('2026-09-09 18:30:00').toISOString()).toBe('2026-09-09T18:30:00.000Z');
        expect(bd.normalizeScheduledDateTime('2026-09-09T18:30')).toBe('2026-09-09 18:30:00');
        expect(()=>bd.normalizeScheduledDateTime('2026-02-30T18:30')).toThrow('Enter a valid scheduled date and time.');
    });
    describe('config accessors', () => {
        it('parseBusinessSqlOffset returns minutes', () => {
            expect(bd.parseBusinessSqlOffset()).toBe(180);
        });

        it('getBusinessDayStartHour default is 6', () => {
            expect(bd.getBusinessDayStartHour()).toBe(6);
        });
    });

    describe('offset-first local parts', () => {
        it('datePartsAtBusinessOffset shifts UTC by the fixed offset', () => {
            const parts = bd.datePartsAtBusinessOffset(new Date('2026-06-30T23:30:00Z'));
            expect(parts).toMatchObject({ year: 2026, month: 7, day: 1, hour: 2, minute: 30 });
        });

        it('zonedLocalTimeToDate maps local midnight to UTC via offset', () => {
            expect(bd.zonedLocalTimeToDate('2026-07-01').toISOString()).toBe('2026-06-30T21:00:00.000Z');
        });
    });

    describe('06:00 cutoff', () => {
        const cases = [
            ['2026-06-30T23:30:00Z', '2026-06-30'],
            ['2026-07-01T02:59:59Z', '2026-06-30'],
            ['2026-07-01T03:00:00Z', '2026-07-01'],
            ['2026-07-01T20:30:00Z', '2026-07-01'],
        ];

        it.each(cases)('%s -> %s', (iso, expected) => {
            expect(bd.getBusinessDate(new Date(iso))).toBe(expected);
        });

        it('getBusinessDayRange yields the 06:00 UTC-converted window', () => {
            const range = bd.getBusinessDayRange('2026-07-01');
            expect(range).toMatchObject({
                date: '2026-07-01',
                nextDate: '2026-07-02',
                start: '2026-07-01 03:00:00',
                end: '2026-07-02 03:00:00',
            });
        });

        it('builds inclusive-date/exclusive-time ranges for multi-day reports', () => {
            const range = bd.getBusinessDateRange('2026-07-01', '2026-07-03');
            expect(range).toMatchObject({
                start: '2026-07-01 03:00:00',
                end: '2026-07-04 03:00:00',
                startDate: '2026-07-01',
                endDate: '2026-07-03',
            });
        });
    });

    describe('SQL helpers', () => {
        it('businessLocalDateSql subtracts the day-start hour', () => {
            const sql = bd.businessLocalDateSql('o.created_at');
            expect(sql).toContain("CONVERT_TZ(o.created_at, '+00:00', '+03:00')");
            expect(sql).toContain('- INTERVAL 6 HOUR');
            expect(sql).toContain("'%Y-%m-%d'");
        });

        it('businessLocalHourSql is the raw local hour label', () => {
            expect(bd.businessLocalHourSql('o.created_at'))
                .toBe("HOUR(CONVERT_TZ(o.created_at, '+00:00', '+03:00'))");
        });

        it('businessLocalHourSortSql wraps to business-day ordering', () => {
            expect(bd.businessLocalHourSortSql('o.created_at'))
                .toBe("((HOUR(CONVERT_TZ(o.created_at, '+00:00', '+03:00')) - 6 + 24) % 24)");
        });

        it('businessLocalElapsedMinuteSql wraps local time around the 06:00 business start', () => {
            expect(bd.businessLocalElapsedMinuteSql('o.created_at')).toBe(
                "MOD((HOUR(CONVERT_TZ(o.created_at, '+00:00', '+03:00')) * 60 + " +
                "MINUTE(CONVERT_TZ(o.created_at, '+00:00', '+03:00')) - 360 + 1440), 1440)"
            );
        });
    });

    it('adds business days using calendar dates', () => {
        expect(bd.addBusinessDays('2025-01-31', 1)).toBe('2025-02-01');
        expect(bd.addBusinessDays('2025-01-01', -6)).toBe('2024-12-26');
    });

    it('formats DB ranges independently of the Node host timezone', () => {
        const repoRoot = path.resolve(__dirname, '../../..');
        const script = [
            "const { getBusinessDayRange } = require('./backend/utils/businessDate');",
            "process.stdout.write(JSON.stringify(getBusinessDayRange('2026-07-01')));",
        ].join(' ');
        const output = execFileSync(process.execPath, ['-e', script], {
            cwd: repoRoot,
            env: { ...process.env, TZ: 'Europe/Berlin' },
            encoding: 'utf8',
        });

        expect(JSON.parse(output)).toMatchObject({
            start: '2026-07-01 03:00:00',
            end: '2026-07-02 03:00:00',
        });
    });
});
