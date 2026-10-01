const { orderDisplayNoSql, formatOrderNumber } = require('../utils/orderNumber');
const { commitAndPublishSpoolerSyncWake } = require('../services/spoolerSyncWake');
const {prepareHeldCustomerReceipt} = require('../services/HeldOrderReceipt');
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const logger = require('../config/logger');
const { requireAuth, rejectCallCenterRole } = require('../middleware/auth');
const { userHas, PERMISSIONS, isAdminRole } = require('../services/PermissionService');
const { roundMoney, calculateExpectedTotals, exemptUnitPrice } = require('../services/PosCalculator');
const { enqueuePrintJobs, enqueueCommittedPrintJobs, resolveReceiptPrinter, dispatchReceiptPrint } = require('../services/printDispatch');
const { buildKitchenPrintPayloads, expandBundlesForKitchen } = require('../services/kitchenPrintRouting');
const { buildShiftReportPayload } = require('../services/shiftReportPayload');
const { buildOrderIdentity } = require('../utils/orderIdentity');
const { normalizeKitchenTicketItems } = require('../services/kitchenTicketItems');
const { userCanAccessOrderForPrint } = require('../services/PermissionService');
const { assertTableReadAccess } = require('../services/TableSettlementContext');
const { sanitizePrintString } = require('../services/printText');
const { getPrintStoreInfo } = require('../services/printStoreInfo');
const { getSettings } = require('../config/settingsHelper');
const { getBusinessDate } = require('../utils/businessDate');
const { CHECKOUT_PRINT_GRACE_MS } = require('../services/printJobIdentity');
const {
    buildOrderPresentationForRead,
    buildOrderPresentation,
    buildHeldPresentations
} = require('../services/ReceiptPresentationSources');
const { BUNDLE_ORDER_CORRUPT } = require('../services/bundleIntegrity');

function sanitizeStoreInfo(storeInfo) {
    if (!storeInfo || typeof storeInfo !== 'object') return storeInfo;
    return Object.fromEntries(
        Object.entries(storeInfo).map(([key, value]) => [key, sanitizePrintString(value, 500)])
    );
}

function sanitizePrintItem(item) {
    if (!item || typeof item !== 'object') return item;
    const cleaned = { ...item };
    for (const key of ['name', 'product_name', 'note', '_bundleLabel']) {
        if (key in cleaned) cleaned[key] = sanitizePrintString(cleaned[key], key === 'note' ? 500 : 200);
    }
    return cleaned;
}

function sanitizeReportRows(rows, fields, maxLength = 200) {
    if (!Array.isArray(rows)) return rows;
    return rows.map(row => {
        if (!row || typeof row !== 'object') return row;
        const cleaned = { ...row };
        for (const field of fields) {
            if (field in cleaned) cleaned[field] = sanitizePrintString(cleaned[field], maxLength);
        }
        return cleaned;
    });
}

function sanitizeCategories(cats) {
    if (!Array.isArray(cats)) return cats;
    return cats.map(cat => {
        if (!cat || typeof cat !== 'object') return cat;
        const cleaned = { ...cat };
        if ('name' in cleaned) cleaned.name = sanitizePrintString(cleaned.name, 200);
        if (Array.isArray(cleaned.subcategories)) {
            cleaned.subcategories = sanitizeCategories(cleaned.subcategories);
        }
        return cleaned;
    });
}

const REPORT_FINANCIAL_FIELDS = new Set([
    'sales_collected', 'sales_processed', 'refunds_issued', 'net_revenue_pre_tax',
    'tax_collected', 'service_charges_collected', 'cash_collected', 'card_collected',
    'total_orders', 'average_ticket', 'discounts_total', 'discounted_orders',
    'refund_count', 'refund_total', 'refund_rate', 'refund_cash', 'refund_card',
    'refund_platform', 'platform_sales',
    'void_count', 'void_value', 'expected_cash', 'actual_cash', 'variance',
    'cash_expenses_total', 'open_shifts', 'closed_shifts', 'closed_outside_window',
    'uncounted_shifts', 'shifts_needing_review', 'net_variance', 'net_variance_total',
    'shortage_total', 'overage_total',
    'amount', 'orders', 'sold_qty', 'returned_qty', 'sold_amount', 'returned_amount',
    'net_sales', 'refund_value', 'event_value', 'value', 'quantity', 'unit_price',
    'line_subtotal', 'line_tax', 'line_total', 'total', 'drawer', 'outside',
    'count', 'expenses_total', 'expense_count', 'drawer_expenses_total',
    'outside_expenses_total', 'remaining_after_expenses', 'refund_order_count',
    'refund_item_count', 'void_order_count', 'void_item_count',
    'positive_allocations', 'provider_credits_applied', 'invoice_allocations',
    'deductions', 'additions', 'net_received', 'computed_net',
    'unreconciled_difference', 'settlement_count', 'reversal_count',
    'commission', 'service_fee', 'marketing_fee', 'penalty', 'withholding_tax',
    'reimbursement', 'incentive', 'correction', 'other'
]);
const NULLABLE_REPORT_FINANCIAL_FIELDS = new Set([
    'refund_rate', 'expected_cash', 'actual_cash', 'variance',
    'net_variance', 'net_variance_total', 'shortage_total', 'overage_total',
]);

function invalidReportPayload(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function assertFiniteReportNumbers(value, path = 'report') {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (REPORT_FINANCIAL_FIELDS.has(key)) {
            const nullable = child === null && NULLABLE_REPORT_FINANCIAL_FIELDS.has(key);
            if (!nullable && (typeof child !== 'number' || !Number.isFinite(child))) {
                throw invalidReportPayload(`${childPath} must be a finite number.`);
            }
        }
        if (typeof child === 'object') assertFiniteReportNumbers(child, childPath);
    }
}

function isValidDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day;
}

