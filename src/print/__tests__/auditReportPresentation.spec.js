import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
    reconciliationFrom,
    shiftShowsEquation,
    summarizeAuditShifts,
} from '../auditReportPresentation.js';

const require = createRequire(import.meta.url);
const {
    reconciliationFrom: spoolerReconciliationFrom,
    summarizeAuditShifts: summarizeSpoolerAuditShifts,
} = require('../../../pos-spooler-printer/v2/report-data.js');

describe('audit report presentation helpers', () => {
    it('summarizes opposite in-window variances without calling the drawer balanced', () => {
        expect(summarizeAuditShifts([
            { status: 'closed', closed_in_window: true, actual_cash: 104, variance: 4 },
            { status: 'closed', closed_in_window: true, actual_cash: 96, variance: -4 },
        ])).toMatchObject({
            closed: 2, closedOutsideWindow: 0, open: 0, uncounted: 0,
            needsReview: 2, netVariance: 0, shortage: 4, overage: 4,
        });
    });

    it('counts an explicit outside-window close separately without inventing reconciliation money', () => {
        expect(summarizeAuditShifts([
            { status: 'closed', closed_in_window: false, actual_cash: 96, variance: -4 },
        ])).toMatchObject({ closed: 0, closedOutsideWindow: 1, netVariance: null });
    });

    it('treats a missing closed_in_window flag as inside for stale payloads', () => {
        expect(summarizeAuditShifts([
            { status: 'closed', actual_cash: 96, variance: -4 },
        ])).toMatchObject({ closed: 1, closedOutsideWindow: 0, netVariance: -4 });
    });

    it('blanks aggregate money when an in-window close has no actual count', () => {
        expect(summarizeAuditShifts([
            { status: 'closed', closed_in_window: true, actual_cash: null, variance: null },
        ])).toMatchObject({ uncounted: 1, netVariance: null, shortage: null, overage: null });
    });

    it('shows the drawer equation only when within_window is explicitly true', () => {
        expect(shiftShowsEquation({ within_window: true })).toBe(true);
        expect(shiftShowsEquation({ within_window: false })).toBe(false);
        expect(shiftShowsEquation({})).toBe(false);
    });

    it('lets new server reconciliation fields win over a row fallback', () => {
        const shifts = [
            { status: 'closed', closed_in_window: true, actual_cash: 104, variance: 4 },
            { status: 'closed', closed_in_window: true, actual_cash: 96, variance: -4 },
        ];
        const server = reconciliationFrom({
            cash_reconciliation: {
                cash_expenses_total: 50,
                open_shifts: 0,
                closed_shifts: 2,
                closed_outside_window: 0,
                uncounted_shifts: 0,
                shifts_needing_review: 2,
                net_variance_total: 0,
                shortage_total: 4,
                overage_total: 4,
            },
            shifts: [],
        });
        const fallback = reconciliationFrom({ shifts });

        expect(server).toMatchObject({
            closed: 2,
            closedOutsideWindow: 0,
            open: 0,
            uncounted: 0,
            needsReview: 2,
            netVariance: 0,
            shortage: 4,
            overage: 4,
            total: 2,
            balanced: 0,
            cashExpensesTotal: 50,
        });
        expect(fallback).toMatchObject({
            closed: 2,
            closedOutsideWindow: 0,
            open: 0,
            uncounted: 0,
            needsReview: 2,
            netVariance: 0,
            shortage: 4,
            overage: 4,
            total: 2,
            balanced: 0,
        });
        expect(server.result).toBe(fallback.result);
        expect(server.state).toBe(fallback.state);
    });

    it('ignores legacy aggregate totals and summarizes rows instead', () => {
        const payload = {
            cash_reconciliation: {
                starting_cash_total: 1100,
                expected_cash_total: 1100,
                actual_cash_total: 1100,
                variance_total: 0,
                cash_expenses_total: 0,
            },
            shifts: [
                { status: 'closed', actual_cash: 400, variance: 0 },
                { status: 'closed', actual_cash: 700, variance: 0 },
            ],
        };

        expect(reconciliationFrom(payload)).toMatchObject({
            closed: 2,
            netVariance: 0,
            balanced: 2,
        });
        expect(reconciliationFrom(payload)).not.toMatchObject({ expectedCashTotal: 1100 });
    });

    it('never calls a payload of only outside-window closes balanced', () => {
        const summary = summarizeAuditShifts([
            { status: 'closed', closed_in_window: false, actual_cash: 96, variance: -4 },
        ]);
        expect(summary.result).not.toMatch(/متوازن/);
        expect(summary.closed).toBe(0);
        expect(summary.netVariance).toBeNull();
        expect(summary.shortage).toBeNull();
        expect(summary.overage).toBeNull();
    });

    it('keeps the packaged spooler aggregation identical to the browser fallback', () => {
        const fixtures = [
            [
                { status: 'closed', closed_in_window: true, actual_cash: 104, variance: 4 },
                { status: 'closed', closed_in_window: true, actual_cash: 96, variance: -4 },
            ],
            [{ status: 'closed', closed_in_window: false, actual_cash: 96, variance: -4 }],
            [{ status: 'closed', closed_in_window: true, actual_cash: null, variance: null }],
        ];

        for (const shifts of fixtures) {
            expect(summarizeSpoolerAuditShifts(shifts)).toEqual(summarizeAuditShifts(shifts));
        }

        const payload = {
            cash_reconciliation: {
                cash_expenses_total: 5,
                open_shifts: 0,
                closed_shifts: 2,
                closed_outside_window: 1,
                uncounted_shifts: 0,
                shifts_needing_review: 2,
                net_variance_total: 0,
                shortage_total: 4,
                overage_total: 4,
            },
        };
        expect(spoolerReconciliationFrom(payload)).toEqual(reconciliationFrom(payload));
    });
});
