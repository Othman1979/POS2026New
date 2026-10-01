<template>
    <div v-if="isAuditReport" class="audit-document" dir="rtl">
        <article class="a4-report audit-page" data-audit-page="financial-summary">
            <header class="running-header audit-running">
                <div class="running-row">
                    <strong class="running-store">{{ storeName }}</strong>
                    <strong class="running-serial">{{ auditIdentity }}</strong>
                </div>
                <div class="running-row running-context">
                    <span class="num">{{ auditWindowLabel }}</span>
                    <span>الملخص المالي وتسوية الصندوق</span>
                </div>
            </header>

            <footer class="running-footer audit-running">
                <div class="running-row">
                    <span class="footer-hash num">{{ data.payload_hash || '' }}</span>
                    <span>الملخص المالي</span>
                    <span class="num">{{ data.serial_label || reportTitle }}</span>
                </div>
            </footer>

            <div class="page-body">
                <div class="report-title">
                    <p class="store-name">{{ storeName }}</p>
                    <h1>{{ reportTitle }}</h1>
                    <p class="report-purpose">{{ auditPurpose }}</p>
                </div>

                <dl class="docket audit-docket">
                    <div v-if="auditWindowLabel"><dt>فترة العمل</dt><dd class="num">{{ auditWindowLabel }}</dd></div>
                    <div v-if="data.generated_at"><dt>وقت الإعداد</dt><dd class="num">{{ auditGeneratedAt }}</dd></div>
                    <div v-if="data.generated_by?.name"><dt>أعده</dt><dd>{{ data.generated_by.name }}</dd></div>
                    <div v-if="data.serial_label"><dt>الرقم المتسلسل</dt><dd class="num">{{ data.serial_label }}</dd></div>
                    <div v-if="data.payload_hash" class="docket-wide"><dt>بصمة التقرير</dt><dd class="hash num">{{ data.payload_hash }}</dd></div>
                    <div v-if="data.copy_label" class="copy-cell"><span class="copy" :class="{ 'copy--original': data.copy_label !== 'REPRINT', 'copy--reprint': data.copy_label === 'REPRINT' }">{{ auditCopyLabel }}</span></div>
                </dl>

                <section class="verdict" aria-label="نتيجة الإغلاق">
                    <div class="verdict-main">
                        <span class="verdict-label">حالة تسوية المناوبات</span>
                        <strong class="verdict-result">{{ auditShiftReview.result }}</strong>
                    </div>
                    <div class="verdict-facts">
                        <div><span>المناوبات المشمولة</span><strong class="num">{{ auditShiftReview.total }}</strong></div>
                        <div><span>تحتاج مراجعة</span><strong class="num">{{ auditShiftReview.needsReview }}</strong></div>
                        <div><span>مفتوحة / بلا جرد</span><strong class="num">{{ auditShiftReview.open }} / {{ auditShiftReview.uncounted }}</strong></div>
                    </div>
                </section>

                <section class="section">
                    <h2 class="section-head">الملخص المالي</h2>
                    <div class="metrics">
                        <div v-for="item in metrics" :key="item.label" class="metric">
                            <div class="metric-label">{{ item.label }}</div>
                            <div class="metric-value num">{{ item.value }}</div>
                        </div>
                    </div>
                </section>

                <div class="split-ledger">
                    <section class="section">
                        <h2 class="section-head">احتساب صافي المبيعات</h2>
                        <table class="compact">
                            <tbody>
                                <tr v-for="row in auditSalesRows" :key="row.label" :class="{ total: row.total }">
                                    <td>{{ row.label }}</td>
                                    <td class="num">{{ row.value }}</td>
                                </tr>
                            </tbody>
                        </table>
                        <span class="row-note">المبيعات شاملة الضريبة محسوبة بعد المرتجعات والخصومات. القيمتان معروضتان للمراجعة ولا تخصمان مرة أخرى. الإلغاءات لا تدخل ضمن المبيعات لأنها تخص طلبات ألغيت قبل الدفع.</span>
                    </section>

                    <section class="section">
                        <h2 class="section-head">ملخص مراجعة المناوبات</h2>
                        <table class="compact">
                            <tbody>
                                <tr v-for="row in auditShiftReviewRows" :key="row.label" :class="{ total: row.total }">
                                    <td>{{ row.label }}</td>
                                    <td class="num">{{ row.value }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </section>
                </div>

                <section class="section payment-section">
                    <h2 class="section-head">توزيع المبيعات حسب طريقة التحصيل</h2>
                    <table class="compact">
                        <thead><tr><th>طريقة التحصيل</th><th class="num">عدد العمليات</th><th class="num">المبلغ</th><th class="num">النسبة من المبيعات</th><th>حالة التحصيل</th></tr></thead>
                        <tbody>
                            <tr v-for="row in auditPaymentRows" :key="row.method" :class="{ total: row.total }">
                                <td>{{ row.method }}</td><td class="num">{{ row.count }}</td><td class="num">{{ row.amount }}</td><td class="num">{{ row.share }}</td><td>{{ row.status }}</td>
                            </tr>
                        </tbody>
                    </table>
                    <span class="row-note">إجمالي المبالغ المحصلة: <b class="num">{{ money(data.payments?.total_collected) }}</b>.</span>
                </section>
            </div>
        </article>

        <article class="a4-report audit-page audit-page--last" data-audit-page="operational-details">
            <header class="running-header audit-running">
                <div class="running-row">
                    <strong class="running-store">{{ storeName }}</strong>
                    <strong class="running-serial">{{ auditIdentity }}</strong>
                </div>
                <div class="running-row running-context">
                    <span class="num">{{ auditWindowLabel }}</span>
                    <span>تفاصيل المناوبات والحركات المالية</span>
                </div>
            </header>

            <footer class="running-footer audit-running">
                <div class="running-row">
                    <span class="footer-hash num">{{ data.payload_hash || '' }}</span>
                    <span>{{ endMarker }}</span>
                    <span class="num">{{ data.serial_label || reportTitle }}</span>
                </div>
            </footer>

            <div class="page-body">
                <div class="report-title">
                    <p class="store-name">{{ auditIdentity }}</p>
                    <h1>التفاصيل التشغيلية</h1>
                    <p class="report-purpose">تفاصيل المناوبات وأنواع الطلبات والخصومات والمرتجعات والمصروفات</p>
                </div>

                <section class="section">
                    <h2 class="section-head">المناوبات</h2>
                    <div class="audit-shifts">
                        <article v-for="shift in auditShiftRows" :key="shift.id" class="audit-shift-ledger">
                            <header class="audit-shift-head">
                                <div><strong class="num">#{{ shift.id }}</strong><strong>{{ shift.cashier }}</strong></div>
                                <strong>{{ shift.status }}</strong>
                            </header>
                            <div class="audit-shift-time"><span>بدأت: <b class="num">{{ shift.opened }}</b></span><span>انتهت: <b class="num">{{ shift.closed }}</b></span></div>
                            <div class="audit-shift-activity">
                                <strong>نشاط ضمن نافذة التقرير</strong>
                                <div class="audit-shift-columns">
                                    <table class="compact">
                                        <tbody>
                                            <tr><td>عدد الطلبات</td><td class="num">{{ shift.orders }}</td></tr>
                                            <tr><td>المبيعات شاملة الضريبة</td><td class="num">{{ shift.sales }}</td></tr>
                                            <tr><td>الضريبة المحصلة</td><td class="num">{{ shift.tax }}</td></tr>
                                            <tr><td>نقدًا / بطاقة / منصات</td><td class="num">{{ shift.cash }} / {{ shift.card }} / {{ shift.platform }}</td></tr>
                                        </tbody>
                                    </table>
                                    <table class="compact">
                                        <tbody>
                                            <tr><td>خصم أصناف / فاتورة</td><td class="num">{{ shift.lineDiscount }} / {{ shift.orderDiscount }}</td></tr>
                                            <tr><td>مرتجعات: عدد / قيمة</td><td class="num">{{ shift.refundCount }} / {{ shift.refundValue }}</td></tr>
                                            <tr><td>طلبات ملغاة: عدد / قيمة</td><td class="num">{{ shift.voidCount }} / {{ shift.voidValue }}</td></tr>
                                            <tr><td>مصروفات الصندوق</td><td class="num">{{ shift.expenses }}</td></tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            <div class="audit-shift-drawer">
                                <strong>أرصدة المناوبة عند الإغلاق</strong>
                                <div><span>رصيد الافتتاح</span><strong class="num">{{ shift.starting }}</strong></div>
                                <template v-if="shift.showEquation">
                                    <div><span>+ المبيعات النقدية بعد المرتجعات</span><strong class="num">{{ shift.cash }}</strong></div>
                                    <div><span>- مصروفات الصندوق</span><strong class="num">{{ shift.expenses }}</strong></div>
                                    <div class="total"><span>= النقد المتوقع</span><strong class="num">{{ shift.expected }}</strong></div>
                                </template>
                                <div v-else><span>النقد المتوقع</span><strong class="num">{{ shift.expected }}</strong></div>
                                <div><span>النقد الفعلي</span><strong class="num">{{ shift.actual }}</strong></div>
                                <div class="total"><span>الفرق (عجز أو زيادة)</span><strong class="num">{{ shift.variance }}</strong></div>
                            </div>
                        </article>
                    </div>
                </section>

                <section class="section">
                    <h2 class="section-head">المبيعات حسب نوع الطلب</h2>
                    <table class="compact">
                        <thead><tr><th>نوع الطلب</th><th class="num">عدد الطلبات</th><th class="num">متوسط الطلب</th><th class="num">المبيعات</th><th class="num">النسبة من المبيعات</th></tr></thead>
                        <tbody>
                            <tr v-if="!auditOrderTypeRows.length"><td colspan="5" class="empty">لا توجد بيانات</td></tr>
                            <tr v-for="row in auditOrderTypeRows" :key="row.name"><td>{{ row.name }}</td><td class="num">{{ row.count }}</td><td class="num">—</td><td class="num">{{ row.sales }}</td><td class="num">—</td></tr>
                            <tr class="total"><td>الإجمالي</td><td class="num">{{ number(data.summary?.total_orders) }}</td><td class="num">{{ money(data.summary?.avg_check) }}</td><td class="num">{{ money(data.summary?.sales_incl_tax) }}</td><td class="num">100%</td></tr>
                        </tbody>
                    </table>
                </section>

                <div class="split-ledger">
                    <section class="section">
                        <h2 class="section-head">الخصومات والمرتجعات والإلغاءات</h2>
                        <table class="compact">
                            <thead><tr><th>نوع الحركة</th><th class="num">عدد العمليات</th><th class="num">القيمة</th></tr></thead>
                            <tbody><tr v-for="row in auditAdjustmentRows" :key="row.label"><td>{{ row.label }}</td><td class="num">{{ row.count }}</td><td class="num">{{ row.value }}</td></tr></tbody>
                        </table>
                    </section>

                    <section class="section">
                        <h2 class="section-head">المصروفات النقدية</h2>
                        <table class="compact">
                            <thead><tr><th>فئة المصروف</th><th class="num">عدد العمليات</th><th class="num">القيمة</th></tr></thead>
                            <tbody><tr class="total"><td>إجمالي المصروفات المدفوعة من الصندوق</td><td class="num">—</td><td class="num">{{ money(data.cash_reconciliation?.cash_expenses_total) }}</td></tr></tbody>
                        </table>
                    </section>
                </div>

                <section class="section platform-section">
                    <h2 class="section-head">تسوية حسابات منصات التوصيل</h2>
                    <table class="compact">
                        <thead><tr><th>البيان</th><th class="num">القيمة</th><th>البيان</th><th class="num">القيمة</th></tr></thead>
                        <tbody>
                            <tr v-if="!auditPlatformPairs.length"><td colspan="4" class="empty">لا توجد بيانات تسوية</td></tr>
                            <tr v-for="row in auditPlatformPairs" :key="row.left.name"><td>{{ row.left.name }}</td><td class="num">{{ row.left.amount }}</td><td>{{ row.right?.name || '' }}</td><td class="num">{{ row.right?.amount || '' }}</td></tr>
                        </tbody>
                    </table>
                </section>

                <section class="section">
                    <h2 class="section-head">نتيجة المراجعة</h2>
                    <div class="review-register">
                        <div v-for="fact in auditReviewFacts" :key="fact.title"><strong>{{ fact.title }}</strong><span>{{ fact.detail }}</span></div>
                    </div>
                </section>

                <div class="trace"><div><span>اعتماد المدير</span></div><div><span>ملاحظات المراجعة</span></div></div>
            </div>
        </article>
    </div>

    <article v-else class="a4-report" :dir="direction" :data-no-i18n="isEnglishOnlyReport ? '' : null">
        <header class="running-header">
            <strong>{{ storeName }}</strong>
            <span>{{ reportTitle }}</span>
            <span v-if="windowLabel">{{ windowLabel }}</span>
            <span v-if="hasAuditMetadata && data.serial_label">{{ data.serial_label }}</span>
        </header>

        <footer class="running-footer">
            <span>{{ formatAuditDateTime(data.generated_at || data.prepared_at) }}</span>
            <span>{{ endMarker }}</span>
            <span v-if="hasAuditMetadata && data.payload_hash" class="footer-hash">{{ data.payload_hash }}</span>
        </footer>

        <div class="report-title">
            <p class="store-name">{{ storeName }}</p>
            <h1>{{ reportTitle }}</h1>
        </div>

        <section class="docket">
            <div v-if="windowLabel"><span>{{ tr('Business window', 'فترة العمل') }}</span><strong>{{ windowLabel }}</strong></div>
            <div v-if="isEnglishOnlyReport && data.shift_id"><span>Shift</span><strong>#{{ data.shift_id }}</strong></div>
            <div v-if="isEnglishOnlyReport && data.cashier_name"><span>Cashier</span><strong>{{ data.cashier_name }}</strong></div>
            <div v-if="data.generated_at"><span>{{ tr('Prepared at', 'وقت الإعداد') }}</span><strong>{{ formatAuditDateTime(data.generated_at) }}</strong></div>
            <div v-if="data.generated_by?.name"><span>{{ tr('Prepared by', 'أعده') }}</span><strong>{{ data.generated_by.name }}</strong></div>
            <div v-if="hasAuditMetadata && data.serial_label"><span>{{ tr('Serial', 'الرقم المتسلسل') }}</span><strong>{{ data.serial_label }}</strong></div>
            <div v-if="hasAuditMetadata && data.payload_hash" class="docket-wide"><span>{{ tr('Payload hash', 'بصمة التقرير') }}</span><strong class="hash">{{ data.payload_hash }}</strong></div>
            <div v-if="hasAuditMetadata && data.copy_label" class="copy-state" :class="{ reprint: data.copy_label === 'REPRINT' }">{{ data.copy_label }}</div>
        </section>

        <section v-if="metrics.length" class="metrics">
            <div v-for="metric in metrics" :key="metric.label" class="metric">
                <strong class="num">{{ metric.value }}</strong>
                <span>{{ metric.label }}</span>
            </div>
        </section>

        <section v-for="section in sections" :key="section.title" class="ledger-section">
            <h2 class="section-head">{{ section.title }}</h2>
            <table>
                <thead>
                    <tr>
                        <th v-for="column in section.columns" :key="column.key" :class="{ num: column.numeric }">{{ column.label }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!section.rows.length">
                        <td :colspan="section.columns.length" class="empty">{{ tr('No entries', 'لا توجد بيانات') }}</td>
                    </tr>
                    <tr v-for="(row, index) in section.rows" :key="`${section.title}-${index}`" :class="{ total: row.__total }">
                        <td v-for="column in section.columns" :key="column.key" :class="{ num: column.numeric }">{{ row[column.key] }}</td>
                    </tr>
                </tbody>
            </table>
        </section>
    </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ingredientQuantity, ingredientWasteRows } from './ingredientReportPresentation.js';
import { formatAuditDateTime, reconciliationFrom, shiftShowsEquation } from './auditReportPresentation.js';

type ReportData = Record<string, any>;
type LedgerColumn = { key: string; label: string; numeric?: boolean };
type LedgerSection = { title: string; columns: LedgerColumn[]; rows: Record<string, any>[] };
type FieldKind = 'money' | 'count' | 'percent' | 'text' | 'state';
type FieldSpec = [key: string, english: string, arabic: string, kind: FieldKind];

const props = defineProps<{
    printType: string;
    data: ReportData;
}>();

const isAuditReport = computed(() => props.printType === 'audit_report');
const isEnglishOnlyReport = computed(() => ['x_report', 'z_report'].includes(props.printType));
const isArabic = computed(() => {
    if (isEnglishOnlyReport.value) return false;
    return props.data.direction === 'rtl' || ["audit_report", 'category_items_report', 'y_held_items_report'].includes(props.printType);
});
const direction = computed(() => isArabic.value ? 'rtl' : 'ltr');
const tr = (english: string, arabic: string) => isArabic.value ? arabic : english;
const money = (value: unknown) => `${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${isArabic.value ? 'د.أ' : 'JD'}`;
const number = (value: unknown) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const percent = (value: unknown) => `${Number(value || 0).toFixed(2)}%`;
const nullableMoney = (value: unknown) => value === null || value === undefined ? '—' : money(value);
const minusMoney = (value: unknown) => `-${money(Math.abs(Number(value || 0)))}`;
const ENUM_LABELS: Record<string, [string, string]> = {
    refund: ['Refund', 'مرتجع'],
    void: ['Void', 'ملغى'],
    cash: ['Cash', 'نقدًا'],
    card: ['Card', 'بطاقة'],
    platform: ['Platform', 'منصة'],
    drawer: ['Cash drawer', 'من الصندوق'],
    outside: ['Outside cash', 'من خارج الصندوق'],
    active: ['Active', 'نشط'],
    canceled: ['Canceled', 'ملغى'],
    open: ['Open', 'مفتوحة'],
    closed: ['Closed', 'مغلقة'],
    split: ['Cash and card', 'نقد وبطاقة'],
    item: ['Item', 'صنف'],
    bundle_child: ['Bundle item', 'عنصر ضمن وجبة'],
};
const enumLabel = (value: unknown) => {
    const token = String(value ?? '');
    const label = ENUM_LABELS[token];
    return label ? tr(label[0], label[1]) : (token || '—');
};
const formatField = (value: unknown, kind: FieldKind) => {
    if (value === null || value === undefined || value === '') return '—';
    if (kind === 'state') { const label = CASH_STATES[String(value)]; return label ? tr(label[0], label[1]) : String(value); }
    if (kind === 'text') return String(value);
    if (kind === 'count') return number(value);
    if (kind === 'percent') return percent(value);
    return money(value);
};
// A named field list per section, never a walk of whatever the object happens to
// hold. Deriving a label from the key prints machine names ("net sales pre tax")
// into an Arabic ledger, and deriving money-ness from the key prints a rate as a
// currency amount. Both are wrong on a document that goes to an accountant, so
// every printed field is named and typed here by hand. A field the spec does not
// name is not printed, and adminReportPrintDesign.spec.js fails when a builder
// grows a field no spec covers.
const field = (key: string, english: string, arabic: string, kind: FieldKind = 'money'): FieldSpec =>
    [key, english, arabic, kind];
const labelled = (source: ReportData, spec: FieldSpec[]): Record<string, any>[] =>
    spec.flatMap(([key, english, arabic, kind]) => {
        const value = (source || {})[key];
        if (value === undefined) return [];
        return [{ name: tr(english, arabic), amount: formatField(value, kind) }];
    });

const PLATFORM_RECONCILIATION_FIELDS: FieldSpec[] = [
    field('start_date', 'Period start', 'بداية الفترة', 'text'),
    field('end_date', 'Period end', 'نهاية الفترة', 'text'),
    field('positive_allocations', 'Positive allocations', 'المخصصات الموجبة'),
    field('provider_credits_applied', 'Provider credits applied', 'أرصدة المنصات المطبقة'),
    field('invoice_allocations', 'Invoice allocations', 'مخصصات الفواتير'),
    field('deductions', 'Deductions', 'الحسومات'),
    field('additions', 'Additions', 'الإضافات'),
    field('net_received', 'Net received', 'صافي المستلم'),
    field('computed_net', 'Computed net', 'الصافي المحتسب'),
    field('unreconciled_difference', 'Unreconciled difference', 'الفرق غير المسوّى'),
    field('settlement_count', 'Settlements', 'عدد التسويات', 'count'),
    field('reversal_count', 'Reversals', 'عدد العكوسات', 'count'),
];
const REMITTANCE_CATEGORIES: FieldSpec[] = [
    field('commission', 'Commission', 'عمولة'),
    field('service_fee', 'Service fee', 'رسوم خدمة'),
    field('marketing_fee', 'Marketing fee', 'رسوم تسويق'),
    field('penalty', 'Penalty', 'غرامة'),
    field('withholding_tax', 'Withholding tax', 'ضريبة مقتطعة'),
    field('reimbursement', 'Reimbursement', 'تعويض'),
    field('incentive', 'Incentive', 'حافز'),
    field('correction', 'Correction', 'تصحيح'),
    field('other', 'Other', 'أخرى'),
];
const COMPARISON_FIELDS: FieldSpec[] = [
    field('sales_collected', 'Sales collected', 'المبيعات المحصلة'),
    field('total_orders', 'Orders', 'عدد الطلبات', 'count'),
    field('average_ticket', 'Average ticket', 'متوسط الفاتورة'),
];
// dailyReportBuilder.js:171-179 emits these four tokens and nothing else.
const CASH_STATES: Record<string, [string, string]> = {
    balanced: ['Balanced', 'مطابق'],
    review: ['Needs review', 'يحتاج مراجعة'],
    in_progress: ['In progress', 'قيد التشغيل'],
    no_shifts: ['No shifts', 'لا توجد مناوبات'],
};
const CASH_STATUS_FIELDS: FieldSpec[] = [
    field('state', 'State', 'الحالة', 'state'),
    field('open_shifts', 'Open shifts', 'مناوبات مفتوحة', 'count'),
    field('closed_shifts', 'Closed shifts', 'مناوبات مغلقة', 'count'),
    field('closed_outside_window', 'Settled on another business day', 'أُغلقت في يوم عمل آخر', 'count'),
    field('uncounted_shifts', 'Uncounted shifts', 'مناوبات بلا جرد', 'count'),
    field('shifts_needing_review', 'Shifts needing review', 'مناوبات تحتاج مراجعة', 'count'),
    field('shortage_total', 'Shortage total', 'إجمالي العجز'),
    field('overage_total', 'Overage total', 'إجمالي الزيادة'),
    field('net_variance', 'Net shift variance', 'صافي فرق المناوبات'),
];
const SALES_TOTALS_FIELDS: FieldSpec[] = [
    field('sales_collected', 'Sales collected', 'المبيعات المحصلة'),
    field('menu_sales', 'Menu sales', 'مبيعات القائمة'),
    field('service_charges_collected', 'Service charges', 'رسوم الخدمة'),
];
const REFUND_SUMMARY_FIELDS: FieldSpec[] = [
    field('sales_processed', 'Sales processed', 'المبيعات المعالجة'),
    field('refund_total', 'Refund value', 'قيمة المرتجعات'),
    field('refund_rate', 'Refund rate', 'نسبة المرتجعات', 'percent'),
    field('refund_cash', 'Refunded in cash', 'مرتجع نقدًا'),
    field('refund_card', 'Refunded to card', 'مرتجع على البطاقة'),
    field('refund_platform', 'Refunded to platform', 'مرتجع إلى المنصة'),
    field('refund_count', 'Refunds', 'عدد المرتجعات', 'count'),
    field('void_count', 'Voids', 'عدد الإلغاءات', 'count'),
    field('void_value', 'Void value', 'قيمة الإلغاءات'),
];
const EXPENSE_SUMMARY_FIELDS: FieldSpec[] = [
    field('total', 'Expenses total', 'إجمالي المصروفات'),
    field('count', 'Entries', 'عدد القيود', 'count'),
    field('drawer', 'From the drawer', 'من الصندوق'),
    field('outside', 'From outside cash', 'من خارج الصندوق'),
];
// Platform reconciliation carries three nested nine-category breakdowns. They are
// flattened under a named group heading rather than as "deductions by category /
// service fee", and a group whose categories are all zero is dropped entirely.
const platformReconciliationRows = (source: ReportData): Record<string, any>[] => {
    if (!source) return [];
    const groups: [string, string, string][] = [
        ['deductions_by_category', 'Deductions', 'الحسومات'],
        ['additions_by_category', 'Additions', 'الإضافات'],
        ['adjustments_by_category', 'Adjustments', 'التسويات'],
    ];
    return [
        ...labelled(source, PLATFORM_RECONCILIATION_FIELDS),
        ...groups.flatMap(([key, english, arabic]) => {
            const totals = source[key];
            if (!totals || typeof totals !== 'object') return [];
            const rows = REMITTANCE_CATEGORIES
                .filter(([category]) => Number(totals[category] || 0) !== 0)
                .map(([category, categoryEnglish, categoryArabic]) => ({
                    name: `${tr(english, arabic)} — ${tr(categoryEnglish, categoryArabic)}`,
                    amount: money(totals[category]),
                }));
            return rows;
        }),
    ];
};

const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const named = (row: ReportData) => row.name || row.label || row.item_name || row.category_name || row.order_type_name || row.cashier_name || row.waiter_name || row.table_name || '—';
const metric = (label: string, value: unknown, kind: 'money' | 'number' = 'money') => ({ label, value: kind === 'money' ? money(value) : number(value) });

const storeName = computed(() => props.data.storeInfo?.store_name || 'POS System');
const hasAuditMetadata = computed(() => props.printType === 'audit_report' && Boolean(props.data.serial_label || props.data.payload_hash || props.data.copy_label));
const windowLabel = computed(() => props.data.period?.window_label
    || (props.data.period_start_date && props.data.period_end_date ? `${props.data.period_start_date} — ${props.data.period_end_date}` : '')
    || (props.data.business_start_at && props.data.business_end_at ? `${formatAuditDateTime(props.data.business_start_at)} / ${formatAuditDateTime(props.data.business_end_at)}` : '')
    || props.data.business_date
    || (props.data.opened_at ? `${formatAuditDateTime(props.data.opened_at)}${props.data.closed_at ? ` — ${formatAuditDateTime(props.data.closed_at)}` : ''}` : ''));

const reportTitle = computed(() => ({
    daily_summary_report: tr('Daily Summary Report', 'ملخص التقرير اليومي'),
    daily_sales_report: tr('Daily Sales Report', 'تقرير المبيعات اليومي'),
    daily_refunds_report: tr('Refunds & Voids Report', 'تقرير المرتجعات والإلغاءات'),
    daily_expenses_report: tr('Expenses Report', 'تقرير المصروفات'),
    daily_ingredients_report: tr('Ingredients Report', 'تقرير المكونات'),
    x_report: 'MID-SHIFT AUDIT (X)',
    z_report: 'END OF SHIFT (Z)',
    audit_report: props.data.is_period ? 'التقرير الدوري' : `جرد ${props.data.report_type === 'z_audit' ? 'Z' : 'X'}`,
    category_items_report: 'تقرير الأصناف',
    y_held_items_report: 'تقرير Y'
}[props.printType] || props.printType));

// The X/Z titles already read "END OF SHIFT (Z)", so prefixing them produced
// "End of END OF SHIFT (Z)" on the footer of every printed page.
const endMarker = computed(() => {
    if (isEnglishOnlyReport.value) return 'End of Report';
    return isArabic.value ? `نهاية ${reportTitle.value}` : `End of ${reportTitle.value}`;
});

const auditIdentity = computed(() => props.data.serial_label ? `${reportTitle.value} / ${props.data.serial_label}` : reportTitle.value);
const auditPurpose = computed(() => props.data.is_period
    ? 'مراجعة المبيعات والتسويات المالية خلال فترة التقرير'
    : props.data.report_type === 'z_audit'
        ? 'إغلاق يوم العمل ومراجعة المبيعات وتسوية الصندوق'
        : 'مراجعة المبيعات وتسوية الصندوق أثناء يوم العمل');
const auditCopyLabel = computed(() => props.data.copy_label === 'REPRINT'
    ? 'نسخة معاد طباعتها'
    : props.data.copy_label === 'ORIGINAL' ? 'نسخة أصلية' : String(props.data.copy_label || ''));
const auditShiftReview = computed(() => reconciliationFrom(props.data));
const auditGeneratedAt = computed(() => formatAuditDateTime(props.data.generated_at));
const auditWindowLabel = computed(() => {
    if (props.data.business_start_at && props.data.business_end_at) {
        return `${formatAuditDateTime(props.data.business_start_at)} — ${formatAuditDateTime(props.data.business_end_at)}`;
    }
    return props.data.business_date || windowLabel.value || '';
});
const auditSalesRows = computed(() => [
    { label: 'المبيعات شاملة الضريبة بعد المرتجعات', value: money(props.data.summary?.sales_incl_tax), total: true },
    { label: 'يخصم منها: الضريبة المحصلة', value: minusMoney(props.data.summary?.tax_collected) },
    { label: 'صافي المبيعات قبل الضريبة', value: money(props.data.summary?.net_sales_pre_tax), total: true },
    { label: 'الخصومات المطبقة — للمراجعة', value: money(props.data.summary?.discounts_total) },
    { label: 'المرتجعات — للمراجعة', value: money(props.data.summary?.refunds_total) },
]);
const auditShiftReviewRows = computed(() => [
    { label: 'المناوبات المشمولة', value: number(auditShiftReview.value.total) },
    { label: 'مناوبات متوازنة', value: number(auditShiftReview.value.balanced) },
    { label: 'مناوبات تحتاج مراجعة', value: number(auditShiftReview.value.needsReview), total: auditShiftReview.value.needsReview > 0 },
    { label: 'مناوبات مفتوحة', value: number(auditShiftReview.value.open) },
    { label: 'مناوبات بلا جرد فعلي', value: number(auditShiftReview.value.uncounted) },
    ...(auditShiftReview.value.netVariance == null ? [] : [
        { label: 'إجمالي العجز', value: money(auditShiftReview.value.shortage) },
        { label: 'إجمالي الزيادة', value: money(auditShiftReview.value.overage) },
        { label: 'صافي فرق المناوبات', value: nullableMoney(auditShiftReview.value.netVariance), total: true },
    ]),
]);
const auditPaymentRows = computed(() => [
    { method: 'نقدًا', count: '—', amount: money(props.data.payments?.cash_sales), share: '—', status: 'موجود في الصندوق' },
    { method: 'بطاقة', count: '—', amount: money(props.data.payments?.card_sales), share: '—', status: 'تم التحصيل' },
    { method: 'مبالغ مستحقة على منصات التوصيل', count: '—', amount: money(props.data.payments?.platform_sales), share: '—', status: 'لم تُحصّل بعد' },
    { method: 'إجمالي المبيعات', count: '—', amount: money(props.data.summary?.sales_incl_tax), share: '100%', status: 'مطابق لإجمالي المبيعات', total: true },
]);
const auditAdjustmentRows = computed(() => [
    { label: 'خصومات أصناف', count: '—', value: money(props.data.summary?.line_discounts_total) },
    { label: 'خصومات طلبات', count: '—', value: money(props.data.summary?.order_discounts_total) },
    { label: 'مرتجعات', count: number(props.data.summary?.refund_count), value: money(props.data.summary?.refunds_total) },
    { label: 'إلغاءات قبل الدفع', count: number(props.data.summary?.void_count), value: money(props.data.summary?.void_value) },
]);
const auditShiftRows = computed(() => array(props.data.shifts).map(row => ({
    id: row.shift_id,
    cashier: row.cashier_name || '—',
    opened: formatAuditDateTime(row.opened_at),
    closed: row.closed_at ? formatAuditDateTime(row.closed_at) : 'لم تُغلق بعد',
    status: enumLabel(row.status),
    orders: number(row.order_count),
    sales: money(row.gross_sales),
    tax: money(row.total_tax),
    cash: money(row.cash_sales),
    card: money(row.card_sales),
    platform: money(row.platform_sales),
    lineDiscount: money(row.line_discounts),
    orderDiscount: money(row.order_discounts),
    refundCount: number(row.refund_count),
    refundValue: money(row.refund_value),
    voidCount: number(row.void_count),
    voidValue: money(row.void_value),
    starting: money(row.starting_cash),
    expected: money(row.expected_cash),
    actual: nullableMoney(row.actual_cash),
    variance: nullableMoney(row.variance),
    showEquation: shiftShowsEquation(row),
    expenses: money(row.cash_expenses),
})));
const auditOrderTypeRows = computed(() => array(props.data.order_types).map(row => ({
    name: row.order_type_name || '—',
    count: number(row.order_count),
    sales: money(row.total_sales),
})));
const auditPlatformRows = computed(() => platformReconciliationRows(props.data.platform_reconciliation));
const auditPlatformPairs = computed(() => {
    const rows = auditPlatformRows.value;
    const pairs: { left: Record<string, any>; right?: Record<string, any> }[] = [];
    for (let index = 0; index < rows.length; index += 2) pairs.push({ left: rows[index], right: rows[index + 1] });
    return pairs;
});
const auditReviewFacts = computed(() => [
    auditShiftReview.value.open
        ? { title: `توجد ${number(auditShiftReview.value.open)} مناوبة مفتوحة`, detail: 'لا يوجد رصيد فعلي أو فرق معتمد للمناوبة المفتوحة.' }
        : { title: 'جميع المناوبات مغلقة', detail: 'لا توجد مناوبة مفتوحة ضمن تقرير اليوم.' },
    auditShiftReview.value.open
        ? { title: 'الجرد النهائي بانتظار الإغلاق', detail: 'المناوبة المفتوحة لا تحمل رصيدًا فعليًا أو فرقًا معتمدًا بعد.' }
        : auditShiftReview.value.uncounted
        ? { title: `توجد ${number(auditShiftReview.value.uncounted)} مناوبة بلا جرد فعلي`, detail: 'يجب تسجيل النقد الفعلي قبل اعتماد نتيجتها.' }
        : { title: 'الجرد الفعلي مكتمل', detail: 'كل مناوبة مغلقة تحمل رصيدًا فعليًا وفرقًا مستقلًا.' },
    auditShiftReview.value.needsReview
        ? { title: auditShiftReview.value.result, detail: 'لا تُلغى الزيادة في مناوبة بالعجز في مناوبة أخرى؛ راجع كل كاشير على حدة.' }
        : { title: 'لا توجد مناوبة بفرق مسجل', detail: 'كل مناوبة مكتملة متوازنة بصورة مستقلة.' },
]);

const moneyRows = (source: unknown, nameKey = 'name', amountKey = 'amount') => array(source).map(row => {
    // Leave the count cell empty when the row carries no count. Coercing a missing
    // count through number() printed "0", which on a sales table reads as a real
    // measurement of zero rather than as "this table has no count column".
    const count = row.count ?? row.orders ?? row.order_count ?? row.qty_sold ?? row.sold_qty;
    return {
        name: row[nameKey] || named(row),
        count: count === undefined || count === null ? '' : number(count),
        amount: money(row[amountKey] ?? row.total_sales ?? row.net_sales ?? row.gross_revenue ?? row.total)
    };
});

const simpleMoneyColumns = (): LedgerColumn[] => [
    { key: 'name', label: tr('Description', 'البيان') },
    { key: 'count', label: tr('Count / Qty', 'العدد / الكمية'), numeric: true },
    { key: 'amount', label: tr('Amount', 'القيمة'), numeric: true }
];

const salesDetailColumns = (quantityLabel = tr('Orders', 'الطلبات'), includeReturnedQuantity = false): LedgerColumn[] => [
    { key: 'name', label: tr('Description', 'البيان') },
    { key: 'quantity', label: quantityLabel, numeric: true },
    ...(includeReturnedQuantity ? [{ key: 'returnedQuantity', label: tr('Returned qty', 'كمية المرتجع'), numeric: true }] : []),
    { key: 'sold', label: tr('Sales', 'المبيعات'), numeric: true },
    { key: 'returned', label: tr('Returns', 'المرتجعات'), numeric: true },
    { key: 'net', label: tr('Net sales', 'صافي المبيعات'), numeric: true },
];
const salesDetailRow = (row: ReportData, name: string, quantityKey = 'orders') => ({
    name,
    quantity: number(row[quantityKey]),
    returnedQuantity: quantityKey === 'sold_qty' ? number(row.returned_qty) : '',
    sold: money(row.sold_amount),
    returned: money(row.returned_amount),
    net: money(row.net_sales),
});
const categorySalesRows = (rows: unknown, parents: string[] = []): Record<string, any>[] => array(rows).flatMap(row => {
    const path = [...parents, row.name || '—'];
    return [
        salesDetailRow(row, path.join(' › '), 'sold_qty'),
        ...categorySalesRows(row.subcategories, path),
    ];
});

const metrics = computed(() => {
    const data = props.data;
    switch (props.printType) {
        case 'daily_summary_report':
            return [
                metric(tr('Sales collected', 'المبيعات المحصلة'), data.summary?.sales_collected),
                metric(tr('Refunds issued', 'المرتجعات'), data.summary?.refunds_issued),
                metric(tr('Net revenue', 'صافي الإيراد'), data.summary?.net_revenue_pre_tax),
                metric(tr('Tax collected', 'الضريبة المحصلة'), data.summary?.tax_collected),
                metric(tr('Service charges', 'رسوم الخدمة'), data.summary?.service_charges_collected),
                metric(tr('Discounts', 'الخصومات'), data.summary?.discounts_total),
                metric(tr('Average ticket', 'متوسط الفاتورة'), data.summary?.average_ticket),
                metric(tr('Orders', 'الطلبات'), data.summary?.total_orders, 'number')
            ];
        case 'daily_sales_report':
            return [
                metric(tr('Sales collected', 'المبيعات المحصلة'), data.totals?.sales_collected),
                metric(tr('Menu sales', 'مبيعات القائمة'), data.totals?.menu_sales),
                metric(tr('Service charges', 'رسوم الخدمة'), data.totals?.service_charges_collected),
                metric(tr('Products', 'الأصناف'), array(data.products).length, 'number')
            ];
        case 'daily_refunds_report':
            return [
                metric(tr('Sales processed', 'المبيعات المعالجة'), data.summary?.sales_processed),
                metric(tr('Refund value', 'قيمة المرتجعات'), data.summary?.refund_total),
                metric(tr('Refunds', 'عدد المرتجعات'), data.summary?.refund_count, 'number'),
                metric(tr('Voids', 'عدد الإلغاءات'), data.summary?.void_count, 'number')
            ];
        case 'daily_expenses_report':
            return [
                metric(tr('Expenses', 'المصروفات'), data.summary?.expenses_total ?? data.summary?.total),
                metric(tr('Sales collected', 'المبيعات المحصلة'), data.sales_collected),
                metric(tr('Remaining', 'المتبقي'), data.remaining_after_expenses),
                metric(tr('Entries', 'القيود'), array(data.entries).length, 'number')
            ];
        case 'daily_ingredients_report':
            return [
                metric(tr('Used JD', 'المستخدم د.أ'), data.totals?.used_cost),
                metric(tr('Waste JD', 'الهدر د.أ'), data.totals?.waste_cost),
                metric(tr('Below par', 'دون الحد الأدنى'), data.totals?.below_par_count, 'number')
            ];
        case 'x_report':
        case 'z_report':
            return [
                metric('Gross Sales', data.gross_sales),
                metric('Cash Payments', data.cash_sales),
                metric('Card Payments', data.card_sales),
                metric('Expected Cash', data.expected_cash)
            ];
        case 'audit_report':
            return [
                metric('المبيعات شاملة الضريبة', data.summary?.sales_incl_tax),
                metric('صافي المبيعات', data.summary?.net_sales_pre_tax),
                metric('الضريبة المحصلة', data.summary?.tax_collected),
                metric('متوسط الفاتورة', data.summary?.avg_check),
                metric('إجمالي الخصومات', data.summary?.discounts_total),
                metric('قيمة المرتجعات', data.summary?.refunds_total),
                metric('قيمة الإلغاءات', data.summary?.void_value),
                metric('عدد الطلبات', data.summary?.total_orders, 'number')
            ];
        case 'category_items_report':
            return [
                metric('عدد الأصناف', data.summary?.product_count, 'number'),
                metric('إجمالي الكمية', data.summary?.total_quantity, 'number'),
                metric('إجمالي المبيعات', data.summary?.gross_revenue),
                metric('المجموعات', array(data.categories).length, 'number')
            ];
        case 'y_held_items_report':
            return [
                metric('عدد الطلبات', data.summary?.order_count, 'number'),
                metric('المجموع قبل الخصم', data.summary?.subtotal),
                metric('خصم الأصناف', data.summary?.line_discount),
                metric('خصم الطلبات', data.summary?.order_discount),
                metric('الضريبة', data.summary?.tax),
                metric('الإجمالي', data.summary?.total)
            ];
        default:
            return [];
    }
});

const sections = computed<LedgerSection[]>(() => {
    const data = props.data;
    const sections: LedgerSection[] = [];
    const add = (title: string, columns: LedgerColumn[], rows: Record<string, any>[]) => sections.push({ title, columns, rows });

    if (props.printType === 'daily_summary_report') {
        const paymentLabels: Record<string, [string, string]> = {
            cash: ['Cash Payments', 'المدفوعات النقدية'],
            card: ['Card Payments', 'مدفوعات البطاقة'],
            platform: ['Platform Sales (not collected)', 'مبيعات المنصات (غير محصلة)'],
        };
        add(tr('Payments', 'المدفوعات'), [
            { key: 'name', label: tr('Description', 'البيان') },
            { key: 'amount', label: tr('Amount', 'القيمة'), numeric: true },
        ], array(data.payments).map(row => {
            const label = paymentLabels[row.key];
            return { name: label ? tr(label[0], label[1]) : String(row.key || '—'), amount: money(row.amount) };
        }));
        add(tr('Platform reconciliation', 'تسويات المنصات'), [{ key: 'name', label: tr('Line', 'البيان') }, { key: 'amount', label: tr('Amount', 'القيمة'), numeric: true }], platformReconciliationRows(data.platform_reconciliation));
        add(tr('Comparison', 'المقارنة'), [{ key: 'name', label: tr('Measure', 'المؤشر') }, { key: 'amount', label: tr('Change', 'التغير'), numeric: true }],
            COMPARISON_FIELDS.flatMap(([key, english, arabic, kind]) => {
                const entry = (data.comparison || {})[key];
                if (!entry) return [];
                // percent is null when the prior period had nothing to compare against;
                // formatting that as 0% claims a flat result that was never measured.
                const change = entry.percent === null || entry.percent === undefined
                    ? tr('no prior period', 'لا توجد فترة سابقة')
                    : percent(entry.percent);
                return [{ name: tr(english, arabic), amount: `${formatField(entry.amount, kind)} / ${change}` }];
            }));
        add(tr('Order types', 'أنواع الطلبات'), simpleMoneyColumns(), moneyRows(data.order_types, 'order_type_name', 'total_sales'));
        add(tr('Hourly sales', 'المبيعات حسب الساعة'), [
            { key: 'hour', label: tr('Hour', 'الساعة') },
            { key: 'orders', label: tr('Orders', 'الطلبات'), numeric: true },
            { key: 'sales', label: tr('Sales processed', 'المبيعات المعالجة'), numeric: true },
        ], array(data.hourly_sales).map(row => ({
            hour: `${String(row.hour ?? 0).padStart(2, '0')}:00`,
            orders: number(row.orders),
            sales: money(row.sales_processed),
        })));
        const cash = data.cash_status || {};
        const showCashMoney = Number(cash.closed_shifts) > 0 && cash.net_variance != null;
        const cashSpec = !showCashMoney
            ? CASH_STATUS_FIELDS.filter(([, , , kind]) => kind !== 'money')
            : CASH_STATUS_FIELDS;
        const cashRows = labelled(cash, cashSpec).map(row => (
            cash.state === 'no_shifts' && Number(cash.closed_outside_window) > 0 && row.name === tr('State', 'الحالة')
                ? { ...row, amount: tr('No shifts settled in this report window', 'لا توجد مناوبات أُغلقت ضمن فترة التقرير') }
                : row
        ));
        if (cash.state === 'in_progress') {
            cashRows.push({
                name: tr('Reconciliation', 'التسوية'),
                amount: tr('Reconciliation in progress', 'التسوية قيد التنفيذ'),
            });
        }
        add(tr('Cash status', 'حالة الصندوق'), [{ key: 'name', label: tr('Measure', 'البيان') }, { key: 'amount', label: tr('Value', 'القيمة'), numeric: true }], cashRows);
    }

    if (props.printType === 'daily_sales_report') {
        add(tr('Sales totals', 'إجماليات المبيعات'), [{ key: 'name', label: tr('Measure', 'البيان') }, { key: 'amount', label: tr('Value', 'القيمة'), numeric: true }], labelled(data.totals, SALES_TOTALS_FIELDS));
        if (array(data.categories).length) add(tr('Categories', 'المجموعات'), salesDetailColumns(tr('Sold qty', 'الكمية المباعة'), true), categorySalesRows(data.categories));
        if (array(data.products).length) add(tr('Products', 'الأصناف'), [
            { key: 'name', label: tr('Product', 'الصنف') },
            { key: 'path', label: tr('Category', 'المجموعة') },
            { key: 'soldQty', label: tr('Sold qty', 'الكمية المباعة'), numeric: true },
            { key: 'returnedQty', label: tr('Returned qty', 'كمية المرتجع'), numeric: true },
            { key: 'sold', label: tr('Sales', 'المبيعات'), numeric: true },
            { key: 'returned', label: tr('Returns', 'المرتجعات'), numeric: true },
            { key: 'net', label: tr('Net sales', 'صافي المبيعات'), numeric: true }
        ], array(data.products).map(row => ({ name: row.item_name, path: row.category_path || '—', soldQty: number(row.sold_qty), returnedQty: number(row.returned_qty), sold: money(row.sold_amount), returned: money(row.returned_amount), net: money(row.net_sales) })));
        if (array(data.order_types).length) add(tr('Order types', 'أنواع الطلبات'), salesDetailColumns(), array(data.order_types).map(row => salesDetailRow(row, row.name || '—')));
        if (array(data.cashiers).length) add(tr('Cashiers', 'الصرافون'), salesDetailColumns(), array(data.cashiers).map(row => salesDetailRow(row, row.name || '—')));
        if (array(data.waiters).length) add(tr('Waiters', 'النوادل'), salesDetailColumns(), array(data.waiters).map(row => salesDetailRow(row, row.name || '—')));
        if (data.tables_enabled !== false && array(data.tables).length) add(tr('Tables', 'الطاولات'), salesDetailColumns(), array(data.tables).map(row => salesDetailRow(row, `${row.section_name || tr('Main Floor', 'الصالة الرئيسية')} · ${tr('Table', 'طاولة')} ${row.table_number || '—'}`)));
    }

    if (props.printType === 'daily_refunds_report') {
        add(tr('Refund and void totals', 'إجماليات المرتجعات والإلغاءات'), [{ key: 'name', label: tr('Measure', 'البيان') }, { key: 'amount', label: tr('Value', 'القيمة'), numeric: true }], labelled(data.summary, REFUND_SUMMARY_FIELDS));
        add(tr('Staff activity', 'نشاط الموظفين'), simpleMoneyColumns(), array(data.by_staff).map(row => ({ name: row.name, count: `${number(row.refund_count)} / ${number(row.void_count)}`, amount: `${money(row.refund_value)} / ${money(row.void_value)}` })));
        add(tr('Top reasons', 'أبرز الأسباب'), simpleMoneyColumns(), moneyRows(data.top_reasons, 'reason', 'value'));
        add(tr('Event ledger', 'سجل العمليات'), [
            { key: 'identity', label: tr('Identity', 'المرجع') },
            { key: 'kind', label: tr('Type', 'النوع') },
            { key: 'reason', label: tr('Reason', 'السبب') },
            { key: 'staff', label: tr('Staff', 'الموظف') },
            { key: 'time', label: tr('Time', 'الوقت') },
            { key: 'method', label: tr('Method', 'الطريقة') },
            { key: 'amount', label: tr('Amount', 'القيمة'), numeric: true }
        ], array(data.events).map(row => ({
            identity: row.invoice_display_no || row.table_number || row.invoice_id || '—',
            kind: enumLabel(row.kind),
            reason: row.reason || '—',
            staff: row.cashier_name || row.user_name || '—',
            time: row.occurred_at_local || formatAuditDateTime(row.created_at),
            method: enumLabel(row.refund_method || row.payment_method),
            amount: money(row.event_value ?? row.amount_refunded ?? row.amount ?? row.refund_value ?? row.void_value),
        })));
    }

    if (props.printType === 'daily_expenses_report') {
        add(tr('Expense totals', 'إجماليات المصروفات'), [{ key: 'name', label: tr('Measure', 'البيان') }, { key: 'amount', label: tr('Value', 'القيمة'), numeric: true }], labelled(data.summary, EXPENSE_SUMMARY_FIELDS));
        add(tr('By source', 'حسب المصدر'), simpleMoneyColumns(), array(data.by_source).map(row => ({ name: enumLabel(row.source), count: '', amount: money(row.total) })));
        add(tr('By category', 'حسب التصنيف'), simpleMoneyColumns(), moneyRows(data.by_category, 'category_name', 'total'));
        add(tr('Expense ledger', 'سجل المصروفات'), [
            { key: 'id', label: '#' },
            { key: 'category', label: tr('Category', 'التصنيف') },
            { key: 'note', label: tr('Note', 'الملاحظة') },
            { key: 'source', label: tr('Source', 'المصدر') },
            { key: 'actor', label: tr('Actor', 'الموظف') },
            { key: 'canceledBy', label: tr('Canceled by', 'ألغاه') },
            { key: 'state', label: tr('State', 'الحالة') },
            { key: 'time', label: tr('Created / canceled', 'الإنشاء / الإلغاء') },
            { key: 'amount', label: tr('Amount', 'القيمة'), numeric: true }
        ], array(data.entries).map(row => ({
            id: row.id,
            category: row.category_name,
            note: row.note || '—',
            source: `${enumLabel(row.source)}${row.shift_id ? ` #${row.shift_id}` : ''}`,
            actor: row.created_by_name || row.actor_name || '—',
            canceledBy: row.canceled_by_name || '—',
            state: enumLabel(row.status || (row.canceled_at ? 'canceled' : 'active')),
            time: `${formatAuditDateTime(row.created_at)}${row.canceled_at ? ` / ${formatAuditDateTime(row.canceled_at)}` : ''}`,
            amount: money(row.amount),
        })));
    }

    if (props.printType === 'daily_ingredients_report') {
        add(tr('Ingredients', 'المكونات'), [
            { key: 'name', label: tr('Name', 'الاسم') },
            { key: 'opening', label: tr('Opening stock', 'رصيد بداية اليوم'), numeric: true },
            { key: 'received', label: tr('Received', 'المستلم'), numeric: true },
            { key: 'used', label: tr('Used quantity', 'الكمية المستهلكة'), numeric: true },
            { key: 'waste', label: tr('Waste', 'الهدر'), numeric: true },
            { key: 'closing', label: tr('Closing stock', 'رصيد نهاية اليوم'), numeric: true },
        ], array(data.ingredients).map(row => ({
            name: row.name,
            opening: ingredientQuantity(row.opening, row.display_unit),
            received: ingredientQuantity(row.received, row.display_unit),
            used: ingredientQuantity(row.used, row.display_unit),
            waste: ingredientQuantity(row.waste, row.display_unit),
            closing: ingredientQuantity(row.closing_expected, row.display_unit),
        })));
        add(tr('Waste by reason', 'الهدر حسب السبب'), [
            { key: 'name', label: tr('Name', 'الاسم') },
            { key: 'reason', label: tr('Reason', 'السبب') },
            { key: 'qty', label: tr('Qty', 'الكمية'), numeric: true },
        ], ingredientWasteRows(data));
    }

    if (['x_report', 'z_report'].includes(props.printType)) {
        add('Tender Breakdown', simpleMoneyColumns(), [
            { name: 'Cash Payments', count: '', amount: money(data.cash_sales) },
            { name: 'Card Payments', count: '', amount: money(data.card_sales) },
            { name: 'Platform Sales', count: '', amount: money(data.platform_sales) },
            { name: 'Discounts', count: '', amount: `-${money(data.total_discounts)}` },
            { name: 'Cash Expenses', count: '', amount: `-${money(data.cash_expenses)}` }
        ]);
        add('Sales by Order Type', simpleMoneyColumns(), moneyRows(data.order_type_breakdown, 'order_type_name', 'total_sales'));
        add('Platform Receivables by Provider', simpleMoneyColumns(), moneyRows(data.platform_order_type_breakdown, 'order_type_name', 'total_sales'));
        add('Cash Expenses by Category', simpleMoneyColumns(), array(data.expense_categories).map(row => ({ name: row.category_name || '—', count: number(row.count), amount: `-${money(row.total)}` })));
        add('Cash Drawer Audit', [{ key: 'name', label: 'Measure' }, { key: 'amount', label: 'Amount', numeric: true }], [
            { name: 'Starting Float', amount: money(data.starting_cash) },
            { name: 'Expected Cash', amount: money(data.expected_cash) },
            { name: 'Actual Cash', amount: data.actual_cash == null ? '—' : money(data.actual_cash) },
            { name: 'Variance', amount: money(data.variance), __total: true }
        ]);
    }

    if (['category_items_report', 'y_held_items_report'].includes(props.printType)) {
        add('المجموعات', simpleMoneyColumns(), moneyRows(data.categories, 'category_name', 'gross_revenue'));
        add('التصنيفات الفرعية', simpleMoneyColumns(), array(data.subcategories).flatMap(group => array(group.rows).map(row => ({ name: `${group.category_name} / ${row.category_name}`, count: number(row.qty_sold), amount: money(row.gross_revenue) }))));
        add('الأصناف', simpleMoneyColumns(), moneyRows(data.items, 'item_name', 'gross_revenue'));
    }

    return sections;
});
</script>

<style scoped>
.a4-report {
    --ink: #000;
    --ink-70: #4a4a4a;
    --ink-40: #8a8a8a;
    --wash: #f2f2f2;
    min-height: 250mm;
    color: var(--ink);
    font-family: "IBM Plex Sans Arabic", Arial, sans-serif;
    font-size: 8.5pt;
    line-height: 1.35;
    font-variant-numeric: tabular-nums;
}
.audit-page { position: relative; width: 210mm; min-height: 297mm; padding: 22mm 12mm 16mm; font-size: 8pt; break-after: page; }
.audit-page--last { break-after: auto; }
.running-header, .running-footer { position: fixed; inset-inline: 0; display: flex; align-items: center; justify-content: space-between; gap: 4mm; font-size: 7pt; }
.running-header { top: -16mm; border-bottom: 2pt solid var(--ink); padding-bottom: 2mm; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
.running-footer { bottom: -11mm; border-top: .5pt solid var(--ink); padding-top: 2mm; color: var(--ink-40); }
.audit-page .running-header, .audit-page .running-footer { position: absolute; }
.audit-page .running-header { top: 12mm; inset-inline: 12mm; }
.audit-page .running-footer { bottom: 8mm; inset-inline: 12mm; }
.audit-page .page-body { padding-top: 4mm; }
.audit-running { display: block; text-transform: none; letter-spacing: 0; }
.running-row { display: flex; align-items: baseline; justify-content: space-between; gap: 3mm; }
.running-store { font-size: 8pt; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.running-serial { font-size: 8pt; font-weight: 700; }
.running-context { margin-top: .8mm; color: var(--ink-70); font-size: 6.5pt; font-weight: 300; }
.footer-hash { max-width: 70mm; overflow-wrap: anywhere; }
.report-title { text-align: center; margin-bottom: 9mm; }
.store-name { margin: 0 0 2mm; font-size: 9pt; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 0; font-size: 15pt; font-weight: 700; }
.report-purpose { margin: 1.5mm 0 0; color: var(--ink-70); font-size: 7pt; font-weight: 400; }
.docket { display: grid; grid-template-columns: repeat(4, 1fr); border: 2pt solid var(--ink); margin-bottom: 6mm; break-inside: avoid; }
.docket > div { display: flex; flex-direction: column; gap: 1mm; min-width: 0; padding: 2mm; border-inline-start: .5pt solid var(--ink); }
.docket > div:first-child { border-inline-start: 0; }
.docket span, .docket dt { color: var(--ink-70); font-size: 6.5pt; font-weight: 300; letter-spacing: .06em; text-transform: uppercase; }
.docket strong, .docket dd { margin: 0; font-size: 8pt; font-weight: 600; }
.audit-docket { grid-template-columns: repeat(4, 1fr); gap: 3mm 6mm; padding: 3mm 6mm; margin-bottom: 9mm; }
.audit-docket > div { padding: 0; border-inline-start: 0; }
.docket-wide { grid-column: span 3; }
.hash { overflow-wrap: anywhere; font-size: 6.5pt !important; }
.copy-state, .copy-cell { align-items: center; justify-content: center; }
.copy-state { border: 1.5pt solid var(--ink) !important; font-weight: 700; }
.copy-state.reprint { color: #fff; background: #000; }
.copy { display: inline-block; padding: .8mm 2.5mm; font-size: 7.5pt !important; font-weight: 700 !important; letter-spacing: .14em !important; text-transform: uppercase; }
.copy--original { border: 1.5pt solid var(--ink); color: var(--ink) !important; }
.copy--reprint { color: #fff !important; background: var(--ink); }
.verdict { display: grid; grid-template-columns: 1.1fr 2fr; align-items: stretch; border: 2pt solid var(--ink); margin-bottom: 9mm; break-inside: avoid; }
.verdict-main { display: flex; flex-direction: column; justify-content: center; padding: 6mm; border-inline-end: 1pt solid var(--ink); }
.verdict-label { color: var(--ink-70); font-size: 6.5pt; font-weight: 400; letter-spacing: .08em; text-transform: uppercase; }
.verdict-result { margin-top: 1mm; font-size: 20pt; font-weight: 700; line-height: 1; }
.verdict-facts { display: grid; grid-template-columns: repeat(3, 1fr); }
.verdict-facts > div { display: flex; flex-direction: column; justify-content: center; gap: 1mm; padding: 3mm; border-inline-start: .5pt solid var(--ink); }
.verdict-facts > div:first-child { border-inline-start: 0; }
.verdict-facts span { color: var(--ink-70); font-size: 6.5pt; }
.verdict-facts strong { font-size: 10pt; }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); border-block: .5pt solid var(--ink); margin-bottom: 9mm; break-inside: avoid; }
.metric { display: flex; flex-direction: column; gap: 1mm; padding: 3mm; border-inline-start: .5pt solid var(--ink); }
.metric:nth-child(4n+1) { border-inline-start: 0; }
.metric strong, .metric-value { font-size: 16pt; font-weight: 600; line-height: 1.1; }
.metric span, .metric-label { color: var(--ink-70); font-size: 6.5pt; font-weight: 300; letter-spacing: .06em; text-transform: uppercase; }
.section { margin-bottom: 9mm; }
[data-audit-page="financial-summary"] .metrics { margin-bottom: 0; }
[data-audit-page="financial-summary"] .payment-section { margin-bottom: 0; }
[data-audit-page="financial-summary"] .report-title,
[data-audit-page="financial-summary"] .audit-docket,
[data-audit-page="financial-summary"] .verdict { margin-bottom: 6mm; }
.ledger-section { margin-top: 9mm; }
.section-head { margin: 0 0 3mm; padding-bottom: 1.5mm; border-bottom: 1pt solid var(--ink); font-size: 8.5pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; break-after: avoid; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
th { padding: 1.5mm; background: var(--wash); border-block: 1pt solid var(--ink); font-size: 7.5pt; font-weight: 700; text-align: start; }
td { padding: 1.5mm; border-bottom: .5pt solid var(--ink); vertical-align: top; }
tbody tr { break-inside: avoid; }
tbody tr.total td { background: var(--wash); border-top: 1pt solid var(--ink); font-size: 9.5pt; font-weight: 700; }
.num { direction: ltr; unicode-bidi: isolate; text-align: end; font-variant-numeric: tabular-nums; }
.empty { text-align: center; color: var(--ink-70); }
.split-ledger { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; align-items: start; }
.split-ledger .section { margin-bottom: 0; }
.compact td, .compact th { padding-block: 1.1mm; }
.row-note { display: block; margin-top: .4mm; color: var(--ink-70); font-size: 6.25pt; font-weight: 400; }
.payment-section, .platform-section { margin-top: 9mm; }
.audit-page--last .report-title { margin-bottom: 1.5mm; }
.audit-page--last .section { margin-bottom: 1.5mm; }
.audit-page--last .section-head { margin-bottom: 1.5mm; padding-bottom: 1mm; }
.audit-page--last .platform-section { margin-top: 0; }
.shift-detail td { padding: 1.2mm 2mm 2mm; background: #fff; color: var(--ink-70); font-size: 6.25pt; }
.shift-detail span { display: inline; margin-inline-end: 3mm; }
.shift-detail b { color: var(--ink); font-weight: 600; }
.audit-shifts { display: grid; gap: 3mm; }
.audit-shift-ledger { border: 1pt solid var(--ink); break-inside: avoid; }
.audit-shift-head { display: flex; align-items: center; justify-content: space-between; padding: 2mm 2.5mm; border-bottom: 1pt solid var(--ink); }
.audit-shift-head div { display: flex; align-items: center; gap: 3mm; }
.audit-shift-time { display: flex; justify-content: space-between; gap: 4mm; padding: 1.5mm 2.5mm; border-bottom: .5pt solid var(--ink); color: var(--ink-70); }
.audit-shift-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; padding: 1.5mm 2.5mm; }
.audit-shift-drawer { display: grid; grid-template-columns: repeat(2, 1fr); border-top: 1pt solid var(--ink); }
.audit-shift-drawer > div { display: flex; justify-content: space-between; gap: 3mm; padding: 1.2mm 2.5mm; border-bottom: .5pt solid var(--ink); }
.audit-shift-drawer > div:nth-child(odd) { border-inline-end: .5pt solid var(--ink); }
.audit-shift-drawer > div.total { font-weight: 700; border-bottom-width: 1pt; }
.review-register { display: grid; grid-template-columns: repeat(3, 1fr); border-block: 1pt solid var(--ink); break-inside: avoid; }
.review-register > div { padding: 3mm; border-inline-start: .5pt solid var(--ink); }
.review-register > div:first-child { border-inline-start: 0; }
.review-register strong { display: block; margin-bottom: 1mm; font-size: 8pt; }
.review-register span { display: block; color: var(--ink-70); font-size: 7pt; line-height: 1.45; }
.trace { display: grid; grid-template-columns: 1fr 1fr; gap: 9mm; margin-top: 9mm; padding-top: 3mm; border-top: 1pt solid var(--ink); break-inside: avoid; }
.trace > div { min-height: 13mm; border-bottom: .5pt solid var(--ink); }
.trace span { color: var(--ink-70); font-size: 6.5pt; letter-spacing: .06em; text-transform: uppercase; }
.audit-page--last .trace { margin-top: 1.5mm; }
.audit-page--last .trace > div { min-height: 6mm; }
p, li { orphans: 3; widows: 3; }

@media screen {
    .audit-document { min-height: 100vh; padding: 24px; background: #e8e8e8; }
    .audit-page { margin: 0 auto 24px; background: #fff; box-shadow: 0 2px 12px rgb(0 0 0 / 18%); }
}
</style>