function addUtcDateDays(dateString, days) {
    const [year, month, day] = dateString.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function sanitizeDailyReportsData(cleaned) {
    assertFiniteReportNumbers(cleaned);
    const sourcePeriod = cleaned.period;
    if (!sourcePeriod || typeof sourcePeriod !== 'object') {
        throw invalidReportPayload('Report period is required.');
    }
    const startDate = String(sourcePeriod.start_date || '');
    const endDate = String(sourcePeriod.end_date || '');
    if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate) || endDate < startDate) {
        throw invalidReportPayload('Report period contains invalid dates.');
    }
    const startHour = Number(sourcePeriod.business_day_start_hour);
    if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
        throw invalidReportPayload('Report period contains an invalid business day start hour.');
    }
    const endHour = (startHour + 23) % 24;
    cleaned.period = {
        ...sourcePeriod,
        start_date: startDate,
        end_date: endDate,
        window_label: `${startDate} ${String(startHour).padStart(2, '0')}:00 → ${addUtcDateDays(endDate, 1)} ${String(endHour).padStart(2, '0')}:59`
    };
    cleaned.report_id = `${cleaned.print_type}:${startDate}:${endDate}`;
    
    // Normalize language & direction
    let lang = 'en';
    if (cleaned.language === 'ar') lang = 'ar';
    cleaned.language = lang;
    cleaned.direction = lang === 'ar' ? 'rtl' : 'ltr';

    if (Array.isArray(cleaned.payments)) {
        const allowedPaymentKeys = new Set([
            'cash',
            'card',
            'platform'
        ]);
        cleaned.payments = cleaned.payments.map(payment => {
            if (!payment || typeof payment !== 'object' || !allowedPaymentKeys.has(payment.key)) {
                throw invalidReportPayload('Unknown report payment key.');
            }
            return { ...payment, key: payment.key };
        });
    }

    if (cleaned.platform_reconciliation && typeof cleaned.platform_reconciliation === 'object') {
        const reconciliation = { ...cleaned.platform_reconciliation };
        const reconciliationDates = ['start_date', 'end_date'];
        for (const key of reconciliationDates) {
            if (key in reconciliation && !isValidDateOnly(String(reconciliation[key]))) {
                throw invalidReportPayload('Platform reconciliation contains an invalid date.');
            }
        }
        if ('start_date' in reconciliation && 'end_date' in reconciliation && reconciliation.end_date < reconciliation.start_date) {
            throw invalidReportPayload('Platform reconciliation dates are out of order.');
        }
        const categoryFields = ['adjustments_by_category', 'deductions_by_category', 'additions_by_category'];
        for (const field of categoryFields) {
            if (reconciliation[field] === undefined) continue;
            if (!reconciliation[field] || typeof reconciliation[field] !== 'object' || Array.isArray(reconciliation[field])) {
                throw invalidReportPayload('Platform reconciliation category totals are invalid.');
            }
            const allowedCategories = [
                'commission', 'service_fee', 'marketing_fee', 'penalty', 'withholding_tax',
                'reimbursement', 'incentive', 'correction', 'other'
            ];
            const unknownCategory = Object.keys(reconciliation[field])
                .find(key => !allowedCategories.includes(key));
            if (unknownCategory) throw invalidReportPayload('Unknown platform reconciliation category.');
            reconciliation[field] = Object.fromEntries(
                allowedCategories.map(key => {
                    const value = reconciliation[field][key] ?? 0;
                    if (typeof value !== 'number' || !Number.isFinite(value)) {
                        throw invalidReportPayload(`platform_reconciliation.${field}.${key} must be a finite number.`);
                    }
                    return [key, value];
                })
            );
        }
        cleaned.platform_reconciliation = reconciliation;
    }

    if (cleaned.cash_status && typeof cleaned.cash_status === 'object') {
        const cs = { ...cleaned.cash_status };
        if ('state' in cs && !['in_progress', 'balanced', 'review', 'no_shifts'].includes(cs.state)) {
            throw invalidReportPayload('Unknown report cash state.');
        }
        cleaned.cash_status = cs;
    }

    if (Array.isArray(cleaned.categories)) {
        cleaned.categories = sanitizeCategories(cleaned.categories);
    }

    if (Array.isArray(cleaned.products)) {
        cleaned.products = cleaned.products.map(p => {
            if (!p || typeof p !== 'object') return p;
            const cp = { ...p };
            if ('item_name' in cp) cp.item_name = sanitizePrintString(cp.item_name, 200);
            if ('category_path' in cp) cp.category_path = sanitizePrintString(cp.category_path, 300);
            for (const key of ['sold_qty', 'returned_qty', 'sold_amount', 'returned_amount', 'net_sales']) {
                if (key in cp && (typeof cp[key] !== 'number' || !Number.isFinite(cp[key]))) {
                    cp[key] = 0;
                }
            }
            return cp;
        });
    }

    if (Array.isArray(cleaned.order_types)) {
        cleaned.order_types = cleaned.order_types.map(ot => {
            if (!ot || typeof ot !== 'object') return ot;
            const cot = { ...ot };
            if ('name' in cot) cot.name = sanitizePrintString(cot.name, 200);
            for (const key of ['orders', 'net_sales']) {
                if (key in cot && (typeof cot[key] !== 'number' || !Number.isFinite(cot[key]))) {
                    cot[key] = 0;
                }
            }
            return cot;
        });
    }

    if (Array.isArray(cleaned.cashiers)) {
        cleaned.cashiers = cleaned.cashiers.map(c => {
            if (!c || typeof c !== 'object') return c;
            const cc = { ...c };
            if ('name' in cc) cc.name = sanitizePrintString(cc.name, 200);
            for (const key of ['orders', 'net_sales']) {
                if (key in cc && (typeof cc[key] !== 'number' || !Number.isFinite(cc[key]))) {
                    cc[key] = 0;
                }
            }
            return cc;
        });
    }

    if (Array.isArray(cleaned.waiters)) {
        cleaned.waiters = cleaned.waiters.map(w => {
            if (!w || typeof w !== 'object') return w;
            const cw = { ...w };
            if ('name' in cw) cw.name = sanitizePrintString(cw.name, 200);
            for (const key of ['orders', 'net_sales']) {
                if (key in cw && (typeof cw[key] !== 'number' || !Number.isFinite(cw[key]))) {
                    cw[key] = 0;
                }
            }
            return cw;
        });
    }

    if (Array.isArray(cleaned.tables)) {
        cleaned.tables = cleaned.tables.map(t => {
            if (!t || typeof t !== 'object') return t;
            const ct = { ...t };
            if ('table_number' in ct) ct.table_number = sanitizePrintString(ct.table_number, 50);
            if ('section_name' in ct) ct.section_name = sanitizePrintString(ct.section_name, 200);
            for (const key of ['orders', 'net_sales']) {
                if (key in ct && (typeof ct[key] !== 'number' || !Number.isFinite(ct[key]))) {
                    ct[key] = 0;
                }
            }
            return ct;
        });
    }

    if (Array.isArray(cleaned.by_staff)) {
        cleaned.by_staff = cleaned.by_staff.map(s => {
            if (!s || typeof s !== 'object') return s;
            const cs = { ...s };
            if ('name' in cs) cs.name = sanitizePrintString(cs.name, 200);
            for (const key of ['refund_value', 'refund_count', 'void_value', 'void_count']) {
                if (key in cs && (typeof cs[key] !== 'number' || !Number.isFinite(cs[key]))) {
                    cs[key] = 0;
                }
            }
            return cs;
        });
    }

    if (Array.isArray(cleaned.top_reasons)) {
        cleaned.top_reasons = cleaned.top_reasons.map(r => {
            if (!r || typeof r !== 'object') return r;
            const cr = { ...r };
            if ('reason' in cr) cr.reason = sanitizePrintString(cr.reason, 200);
            for (const key of ['count', 'value']) {
                if (key in cr && (typeof cr[key] !== 'number' || !Number.isFinite(cr[key]))) {
                    cr[key] = 0;
                }
            }
            return cr;
        });
    }

    if (Array.isArray(cleaned.events)) {
        cleaned.events = cleaned.events.map(ev => {
            if (!ev || typeof ev !== 'object') return ev;
            const cev = { ...ev };
            if ('cashier_name' in cev) cev.cashier_name = sanitizePrintString(cev.cashier_name, 200);
            if ('reason' in cev) cev.reason = sanitizePrintString(cev.reason, 300);
            if ('invoice_display_no' in cev) cev.invoice_display_no = sanitizePrintString(cev.invoice_display_no, 50);
            if ('occurred_at_local' in cev) cev.occurred_at_local = sanitizePrintString(cev.occurred_at_local, 100);
            if ('kind' in cev && !['refund', 'void'].includes(cev.kind)) {
                throw invalidReportPayload('Unknown report event kind.');
            }
            if (cev.refund_method != null && !['cash', 'card', 'split'].includes(cev.refund_method)) {
                throw invalidReportPayload('Unknown report refund method.');
            }
            for (const key of ['event_value']) {
                if (key in cev && (typeof cev[key] !== 'number' || !Number.isFinite(cev[key]))) {
                    cev[key] = 0;
                }
            }
            if (Array.isArray(cev.items)) {
                cev.items = cev.items.map(item => {
                    if (!item || typeof item !== 'object') return item;
                    const citem = { ...item };
                    if ('item_name' in citem) citem.item_name = sanitizePrintString(citem.item_name, 200);
                    if ('note' in citem) citem.note = sanitizePrintString(citem.note, 500);
                    for (const key of ['quantity', 'unit_price', 'line_total']) {
                        if (key in citem && (typeof citem[key] !== 'number' || !Number.isFinite(citem[key]))) {
                            citem[key] = 0;
                        }
                    }
                    return citem;
                });
            }
            return cev;
        });
    }

    if (Array.isArray(cleaned.by_category)) {
        cleaned.by_category = sanitizeReportRows(cleaned.by_category, ['category_name']);
    }
    if (Array.isArray(cleaned.by_source)) {
        cleaned.by_source = cleaned.by_source.map(row => {
            if (!row || typeof row !== 'object' || !['drawer', 'outside'].includes(row.source)) {
                throw invalidReportPayload('Unknown expense source.');
            }
            return { ...row };
        });
    }
    if (Array.isArray(cleaned.entries)) {
        cleaned.entries = cleaned.entries.map(row => {
            if (!row || typeof row !== 'object') return row;
            if (!['drawer', 'outside'].includes(row.source)) throw invalidReportPayload('Unknown expense source.');
            if (!['active', 'canceled'].includes(row.status)) throw invalidReportPayload('Unknown expense state.');
            return {
                ...row,
                category_name: sanitizePrintString(row.category_name, 120),
                note: sanitizePrintString(row.note, 255),
                created_by_name: sanitizePrintString(row.created_by_name, 200),
                canceled_by_name: sanitizePrintString(row.canceled_by_name, 200),
                created_at: sanitizePrintString(row.created_at, 100),
                canceled_at: sanitizePrintString(row.canceled_at, 100),
            };
        });
    }
}

