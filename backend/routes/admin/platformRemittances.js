'use strict';

const express = require('express');
const router = express.Router();
const {
    pool,
    sendSuccess,
    sendError,
    logAdminRouteError
} = require('./helpers');
const PlatformRemittanceService = require('../../services/PlatformRemittanceService');

const RECORD_KEYS = new Set([
    'order_type_id',
    'invoice_allocations',
    'adjustments',
    'net_received',
    'settled_on',
    'statement_start_date',
    'statement_end_date',
    'reference',
    'idempotency_key'
]);
const ALLOCATION_KEYS = new Set(['invoice_id', 'balance_token', 'allocation_amount']);
const ADJUSTMENT_KEYS = new Set(['direction', 'category', 'amount', 'note']);

function rejectUnknownKeys(value, allowed, message = 'Unknown request field.') {
    const body = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const unknown = Object.keys(body).find(key => !allowed.has(key));
    if (unknown) {
        const error = new Error(`${message} ${unknown}`);
        error.statusCode = 400;
        error.publicCode = 'PLATFORM_REMITTANCE_UNKNOWN_FIELD';
        throw error;
    }
}

function mapRecordInput(body = {}, req) {
    rejectUnknownKeys(body, RECORD_KEYS);
    const allocations = body.invoice_allocations;
    if (allocations !== undefined) {
        if (!Array.isArray(allocations)) {
            const error = new Error('Invoice allocations must be an array.');
            error.statusCode = 400;
            error.publicCode = 'PLATFORM_REMITTANCE_INVALID_ALLOCATIONS';
            throw error;
        }
        allocations.forEach((allocation) => rejectUnknownKeys(allocation, ALLOCATION_KEYS, 'Unknown allocation field.'));
    }
    const adjustments = body.adjustments;
    if (adjustments !== undefined) {
        if (!Array.isArray(adjustments)) {
            const error = new Error('Adjustments must be an array.');
            error.statusCode = 400;
            error.publicCode = 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENTS';
            throw error;
        }
        adjustments.forEach((adjustment) => rejectUnknownKeys(adjustment, ADJUSTMENT_KEYS, 'Unknown adjustment field.'));
    }
    return {
        actorId: req.user.id,
        ipAddress: req.ip || null,
        orderTypeId: body.order_type_id,
        invoiceAllocations: allocations === undefined ? undefined : allocations.map(allocation => ({
            invoiceId: allocation.invoice_id,
            balanceToken: allocation.balance_token,
            allocationAmount: allocation.allocation_amount
        })),
        adjustments,
        netReceived: body.net_received,
        settledOn: body.settled_on,
        statementStartDate: body.statement_start_date,
        statementEndDate: body.statement_end_date,
        reference: body.reference,
        idempotencyKey: body.idempotency_key
    };
}

function mapReversalInput(body = {}, req, remittanceId) {
    rejectUnknownKeys(body, new Set(['reason', 'idempotency_key']));
    return {
        actorId: req.user.id,
        ipAddress: req.ip || null,
        remittanceId,
        reason: body.reason,
        idempotencyKey: body.idempotency_key
    };
}

function sendRouteError(req, res, error, fallback) {
    const status = error.statusCode || 500;
    if (status >= 500) logAdminRouteError(req, error);
    return sendError(res, status, status >= 500 ? fallback : error.message, error.publicCode || null);
}

async function withConnection(operation) {
    const conn = await pool.getConnection();
    try {
        return await operation(conn);
    } finally {
        conn.release();
    }
}

// Static paths must remain above /:id so `providers` and `receivables` cannot be
// interpreted as malformed remittance IDs.
router.get('/platform-remittances/providers', async (req, res) => {
    try {
        return sendSuccess(res, { providers: await PlatformRemittanceService.listProviders(pool) });
    } catch (error) {
        return sendRouteError(req, res, error, 'Failed to load platform providers.');
    }
});

router.get('/platform-remittances/receivables', async (req, res) => {
    try {
        return sendSuccess(res, {
            receivables: await PlatformRemittanceService.listReceivables(pool, req.query.order_type_id)
        });
    } catch (error) {
        return sendRouteError(req, res, error, 'Failed to load platform receivables.');
    }
});

router.get('/platform-remittances', async (req, res) => {
    try {
        const filters = {};
        if (req.query.order_type_id !== undefined) filters.orderTypeId = req.query.order_type_id;
        if (req.query.start_date !== undefined) filters.startDate = req.query.start_date;
        if (req.query.end_date !== undefined) filters.endDate = req.query.end_date;
        return sendSuccess(res, { remittances: await PlatformRemittanceService.listRemittances(pool, filters) });
    } catch (error) {
        return sendRouteError(req, res, error, 'Failed to load platform remittances.');
    }
});

router.post('/platform-remittances', async (req, res) => {
    let input;
    try {
        input = mapRecordInput(req.body, req);
    } catch (error) {
        return sendRouteError(req, res, error, 'Invalid platform reconciliation request.');
    }
    try {
        const remittance = await withConnection(async (conn) => PlatformRemittanceService.recordPlatformRemittance(conn, input));
        return sendSuccess(res, { remittance });
    } catch (error) {
        return sendRouteError(req, res, error, 'Failed to record platform remittance.');
    }
});

router.get('/platform-remittances/:id', async (req, res) => {
    try {
        return sendSuccess(res, { remittance: await PlatformRemittanceService.getRemittance(pool, req.params.id) });
    } catch (error) {
        return sendRouteError(req, res, error, 'Failed to load platform remittance.');
    }
});

router.post('/platform-remittances/:id/reverse', async (req, res) => {
    let input;
    try {
        input = mapReversalInput(req.body, req, req.params.id);
    } catch (error) {
        return sendRouteError(req, res, error, 'Invalid platform remittance reversal request.');
    }
    try {
        const remittance = await withConnection(async (conn) => PlatformRemittanceService.reversePlatformRemittance(conn, input));
        return sendSuccess(res, { remittance });
    } catch (error) {
        return sendRouteError(req, res, error, 'Failed to reverse platform remittance.');
    }
});

module.exports = router;
