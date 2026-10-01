import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Daily Reports localization contract', () => {
    const containsArabic = (value) => /[\u0600-\u06ff]/.test(String(value || ''));
    const reportFiles = [
        path.resolve(__dirname, '../../components/ReportsLayout.vue'),
        path.resolve(__dirname, '../../components/ReportPrintMenu.vue'),
        path.resolve(__dirname, '../ReportsSummary.vue'),
        path.resolve(__dirname, '../ReportsSalesDetails.vue'),
        path.resolve(__dirname, '../ReportsRefunds.vue'),
        path.resolve(__dirname, '../ReportsExpenses.vue')
    ];
    const reportSource = reportFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const dictionary = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));

    it('has an Arabic entry for every static report translation key', () => {
        const translationKeys = new Set(
            [...reportSource.matchAll(/\$t\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
        );
        const arabicKeys = new Set(Object.keys(dictionary));

        const missing = [...translationKeys].filter((key) => !arabicKeys.has(key)).sort();
        expect(missing).toEqual([]);
        expect([...translationKeys].filter((key) => !containsArabic(dictionary[key])).sort()).toEqual([]);
    });

    it('covers dynamic tab, payment, state, event, and fallback error keys', () => {
        const arabicKeys = new Set(Object.keys(dictionary));
        const dynamicKeys = [
            'Sales Breakdown',
            'Revenue, payments, and cash status',
            'Products, categories, and staff',
            'Refund activity and voided items',
            'Recorded expenses and drawer payouts',
            'cash',
            'card',
            'split',
            'refund',
            'void',
            'Item removed from table',
            'Table cleared',
            'Table {table}',
            'Search by table, invoice number, or reason',
            'balanced',
            'review',
            'in_progress',
            'no_shifts',
            'Failed to fetch report',
            'Failed to fetch refunds report',
            'Network error',
            'Print',
            'Thermal (80mm)',
            'Detailed A4',
            'Compact receipt layout',
            'Full-page detailed layout',
            'Preparing print preview…',
            'Popup was blocked. Allow popups and try again.',
            'Print preview failed. Try again.'
        ];

        expect(dynamicKeys.filter((key) => !arabicKeys.has(key))).toEqual([]);
        expect(dynamicKeys.filter((key) => !containsArabic(dictionary[key]))).toEqual([]);
    });

    it('uses restaurant-friendly Arabic wording for the summary accounting story', () => {
        expect(dictionary).toMatchObject({
            'expense entries': 'حركات مصروفات',
            'Operating remainder; this is not a profit figure': 'المبلغ المتبقي للتشغيل، وليس صافي الربح',
            'Already Reflected Above': 'مبالغ محسوبة ضمن الأرقام أعلاه',
            'These amounts explain the result and must not be subtracted again': 'هذه المبالغ توضح النتيجة، وهي محسوبة بالفعل فلا تخصمها مرة أخرى',
            'Tax removed for reference': 'المبلغ قبل الضريبة، للعرض فقط',
            'Tax Included': 'الضريبة محسوبة ضمن المبيعات',
            'Discounts Given': 'الخصومات الممنوحة',
            'Voided Before Payment': 'طلبات ملغاة قبل الدفع',
            'Not collected as sales': 'لم تدخل ضمن المبيعات المحصلة',
            'Service Charges Included': 'رسوم الخدمة محسوبة ضمن المبيعات',
            'Sales tenders and later receivable collections are shown separately': 'تُعرض طرق دفع المبيعات وتحصيلات الذمم اللاحقة كلٌّ على حدة',
            'Cash drawer': 'درج النقدية',
            'No comparable sales last week': 'لا توجد مبيعات للفترة نفسها من الأسبوع الماضي',
            'Collected later; not another sale': 'تم تحصيلها لاحقاً؛ وليست عملية بيع جديدة',
            'Platform Sales (not collected)': 'مبيعات المنصات (لم تُحصّل بعد)'
        });
    });

    it('does not hard-code English currency or typographic dash placeholders', () => {
        expect(reportSource).not.toContain("+ ' JD'");
        expect(reportSource).not.toContain('\u2014');
        expect(reportSource).not.toContain('\u2013');
    });
});