function sanitizePrintData(data) {
    if (!data || typeof data !== 'object') return data;
    const cleaned = { ...data };
    if (['daily_summary_report', 'daily_sales_report', 'daily_refunds_report', 'daily_expenses_report'].includes(cleaned.print_type)) {
        sanitizeDailyReportsData(cleaned);
        return cleaned;
    }
    for (const key of [
        'cashier', 'cashier_name', 'order_type_name', 'table_number',
        'customer_name', 'customer_phone', 'customer_address', 'hash_number',
        'category_name', 'created_by_name', 'canceled_by_name', 'note'
    ]) {
        if (key in cleaned) cleaned[key] = sanitizePrintString(cleaned[key], 200);
    }
    for (const key of ['date', 'order_taken_at', 'delivery_date']) {
        if (key in cleaned) cleaned[key] = sanitizePrintString(cleaned[key] instanceof Date ? cleaned[key].toISOString() : cleaned[key], 100);
    }
    if (cleaned.storeInfo) cleaned.storeInfo = sanitizeStoreInfo(cleaned.storeInfo);
    if (Array.isArray(cleaned.items)) cleaned.items = cleaned.items.map(sanitizePrintItem);
    for (const key of ['order_type_breakdown', 'platform_order_type_breakdown']) {
        if (!Array.isArray(cleaned[key])) continue;
        cleaned[key] = cleaned[key].map(row => ({
            ...row,
            order_type_name: sanitizePrintString(row.order_type_name, 200)
        }));
    }
    cleaned.products = sanitizeReportRows(cleaned.products, ['item_name', 'category_name']);
    cleaned.categories = sanitizeReportRows(cleaned.categories, ['category_name']);
    cleaned.expense_categories = sanitizeReportRows(cleaned.expense_categories, ['category_name']);
    cleaned.tables = sanitizeReportRows(cleaned.tables, ['table_number', 'section_name']);
    cleaned.cashiers = sanitizeReportRows(cleaned.cashiers, ['staff_name', 'staff_role']);
    cleaned.waiters = sanitizeReportRows(cleaned.waiters, ['staff_name', 'staff_role']);
    cleaned.invoices = sanitizeReportRows(cleaned.invoices, [
        'invoice_display_no',
        'ticket_display_no',
        'order_display_no',
        'order_type_name',
        'payment_method',
        'cashier_name',
        'waiter_name',
        'table_number'
    ]);
    cleaned.shifts = sanitizeReportRows(cleaned.shifts, ['cashier_name', 'status']);
    return cleaned;
}

