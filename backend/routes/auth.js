const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const logger = require('../config/logger');
const { requireAuth, requireAdmin, rejectCallCenterRole, invalidateToken, hashPin, verifyPin, preWarmToken, invalidateShiftTokens, invalidateUserSessions, setTokenShiftId } = require('../middleware/auth');
const { invalidateDashboardCache } = require('../config/cache');
const { REFUNDS_ROLLUP_JOIN, NET_TOTAL, getRefundsByShift } = require('./admin/helpers');
const { getShiftDiscountsByShift } = require('../services/shiftMetrics');
const { getCashExpensesByShift, getCashExpenseCategoriesByShift } = require('../services/expenseMetrics');
const { appendAuditEvent, appendSecurityAuditEvent } = require('../services/auditEvents');
const { validateCashAmount } = require('../services/CashValidation');
const { canOpenShift, canCloseShift, CHECKOUT_MANAGER_OVERRIDE_PERMISSIONS, getOverridableKeys } = require('../services/PermissionService');
const { createSession, findActiveSession, revokeSessionByToken: revokeDurableSessionByToken, revokeUserSessions: revokeDurableUserSessions } = require('../services/staffSessions');
const { readAuthMode, lockAuthMode } = require('../services/deviceAccess');
const { ELIGIBLE_CREDENTIAL_SQL } = require('../services/webauthn/credentials');
const { loadWebAuthnConfig, assertWebAuthnRuntimeReady } = require('../services/webauthn/config');
const { setSessionCookie, clearSessionCookie } = require('../services/sessionCookies');
const { createLoginThrottle } = require('../services/loginDelay');
const { beginOverrideAttempt, finishOverrideAttempt, recordManagerOverrideAudit } = require('../services/ManagerOverrideService');
const { getBusinessDate, getBusinessDayRange } = require('../utils/businessDate');
const { isReservedOrderIntakeActor } = require('../modules/orderIntake/config');
const printRouter = require('./print');

router.use('/webauthn', require('./auth/webauthn'));

router.get('/login-policy', async (req, res) => {
    let mode = 'disabled';
    try {
        mode = await readAuthMode();
        if (mode === 'disabled') return sendSuccess(res, { mode, supported: false, enforce_https: ENFORCE_HTTPS, message: 'PIN login is available.' });
        const config = loadWebAuthnConfig(process.env);
        assertWebAuthnRuntimeReady({ config, mode, enforceHttps: ENFORCE_HTTPS });
        return sendSuccess(res, { mode, supported: true, enforce_https: ENFORCE_HTTPS, message: 'Only users with a registered browser need device verification.' });
    } catch (error) {
        return res.status(200).json({ success: true, mode, supported: false, enforce_https: ENFORCE_HTTPS, message: 'Registered-device access is not ready.' });
    }
});

const ENFORCE_HTTPS = process.env.ENFORCE_HTTPS === 'true';

const sendError = (res, status, message) => res.status(status).json({ success: false, message });
const sendSuccess = (res, data) => res.status(200).json({ success: true, ...data });
const isAdminUser = (user) => user && (user.role === 'admin' || user.role === 'programmer');
const loginThrottle = createLoginThrottle();

const canAccessUser = (req, userId) => {
    if (isAdminUser(req.user)) return true;
    return String(req.user?.id) === String(userId);
};

const canAccessShift = async (req, shiftId) => {
    const [rows] = await pool.query("SELECT id, user_id FROM shifts WHERE id = ? LIMIT 1", [shiftId]);
    if (rows.length === 0) return { allowed: false, status: 404, message: "Shift not found." };
    if (isAdminUser(req.user) || String(rows[0].user_id) === String(req.user.id)) {
        return { allowed: true, shift: rows[0] };
    }
    return { allowed: false, status: 403, message: "Forbidden: Shift does not belong to this user." };
};

