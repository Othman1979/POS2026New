import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { currentLanguage, prepareLanguage } from '@/shared/i18n.js';
import { serveArabicDictionary } from '@/shared/__tests__/serveArabicDictionary.js';
import {
    formatReportBusinessDate,
    formatReportBusinessTime,
    formatReportMoney,
    formatReportNumber,
    formatReportPercent,
    formatReportWeekday,
} from '../reportFormatting.js';

describe('reportFormatting', () => {
    const originalLanguage = currentLanguage.value;

    beforeAll(() => { serveArabicDictionary(); return prepareLanguage('ar'); });

    afterEach(() => {
        currentLanguage.value = originalLanguage;
    });

    it('uses Latin digits in Arabic reports while keeping the Arabic currency label', () => {
        currentLanguage.value = 'ar';

        expect(formatReportNumber(1234.5)).toBe('1,234.5');
        expect(formatReportMoney(1234.5)).toBe('1,234.50 د.أ.');
        expect(formatReportPercent(8.77)).toBe('8.77%');
    });

    it('uses Latin digits for Arabic dashboard dates and times', () => {
        currentLanguage.value = 'ar';
        const values = [
            formatReportBusinessDate('2026-07-14'),
            formatReportBusinessTime('2026-07-14T09:05:00.000Z'),
        ];

        for (const value of values) {
            expect(value).toMatch(/[0-9]/);
            expect(value).not.toMatch(/[٠-٩]/);
        }
        expect(formatReportWeekday('2026-07-14')).toBe('الثلاثاء');
    });
});