// A checkout's own receipt: the primary copy, or the duplicate copy while duplicate
// receipts are on, on the sale's business day. Its print id is deduplicated for that
// day (the queue purge keeps the current day's rows), so it can yield only one paper.
// A print still in flight across the day cutoff gets a short grace; its job row is
// created after the cutoff, and the purge keeps rows younger than the grace.
async function isFirstCheckoutPrint(order, requestedPrintId) {
    const soldAt = new Date(order.invoice_issued_at || order.created_at);
    const sameDay = getBusinessDate(soldAt) === getBusinessDate();
    if (!requestedPrintId || !(sameDay || Date.now() - soldAt.getTime() <= CHECKOUT_PRINT_GRACE_MS)) return false;
    if (requestedPrintId === `checkout-receipt:${order.invoice_id}:primary`) return true;
    if (requestedPrintId !== `checkout-receipt:${order.invoice_id}:duplicate`) return false;
    const { duplicate_customer_receipt: duplicate } = await getSettings(pool, ['duplicate_customer_receipt']);
    return duplicate === '1';
}

router.post('/print', requireAuth, rejectCallCenterRole, async (req, res) => {
    let data = req.body;
    if (!data || Object.keys(data).length === 0) {
        return res.status(400).json({ success: false, message: "Request body is empty or invalid." });
    }
    // Only the authoritative held-receipt builder may enable this layout.
    data = { ...data, held_order_receipt: false, held_order: false };
    const requestedPrintId = data.print_request_id;
    if (requestedPrintId !== undefined &&
        (typeof requestedPrintId !== 'string' || !/^[A-Za-z0-9:_-]{1,80}$/.test(requestedPrintId))) {
        return res.status(400).json({ success: false, message: 'Invalid print request id.' });
    }

    try {
        const storeInfo = await getPrintStoreInfo(pool);
        data.storeInfo = storeInfo;

        // 1 & 2. Route Receipts, Z-Reports, X-Reports, and Daily Reports
        if (['receipt', 'z_report', 'zreport', 'x_report', 'daily_summary_report', 'daily_sales_report', 'daily_refunds_report', 'daily_expenses_report', 'expense_slip', 'expense_cancel_slip'].includes(data.print_type)) {
            const printer_id = data.receipt_printer_id || null;
            const printerConfig = await resolveReceiptPrinter({ printerId: printer_id });

            if (!printerConfig) {
                return res.json({ success: false, message: "No receipt printer found." });
            }

            // Secure Receipts: If invoice_id is numeric, load from DB to prevent tampering
            if (data.print_type === 'receipt') {
                if (data.payment_method === 'held') {
                    const heldId = parseInt(data.invoice_id, 10);
                    if (isNaN(heldId)) {
                        return res.status(400).json({ success: false, message: "A valid held check id is required to print this receipt." });
                    }
                    if (!isNaN(heldId)) {
                        const [heldRows] = await pool.query(`
                            SELECT h.*, u.name as cashier_name 
                            FROM held_orders h
                            LEFT JOIN users u ON h.user_id = u.id
                            WHERE h.id = ?
                        `, [heldId]);
                        
                        if (heldRows.length === 0) {
                            return res.status(404).json({ success: false, message: "Split check not found." });
                        }
                        const held = heldRows[0];
                        const split = held.parent_invoice_id != null || held.table_id != null;
                        if (split) await assertTableReadAccess(pool, req.user, { tableId: held.table_id, invoiceId: held.parent_invoice_id });
                        const [presResult] = await buildHeldPresentations(pool, [held], { split });
                        if (presResult.error) {
                            throw presResult.error;
                        }
                        const receipt_display_v1 = presResult.presentation;

                        let parsedData = {};
                        let items = [];
                        let parentInvoiceId = null;
                        let parentOrderId = null;
                        try {
                            parsedData = JSON.parse(held.cart_data || '{}');
                            if (Array.isArray(parsedData)) {
                                items = parsedData;
                            } else {
                                items = parsedData.items || [];
                                parentInvoiceId = parsedData.parent_invoice_id || null;
                                parentOrderId = parsedData.parent_order_id || null;
                            }
                        } catch (e) {
                            items = [];
                        }

                        // Auth check for split/held checks
                        const isAdmin = isAdminRole(req.user);
                        const isCreator = held.user_id === req.user.id;
                        const hasReprintPerm = userHas(req.user, PERMISSIONS.POS_REPRINT_RECEIPT);
                        let hasAccess = isAdmin || isCreator || hasReprintPerm;

                        if (!hasAccess && parentInvoiceId) {
                            const [[parentOrder]] = await pool.query(
                                "SELECT user_id, waiter_id FROM orders WHERE invoice_id = ?",
                                [parentInvoiceId]
                            );
                            if (parentOrder) {
                                const isParentOwner = parentOrder.user_id === req.user.id || parentOrder.waiter_id === req.user.id;
                                const isCashier = userHas(req.user, PERMISSIONS.POS_CHECKOUT);
                                const isWaiterCheckout = userHas(req.user, PERMISSIONS.WAITER_CHECKOUT);
                                const canSplit = userHas(req.user, PERMISSIONS.POS_SPLIT_CHECKS);
                                const hasTableAccess = userHas(req.user, PERMISSIONS.TABLES_ACCESS);
                                
                                hasAccess = isParentOwner || isCashier || isWaiterCheckout || canSplit || hasTableAccess;
                            }
                        }

                        if (!hasAccess) {
                            return res.status(403).json({ success: false, message: "You are not authorized to print this check." });
                        }

                        if (!split) {
                            if (!requestedPrintId) return res.status(400).json({success:false,message:'A print request id is required for a held receipt.'});
                            const conn = await pool.getConnection();
                            try {
                                await conn.beginTransaction();
                                const [[locked]] = await conn.query('SELECT * FROM held_orders WHERE id=? FOR UPDATE', [heldId]);
                                if (!locked) throw Object.assign(new Error('Held order not found.'), {statusCode:404});
                                const receipt = await prepareHeldCustomerReceipt(conn, locked, {
                                    printerId:printer_id, requestId:requestedPrintId, forceBackend:true
                                });
                                await commitAndPublishSpoolerSyncWake(conn);
                                return res.json({success:true,order_display_no:formatOrderNumber(locked),customer_receipt:receipt});
                            } catch(error) {
                                await conn.rollback();
                                throw error;
                            } finally { conn.release(); }
                        }

                        const frozenAccountingFlag = parsedData.tax_inclusive_at_sale
                            ?? parsedData.tax_inclusive_at_hold;
                        const taxInclusivePricing = frozenAccountingFlag == null
                            ? storeInfo.tax_inclusive_pricing === '1'
                            : Number(frozenAccountingFlag) === 1;
                        const cartItems = items.map((item, index) => {
                            const qty = Number(item.qty || item.quantity || 1);
                            const price = Number(item.price || item.price_at_sale || 0);
                            const discType = item.discountType || item.discount_type || null;
                            const discVal = Number(item.discountValue || item.discount_value || 0);
                            return {
                                ...item,
                                product_id: item.id || item.product_id || null,
                                qty,
                                price,
                                discountType: discType,
                                discountValue: discVal
                            };
                        });
                        const splitOrderDiscount = parsedData.order_discount || { type: null, value: 0 };
                        const calcData = {
                            order_discount_type: splitOrderDiscount.type || null,
                            order_discount_value: splitOrderDiscount.value || 0
                        };
                        const totals = calculateExpectedTotals(calcData, cartItems, new Map(), taxInclusivePricing);

                        data = {
                            print_type: 'receipt',
                            receipt_printer_id: printer_id,
                            storeInfo: storeInfo,
                            internal_invoice_id: parentInvoiceId || held.id,
                            invoice_id: parentInvoiceId || held.id,
                            order_id: parentOrderId || 'SPLIT-TEMP',
                            invoice_number: null,
                            invoice_issued_at: null,
                            invoice_display_no: null,
                            order_display_no: parsedData.parent_order_display_no || (parentOrderId ? String(parentOrderId) : null),
                            ticket_display_no: parsedData.parent_ticket_display_no || parsedData.parent_order_display_no || (parentOrderId ? String(parentOrderId) : null),
                            order_taken_at: held.created_at,
                            date: held.created_at,
                            cashier: held.cashier_name || 'System',
                            order_type_name: 'Table Split',
                            table_number: held.reference_name,
                            customer_name: '',
                            customer_phone: '',
                            customer_address: '',
                            items: items.map(item => ({
                                qty: item.qty || item.quantity || 1,
                                name: item.name || item.product_name || 'Unknown Item',
                                price: item.price || item.price_at_sale || 0,
                                tax_rate: item.tax_rate || 0,
                                tax_amount: item.tax_amount ?? null,
                                discountType: item.discountType || item.discount_type || null,
                                discountValue: parseFloat(item.discountValue || item.discount_value || 0),
                                note: item.note || '',
                                modifier_surcharge: item.modifier_surcharge ?? null,
                                modifier_tax_amount: item.modifier_tax_amount ?? null
                            })),
                            subtotal: totals.subtotal,
                            tax: totals.tax,
                            discount: totals.discount,
                            total: totals.total,
                            payment_method: 'held',
                            amount_tendered: 0,
                            change_due: 0,
                            hash_number: '',
                            receipt_display_v1
                        };
                    }
                } else if (data.invoice_id === 'GUEST CHECK') {
                    // A guest check is a pre-payment bill of the in-progress cart — no order exists
                    // yet, so it is legitimately client-built. It is explicitly "Unpaid" with no
                    // invoice number and therefore cannot masquerade as a paid receipt. Gate it
                    // behind the checkout permission (mirrors the frontend canPrintCheck =
                    // canCheckout || canCheckoutTable), mark it provisional, and let the shared
                    // sanitizePrintData below strip any injected control bytes from the client strings.
                    if (!userHas(req.user, PERMISSIONS.POS_CHECKOUT) && !userHas(req.user, PERMISSIONS.WAITER_CHECKOUT)) {
                        return res.status(403).json({ success: false, message: "You are not authorized to print a guest check." });
                    }
                    if (data.tax_exempt !== undefined && typeof data.tax_exempt !== 'boolean') {
                        return res.status(400).json({ success: false, message: 'Tax exemption must be boolean.' });
                    }
                    const taxExempt = data.tax_exempt === true;
                    const tableDisplayNo = data.table_number == null || data.table_number === ''
                        ? null
                        : String(data.table_number);
                    const takenAt = data.order_taken_at || data.date || new Date().toISOString();
                    
                    let accountingTaxInclusive = false;
                    let receiptTaxInclusiveDisplay = storeInfo.tax_inclusive_pricing === '1';
                    if (data.source_invoice_id !== undefined && data.source_invoice_id !== null) {
                        const sourceInvoiceId = Number(data.source_invoice_id);
                        if (!Number.isSafeInteger(sourceInvoiceId) || sourceInvoiceId <= 0) {
                            return res.status(400).json({ success: false, message: 'Invalid guest-check source.' });
                        }
                        const [[sourceOrder]] = await pool.query(
                            `SELECT table_id, payment_method, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale
                               FROM orders WHERE invoice_id = ?`,
                            [sourceInvoiceId]
                        );
                        if (!sourceOrder || sourceOrder.payment_method !== 'unpaid_table') {
                            return res.status(409).json({ success: false, message: 'The open table order is no longer available.' });
                        }
                        await assertTableReadAccess(pool, req.user, { tableId: sourceOrder.table_id });
                        accountingTaxInclusive = Number(sourceOrder.tax_inclusive_at_sale) === 1;
                        receiptTaxInclusiveDisplay = sourceOrder.receipt_tax_inclusive_at_sale == null
                            ? accountingTaxInclusive
                            : Number(sourceOrder.receipt_tax_inclusive_at_sale) === 1;
                    }
                    const builderItems = (data.items || []).map((item, index) => {
                        const key = String(item.key ?? item.cartId ?? `row-${index}`);
                        const kind = item.parent_item_id != null ? 'bundle_child' : 'item';
                        const price = taxExempt && item.note !== 'Auto-Gratuity'
                            ? exemptUnitPrice(item, Number(item.tax_rate ?? 0), accountingTaxInclusive)
                            : Number(item.price ?? item.price_at_sale ?? 0);
                        return {
                            key,
                            kind,
                            name: item.name || 'Unknown Item',
                            note: item.note,
                            selectedModifiers: item.selectedModifiers ?? item.selected_modifiers ?? null,
                            qty: Number(item.qty ?? item.quantity ?? 1),
                            price,
                            discountType: item.discountType ?? item.discount_type ?? null,
                            discountValue: Number(item.discountValue ?? item.discount_value ?? 0),
                            tax_rate: Number(item.tax_rate ?? 0),
                            parent_item_id: item.parent_item_id,
                            modifier_surcharge: item.modifier_surcharge ?? null,
                            modifier_tax_amount: item.modifier_tax_amount ?? null
                        };
                    });
                    const submittedOrderDiscount = data.orderDiscount ?? data.order_discount ?? {};
                    let orderDiscountType = submittedOrderDiscount.type ?? data.order_discount_type ?? null;
                    let orderDiscountValue = Number(submittedOrderDiscount.value ?? data.order_discount_value ?? 0);
                    // Older guest-check clients sent only the computed fixed discount amount.
                    if (!orderDiscountType && Number(data.discount) > 0) {
                        orderDiscountType = 'fixed';
                        orderDiscountValue = Number(data.discount);
                    }
                    const calculated = calculateExpectedTotals(
                        { order_discount_type: orderDiscountType, order_discount_value: orderDiscountValue },
                        builderItems.filter(item => item.kind !== 'bundle_child'),
                        new Map(),
                        accountingTaxInclusive,
                        { taxExempt, pricesAlreadyExempt: taxExempt }
                    );
                    const receipt_display_v1 = buildOrderPresentation({
                        order: {
                            subtotal: calculated.subtotal,
                            tax: calculated.tax,
                            total: calculated.total,
                            tax_inclusive_at_sale: accountingTaxInclusive ? 1 : 0,
                            receipt_tax_inclusive_at_sale: receiptTaxInclusiveDisplay ? 1 : 0,
                            tax_registration_type_at_sale: data.tax_registration_type_at_sale || null,
                            tax_exempt_at_sale: taxExempt ? 1 : 0,
                            payment_method: 'unpaid_table',
                            discount_type: calculated.orderDiscount.type,
                            discount_value: calculated.orderDiscount.value
                        },
                        items: builderItems.map(item => ({
                            ...item,
                            item_name: item.name,
                            quantity: item.qty,
                            price_at_sale: item.price,
                            discount_type: item.discountType,
                            discount_value: item.discountValue
                        }))
                    });

                    data = {
                        ...data,
                        invoice_id: 'GUEST CHECK',
                        invoice_number: null,
                        invoice_display_no: null,
                        invoice_issued_at: null,
                        order_id: null,
                        order_display_no: null,
                        ticket_display_no: null,
                        table_display_no: tableDisplayNo,
                        order_taken_at: takenAt,
                        date: takenAt,
                        provisional: true,
                        receipt_display_v1
                    };
                    // No DB load — the guest check reflects the current cart, not a persisted order.
                } else {
                    const invoiceId = parseInt(data.invoice_id || data.order_id, 10);
                    if (isNaN(invoiceId)) {
                        return res.status(400).json({ success: false, message: "A valid invoice id is required to print this receipt." });
                    }
                    if (!isNaN(invoiceId)) {
                        const [orders] = await pool.query(`
                            SELECT o.*,
                            o.invoice_number,
                            o.invoice_issued_at,
                            CASE WHEN o.invoice_number IS NULL THEN NULL ELSE CAST(o.invoice_number AS CHAR) END AS invoice_display_no,
                            ${orderDisplayNoSql('o')} AS order_display_no,
                            CASE WHEN o.invoice_number IS NULL AND o.order_id IS NOT NULL THEN ${orderDisplayNoSql('o')} ELSE NULL END AS ticket_display_no,
                            u.name as cashier_name,
                            CASE WHEN o.payment_method='receivable' THEN o.buyer_name_at_sale ELSE c.name END as customer_name,
                            CASE WHEN o.payment_method='receivable' THEN o.buyer_phone_at_sale ELSE c.phone END as customer_phone,
                            CASE WHEN o.payment_method='receivable' THEN o.buyer_address_at_sale ELSE c.address END as customer_address,
                            ot.name as order_type_name,
                            t.table_number
                            FROM orders o
                            LEFT JOIN users u ON o.user_id = u.id
                            LEFT JOIN customers c ON o.customer_id = c.id
                            LEFT JOIN order_types ot ON o.order_type_id = ot.id
                            LEFT JOIN restaurant_tables t ON o.table_id = t.id
                            WHERE o.invoice_id = ?
                        `, [invoiceId]);

                        if (orders.length === 0) {
                            return res.status(404).json({ success: false, message: "Order not found." });
                        }
                        const order = orders[0];
                        if (order.payment_method === 'unpaid_table') await assertTableReadAccess(pool, req.user, { tableId: order.table_id });

                        if (!userCanAccessOrderForPrint(req.user, order)) {
                            return res.status(403).json({ success: false, message: 'You are not authorized to print this receipt.' });
                        }
                        // Without pos.reprint_receipt a paid receipt prints only as its checkout's own copy.
                        // Another invoice's id is refused as a mismatch (400) below.
                        const foreignPrintId = requestedPrintId
                            && !String(requestedPrintId).startsWith(`checkout-receipt:${order.invoice_id}:`);
                        if (order.payment_method !== 'unpaid_table' && !foreignPrintId
                            && !isAdminRole(req.user) && !userHas(req.user, PERMISSIONS.POS_REPRINT_RECEIPT)
                            && !await isFirstCheckoutPrint(order, requestedPrintId)) {
                            return res.status(403).json({ success: false, message: 'You are not authorized to reprint this receipt.' });
                        }

                        const [dbItems] = await pool.query(`
                            SELECT oi.*, COALESCE(oi.item_name, p.name) as name, p.category_id
                            FROM order_items oi
                            LEFT JOIN products p ON oi.product_id = p.id
                            WHERE oi.invoice_id = ?
                            ORDER BY COALESCE(oi.parent_item_id, oi.id) ASC, oi.parent_item_id IS NOT NULL ASC, oi.sort_order ASC
                        `, [invoiceId]);

                        const identity = buildOrderIdentity(order);
                        const resRead = buildOrderPresentationForRead({ order, items: dbItems });
                        let receipt_display_v1 = undefined;
                        let receipt_display_legacy_reason = undefined;
                        if (resRead.presentation) {
                            receipt_display_v1 = resRead.presentation;
                        } else {
                            receipt_display_legacy_reason = resRead.legacyReason;
                        }
                        data = {
                            print_type: 'receipt',
                            receipt_printer_id: printer_id,
                            storeInfo: storeInfo,
                            internal_invoice_id: order.invoice_id,
                            invoice_id: order.invoice_id,
                            order_id: order.order_id,
                            ...identity,
                            order_taken_at: order.created_at,
                            date: order.created_at,
                            cashier: order.cashier_name || 'System',
                            order_type_name: order.order_type_name || 'Standard',
                            table_number: order.table_number || '',
                            customer_name: order.customer_name || '',
                            customer_phone: order.customer_phone || '',
                            customer_address: order.customer_address || '',
                            delivery_date: order.delivery_date || null,
                            tax_registration_type_at_sale: order.tax_registration_type_at_sale || null,
                            items: dbItems.map(item => ({
                                qty: item.quantity,
                                name: item.name || 'Unknown Item',
                                price: item.price_at_sale,
                                tax_rate: item.tax_rate || 0,
                                tax_amount: item.tax_amount ?? null,
                                _isChild: item.parent_item_id != null,
                                discountType: item.discount_type || null,
                                discountValue: parseFloat(item.discount_value || 0),
                                note: item.note || ''
                            })),
                            subtotal: order.subtotal,
                            tax: order.tax,
                            discount: order.discount_type === 'percent'
                                ? roundMoney(Number(order.subtotal) * (Number(order.discount_value) / 100))
                                : Number(order.discount_value || 0),
                            total: order.total,
                            payment_method: order.payment_method,
                            amount_tendered: order.amount_tendered,
                            change_due: order.change_due,
                            cash_amount: order.cash_amount,
                            card_amount: order.card_amount,
                            hash_number: order.hash_number,
                            ...(receipt_display_v1 ? { receipt_display_v1 } : {}),
                            ...(receipt_display_legacy_reason ? { receipt_display_legacy_reason } : {})
                        };
                    }
                }
            }

            // Secure Shift Reports: Load shift data and compute totals from DB
            if (['z_report', 'x_report', 'zreport'].includes(data.print_type)) {
                try {
                    data = await buildShiftReportPayload(pool, {
                        shiftId: data.shift_id,
                        printType: data.print_type,
                        user: req.user,
                        storeInfo,
                        receiptPrinterId: printer_id,
                    });
                } catch (error) {
                    if ([400, 403, 404].includes(error.statusCode)) {
                        return res.status(error.statusCode).json({ success: false, message: error.message });
                    }
                    throw error;
                }
            }

            if (['expense_slip', 'expense_cancel_slip'].includes(data.print_type)) {
                if (!isAdminRole(req.user)) {
                    return res.status(403).json({ success: false, message: 'Admin privileges are required to reprint expenses.' });
                }
                const expenseId = Number(data.expense_id);
                if (!Number.isInteger(expenseId) || expenseId <= 0) {
                    return res.status(400).json({ success: false, message: 'A valid expense id is required.' });
                }
                const [[expense]] = await pool.query(`
                    SELECT e.id, e.amount, e.source, e.shift_id, e.note, e.status,
                           e.created_at, e.canceled_at, c.name AS category_name,
                           u.name AS created_by_name, cu.name AS canceled_by_name
                    FROM expenses e
                    JOIN expense_categories c ON c.id=e.category_id
                    JOIN users u ON u.id=e.created_by
                    LEFT JOIN users cu ON cu.id=e.canceled_by
                    WHERE e.id=?
                `, [expenseId]);
                if (!expense) return res.status(404).json({ success: false, message: 'Expense not found.' });
                const printType = data.print_type;
                if (printType === 'expense_cancel_slip' && expense.status !== 'canceled') {
                    return res.status(409).json({ success: false, message: 'This expense has not been canceled.' });
                }
                data = {
                    ...expense,
                    id: Number(expense.id),
                    amount: Number(expense.amount),
                    shift_id: expense.shift_id === null ? null : Number(expense.shift_id),
                    print_type: printType,
                    receipt_printer_id: printer_id,
                    storeInfo,
                    language: data.language === 'ar' ? 'ar' : 'en',
                    direction: data.language === 'ar' ? 'rtl' : 'ltr',
                };
            }

            if (['daily_summary_report', 'daily_sales_report', 'daily_refunds_report', 'daily_expenses_report'].includes(data.print_type)) {
                const isAdmin = req.user.role === 'admin' || req.user.role === 'programmer';
                if (!isAdmin) {
                    return res.status(403).json({ success: false, message: "Forbidden: Admin privileges required to print reports." });
                }
            }

            if (requestedPrintId) {
                const invoiceId = Number(data.internal_invoice_id);
                const expectedIds = new Set([
                    `checkout-receipt:${invoiceId}:primary`,
                    `checkout-receipt:${invoiceId}:duplicate`
                ]);
                if (data.print_type !== 'receipt' || !Number.isSafeInteger(invoiceId) || !expectedIds.has(requestedPrintId)) {
                    return res.status(400).json({ success: false, message: 'Print request id does not match this receipt.' });
                }
            }

            const payloads = [
                {
                    printer_id: printerConfig.id,
                    printer_name: sanitizePrintString(printerConfig.windows_name, 200),
                    printer_type: printerConfig.type,
                    network_ip: printerConfig.network_ip,
                    network_port: printerConfig.network_port,
                    status_capability: printerConfig.status_capability || 'write_only',
                    print_type: data.print_type,
                    ...(requestedPrintId ? { print_request_id: requestedPrintId } : {}),
                    data: sanitizePrintData(data)
                }
            ];

            await enqueueCommittedPrintJobs(payloads);
            return res.json({ success: true, message: 'Print job queued and sent to spooler.' });
        }

        // 3. Route Kitchen Tickets (Verified via Database records, preventing arbitrary client inputs injection)
        if (data.print_type === 'kitchen') {
            const invoice_id = data.invoice_id || data.order_id || null;
            if (!invoice_id) {
                return res.status(400).json({ success: false, message: "Invoice ID is required to print a kitchen ticket." });
            }

            const [orders] = await pool.query(`
                SELECT o.*, ot.name as order_type_name
                FROM orders o
                LEFT JOIN order_types ot ON o.order_type_id = ot.id
                WHERE o.invoice_id = ?
            `, [invoice_id]);
            if (orders.length === 0) {
                return res.status(404).json({ success: false, message: "Order not found." });
            }
            const order = orders[0];
            if (order.payment_method === 'unpaid_table') await assertTableReadAccess(pool, req.user, { tableId: order.table_id });

            // Verify access permissions to prevent IDOR printing
            const ownsByWaiter = order.waiter_id && order.waiter_id === req.user.id;
            const canBypassWaiter = userHas(req.user, PERMISSIONS.WAITER_OVERRIDE_TABLES);
            if (!ownsByWaiter && !canBypassWaiter && !userCanAccessOrderForPrint(req.user, order)) {
                return res.status(403).json({ success: false, message: "Forbidden: You do not own this order." });
            }

            // Fetch items from database (authoritative source of truth)
            const [dbItems] = await pool.query(`
                SELECT oi.*, COALESCE(oi.item_name, p.name) as name, p.category_id
                FROM order_items oi
                LEFT JOIN products p ON oi.product_id = p.id
                WHERE oi.invoice_id = ?
            `, [invoice_id]);

            if (dbItems.length === 0) {
                return res.json({ success: false, message: "No items to print in this order." });
            }

            const kitchenItems = await normalizeKitchenTicketItems(dbItems, {
                db: pool,
                linePrefix: `order-${invoice_id}`,
                deriveBundleParentsFromLinks: true
            });

            const [tableRows] = await pool.query("SELECT table_number FROM restaurant_tables WHERE id = ?", [order.table_id]);
            const tableNumber = tableRows.length > 0 ? tableRows[0].table_number : '';

            const kitchenIdentity = buildOrderIdentity(order);
            const isOpenTableKitchenTicket = order.payment_method === 'unpaid_table';
            const orderTakenAt = order.created_at || null;
            const printPayload = {
                internal_invoice_id: order.invoice_id,
                invoice_id: order.invoice_id,
                invoice_number: isOpenTableKitchenTicket ? null : kitchenIdentity.invoice_number,
                invoice_display_no: isOpenTableKitchenTicket ? null : kitchenIdentity.invoice_display_no,
                order_display_no: isOpenTableKitchenTicket ? null : kitchenIdentity.order_display_no,
                ticket_display_no: isOpenTableKitchenTicket ? null : (kitchenIdentity.ticket_display_no || null),
                order_id: isOpenTableKitchenTicket
                    ? null
                    : (kitchenIdentity.order_display_no || kitchenIdentity.ticket_display_no || null),
                table_number: tableNumber,
                order_type_name: order.order_type_name || (order.payment_method === 'unpaid_table' ? 'Table' : 'Standard'),
                order_taken_at: orderTakenAt,
                date: orderTakenAt,
                items: kitchenItems,
                hash_number: order.hash_number,
                storeInfo: storeInfo
            };

            const count = await printKitchenOrder(req.io, printPayload);
            return res.json({ success: true, message: `${count} kitchen ticket(s) queued and sent to spooler.` });
        }
        
        return res.status(400).json({ success: false, message: 'Unsupported print type.' });

    } catch (e) {
        if (e.publicCode === BUNDLE_ORDER_CORRUPT) {
            logger.error({
                err: e,
                invoiceId: req.body?.invoice_id || req.body?.order_id,
                integrityReason: e.integrityReason,
                integrityContext: e.integrityContext
            }, 'Print blocked by corrupt bundle data.');
            return res.status(e.statusCode || 409).json({
                success: false,
                message: e.message,
                publicCode: e.publicCode
            });
        }
        if (e.statusCode === 422 || e.code === 'RECEIPT_PRESENTATION_INVALID') {
            return res.status(422).json({ success: false, message: e.message, publicCode: e.publicCode || e.code });
        }
        // Bad client input on the provisional guest-check build (e.g. an invalid
        // tax rate rejected by validateTaxRate) is a 400, not an engine error.
        if (e.statusCode === 400 || e.statusCode === 409) {
            return res.status(e.statusCode).json({ success: false, message: e.message, publicCode: e.publicCode || e.code || null });
        }
        logger.error({
            err: e,
            route: req.originalUrl,
            method: req.method,
            userId: req.user?.id,
            role: req.user?.role,
            printType: req.body?.print_type,
            invoiceId: req.body?.invoice_id || req.body?.order_id,
            shiftId: req.body?.shift_id
        }, 'Print request failed.');
        if (e.publicCode === 'TABLE_ACCESS_DENIED') {
            return res.status(403).json({ success: false, message: e.message, code: e.publicCode });
        }
        const isDbError = !!(e.code || e.errno || e.sqlState || e.sql);
        const msg = (process.env.NODE_ENV === 'production' || isDbError)
            ? "An internal print engine error occurred."
            : e.message;
        return res.json({ success: false, message: msg });
    }
});

