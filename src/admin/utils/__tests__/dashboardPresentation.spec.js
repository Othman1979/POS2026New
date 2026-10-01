import { beforeAll, describe, expect, it } from 'vitest';
import {
    buildDashboardNarrative,
    attentionMessage,
    formatElapsedMinutes,
    formatProductUnits,
} from '../dashboardPresentation.ts';
import { prepareLanguage, t } from '@/shared/i18n.js';
import { serveArabicDictionary } from '@/shared/__tests__/serveArabicDictionary.js';

const translate = value => value;
const payload = {
    business_date: '2026-07-14',
    headline: { sales_today: 120, orders: 12, average_check: 10, estimated_close: 240 },
    history: { eligible_days: 4, comparison_ready: true },
    comparison: {
        pace_state: 'ahead',
        driver: 'orders',
        delta: {
            sales_today: { amount: 20, percent: 20 },
            orders: { amount: 2, percent: 20 },
            average_check: { amount: 0, percent: 0 },
        },
    },
};

describe('dashboardPresentation', () => {
    beforeAll(() => { serveArabicDictionary(); return prepareLanguage('ar'); });

    it('builds fixed natural narrative from reason codes', () => {
        expect(buildDashboardNarrative(payload, translate)).toBe(
            'Sales are 20% ahead of a typical Tuesday. More orders caused most of the increase.'
        );
    });

    it('never claims comparison when history is sparse', () => {
        expect(buildDashboardNarrative({
            ...payload,
            history: { eligible_days: 2, comparison_ready: false },
        }, translate)).toBe('Not enough matching days for a useful comparison yet.');
    });

    it('uses calm empty-day copy', () => {
        expect(buildDashboardNarrative({
            ...payload,
            headline: { ...payload.headline, sales_today: 0, orders: 0 },
        }, translate)).toBe('No sales yet today.');
    });

    it('formats typed attention objects without backend prose', () => {
        expect(attentionMessage({
            message_key: 'register_variance',
            params: { amount: 3.5, direction: 'short' },
        }, translate)).toBe('One closed register is 3.50 JD short.');
    });

    it('formats elapsed durations without seconds', () => {
        expect(formatElapsedMinutes(135, translate)).toBe('2 hr 15 min');
    });

    it('uses natural singular and plural product units', () => {
        expect(formatProductUnits(1, translate)).toBe('1 Unit');
        expect(formatProductUnits(2, translate)).toBe('2 Units');
        expect(formatProductUnits(1, value => ({ Unit: 'وحدة', Units: 'وحدات' }[value] || value)))
            .toBe('1 وحدة');
    });

    it('translates the stock alert control for Arabic users', () => {
        expect(t('Stock alerts', 'ar')).toBe('تنبيهات المخزون');
    });
});
