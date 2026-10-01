'use strict';

const crypto = require('crypto');
const { REFUNDS_ROLLUP_JOIN } = require('./financialSql');
const { getBusinessDate } = require('../utils/businessDate');
const { normalizeCheckoutAttemptKey } = require('./CheckoutAttemptService');
const { appendAuditEvent } = require('./auditEvents');

const ADJUSTMENT_CATEGORIES = Object.freeze([
    'commission',
    'service_fee',
    'marketing_fee',
    'penalty',
    'withholding_tax',
    'reimbursement',
    'incentive',
    'correction',
    'other'
]);

const DEDUCTION_CATEGORIES = new Set([
    'commission',
    'service_fee',
    'marketing_fee',
    'penalty',
    'withholding_tax'
]);

const ADDITION_CATEGORIES = new Set(['reimbursement', 'incentive']);
const FLEXIBLE_CATEGORIES = new Set(['correction', 'other']);
const MAX_DATE_LENGTH = 10;

function remittanceError(message, statusCode = 400, publicCode = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (publicCode) error.publicCode = publicCode;
    return error;
}

function parseCents(value, field = 'amount', { allowNegative = true, allowZero = true } = {}) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw remittanceError(`Invalid ${field}.`, 400, 'PLATFORM_REMITTANCE_INVALID_AMOUNT');
        }
        value = String(value);
    }
    if (typeof value !== 'string') {
        throw remittanceError(`Invalid ${field}.`, 400, 'PLATFORM_REMITTANCE_INVALID_AMOUNT');
    }
    const text = value.trim();
    if (!/^-?(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(text)) {
        throw remittanceError(`Invalid ${field}.`, 400, 'PLATFORM_REMITTANCE_INVALID_AMOUNT');
    }
    const negative = text.startsWith('-');
    const unsigned = negative ? text.slice(1) : text;
    const [whole, fraction = ''] = unsigned.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0') || 0);
    const signed = negative ? -cents : cents;
    if (!allowNegative && signed < 0) {
        throw remittanceError(`${field} cannot be negative.`, 400, 'PLATFORM_REMITTANCE_INVALID_AMOUNT');
    }
    if (!allowZero && signed === 0) {
        throw remittanceError(`${field} must be greater than zero.`, 400, 'PLATFORM_REMITTANCE_INVALID_AMOUNT');
    }
    return signed;
}

function dbCents(value, field = 'amount') {
    if (value == null || value === '') return 0;
    return parseCents(String(value), field);
}

function amountFromCents(cents) {
    return Number((Number(cents || 0) / 100).toFixed(2));
}

function dateOnlyValue(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) {
        return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
    }
    return String(value).slice(0, 10);
}

function normalizeDate(value, field = 'date', { required = true } = {}) {
    if (value == null || value === '') {
        if (required) throw remittanceError(`${field} is required.`, 400, 'PLATFORM_REMITTANCE_INVALID_DATE');
        return null;
    }
    if (typeof value !== 'string' || value.length > MAX_DATE_LENGTH || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw remittanceError(`Invalid ${field}.`, 400, 'PLATFORM_REMITTANCE_INVALID_DATE');
    }
    const [year, month, day] = value.split('-').map(Number);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
        throw remittanceError(`Invalid ${field}.`, 400, 'PLATFORM_REMITTANCE_INVALID_DATE');
    }
    return value;
}

function normalizeOrderTypeId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
        throw remittanceError('A valid provider is required.', 400, 'PLATFORM_REMITTANCE_INVALID_PROVIDER');
    }
    return id;
}

function makeBalanceToken(orderTypeId, invoiceId, openCents) {
    return crypto.createHash('sha256')
        .update(`${Number(orderTypeId)}:${Number(invoiceId)}:${Number(openCents)}`)
        .digest('hex');
}

function emptyCategoryTotals() {
    return Object.fromEntries(ADJUSTMENT_CATEGORIES.map(category => [category, 0]));
}

function moneySummary(cents) {
    return amountFromCents(cents);
}

function signedKind(kind) {
    return kind === 'reversal' ? -1 : 1;
}

function normalizeProviderName(row) {
    const direct = String(row.provider_name || row.name || '').trim();
    if (direct) return direct;
    const snapshot = String(row.provider_name_at_entry || '').trim();
    return snapshot || `Provider #${Number(row.order_type_id)}`;
}

const RECORD_INPUT_KEYS = new Set([
    'actorId',
    'ipAddress',
    'orderTypeId',
    'invoiceAllocations',
    'adjustments',
    'netReceived',
    'settledOn',
    'statementStartDate',
    'statementEndDate',
    'reference',
    'idempotencyKey'
]);

const ALLOCATION_KEYS = new Set(['invoiceId', 'balanceToken', 'allocationAmount']);
const ADJUSTMENT_KEYS = new Set(['direction', 'category', 'amount', 'note']);

function rejectUnknownKeys(value, allowed, publicCode) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw remittanceError('Invalid platform reconciliation input.', 400, publicCode);
    }
    const unknown = Object.keys(value).find(key => !allowed.has(key));
    if (unknown) {
        throw remittanceError(`Unknown field: ${unknown}.`, 400, 'PLATFORM_REMITTANCE_UNKNOWN_FIELD');
    }
}

function normalizeActorId(value) {
    const actorId = Number(value);
    if (!Number.isInteger(actorId) || actorId <= 0) {
        throw remittanceError('A valid administrator is required.', 400, 'PLATFORM_REMITTANCE_INVALID_ACTOR');
    }
    return actorId;
}