// Compatibility boundary for existing print and held-order callers. Routing is now
// separately reusable inside a transaction.
async function printKitchenOrder(io, data, { executor = pool, publish = executor === pool } = {}) {
    const { payloads } = await buildKitchenPrintPayloads(executor, data);
    if (payloads.length > 0) {
        if (publish) await enqueueCommittedPrintJobs(payloads);
        else await enqueuePrintJobs(executor, payloads);
    }
    return payloads.length;
}

// Queued by the shift-close request itself: closing a shift revokes the closer's
// session and clears its cookie, so a separate print request after it is refused.
// The report is built from the committed shift, exactly like POST /print z_report.
async function queueShiftReportPrint({ shiftId, user, printerId = null, printType = 'z_report' }) {
    const storeInfo = await getPrintStoreInfo(pool);
    const data = await buildShiftReportPayload(pool, {
        shiftId,
        printType,
        user,
        storeInfo,
        receiptPrinterId: printerId || null,
    });
    await dispatchReceiptPrint({ printerId: printerId || null, printType: data.print_type, data: sanitizePrintData(data) });
}

router.printKitchenOrder = printKitchenOrder;
router.queueShiftReportPrint = queueShiftReportPrint;
// Re-exported for the bundle print/table tests that assert routing through this
// router; production callers import it from services/kitchenPrintRouting directly.
router.expandBundlesForKitchen = expandBundlesForKitchen;
router.sanitizePrintData = sanitizePrintData;

module.exports = router;