async function runLoginTransaction(conn, userNumber, req, res) {
        await conn.beginTransaction();
        const authMode = await lockAuthMode(conn);
        const [users] = await conn.query(
            `SELECT id, user_number, name, role, is_active, allowed_sections, table_access_scope
             FROM users WHERE user_number = ? AND is_active = 1 LIMIT 1 FOR UPDATE`,
            [userNumber]
        );

        if (users.length > 0) {
            const user = users[0];
            if (isReservedOrderIntakeActor(user.id)) {
                await conn.rollback();
                return { status: 401, delayAction: 'record', body: { success: false, message: "Invalid user number." } };
            }
            let hasEligibleRegisteredBrowser = false;
            user.device_auth_mode = authMode;
            if (authMode !== 'disabled' && user.role !== 'programmer') {
                const [[registered]] = await conn.query(
                    `SELECT EXISTS(SELECT 1 FROM webauthn_credentials WHERE user_id=? AND ${ELIGIBLE_CREDENTIAL_SQL}) AS required`,
                    [user.id]
                );
                hasEligibleRegisteredBrowser = Number(registered?.required || 0) === 1;
                if (hasEligibleRegisteredBrowser) {
                    await conn.rollback();
                    return { status: 403, delayAction: 'keep', body: { success: false, code: 'DEVICE_AUTH_REQUIRED', message: 'A registered device is required.' } };
                }
            }
            const { loadUserPermissions, canStaySignedInOnSeveralTerminals } = require('../services/PermissionService');
            user.permissions = await loadUserPermissions(user.id, user.role, conn);
            if (user.role === 'call_center') { user.allowed_sections = null; user.table_access_scope = 'none'; }
            // A user granted auth.multi_terminal stays signed in on their other terminals.
            const keepOtherSessions = canStaySignedInOnSeveralTerminals(user);
            const session = await createSession({
                executor: conn,
                userId: user.id,
                credentialId: null,
                revokeUserSessions: !keepOtherSessions,
                revokeReason: 'legacy_login'
            });
            const [[tablesSetting]] = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'tables_enabled' LIMIT 1");
            if (user.role === 'programmer') {
                await appendSecurityAuditEvent(conn, {
                    eventType: 'programmer_login',
                    userId: user.id,
                    entityType: 'auth_session',
                    entityId: null,
                    newValue: { device_auth_mode: authMode },
                    ipAddress: req.ip || null,
                });
            }
            await conn.commit();
            // Revoke any prior session for this user so a fresh login is single-session,
            // unless the user may stay signed in on several terminals.
            // MUST run BEFORE preWarmToken — invalidateUserSessions deletes every cache
            // entry for this user.id, which would otherwise also wipe the new token below.
            if (!keepOtherSessions) {
                invalidateUserSessions(user.id);
                if (req.io) req.io.to(`user:${user.id}`).disconnectSockets(true);
            }
            // Pre-warm session cache immediately so the first authenticated request is a cache hit
            preWarmToken(session.rawToken, user, {
                sessionId: session.id,
                credentialId: null,
                deviceAuthMode: user.device_auth_mode,
                absoluteExpiresAt: session.absoluteExpiresAt
            });
            setSessionCookie(res, session.rawToken, req);

            const tablesEnabled = tablesSetting?.setting_value === '1';

            return { status: 200, delayAction: 'clear', body: { success: true,
                message: "Authentication successful.",
                tables_enabled: tablesEnabled,
                device_registration_required: user.device_auth_mode === 'staged' && user.role !== 'programmer',
                device_registration_suggested: user.device_auth_mode === 'enforced'
                    && user.role !== 'programmer'
                    && !hasEligibleRegisteredBrowser,
                user: {
                    id: user.id,
                    name: user.name,
                    role: user.role,
                    permissions: user.permissions,
                    allowed_sections: user.allowed_sections, table_access_scope: user.table_access_scope,
                    device_auth_mode: user.device_auth_mode
                }
            } };
        } else {
            await conn.rollback();
            return { status: 401, delayAction: 'record', body: { success: false, message: "Invalid user number." } };
        }
}

