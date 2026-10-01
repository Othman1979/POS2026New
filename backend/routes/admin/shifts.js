const express = require('express');
const router = express.Router();
const {
    pool,
    sendSuccess,
    sendError,
    logAdminRouteError,
    invalidateDashboardCache,
    invalidateUserSessions,
    REFUNDS_ROLLUP_JOIN,
    NET_TOTAL,
    getRefundsByShift,
    paidOrderTimeSql,
} = require('./helpers');
const { getShiftDiscountsByShift } = require('../../services/shiftMetrics');
const { getCashExpensesByShift } = require('../../services/expenseMetrics');
const { getBusinessDateRange } = require('../../utils/businessDate');
const { appendAuditEvent } = require('../../services/auditEvents');
const { validateCashAmount } = require('../../services/CashValidation');
const { revokeUserSessions: revokeDurableUserSessions } = require('../../services/staffSessions');

// ALL /api/admin/shifts
router.all('/shifts', async (req, res) => {
    try {
        const method = req.method;
        const action = req.query.action || '';

        if (method === 'GET') {
            if (action === 'cashiers') {
                const showAll = req.query.all === 'true';
                let sql = `
                    SELECT u.id, u.name 
                    FROM users u 
                    LEFT JOIN shifts s ON u.id = s.user_id AND s.status = 'open' 
                    WHERE u.is_active = 1 AND u.role NOT IN ('programmer','call_center')
                `;
                if (!showAll) {
                    sql += " AND s.id IS NULL";
                }
                sql += " ORDER BY u.name ASC";
                const [cashiers] = await pool.query(sql);
                return sendSuccess(res, { cashiers, users: cashiers });
            }

            const cashierIdsStr = String(req.query.cashier_ids || '').trim();
            const status = String(req.query.status || '').trim();
            const where = [];
            const params = [];

            if (cashierIdsStr) {
                const ids = cashierIdsStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
                if (ids.length > 0) {
                    const placeholders = ids.map(() => '?').join(',');
                    where.push(`s.user_id IN (${placeholders})`);
                    params.push(...ids);
                }
            }

            if (status === 'open') {
                where.push("s.status = 'open'");
            } else if (status === 'closed') {
                where.push("s.status = 'closed'");
            }

            const searchStr = String(req.query.search || '').trim();
            if (searchStr) {
                where.push('(CAST(s.id AS CHAR) LIKE ? OR u.name LIKE ?)');
                const like = `%${searchStr}%`;
                params.push(like, like);
            }

            const startDateStr = String(req.query.start_date || '').trim();
            const endDateStr = String(req.query.end_date || '').trim();
            let dateRange = null;
            if (startDateStr) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || (endDateStr && !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr))) {
                    return sendError(res, 400, 'Invalid date filter.');
                }
                dateRange = getBusinessDateRange(startDateStr, endDateStr || startDateStr);
                // Separate issued and legacy dates so eligibility can use each date index.
                where.push(`s.opened_at < ? AND (
                    s.opened_at >= ?
                    OR EXISTS (
                        SELECT 1 FROM orders so
                        WHERE so.shift_id = s.id
                          AND so.invoice_issued_at >= ? AND so.invoice_issued_at < ?
                          AND so.payment_method NOT IN ('unpaid_table', 'voided')
                    )
                    OR EXISTS (
                        SELECT 1 FROM orders so
                        WHERE so.shift_id = s.id AND so.invoice_issued_at IS NULL
                          AND so.created_at >= ? AND so.created_at < ?
                          AND so.payment_method NOT IN ('unpaid_table', 'voided')
                    )
                    OR EXISTS (
                        SELECT 1 FROM refunds sr
                        WHERE sr.shift_id = s.id AND sr.created_at >= ? AND sr.created_at < ?
                    )
                    OR EXISTS (
                        SELECT 1 FROM orders svo
                        WHERE svo.shift_id = s.id
                          AND svo.created_at >= ? AND svo.created_at < ?
                          AND svo.payment_method = 'voided'
                    )
                    OR EXISTS (
                        SELECT 1 FROM expenses se
                        WHERE se.shift_id = s.id AND se.created_at >= ? AND se.created_at < ?
                    )
                )`);
                params.push(
                    dateRange.end,
                    dateRange.start,
                    dateRange.start, dateRange.end,
                    dateRange.start, dateRange.end,
                    dateRange.start, dateRange.end,
                    dateRange.start, dateRange.end,
                    dateRange.start, dateRange.end,
                );
            }

            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

            const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM shifts s LEFT JOIN users u ON s.user_id = u.id ${whereSql}`, params);
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
            const offset = (page - 1) * limit;

            const [shifts] = await pool.query(`
                SELECT 
                    s.id, s.user_id, s.starting_cash, s.expected_cash, s.actual_cash, 
                    s.opened_at, s.closed_at, s.status,
                    u.name as cashier_name
                FROM shifts s
                LEFT JOIN users u ON s.user_id = u.id
                ${whereSql}
                ORDER BY s.status DESC, s.id DESC
                LIMIT ? OFFSET ?
            `, [...params, limit, offset]);

            if (shifts.length > 0) {
                const shiftIds = shifts.map(s => s.id);
                const closedIds = shifts.filter(s => s.status === 'closed').map(s => s.id);
                const neighborById = {};
                if (closedIds.length > 0) {
                    const [neighbors] = await pool.query(`
                        SELECT s.id,
                          (SELECT p.actual_cash FROM shifts p
                             WHERE p.id <> s.id AND p.status='closed' AND p.closed_at <= s.opened_at
                             ORDER BY p.closed_at DESC, p.id DESC LIMIT 1) AS prev_actual_cash,
                          EXISTS (SELECT 1 FROM shifts o
                             WHERE o.id <> s.id AND o.opened_at <= s.opened_at
                               AND (o.closed_at IS NULL OR o.closed_at > s.opened_at)) AS overlapped_at_open
                        FROM shifts s WHERE s.id IN (?)
                    `, [closedIds]);
                    for (const row of neighbors) {
                        neighborById[row.id] = row;
                    }
                }

                // Batch load the GROSS totals for all returned shifts (no invoice-level refund join).
                // Refunds are netted separately by shift_id below.
                const orderRangeSql = dateRange
                    ? `AND ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?`
                    : '';
                const orderRangeParams = dateRange ? [dateRange.start, dateRange.end] : [];

                const [aggregates] = await pool.query(`
                    SELECT
                        o.shift_id,
                        COALESCE(SUM(o.total), 0) as gross_sales,
                        COALESCE(SUM(o.cash_amount), 0) as cash_sales,
                        COALESCE(SUM(o.card_amount), 0) as card_sales,
                        COALESCE(SUM(CASE WHEN o.payment_method = 'platform' THEN o.total ELSE 0 END), 0) as platform_sales
                    FROM orders o
                    WHERE o.shift_id IN (${shiftIds.map(() => '?').join(',')})
                      ${orderRangeSql}
                      AND o.payment_method NOT IN ('unpaid_table', 'voided')
                    GROUP BY o.shift_id
                `, [...shiftIds, ...orderRangeParams]);

                const aggregatesMap = {};
                for (const agg of aggregates) {
                    aggregatesMap[agg.shift_id] = agg;
                }

                // Refunds scoped to the shift they were ISSUED in (refunds.shift_id).
                // This is the correct drawer number: a refund issued in shift B reduces B's
                // expected_cash, not the shift that originally took the payment.
                const refundsMap = await getRefundsByShift(pool, shiftIds, dateRange);
                const discountsMap = await getShiftDiscountsByShift(pool, shiftIds, dateRange);
                const expensesMap = await getCashExpensesByShift(pool, shiftIds, dateRange);

                const [breakdowns] = await pool.query(`
                    SELECT o.shift_id, COALESCE(ot.name, 'Standard') as order_type_name, SUM(${NET_TOTAL}) as total_sales
                    FROM orders o
                    LEFT JOIN order_types ot ON o.order_type_id = ot.id
                    ${REFUNDS_ROLLUP_JOIN}
                    WHERE o.shift_id IN (${shiftIds.map(() => '?').join(',')})
                      ${orderRangeSql}
                      AND o.payment_method NOT IN ('unpaid_table', 'voided')
                    GROUP BY o.shift_id, o.order_type_id
                `, [...shiftIds, ...orderRangeParams]);

                const breakdownsMap = {};
                for (const b of breakdowns) {
                    if (!breakdownsMap[b.shift_id]) {
                        breakdownsMap[b.shift_id] = [];
                    }
                    breakdownsMap[b.shift_id].push({
                        order_type_name: b.order_type_name,
                        total_sales: b.total_sales
                    });
                }

                for (let shift of shifts) {
                    const agg = aggregatesMap[shift.id] || {
                        gross_sales: 0,
                        cash_sales: 0,
                        card_sales: 0,
                        platform_sales: 0
                    };
                    const ref = refundsMap[shift.id] || { amt: 0, cash: 0, card: 0, platform: 0 };
                    const discounts = discountsMap[shift.id] || { total_discounts: 0 };
                    shift.gross_sales = Number(agg.gross_sales) - Number(ref.amt);
                    shift.cash_sales = Number(agg.cash_sales) - Number(ref.cash);
                    shift.card_sales = Number(agg.card_sales) - Number(ref.card);
                    shift.platform_sales = Number(agg.platform_sales) - Number(ref.platform);
                    shift.total_discounts = Number(discounts.total_discounts);
                    shift.cash_expenses = Number(expensesMap[shift.id] || 0);

                    shift.is_active = (shift.status === 'open');
                    shift.live_expected_cash = parseFloat(shift.starting_cash || 0)
                        + parseFloat(shift.cash_sales || 0)
                        - shift.cash_expenses;

                    if (shift.is_active) {
                        shift.variance = null;
                        shift.variance_hint = null;
                        shift.drawer_change_since_previous_close = null;
                    } else {
                        // Closed shifts are immutable records: variance is measured against the
                        // expected_cash that was frozen at close, not a live recompute that would
                        // drift if an order is later voided/refunded.
                        const frozenExpected = parseFloat(shift.expected_cash || 0);
                        shift.variance = Number(((parseFloat(shift.actual_cash || 0)) - frozenExpected).toFixed(2));

                        const cents = v => Math.round(Number(v) * 100);
                        const row = neighborById[shift.id] || {};
                        const startingCents = cents(shift.starting_cash);
                        const expectedCents = cents(shift.expected_cash);
                        const actualCents = cents(shift.actual_cash);
                        const prevCents = row.prev_actual_cash == null ? null : cents(row.prev_actual_cash);
                        const hasPrev = prevCents !== null && !row.overlapped_at_open;
                        const v = actualCents - expectedCents;

                        let variance_hint = null;
                        if (v !== 0) {
                          if (hasPrev && v === prevCents - startingCents)
                            variance_hint = { kind: 'starting_cash_mismatch', suggested: { starting_cash: prevCents / 100 } };
                          else if (startingCents > 0 && v === -startingCents)
                            variance_hint = { kind: 'count_excluded_opening', suggested: { actual_cash: (actualCents + startingCents) / 100 } };
                        }
                        const drawer_change_since_previous_close = hasPrev ? (startingCents - prevCents) / 100 : null;
                        shift.variance_hint = variance_hint;
                        shift.drawer_change_since_previous_close = drawer_change_since_previous_close;
                    }

                    shift.order_type_breakdown = breakdownsMap[shift.id] || [];
                }
            }

            return sendSuccess(res, { shifts, pagination: { total: Number(total), page, limit, total_pages: Math.max(1, Math.ceil(total / limit)) } });
        }
        else if (method === 'POST') {
            const data = req.body;
            const userId = parseInt(data.user_id, 10);
            if (!userId || Number.isNaN(userId)) {
                return sendError(res, 400, 'A valid cashier must be selected.');
            }

            const cash = validateCashAmount(data.starting_cash);
            if (!cash.valid) {
                return sendError(res, 400, cash.message);
            }

            // Transaction + FOR UPDATE prevents two simultaneous shift-open requests
            // for the same cashier from both passing the duplicate check.
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const [targets] = await conn.query(
                    'SELECT id, role, is_active FROM users WHERE id=? FOR UPDATE',
                    [userId]
                );
                if (targets.length === 0 || Number(targets[0].is_active) !== 1) {
                    await conn.rollback();
                    return sendError(res, 404, 'Active user not found.');
                }
                if (targets[0].role === 'call_center') {
                    await conn.rollback();
                    return sendError(res, 403, 'Call center users cannot have register shifts.');
                }
                const [check] = await conn.query(
                    "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' FOR UPDATE",
                    [userId]
                );
                if (check.length > 0) {
                    await conn.rollback();
                    return sendError(res, 400, "User already has an open shift.");
                }
                await conn.query(
                    "INSERT INTO shifts (user_id, starting_cash, status) VALUES (?, ?, 'open')",
                    [userId, cash.value]
                );
                await conn.commit();
                invalidateDashboardCache();
                if (req.io) req.io.to('staff').emit('shifts_changed', { user_id: userId, action: 'open' });
                return sendSuccess(res, { message: "Shift Opened." });
            } catch (txErr) {
                await conn.rollback();
                throw txErr;
            } finally {
                conn.release();
            }
        }
        else if (method === 'PUT') {
            const data = req.body;
            const shift_id = parseInt(data.id, 10);
            if (!shift_id) {
                return sendError(res, 400, 'A valid shift id is required.');
            }
            const actual_cash = data.actual_cash;

            const cash = validateCashAmount(actual_cash);
            if (!cash.valid) {
                return sendError(res, 400, cash.message);
            }

            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();

                const [shifts] = await conn.query("SELECT status, starting_cash, user_id FROM shifts WHERE id = ? FOR UPDATE", [shift_id]);
                if (shifts.length === 0) {
                    await conn.rollback();
                    return sendError(res, 404, "Shift not found.");
                }
                if (shifts[0].status === 'closed') {
                    await conn.rollback();
                    return sendError(res, 400, "Shift is already closed.");
                }

                // Phase 3: Warn admin if cashier has open unpaid tables.
                // Require ?force=true to override — protects against accidentally closing
                // a shift while a table is still open.
                if (req.query.force !== 'true') {
                    const [openTables] = await conn.query(`
                        SELECT rt.id, rt.table_number
                        FROM restaurant_tables rt
                        JOIN orders o ON rt.current_order_id = o.invoice_id
                        WHERE o.user_id = ? AND o.payment_method = 'unpaid_table'
                          AND rt.status = 'occupied'
                    `, [shifts[0].user_id]);
                    if (openTables.length > 0) {
                        await conn.rollback();
                        const tableNums = openTables.map(t => `#${t.table_number}`).join(', ');
                        return res.status(409).json({
                            success: false,
                            message: `Cannot close shift: cashier has ${openTables.length} open table order(s) (${tableNums}). Please resolve all open tables before closing this shift.`,
                            open_tables: openTables
                        });
                    }
                }

                const startingCash = parseFloat(shifts[0].starting_cash || 0);

                // Compute expected cash: gross cash from orders minus cash refunds issued IN this shift.
                // Refunds are scoped to refunds.shift_id so a refund issued in a different shift
                // never pollutes this shift's drawer balance.
                const [totals] = await conn.query(`
                    SELECT SUM(COALESCE(o.cash_amount, 0)) as gross_cash
                    FROM orders o
                    WHERE o.shift_id = ? AND o.payment_method NOT IN ('unpaid_table', 'voided')
                `, [shift_id]);
                const shiftRefMap = await getRefundsByShift(conn, [shift_id]);
                const grossCash = parseFloat(totals[0]?.gross_cash || 0);
                const cashRef = shiftRefMap[shift_id]?.cash || 0;
                const expenseMap = await getCashExpensesByShift(conn, [shift_id]);
                const computedExpectedCash = startingCash + grossCash - cashRef - (expenseMap[shift_id] || 0);

                await conn.query(
                    "UPDATE shifts SET expected_cash = ?, actual_cash = ?, closed_at = CURRENT_TIMESTAMP, status = 'closed' WHERE id = ? AND status = 'open'",
                    [computedExpectedCash, cash.value, shift_id]
                );

                // Revoke every durable session for the user of this shift in the same transaction.
                await revokeDurableUserSessions(shifts[0].user_id, 'shift_force_closed', conn);

                // Durable audit row for this destructive admin action, in the SAME
                // transaction as the close so the two commit or roll back together.
                await appendAuditEvent(conn, {
                    eventType: 'shift_force_closed',
                    userId: req.user.id,
                    entityType: 'shift',
                    entityId: shift_id,
                    oldValue: { status: 'open', cashier_user_id: shifts[0].user_id },
                    newValue: {
                         expected_cash: computedExpectedCash,
                         actual_cash: cash.value,
                         variance: Number((cash.value - computedExpectedCash).toFixed(3)),
                    },
                    ipAddress: req.ip || null
                });

                await conn.commit();
                invalidateDashboardCache();
                if (req.io) req.io.to('staff').emit('shifts_changed', { shift_id, action: 'close' });
                // Immediately evict all session cache entries for this user
                invalidateUserSessions(shifts[0].user_id);
                if (req.io) req.io.to(`user:${shifts[0].user_id}`).disconnectSockets(true);
                return sendSuccess(res, { message: "Shift forced closed by Admin.", expected_cash: computedExpectedCash });
            } catch (txErr) {
                await conn.rollback();
                throw txErr;
            } finally {
                conn.release();
            }
        } else {
            return sendError(res, 405, 'Method not allowed.');
        }
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, 500, e.message);
    }
});

module.exports = router;