function normalizeIdempotencyKey(value) {
    let key;
    try {
        key = normalizeCheckoutAttemptKey(value);
    } catch (error) {
        throw remittanceError(error.message, error.statusCode || 400, 'PLATFORM_REMITTANCE_INVALID_IDEMPOTENCY_KEY');
    }
    if (!key) {
        throw remittanceError('An idempotency key is required.', 400, 'PLATFORM_REMITTANCE_INVALID_IDEMPOTENCY_KEY');
    }
    return key;
}

function normalizeAllocations(value) {
    if (!Array.isArray(value) || value.length > 200) {
        throw remittanceError('At most 200 invoice allocations are allowed.', 400, 'PLATFORM_REMITTANCE_INVALID_ALLOCATIONS');
    }
    const seen = new Set();
    const allocations = value.map((raw) => {
        rejectUnknownKeys(raw, ALLOCATION_KEYS, 'PLATFORM_REMITTANCE_INVALID_ALLOCATIONS');
        const invoiceId = Number(raw.invoiceId);
        if (!Number.isInteger(invoiceId) || invoiceId <= 0 || seen.has(invoiceId)) {
            throw remittanceError('Invoice allocations must contain unique valid invoice IDs.', 400, 'PLATFORM_REMITTANCE_INVALID_ALLOCATIONS');
        }
        seen.add(invoiceId);
        if (typeof raw.balanceToken !== 'string' || !/^[a-f0-9]{64}$/.test(raw.balanceToken)) {
            throw remittanceError('Each invoice allocation requires a valid balance token.', 400, 'PLATFORM_REMITTANCE_INVALID_BALANCE_TOKEN');
        }
        const allocationCents = parseCents(raw.allocationAmount, 'allocation amount');
        if (allocationCents === 0) {
            throw remittanceError('Zero allocations must be omitted.', 400, 'PLATFORM_REMITTANCE_INVALID_ALLOCATIONS');
        }
        return { invoiceId, balanceToken: raw.balanceToken, allocationCents };
    });
    return allocations.sort((left, right) => left.invoiceId - right.invoiceId);
}