router.post('/login', async (req, res) => {
    const userNumber = String(req.body?.user_number || '').trim();
    if (!userNumber) return sendError(res, 400, "User number is required.");
    const browserId = loginThrottle.browserIdFor(req, res);
    const throttleKey = loginThrottle.keyFor(browserId, userNumber);
    const pendingBlockMs = loginThrottle.retryAfterMs(throttleKey);
    if (pendingBlockMs) {
        res.setHeader('Retry-After', String(Math.ceil(pendingBlockMs / 1000)));
        return res.status(429).json({
            success: false,
            code: 'LOGIN_RATE_LIMITED',
            message: 'Too many login attempts. Try again shortly.'
        });
    }
    let conn;
    let outcome;
    try {
        conn = await pool.getConnection();
        outcome = await runLoginTransaction(conn, userNumber, req, res);
    } catch (e) {
        if (conn) await conn.rollback().catch(() => {});
        logger.error({ err: e }, 'Login: authentication failed');
        outcome = { status: 500, delayAction: 'keep', body: { success: false, message: "Authentication failed. Please try again." } };
    } finally {
        conn?.release();
    }
    if (outcome.delayAction === 'record') {
        const blockMs = loginThrottle.recordFailure(throttleKey);
        if (blockMs) {
            res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
            return res.status(429).json({
                success: false,
                code: 'LOGIN_RATE_LIMITED',
                message: 'Too many login attempts. Try again shortly.'
            });
        }
    } else if (outcome.delayAction === 'clear') {
        loginThrottle.clear(throttleKey);
    }
    return res.status(outcome.status).json(outcome.body);
});

router.post('/manager_override', requireAuth, rejectCallCenterRole, async (req, res) => {
    const adminPin = String(req.body?.admin_pin || '').trim();
    if (!adminPin) {
        return sendError(res, 400, "Manager PIN is required.");
    }

    const attemptKey = `manager_override:user:${req.user?.id || 'anon'}`;
    let action = 'server-error';
    let began = false;
    try {
        try {
            await beginOverrideAttempt(attemptKey);
        } catch (error) {
            if (error.statusCode === 429) {
                await recordManagerOverrideAudit({
                    eventType: 'pin_override_locked',
                    userId: req.user?.id,
                    route: req.originalUrl,
                    ipAddress: req.ip || null,
                });
            }
            throw error;
        }
        began = true;
        const [candidates] = await pool.query(
            "SELECT id, role, admin_pin FROM users WHERE is_active = 1 AND admin_pin IS NOT NULL AND role IN ('admin','programmer')"
        );

        let matchedUser = null;
        for (const candidate of candidates) {
            const result = await verifyPin(adminPin, candidate.admin_pin);
            if (result) {
                matchedUser = candidate;
                if (result === 'needs_rehash') {
                    const newHash = await hashPin(adminPin);
                    pool.query("UPDATE users SET admin_pin = ? WHERE id = ?", [newHash, candidate.id])
                        .catch(err => logger.error({ err }, 'manager_override: failed to re-hash PIN'));
                }
                break;
            }
        }

        if (matchedUser && isAdminUser(matchedUser)) {
            action = 'success';
            await recordManagerOverrideAudit({
                eventType: 'pin_override_success',
                userId: req.user?.id,
                managerId: matchedUser.id,
                route: req.originalUrl,
                ipAddress: req.ip || null,
            });
            return sendSuccess(res, {
                message: "Manager override approved.",
                permissions: await getOverridableKeys(pool, CHECKOUT_MANAGER_OVERRIDE_PERMISSIONS),
            });
        }

        action = 'failed';
        await recordManagerOverrideAudit({
            eventType: 'pin_override_failed',
            userId: req.user?.id,
            route: req.originalUrl,
            ipAddress: req.ip || null,
        });
        return sendError(res, 401, "Invalid manager PIN.");
    } catch (e) {
        if (e.statusCode === 429) return sendError(res, 429, "Too many failed override attempts. Please try again later.");
        logger.error({ err: e }, 'Manager override: failed');
        return sendError(res, 500, "An internal error occurred.");
    } finally {
        if (began) finishOverrideAttempt(attemptKey, action);
    }
});

