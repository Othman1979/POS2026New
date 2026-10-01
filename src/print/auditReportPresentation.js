import { formatBusinessDateTimeShort } from '../utils/businessDate.js';

const roundedMoney = value => Number(Number(value || 0).toFixed(2));
export const shiftShowsEquation = s => s?.within_window === true;

function applyVerdict(summary) {
    if (summary.open > 0) {
        summary.result = 'الإغلاق غير مكتمل';
        summary.state = 'توجد مناوبات مفتوحة';
    } else if (summary.uncounted > 0) {
        summary.result = 'العد النقدي غير مكتمل';
        summary.state = 'توجد مناوبات بلا رصيد فعلي معتمد';
    } else if (summary.needsReview === 1) {
        summary.result = 'مناوبة تحتاج مراجعة';
        summary.state = 'راجع فرق الكاشير';
    } else if (summary.needsReview === 2) {
        summary.result = 'مناوبتان تحتاجان مراجعة';
        summary.state = 'راجع فرق كل كاشير';
    } else if (summary.needsReview > 2) {
        summary.result = `${summary.needsReview} مناوبات تحتاج مراجعة`;
        summary.state = 'راجع فرق كل كاشير';
    } else if (summary.closed === 0) {
        summary.result = 'لا توجد مناوبات أُغلقت ضمن فترة التقرير';
        summary.state = summary.closedOutsideWindow > 0
            ? `مناوبات أُغلقت في يوم عمل آخر: ${summary.closedOutsideWindow}`
            : 'لا توجد بيانات صندوق لهذا اليوم';
    } else {
        summary.result = 'جميع المناوبات متوازنة';
        summary.state = 'لا يوجد عجز أو زيادة';
    }
}

export function summarizeAuditShifts(value) {
    const shifts = Array.isArray(value) ? value : [];
    const summary = {
        total: shifts.length,
        closed: 0,
        closedOutsideWindow: 0,
        open: 0,
        uncounted: 0,
        needsReview: 0,
        balanced: 0,
        netVariance: 0,
        shortage: 0,
        overage: 0,
    };
    let moneyIncomplete = false;

    for (const shift of shifts) {
        if (shift?.status !== 'closed') {
            summary.open += 1;
            moneyIncomplete = true;
            continue;
        }
        if (shift.closed_in_window === false) {
            summary.closedOutsideWindow += 1;
            continue;
        }
        summary.closed += 1;
        if (shift.actual_cash == null || shift.variance == null) {
            summary.uncounted += 1;
            moneyIncomplete = true;
            continue;
        }
        const variance = roundedMoney(shift.variance);
        summary.netVariance = roundedMoney(summary.netVariance + variance);
        if (variance < 0) summary.shortage = roundedMoney(summary.shortage + Math.abs(variance));
        else if (variance > 0) summary.overage = roundedMoney(summary.overage + variance);
        if (variance !== 0) summary.needsReview += 1;
    }

    summary.balanced = Math.max(0, summary.closed - summary.uncounted - summary.needsReview);
    if (moneyIncomplete || summary.closed === 0) {
        summary.netVariance = null;
        summary.shortage = null;
        summary.overage = null;
    }
    applyVerdict(summary);
    return summary;
}

export function reconciliationFrom(payload) {
    const recon = payload?.cash_reconciliation;
    if (recon && Object.prototype.hasOwnProperty.call(recon, 'net_variance_total')) {
        const closed = Number(recon.closed_shifts) || 0;
        const closedOutsideWindow = Number(recon.closed_outside_window) || 0;
        const open = Number(recon.open_shifts) || 0;
        const uncounted = Number(recon.uncounted_shifts) || 0;
        const needsReview = Number(recon.shifts_needing_review) || 0;
        const summary = {
            cashExpensesTotal: recon.cash_expenses_total,
            closed,
            closedOutsideWindow,
            open,
            uncounted,
            needsReview,
            total: closed + closedOutsideWindow + open,
            balanced: Math.max(0, closed - uncounted - needsReview),
            netVariance: recon.net_variance_total,
            shortage: recon.shortage_total,
            overage: recon.overage_total,
        };
        applyVerdict(summary);
        return summary;
    }
    return summarizeAuditShifts(payload?.shifts);
}

export function formatAuditDateTime(value) {
    return formatBusinessDateTimeShort(value) || '—';
}