function normalizeAdjustments(value) {
    if (!Array.isArray(value) || value.length > 50) {
        throw remittanceError('At most 50 statement adjustments are allowed.', 400, 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENTS');
    }
    return value.map((raw) => {
        rejectUnknownKeys(raw, ADJUSTMENT_KEYS, 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENTS');
        const direction = raw.direction;
        const category = raw.category;
        if (!['deduction', 'addition'].includes(direction) || !ADJUSTMENT_CATEGORIES.includes(category)) {
            throw remittanceError('Invalid adjustment category or direction.', 400, 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENT');
        }
        if (DEDUCTION_CATEGORIES.has(category) && direction !== 'deduction') {
            throw remittanceError('This adjustment category must be a deduction.', 400, 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENT');
        }
        if (ADDITION_CATEGORIES.has(category) && direction !== 'addition') {
            throw remittanceError('This adjustment category must be an addition.', 400, 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENT');
        }
        const note = raw.note == null ? null : String(raw.note).trim();
        if (note && note.length > 255) {
            throw remittanceError('Adjustment note is too long.', 400, 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENT');
        }
        if (FLEXIBLE_CATEGORIES.has(category) && !note) {
            throw remittanceError('Correction and other adjustments require a note.', 400, 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENT');
        }
        return {
            direction,
            category,
            amountCents: parseCents(raw.amount, 'adjustment amount', { allowNegative: false, allowZero: false }),
            note: note || null
        };
    });
}

function normalizeRecordInput(input) {
    rejectUnknownKeys(input, RECORD_INPUT_KEYS, 'PLATFORM_REMITTANCE_INVALID_INPUT');
    const actorId = normalizeActorId(input.actorId);
    const orderTypeId = normalizeOrderTypeId(input.orderTypeId);
    const invoiceAllocations = normalizeAllocations(input.invoiceAllocations || []);
    const adjustments = normalizeAdjustments(input.adjustments || []);
    const settledOn = normalizeDate(input.settledOn || getBusinessDate(), 'settled date');
    if (settledOn > getBusinessDate()) {
        throw remittanceError('Settlement date cannot be in the future.', 400, 'PLATFORM_REMITTANCE_INVALID_DATE');
    }
    const statementStartDate = normalizeDate(input.statementStartDate, 'statement start date', { required: false });
    const statementEndDate = normalizeDate(input.statementEndDate, 'statement end date', { required: false });
    if ((statementStartDate && !statementEndDate) || (!statementStartDate && statementEndDate) || (statementStartDate && statementEndDate && statementStartDate > statementEndDate)) {
        throw remittanceError('Statement dates must be a complete ascending range.', 400, 'PLATFORM_REMITTANCE_INVALID_DATE_RANGE');
    }
    const reference = input.reference == null ? null : String(input.reference).trim();
    if (reference && reference.length > 120) {
        throw remittanceError('Reference is too long.', 400, 'PLATFORM_REMITTANCE_INVALID_REFERENCE');
    }
    return {
        actorId,
        ipAddress: input.ipAddress == null ? null : String(input.ipAddress),
        orderTypeId,
        invoiceAllocations,
        adjustments,
        netReceivedCents: parseCents(input.netReceived, 'net received', { allowNegative: false }),
        settledOn,
        statementStartDate,
        statementEndDate,
        reference: reference || null,
        idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey)
    };
}

function normalizeReversalInput(input) {
    const allowed = new Set(['actorId', 'ipAddress', 'remittanceId', 'reason', 'idempotencyKey']);
    rejectUnknownKeys(input, allowed, 'PLATFORM_REMITTANCE_INVALID_INPUT');
    const actorId = normalizeActorId(input.actorId);
    const remittanceId = Number(input.remittanceId);
    if (!Number.isInteger(remittanceId) || remittanceId <= 0) {
        throw remittanceError('Invalid remittance.', 400, 'PLATFORM_REMITTANCE_INVALID_ID');
    }
    const reason = String(input.reason == null ? '' : input.reason).trim();
    if (!reason || reason.length > 255) {
        throw remittanceError('A reversal reason is required.', 400, 'PLATFORM_REMITTANCE_INVALID_REVERSAL');
    }
    return {
        actorId,
        ipAddress: input.ipAddress == null ? null : String(input.ipAddress),
        remittanceId,
        reason,
        idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey)
    };
}

function canonicalRecordIntent(intent) {
    return JSON.stringify({
        actorId: intent.actorId,
        orderTypeId: intent.orderTypeId,
        invoiceAllocations: intent.invoiceAllocations.map(row => ({
            invoiceId: row.invoiceId,
            allocationCents: row.allocationCents
        })),
        adjustments: intent.adjustments.map(row => ({
            direction: row.direction,
            category: row.category,
            amountCents: row.amountCents,
            note: row.note
        })),
        netReceivedCents: intent.netReceivedCents,
        settledOn: intent.settledOn,
        statementStartDate: intent.statementStartDate,
        statementEndDate: intent.statementEndDate,
        reference: intent.reference
    });
}

function canonicalStoredIntent(remittance) {
    return JSON.stringify({
        actorId: Number(remittance.recorded_by),
        orderTypeId: Number(remittance.order_type_id),
        invoiceAllocations: (remittance.allocations || []).map(row => ({
            invoiceId: Number(row.invoice_id),
            allocationCents: parseCents(String(row.allocated_amount), 'allocated amount')
        })).sort((left, right) => left.invoiceId - right.invoiceId),
        adjustments: (remittance.adjustments || []).map(row => ({
            direction: row.direction,
            category: row.category,
            amountCents: parseCents(String(row.amount), 'adjustment amount'),
            note: row.note || null
        })),
        netReceivedCents: parseCents(String(remittance.net_received), 'net received'),
        settledOn: dateOnlyValue(remittance.settled_on),
        statementStartDate: dateOnlyValue(remittance.statement_start_date),
        statementEndDate: dateOnlyValue(remittance.statement_end_date),
        reference: remittance.reference || null
    });
}

async function findByIdempotencyKey(executor, key) {
    const [[row]] = await executor.query(
        'SELECT id FROM platform_remittances WHERE idempotency_key = ? LIMIT 1',
        [key]
    );
    return row ? getRemittance(executor, Number(row.id)) : null;
}

function assertRecordRetryCompatible(existing, intent) {
    if (existing.kind !== 'settlement' || canonicalStoredIntent(existing) !== canonicalRecordIntent(intent)) {
        throw remittanceError('This idempotency key was already used for different reconciliation intent.', 409, 'PLATFORM_REMITTANCE_IDEMPOTENCY_CONFLICT');
    }
    return existing;
}

function assertReversalRetryCompatible(existing, intent) {
    if (existing.kind !== 'reversal' || Number(existing.reverses_remittance_id) !== intent.remittanceId || Number(existing.recorded_by) !== intent.actorId || existing.reason !== intent.reason) {
        throw remittanceError('This idempotency key was already used for different reversal intent.', 409, 'PLATFORM_REMITTANCE_IDEMPOTENCY_CONFLICT');
    }
    return existing;
}

function normalizeLockedBalances(rows, orderTypeId, allocations) {
    const byInvoice = new Map(rows.map(row => [Number(row.invoice_id), row]));
    if (byInvoice.size !== allocations.length) {
        throw remittanceError('One or more platform invoices were not found.', 409, 'PLATFORM_REMITTANCE_INVALID_INVOICE');
    }
    let signedAllocations = 0;
    for (const allocation of allocations) {
        const row = byInvoice.get(allocation.invoiceId);
        if (!row || Number(row.order_type_id) !== Number(orderTypeId)) {
            throw remittanceError('Every invoice must belong to the selected platform provider.', 409, 'PLATFORM_REMITTANCE_CROSS_PROVIDER');
        }
        const currentOpenCents = parseCents(String(row.open_amount), 'open amount');
        if (makeBalanceToken(orderTypeId, allocation.invoiceId, currentOpenCents) !== allocation.balanceToken) {
            throw remittanceError('An invoice balance changed. Reload the receivables before recording.', 409, 'PLATFORM_REMITTANCE_STALE_BALANCE');
        }
        if (currentOpenCents > 0 && (allocation.allocationCents <= 0 || allocation.allocationCents > currentOpenCents)) {
            throw remittanceError('The allocation exceeds the current provider balance.', 409, 'PLATFORM_REMITTANCE_ALLOCATION_BOUNDS');
        }
        if (currentOpenCents < 0 && (allocation.allocationCents >= 0 || allocation.allocationCents < currentOpenCents)) {
            throw remittanceError('The provider credit allocation exceeds the current credit.', 409, 'PLATFORM_REMITTANCE_ALLOCATION_BOUNDS');
        }
        if (currentOpenCents === 0) {
            throw remittanceError('An invoice with no open balance cannot be allocated.', 409, 'PLATFORM_REMITTANCE_ALLOCATION_BOUNDS');
        }
        signedAllocations += allocation.allocationCents;
    }
    return signedAllocations;
}

function validateEquation(intent, signedAllocations) {
    const deductions = intent.adjustments
        .filter(row => row.direction === 'deduction')
        .reduce((sum, row) => sum + row.amountCents, 0);
    const additions = intent.adjustments
        .filter(row => row.direction === 'addition')
        .reduce((sum, row) => sum + row.amountCents, 0);
    const computedNet = signedAllocations - deductions + additions;
    if (signedAllocations <= 0) {
        throw remittanceError('At least one positive invoice allocation is required.', 400, 'PLATFORM_REMITTANCE_INVALID_ALLOCATIONS');
    }
    if (computedNet < 0) {
        throw remittanceError('The reconciled payout cannot be negative.', 400, 'PLATFORM_REMITTANCE_NEGATIVE_NET');
    }
    if (intent.netReceivedCents === 0 && (intent.adjustments.length === 0 || signedAllocations <= 0)) {
        throw remittanceError('A zero payout must be fully explained by an allocation and adjustment.', 400, 'PLATFORM_REMITTANCE_INVALID_ZERO_PAYOUT');
    }
    if (intent.netReceivedCents !== computedNet) {
        throw remittanceError('The entered payout does not match the invoice allocations and statement adjustments.', 409, 'PLATFORM_REMITTANCE_EQUATION_MISMATCH');
    }
    return { deductions, additions, computedNet };
}

async function recordPlatformRemittance(conn, input) {
    const intent = normalizeRecordInput(input);
    if (!intent.invoiceAllocations.length) {
        throw remittanceError('At least one invoice allocation is required.', 400, 'PLATFORM_REMITTANCE_INVALID_ALLOCATIONS');
    }

    const existing = await findByIdempotencyKey(conn, intent.idempotencyKey);
    if (existing) return assertRecordRetryCompatible(existing, intent);

    let started = false;
    try {
        await conn.beginTransaction();
        started = true;
        const invoiceIds = intent.invoiceAllocations.map(row => row.invoiceId).sort((left, right) => left - right);
        const placeholders = invoiceIds.map(() => '?').join(',');
        const [lockedOrders] = await conn.query(`
            SELECT invoice_id, payment_method, order_type_id
              FROM orders
             WHERE invoice_id IN (${placeholders})
             ORDER BY invoice_id
             FOR UPDATE
        `, invoiceIds);
        if (lockedOrders.length !== invoiceIds.length) {
            throw remittanceError('One or more platform invoices were not found.', 409, 'PLATFORM_REMITTANCE_INVALID_INVOICE');
        }
        if (lockedOrders.some(row => row.payment_method !== 'platform')) {
            throw remittanceError('Only finalized platform invoices can be reconciled.', 409, 'PLATFORM_REMITTANCE_INVALID_INVOICE');
        }
        if (lockedOrders.some(row => Number(row.order_type_id) !== intent.orderTypeId)) {
            throw remittanceError('Every invoice must belong to the selected platform provider.', 409, 'PLATFORM_REMITTANCE_CROSS_PROVIDER');
        }

        const [[insideExisting]] = await conn.query(
            'SELECT id FROM platform_remittances WHERE idempotency_key = ? LIMIT 1 FOR UPDATE',
            [intent.idempotencyKey]
        );
        if (insideExisting) {
            await conn.rollback();
            started = false;
            return assertRecordRetryCompatible(await getRemittance(conn, Number(insideExisting.id)), intent);
        }

        const currentRows = await loadReceivableRows(conn, intent.orderTypeId, { invoiceIds });
        const signedAllocations = normalizeLockedBalances(currentRows, intent.orderTypeId, intent.invoiceAllocations);
        const equation = validateEquation(intent, signedAllocations);
        const [[provider]] = await conn.query(
            'SELECT name FROM order_types WHERE id = ? LIMIT 1',
            [intent.orderTypeId]
        );
        const providerName = String(provider?.name || `Provider #${intent.orderTypeId}`).trim();
        const [headerResult] = await conn.query(`
            INSERT INTO platform_remittances
                (order_type_id, provider_name_at_entry, kind, statement_start_date,
                 statement_end_date, settled_on, reference, net_received,
                 recorded_by, idempotency_key)
            VALUES (?, ?, 'settlement', ?, ?, ?, ?, ?, ?, ?)
        `, [
            intent.orderTypeId,
            providerName,
            intent.statementStartDate,
            intent.statementEndDate,
            intent.settledOn,
            intent.reference,
            amountFromCents(intent.netReceivedCents),
            intent.actorId,
            intent.idempotencyKey
        ]);
        const remittanceId = Number(headerResult.insertId);
        for (const allocation of intent.invoiceAllocations) {
            await conn.query(
                'INSERT INTO platform_remittance_lines (remittance_id, invoice_id, allocated_amount) VALUES (?, ?, ?)',
                [remittanceId, allocation.invoiceId, amountFromCents(allocation.allocationCents)]
            );
        }
        for (const adjustment of intent.adjustments) {
            await conn.query(
                'INSERT INTO platform_remittance_adjustments (remittance_id, direction, category, amount, note) VALUES (?, ?, ?, ?, ?)',
                [remittanceId, adjustment.direction, adjustment.category, amountFromCents(adjustment.amountCents), adjustment.note]
            );
        }
        await appendAuditEvent(conn, {
            eventType: 'platform_remittance_recorded',
            userId: intent.actorId,
            entityType: 'platform_remittance',
            entityId: remittanceId,
            oldValue: null,
            newValue: {
                order_type_id: intent.orderTypeId,
                provider_name: providerName,
                settled_on: intent.settledOn,
                statement_start_date: intent.statementStartDate,
                statement_end_date: intent.statementEndDate,
                reference: intent.reference,
                invoice_allocations: intent.invoiceAllocations.map(row => ({ invoice_id: row.invoiceId, amount: amountFromCents(row.allocationCents) })),
                adjustments: intent.adjustments.map(row => ({ direction: row.direction, category: row.category, amount: amountFromCents(row.amountCents), note: row.note })),
                net_received: amountFromCents(intent.netReceivedCents),
                computed_net: amountFromCents(equation.computedNet),
                unreconciled_difference: 0
            },
            ipAddress: intent.ipAddress
        });
        await conn.commit();
        started = false;
        return getRemittance(conn, remittanceId);
    } catch (error) {
        if (started) await conn.rollback().catch(() => {});
        if (error?.code === 'ER_DUP_ENTRY') {
            const winner = await findByIdempotencyKey(conn, intent.idempotencyKey);
            if (winner) return assertRecordRetryCompatible(winner, intent);
        }
        throw error;
    }
}

async function reversePlatformRemittance(conn, input) {
    const intent = normalizeReversalInput(input);
    const existing = await findByIdempotencyKey(conn, intent.idempotencyKey);
    if (existing) return assertReversalRetryCompatible(existing, intent);

    let started = false;
    try {
        await conn.beginTransaction();
        started = true;
        const [[original]] = await conn.query(
            'SELECT * FROM platform_remittances WHERE id = ? LIMIT 1 FOR UPDATE',
            [intent.remittanceId]
        );
        if (!original) throw remittanceError('Remittance not found.', 404, 'PLATFORM_REMITTANCE_NOT_FOUND');
        if (original.kind !== 'settlement') {
            throw remittanceError('Only a settlement can be reversed.', 409, 'PLATFORM_REMITTANCE_INVALID_REVERSAL');
        }
        const [[priorReversal]] = await conn.query(
            'SELECT id FROM platform_remittances WHERE reverses_remittance_id = ? LIMIT 1',
            [intent.remittanceId]
        );
        if (priorReversal) {
            throw remittanceError('This remittance has already been reversed.', 409, 'PLATFORM_REMITTANCE_ALREADY_REVERSED');
        }
        const [[insideExisting]] = await conn.query(
            'SELECT id FROM platform_remittances WHERE idempotency_key = ? LIMIT 1 FOR UPDATE',
            [intent.idempotencyKey]
        );
        if (insideExisting) {
            await conn.rollback();
            started = false;
            return assertReversalRetryCompatible(await getRemittance(conn, Number(insideExisting.id)), intent);
        }
        const originalDetail = await getRemittance(conn, intent.remittanceId);
        const [headerResult] = await conn.query(`
            INSERT INTO platform_remittances
                (order_type_id, provider_name_at_entry, kind, statement_start_date,
                 statement_end_date, settled_on, reference, net_received,
                 reverses_remittance_id, reason, recorded_by, idempotency_key)
            VALUES (?, ?, 'reversal', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            original.order_type_id,
            original.provider_name_at_entry,
            original.statement_start_date,
            original.statement_end_date,
            getBusinessDate(),
            original.reference,
            original.net_received,
            intent.remittanceId,
            intent.reason,
            intent.actorId,
            intent.idempotencyKey
        ]);
        const reversalId = Number(headerResult.insertId);
        for (const allocation of originalDetail.allocations) {
            await conn.query(
                'INSERT INTO platform_remittance_lines (remittance_id, invoice_id, allocated_amount) VALUES (?, ?, ?)',
                [reversalId, allocation.invoice_id, allocation.allocated_amount]
            );
        }
        for (const adjustment of originalDetail.adjustments) {
            await conn.query(
                'INSERT INTO platform_remittance_adjustments (remittance_id, direction, category, amount, note) VALUES (?, ?, ?, ?, ?)',
                [reversalId, adjustment.direction, adjustment.category, Math.abs(adjustment.amount), adjustment.note]
            );
        }
        await appendAuditEvent(conn, {
            eventType: 'platform_remittance_reversed',
            userId: intent.actorId,
            entityType: 'platform_remittance',
            entityId: reversalId,
            oldValue: null,
            newValue: {
                original_remittance_id: intent.remittanceId,
                reason: intent.reason,
                net_received: original.net_received,
                invoice_allocations: originalDetail.allocations,
                adjustments: originalDetail.adjustments
            },
            ipAddress: intent.ipAddress
        });
        await conn.commit();
        started = false;
        return getRemittance(conn, reversalId);
    } catch (error) {
        if (started) await conn.rollback().catch(() => {});
        if (error?.code === 'ER_DUP_ENTRY') {
            const winner = await findByIdempotencyKey(conn, intent.idempotencyKey);
            if (winner) return assertReversalRetryCompatible(winner, intent);
        }
        throw error;
    }
}

const PLATFORM_ALLOCATIONS_JOIN = `
    LEFT JOIN (
        SELECT prl.invoice_id,
               SUM(CASE WHEN pr.kind='reversal' THEN -prl.allocated_amount ELSE prl.allocated_amount END) AS signed_allocated
          FROM platform_remittance_lines prl
          JOIN platform_remittances pr ON pr.id = prl.remittance_id
         GROUP BY prl.invoice_id
    ) alloc ON alloc.invoice_id = o.invoice_id`;

async function loadReceivableRows(executor, orderTypeId = null, { lock = false, invoiceIds = null } = {}) {
    const params = [];
    const where = ["o.payment_method = 'platform'", 'o.order_type_id IS NOT NULL'];
    if (orderTypeId != null) {
        where.push('o.order_type_id = ?');
        params.push(normalizeOrderTypeId(orderTypeId));
    }
    if (Array.isArray(invoiceIds)) {
        const normalizedIds = invoiceIds.map(value => Number(value));
        if (normalizedIds.some(value => !Number.isInteger(value) || value <= 0)) {
            throw remittanceError('Invalid invoice allocation.', 400, 'PLATFORM_REMITTANCE_INVALID_INVOICE');
        }
        if (normalizedIds.length === 0) return [];
        where.push(`o.invoice_id IN (${normalizedIds.map(() => '?').join(',')})`);
        params.push(...normalizedIds);
    }
    const lockClause = lock ? ' FOR UPDATE' : '';
    const [rows] = await executor.query(`
        SELECT o.invoice_id,
               o.invoice_number,
               o.order_id,
               o.invoice_issued_at,
               o.created_at,
               o.order_type_id,
               o.total AS invoice_total,
               COALESCE(rf.platform, 0) AS platform_refunded,
               COALESCE(alloc.signed_allocated, 0) AS signed_allocated
          FROM orders o
          ${REFUNDS_ROLLUP_JOIN}
          ${PLATFORM_ALLOCATIONS_JOIN}
         WHERE ${where.join(' AND ')}
         ORDER BY o.order_type_id, o.invoice_id${lockClause}
    `, params);

    return rows.map((row) => {
        const invoiceId = Number(row.invoice_id);
        const providerId = Number(row.order_type_id);
        const netSaleCents = dbCents(row.invoice_total, 'invoice total') - dbCents(row.platform_refunded, 'platform refund');
        const previousAllocationCents = dbCents(row.signed_allocated, 'previous allocation');
        const openCents = netSaleCents - previousAllocationCents;
        return {
            invoice_id: invoiceId,
            invoice_number: row.invoice_number == null ? null : String(row.invoice_number),
            order_id: row.order_id == null ? null : Number(row.order_id),
            sale_date: row.invoice_issued_at || row.created_at || null,
            invoice_issued_at: row.invoice_issued_at || null,
            order_type_id: providerId,
            gross_total: moneySummary(dbCents(row.invoice_total, 'invoice total')),
            platform_refunded: moneySummary(dbCents(row.platform_refunded, 'platform refund')),
            net_platform_sale: moneySummary(netSaleCents),
            previous_allocations: moneySummary(previousAllocationCents),
            open_amount: moneySummary(openCents),
            balance_token: makeBalanceToken(providerId, invoiceId, openCents)
        };
    }).filter(row => row.open_amount !== 0);
}

async function listReceivables(executor, orderTypeId) {
    return loadReceivableRows(executor, orderTypeId);
}

async function listProviders(executor) {
    const [providers] = await executor.query(`
        SELECT ids.order_type_id,
               ot.name AS provider_name,
               ot.is_active,
               latest.provider_name_at_entry
          FROM (
              SELECT DISTINCT order_type_id
                FROM orders
               WHERE payment_method='platform' AND order_type_id IS NOT NULL
              UNION
              SELECT DISTINCT order_type_id
                FROM platform_remittances
          ) ids
          LEFT JOIN order_types ot ON ot.id = ids.order_type_id
          LEFT JOIN (
              SELECT r.order_type_id, r.provider_name_at_entry
                FROM platform_remittances r
                JOIN (
                    SELECT order_type_id, MAX(id) AS id
                      FROM platform_remittances
                     GROUP BY order_type_id
                ) latest_id ON latest_id.id = r.id
          ) latest ON latest.order_type_id = ids.order_type_id
         ORDER BY ids.order_type_id
    `);
    // Aggregate exact DECIMAL amounts before transfer; summaries need no invoice tokens.
    const [balances] = await executor.query(`
        SELECT order_type_id,
               SUM(GREATEST(open_amount, 0)) * 100 AS gross_due_cents,
               SUM(-LEAST(open_amount, 0)) * 100 AS credit_cents,
               MAX(ABS(platform_refunded)) AS max_platform_refunded,
               MAX(ABS(previous_allocations)) AS max_previous_allocation,
               MAX(ABS(open_amount)) AS max_open_amount
          FROM (
              SELECT o.order_type_id,
                     COALESCE(rf.platform, 0) AS platform_refunded,
                     COALESCE(alloc.signed_allocated, 0) AS previous_allocations,
                     o.total - COALESCE(rf.platform, 0) - COALESCE(alloc.signed_allocated, 0) AS open_amount
                FROM orders o
                ${REFUNDS_ROLLUP_JOIN}
                ${PLATFORM_ALLOCATIONS_JOIN}
               WHERE o.payment_method='platform' AND o.order_type_id IS NOT NULL
          ) balances
         GROUP BY order_type_id
    `);
    const byProvider = new Map();
    for (const row of balances) {
        // Retain per-invoice limits, including settled rows. Provider sums may exceed them.
        dbCents(row.max_platform_refunded, 'platform refund');
        dbCents(row.max_previous_allocation, 'previous allocation');
        dbCents(row.max_open_amount, 'open amount');
        byProvider.set(Number(row.order_type_id), {
            grossDueCents: Number(row.gross_due_cents),
            creditCents: Number(row.credit_cents),
        });
    }
    return providers.map((provider) => {
        const id = Number(provider.order_type_id);
        const entry = byProvider.get(id) || { grossDueCents: 0, creditCents: 0 };
        return {
            order_type_id: id,
            provider_name: normalizeProviderName(provider),
            is_active: provider.is_active == null ? null : Number(provider.is_active) === 1,
            gross_due: moneySummary(entry.grossDueCents),
            provider_credit: moneySummary(entry.creditCents),
            net_outstanding: moneySummary(entry.grossDueCents - entry.creditCents)
        };
    });
}

async function loadRemittanceRows(executor, { startDate = null, endDate = null, orderTypeId = null, id = null } = {}) {
    const params = [];
    const where = [];
    if (id != null) {
        where.push('r.id = ?');
        params.push(Number(id));
    }
    if (orderTypeId != null) {
        where.push('r.order_type_id = ?');
        params.push(normalizeOrderTypeId(orderTypeId));
    }
    if (startDate != null) {
        where.push('r.settled_on >= ?');
        params.push(normalizeDate(startDate, 'start date'));
    }
    if (endDate != null) {
        where.push('r.settled_on <= ?');
        params.push(normalizeDate(endDate, 'end date'));
    }
    if (startDate != null && endDate != null && startDate > endDate) {
        throw remittanceError('Start date must not be after end date.', 400, 'PLATFORM_REMITTANCE_INVALID_DATE_RANGE');
    }
    const [headers] = await executor.query(`
        SELECT r.id, r.order_type_id, r.provider_name_at_entry, r.kind,
               r.statement_start_date, r.statement_end_date, r.settled_on,
               r.reference, r.net_received, r.reverses_remittance_id,
               r.reason, r.recorded_by, r.idempotency_key, r.created_at,
               reversal.id AS reversal_id
          FROM platform_remittances r
          LEFT JOIN platform_remittances reversal
            ON reversal.reverses_remittance_id = r.id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY r.settled_on DESC, r.id DESC
    `, params);
    if (!headers.length) return { headers, lines: [], adjustments: [] };
    const ids = headers.map(row => Number(row.id));
    const placeholders = ids.map(() => '?').join(',');
    const [lines] = await executor.query(`
        SELECT remittance_id, invoice_id, allocated_amount
          FROM platform_remittance_lines
         WHERE remittance_id IN (${placeholders})
         ORDER BY remittance_id, id
    `, ids);
    const [adjustments] = await executor.query(`
        SELECT remittance_id, direction, category, amount, note
          FROM platform_remittance_adjustments
         WHERE remittance_id IN (${placeholders})
         ORDER BY remittance_id, id
    `, ids);
    return { headers, lines, adjustments };
}

function summarizeRemittanceRows(headers, lines, adjustments) {
    const linesByRemittance = new Map();
    for (const line of lines) {
        const group = linesByRemittance.get(Number(line.remittance_id)) || [];
        group.push(line);
        linesByRemittance.set(Number(line.remittance_id), group);
    }
    const adjustmentsByRemittance = new Map();
    for (const adjustment of adjustments) {
        const group = adjustmentsByRemittance.get(Number(adjustment.remittance_id)) || [];
        group.push(adjustment);
        adjustmentsByRemittance.set(Number(adjustment.remittance_id), group);
    }
    return headers.map((header) => {
        const sign = signedKind(header.kind);
        let invoiceAllocations = 0;
        let positiveAllocations = 0;
        let providerCreditsApplied = 0;
        for (const line of linesByRemittance.get(Number(header.id)) || []) {
            const storedCents = dbCents(line.allocated_amount, 'allocated amount');
            const cents = sign * storedCents;
            invoiceAllocations += cents;
            if (storedCents > 0) positiveAllocations += cents;
            else providerCreditsApplied += sign * -storedCents;
        }
        let deductions = 0;
        let additions = 0;
        const adjustmentsByCategory = emptyCategoryTotals();
        const deductionsByCategory = emptyCategoryTotals();
        const additionsByCategory = emptyCategoryTotals();
        for (const adjustment of adjustmentsByRemittance.get(Number(header.id)) || []) {
            const cents = sign * dbCents(adjustment.amount, 'adjustment amount');
            if (adjustment.direction === 'deduction') {
                deductions += cents;
                deductionsByCategory[adjustment.category] += cents;
            } else {
                additions += cents;
                additionsByCategory[adjustment.category] += cents;
            }
            if (Object.prototype.hasOwnProperty.call(adjustmentsByCategory, adjustment.category)) {
                adjustmentsByCategory[adjustment.category] += cents;
            }
        }
        const netReceived = sign * dbCents(header.net_received, 'net received');
        const computedNet = invoiceAllocations - deductions + additions;
        return {
            id: Number(header.id),
            order_type_id: Number(header.order_type_id),
            provider_name: String(header.provider_name_at_entry || `Provider #${Number(header.order_type_id)}`),
            kind: header.kind,
            statement_start_date: dateOnlyValue(header.statement_start_date),
            statement_end_date: dateOnlyValue(header.statement_end_date),
            settled_on: dateOnlyValue(header.settled_on),
            reference: header.reference || null,
            net_received: moneySummary(netReceived),
            reverses_remittance_id: header.reverses_remittance_id == null ? null : Number(header.reverses_remittance_id),
            reversal_id: header.reversal_id == null ? null : Number(header.reversal_id),
            reason: header.reason || null,
            recorded_by: header.recorded_by == null ? null : Number(header.recorded_by),
            idempotency_key: header.idempotency_key,
            created_at: header.created_at,
            positive_allocations: moneySummary(positiveAllocations),
            provider_credits_applied: moneySummary(providerCreditsApplied),
            invoice_allocations: moneySummary(invoiceAllocations),
            deductions: moneySummary(deductions),
            additions: moneySummary(additions),
            computed_net: moneySummary(computedNet),
            unreconciled_difference: moneySummary(netReceived - computedNet),
            adjustments_by_category: Object.fromEntries(Object.entries(adjustmentsByCategory).map(([key, value]) => [key, moneySummary(value)])),
            deductions_by_category: Object.fromEntries(Object.entries(deductionsByCategory).map(([key, value]) => [key, moneySummary(value)])),
            additions_by_category: Object.fromEntries(Object.entries(additionsByCategory).map(([key, value]) => [key, moneySummary(value)])),
            allocations: (linesByRemittance.get(Number(header.id)) || []).map(line => ({
                invoice_id: Number(line.invoice_id),
                allocated_amount: moneySummary(sign * dbCents(line.allocated_amount, 'allocated amount'))
            })),
            adjustments: (adjustmentsByRemittance.get(Number(header.id)) || []).map(adjustment => ({
                direction: adjustment.direction,
                category: adjustment.category,
                amount: moneySummary(sign * dbCents(adjustment.amount, 'adjustment amount')),
                note: adjustment.note || null
            }))
        };
    });
}

async function listRemittances(executor, filters = {}) {
    const rows = await loadRemittanceRows(executor, filters);
    return summarizeRemittanceRows(rows.headers, rows.lines, rows.adjustments);
}

async function getRemittance(executor, remittanceId) {
    const id = Number(remittanceId);
    if (!Number.isInteger(id) || id <= 0) throw remittanceError('Invalid remittance.', 400, 'PLATFORM_REMITTANCE_INVALID_ID');
    const rows = await loadRemittanceRows(executor, { id });
    if (!rows.headers.length) throw remittanceError('Remittance not found.', 404, 'PLATFORM_REMITTANCE_NOT_FOUND');
    return summarizeRemittanceRows(rows.headers, rows.lines, rows.adjustments)[0];
}

async function getRangeTotals(executor, { startDate, endDate, orderTypeId = null } = {}) {
    const normalizedStart = normalizeDate(startDate, 'start date');
    const normalizedEnd = normalizeDate(endDate, 'end date');
    if (normalizedStart > normalizedEnd) {
        throw remittanceError('Start date must not be after end date.', 400, 'PLATFORM_REMITTANCE_INVALID_DATE_RANGE');
    }
    const rows = await loadRemittanceRows(executor, {
        startDate: normalizedStart,
        endDate: normalizedEnd,
        orderTypeId
    });
    const summaries = summarizeRemittanceRows(rows.headers, rows.lines, rows.adjustments);
    const totals = {
        positiveAllocations: 0,
        providerCreditsApplied: 0,
        invoiceAllocations: 0,
        deductions: 0,
        additions: 0,
        netReceived: 0,
        settlementCount: 0,
        reversalCount: 0,
        adjustmentsByCategory: emptyCategoryTotals(),
        deductionsByCategory: emptyCategoryTotals(),
        additionsByCategory: emptyCategoryTotals()
    };
    for (const summary of summaries) {
        totals.positiveAllocations += parseCents(String(summary.positive_allocations), 'positive allocations');
        totals.providerCreditsApplied += parseCents(String(summary.provider_credits_applied), 'provider credits');
        totals.invoiceAllocations += parseCents(String(summary.invoice_allocations), 'invoice allocations');
        totals.deductions += parseCents(String(summary.deductions), 'deductions');
        totals.additions += parseCents(String(summary.additions), 'additions');
        totals.netReceived += parseCents(String(summary.net_received), 'net received');
        if (summary.kind === 'reversal') totals.reversalCount += 1;
        else totals.settlementCount += 1;
        for (const category of ADJUSTMENT_CATEGORIES) {
            totals.adjustmentsByCategory[category] += parseCents(String(summary.adjustments_by_category[category]), 'adjustment category');
            totals.deductionsByCategory[category] += parseCents(String(summary.deductions_by_category[category]), 'deduction category');
            totals.additionsByCategory[category] += parseCents(String(summary.additions_by_category[category]), 'addition category');
        }
    }
    const computedNet = totals.invoiceAllocations - totals.deductions + totals.additions;
    return {
        start_date: normalizedStart,
        end_date: normalizedEnd,
        positive_allocations: moneySummary(totals.positiveAllocations),
        provider_credits_applied: moneySummary(totals.providerCreditsApplied),
        invoice_allocations: moneySummary(totals.invoiceAllocations),
        deductions: moneySummary(totals.deductions),
        additions: moneySummary(totals.additions),
        net_received: moneySummary(totals.netReceived),
        computed_net: moneySummary(computedNet),
        unreconciled_difference: moneySummary(totals.netReceived - computedNet),
        adjustments_by_category: Object.fromEntries(Object.entries(totals.adjustmentsByCategory).map(([key, value]) => [key, moneySummary(value)])),
        deductions_by_category: Object.fromEntries(Object.entries(totals.deductionsByCategory).map(([key, value]) => [key, moneySummary(value)])),
        additions_by_category: Object.fromEntries(Object.entries(totals.additionsByCategory).map(([key, value]) => [key, moneySummary(value)])),
        settlement_count: totals.settlementCount,
        reversal_count: totals.reversalCount
    };
}

module.exports = {
    listProviders,
    listReceivables,
    listRemittances,
    getRemittance,
    getRangeTotals,
    recordPlatformRemittance,
    reversePlatformRemittance
};