router.all('/shifts', requireAuth, rejectCallCenterRole, async (req, res) => {
    const method = req.method;
    const action = req.query.action || '';

    try {
        if (method === 'GET' && action === 'check') {
            const { user_id } = req.query;
            if (!parseInt(user_id, 10)) {
                return sendError(res, 400, "A valid user id is required.");
            }
            if (!canAccessUser(req, user_id)) return sendError(res, 403, "Forbidden: Cannot inspect another user's shift.");
            const [rows] = await pool.query("SELECT * FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [user_id]);
            const shift = rows.length > 0 ? rows[0] : null;
            let previousShiftClosingCash = null;
            let suggestedStartingCash = null;

            if (!shift && canOpenShift(req.user)) {
                const range = getBusinessDayRange(getBusinessDate());
                const [[drawerContext]] = await pool.query(`
                    SELECT
                      (
                        SELECT s.actual_cash
                        FROM shifts s
                        WHERE s.status = 'closed'
                          AND s.actual_cash IS NOT NULL
                          AND s.closed_at >= ?
                          AND s.closed_at < ?
                          AND NOT EXISTS (SELECT 1 FROM shifts active WHERE active.status = 'open')
                        ORDER BY s.closed_at DESC, s.id DESC
                        LIMIT 1
                      ) AS previous_shift_closing_cash,
                      EXISTS (
                        SELECT 1
                        FROM shifts closed_shift
                        WHERE closed_shift.status = 'closed'
                          AND closed_shift.closed_at >= ?
                          AND closed_shift.closed_at < ?
                      ) AS has_closed_shift,
                      (
                        SELECT setting_value
                        FROM settings
                        WHERE setting_key = 'first_shift_starting_cash'
                        LIMIT 1
                      ) AS configured_starting_cash
                `, [range.start, range.end, range.start, range.end]);
                if (drawerContext?.previous_shift_closing_cash !== null && drawerContext?.previous_shift_closing_cash !== undefined) {
                    previousShiftClosingCash = Number(drawerContext.previous_shift_closing_cash);
                }
                if (previousShiftClosingCash !== null) suggestedStartingCash = previousShiftClosingCash;
                if (Number(drawerContext?.has_closed_shift || 0) === 0) {
                    const configured = validateCashAmount(drawerContext?.configured_starting_cash ?? 0);
                    suggestedStartingCash = configured.valid ? configured.value : 0;
                }
            }

            res.set('Cache-Control', 'no-store');
            return sendSuccess(res, {
                shift,
                previous_shift_closing_cash: previousShiftClosingCash,
                suggested_starting_cash: suggestedStartingCash,
            });
        }
        else if (method === 'GET' && action === 'history') {
            if (!isAdminUser(req.user)) return sendError(res, 403, "Forbidden: Admin privileges required.");
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
            const offset = (page - 1) * limit;
            const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM shifts s JOIN users u ON s.user_id = u.id");
            const [rows] = await pool.query("SELECT s.*, u.name as cashier_name FROM shifts s JOIN users u ON s.user_id = u.id ORDER BY s.id DESC LIMIT ? OFFSET ?", [limit, offset]);
            return sendSuccess(res, { shifts: rows, pagination: { total: Number(total), page, limit, total_pages: Math.max(1, Math.ceil(total / limit)) } });
        }
        else if (method === 'GET' && action === 'zreport') {
            const { shift_id } = req.query;
            if (!parseInt(shift_id, 10)) {
                return sendError(res, 400, "A valid shift id is required.");
            }
            const access = await canAccessShift(req, shift_id);
            if (!access.allowed) return sendError(res, access.status, access.message);

            const [shifts] = await pool.query("SELECT * FROM shifts WHERE id = ?", [shift_id]);
            const shift = shifts[0];

            const [totals] = await pool.query(`SELECT
                SUM(o.total) as gross_total,
                SUM(COALESCE(o.cash_amount, 0)) as gross_cash,
                SUM(COALESCE(o.card_amount, 0)) as gross_card,
                SUM(CASE WHEN o.payment_method = 'platform' THEN o.total ELSE 0 END) as gross_platform
                FROM orders o
                WHERE o.shift_id = ? AND o.payment_method NOT IN ('unpaid_table', 'voided')`, [shift_id]);
            const totalData = totals[0];
            const discountMap = await getShiftDiscountsByShift(pool, [shift_id]);
            const shiftDiscounts = discountMap[shift_id] || { total_discounts: 0 };

            // Net refunds scoped to refunds.shift_id so cross-shift refunds hit the correct drawer.
            const refMap = await getRefundsByShift(pool, [shift_id]);
            const shiftRef = refMap[shift_id] || { amt: 0, cash: 0, card: 0, platform: 0 };

            const gross_sales = parseFloat(totalData?.gross_total || 0) - shiftRef.amt;
            const cash_sales  = parseFloat(totalData?.gross_cash  || 0) - shiftRef.cash;
            const card_sales  = parseFloat(totalData?.gross_card  || 0) - shiftRef.card;
            const platform_sales = parseFloat(totalData?.gross_platform || 0) - shiftRef.platform;
            const expenseMap = await getCashExpensesByShift(pool, [Number(shift_id)]);
            const expenseCategoryMap = await getCashExpenseCategoriesByShift(pool, [Number(shift_id)]);
            const cash_expenses = expenseMap[Number(shift_id)] || 0;
            const expected_cash = parseFloat(shift.starting_cash || 0) + cash_sales - cash_expenses;

            const [order_type_breakdown] = await pool.query(`
                SELECT COALESCE(ot.name, 'Standard') as order_type_name, SUM(${NET_TOTAL}) as total_sales
                FROM orders o
                LEFT JOIN order_types ot ON o.order_type_id = ot.id
                ${REFUNDS_ROLLUP_JOIN}
                WHERE o.shift_id = ? AND o.payment_method NOT IN ('unpaid_table', 'voided')
                GROUP BY o.order_type_id
            `, [shift_id]);

            return sendSuccess(res, {
                data: {
                    shift_id: shift_id,
                    opened_at: shift.opened_at,
                    closed_at: shift.closed_at,
                    starting_cash: parseFloat(shift.starting_cash || 0),
                    cash_sales: cash_sales,
                    cash_expenses: cash_expenses,
                    expense_categories: expenseCategoryMap[Number(shift_id)] || [],
                    card_sales: card_sales,
                    platform_sales: platform_sales,
                    gross_sales: gross_sales,
                    total_discounts: parseFloat(shiftDiscounts.total_discounts || 0),
                    expected_cash: expected_cash,
                    actual_cash: shift.status === 'open' ? null : parseFloat(shift.actual_cash || 0),
                    order_type_breakdown: order_type_breakdown
                }
            });
        }
        else if (method === 'POST' && action === 'open') {
            const { user_id, starting_cash } = req.body;
            if (!canAccessUser(req, user_id)) return sendError(res, 403, "Forbidden: Cannot open another user's shift.");

            if (!canOpenShift(req.user)) {
                return sendError(res, 403, "Forbidden: You are not authorized to open a register shift.");
            }

            const cash = validateCashAmount(starting_cash);
            if (!cash.valid) {
                return sendError(res, 400, cash.message);
            }

            // Acquire a dedicated connection so we can lock the check and insert atomically.
            // Without this, two concurrent shift-open requests for the same user could both
            // pass the duplicate check before either INSERT commits.
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const [targets] = await conn.query(
                    'SELECT id, role, is_active FROM users WHERE id=? FOR UPDATE',
                    [user_id]
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
                    [user_id]
                );
                if (check.length > 0) {
                    await conn.rollback();
                    return sendError(res, 400, "User already has an open shift.");
                }
                const [insertResult] = await conn.query(
                    "INSERT INTO shifts (user_id, starting_cash) VALUES (?, ?)",
                    [user_id, cash.value]
                );
                await conn.commit();
                invalidateDashboardCache();
                setTokenShiftId(user_id, insertResult.insertId);
                if (req.io) req.io.to('staff').emit('shifts_changed', { shift_id: insertResult.insertId, action: 'open' });
                return sendSuccess(res, { message: "Shift Opened.", shift_id: insertResult.insertId });
            } catch (err) {
                await conn.rollback();
                throw err;
            } finally {
                conn.release();
            }
        }
        else if (method === 'PUT' && action === 'close') {
            const { actual_cash, shift_id } = req.body;
            if (!parseInt(shift_id, 10)) {
                return sendError(res, 400, "A valid shift id is required.");
            }
            const access = await canAccessShift(req, shift_id);
            if (!access.allowed) return sendError(res, access.status, access.message);

            if (!canCloseShift(req.user)) {
                return sendError(res, 403, "Forbidden: You are not authorized to close shifts.");
            }

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

                // Fraud guard: block shift close when the cashier still has open unpaid table orders.
                // A cashier cannot walk away from active tables and close their shift silently.
                const [openTables] = await conn.query(`
                    SELECT rt.id, rt.table_number
                    FROM restaurant_tables rt
                    JOIN orders o ON rt.current_order_id = o.invoice_id
                    WHERE o.user_id = ? AND o.payment_method = 'unpaid_table'
                      AND rt.status IN ('occupied', 'printed')
                `, [shifts[0].user_id]);

                if (openTables.length > 0) {
                    await conn.rollback();
                    return sendError(res, 409,
                        `Cannot close shift: ${openTables.length} open table order(s) remain ` +
                        `(Tables: ${openTables.map(t => t.table_number).join(', ')}). ` +
                        `Please finalise or transfer all open tables before closing.`
                    );
                }

                const startingCash = parseFloat(shifts[0].starting_cash || 0);

                // Compute expected cash: gross cash from orders minus cash refunds issued IN this shift.
                // Refunds scoped to refunds.shift_id — cross-shift refunds hit the correct drawer.
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
                    "UPDATE shifts SET status = 'closed', closed_at = CURRENT_TIMESTAMP, expected_cash = ?, actual_cash = ? WHERE id = ?",
                    [computedExpectedCash, cash.value, shift_id]
                );

                // Revoke every durable session for the user of this shift in the same transaction.
                await revokeDurableUserSessions(shifts[0].user_id, 'shift_closed', conn);

                await conn.commit();
                invalidateDashboardCache();
                invalidateShiftTokens(shift_id);
                if (req.io) req.io.to('staff').emit('shifts_changed', { shift_id, action: 'close' });
                // Immediately evict all session cache entries for this user
                invalidateUserSessions(shifts[0].user_id);
                if (req.io) req.io.to(`user:${shifts[0].user_id}`).disconnectSockets(true);
                // If the caller is closing their OWN shift, also clear the session cookie on
                // this response so the browser doesn't hold a now-invalid token.
                if (req.user?.id === shifts[0].user_id) {
                    clearSessionCookie(res, req);
                }
                // The close just revoked this session, so the terminal cannot send the
                // Z report afterwards: queue it here from the committed shift.
                let zReportPrintQueued;
                if (req.body.print_z_report === true) {
                    try {
                        await printRouter.queueShiftReportPrint({ shiftId: shift_id, user: req.user, printerId: req.body.receipt_printer_id });
                        zReportPrintQueued = true;
                    } catch (error) {
                        logger.warn({ err: error, shiftId: shift_id }, 'Shift closed, but its Z report could not be queued.');
                        zReportPrintQueued = false;
                    }
                }
                return sendSuccess(res, {
                    message: "Shift Closed.",
                    expected_cash: computedExpectedCash,
                    ...(zReportPrintQueued === undefined ? {} : { z_report_print_queued: zReportPrintQueued }),
                });
            } catch (err) {
                await conn.rollback();
                throw err;
            } finally {
                conn.release();
            }
        }
        else if (method === 'PUT' && action === 'update_cash') {
            if (!isAdminUser(req.user)) return sendError(res, 403, "Forbidden: Admin privileges required.");

            const { shift_id, starting_cash, actual_cash } = req.body;
            const parsedShiftId = parseInt(shift_id, 10);
            if (!parsedShiftId) {
                return sendError(res, 400, "A valid shift id is required.");
            }
            const hasStarting = starting_cash !== undefined;
            const hasActual = actual_cash !== undefined;
            if (!hasStarting && !hasActual) {
                return sendError(res, 400, "starting_cash or actual_cash is required.");
            }

            let roundedStart = null;
            let roundedActual = null;
            if (hasStarting) {
                const cash = validateCashAmount(starting_cash);
                if (!cash.valid) return sendError(res, 400, cash.message);
                roundedStart = Math.round(cash.value * 100) / 100;
            }
            if (hasActual) {
                const cash = validateCashAmount(actual_cash);
                if (!cash.valid) return sendError(res, 400, cash.message);
                roundedActual = Math.round(cash.value * 100) / 100;
            }

            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();

                const [rows] = await conn.query(
                    "SELECT status, starting_cash, expected_cash, actual_cash FROM shifts WHERE id = ? FOR UPDATE",
                    [parsedShiftId]
                );
                if (rows.length === 0) {
                    await conn.rollback();
                    return sendError(res, 404, "Shift not found.");
                }

                const shift = rows[0];
                const isClosed = shift.status === 'closed';
                if (!isClosed && hasActual) {
                    await conn.rollback();
                    return sendError(res, 400, "Actual cash can only be corrected on a closed shift.");
                }

                const oldStart = Number(shift.starting_cash || 0);
                const oldExpected = Number(shift.expected_cash || 0);
                const oldActual = Number(shift.actual_cash || 0);
                const d = hasStarting ? (Math.round(roundedStart * 100) - Math.round(oldStart * 100)) / 100 : 0;
                const newExpected = Math.round((oldExpected + d) * 100) / 100;

                if (isClosed) {
                    await conn.query(
                        "UPDATE shifts SET starting_cash = COALESCE(?, starting_cash), expected_cash = ROUND(expected_cash + ?, 2), actual_cash = COALESCE(?, actual_cash) WHERE id = ?",
                        [hasStarting ? roundedStart : null, d, hasActual ? roundedActual : null, parsedShiftId]
                    );
                } else {
                    await conn.query(
                        "UPDATE shifts SET starting_cash = ? WHERE id = ?",
                        [roundedStart, parsedShiftId]
                    );
                }

                const oldValue = {};
                const newValue = {};
                if (hasStarting && Math.round(roundedStart * 100) !== Math.round(oldStart * 100)) {
                    oldValue.starting_cash = oldStart;
                    newValue.starting_cash = roundedStart;
                    if (isClosed) {
                        oldValue.expected_cash = oldExpected;
                        newValue.expected_cash = newExpected;
                    }
                }
                if (hasActual && Math.round(roundedActual * 100) !== Math.round(oldActual * 100)) {
                    oldValue.actual_cash = oldActual;
                    newValue.actual_cash = roundedActual;
                }
                if (Object.keys(oldValue).length > 0) {
                    await appendAuditEvent(conn, {
                        eventType: 'shift_cash_edited',
                        userId: req.user.id,
                        entityType: 'shift',
                        entityId: parsedShiftId,
                        oldValue,
                        newValue,
                        ipAddress: req.ip || null
                    });
                }

                await conn.commit();
                invalidateDashboardCache();
                if (req.io) req.io.to('staff').emit('shifts_changed', { shift_id: parsedShiftId, action: 'edit' });
                return sendSuccess(res, { message: "Shift cash updated." });
            } catch (txErr) {
                await conn.rollback();
                throw txErr;
            } finally {
                conn.release();
            }
        }
        else {
            sendError(res, 404, "Invalid shift action.");
        }
    } catch (e) {
        logger.error({ err: e }, 'Shift operation failed');
        sendError(res, 500, "Shift operation failed. Please try again.");
    }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
    try {
        // Cookie-only logout: invalidate the httpOnly browser session token.
        const cookies = (req.headers['cookie'] || '').split(';').reduce((m, p) => { const i = p.indexOf('='); if (i > 0) m[p.substring(0,i).trim()] = p.substring(i+1).trim(); return m; }, {});
        const rawToken = cookies['pos_token'] || null;

        if (rawToken) {
            const session = await findActiveSession(rawToken);
            await revokeDurableSessionByToken(rawToken, 'logout');
            invalidateToken(rawToken);
            if (session && req.io) req.io.to(`session:${session.session_id}`).disconnectSockets(true);
        }

        clearSessionCookie(res, req);
        return sendSuccess(res, { message: "Logged out successfully." });
    } catch (e) {
        logger.error({
            err: e,
            route: req.originalUrl,
            method: req.method
        }, 'Logout failed.');
        return sendError(res, 500, "Logout failed. Please try again.");
    }
});

// ALL /api/auth/permissions
router.all('/permissions', requireAuth, requireAdmin, async (req, res) => {
    return sendError(res, 410, "Deprecated: use GET /api/admin/permissions or POST/PUT /api/admin/users to manage permissions.");
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
    try {
        const { password_hash, admin_pin, ...safeUser } = req.user;
        return sendSuccess(res, { user: safeUser });
    } catch (e) {
        logger.error({ err: e }, 'me endpoint failed');
        return sendError(res, 500, "Failed to retrieve user session.");
    }
});

module.exports = router;
