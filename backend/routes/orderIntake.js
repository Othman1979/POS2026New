'use strict';

const express = require('express');
const logger = require('../config/logger');
const { sendPosError: sendError, sendPosSuccess: sendSuccess } = require('../http/jsonResponse');
const { createKeyedRateLimiter } = require('../middleware/rateLimit');
const { requireOrderIntakeAuth } = require('../modules/orderIntake/auth');
const { readOrderIntakeConfig } = require('../modules/orderIntake/config');
const { normalizeCustomerLookup } = require('../modules/orderIntake/contract');
const service = require('../modules/orderIntake/service');

const router = express.Router();
const initialConfig = readOrderIntakeConfig();
const requestLimit = createKeyedRateLimiter({
    windowMs: 60_000,
    max: initialConfig.requestRateLimit,
    maxEntries: 100,
    code: 'ORDER_INTAKE_RATE_LIMITED',
    message: 'Too many order-intake requests. Try again shortly.',
    keyForRequest: req => req.orderIntake?.clientId,
});
const creationLimit = createKeyedRateLimiter({
    windowMs: 60_000,
    max: initialConfig.createRateLimit,
    maxEntries: 100,
    code: 'ORDER_INTAKE_CREATE_RATE_LIMITED',
    message: 'Too many held orders are being created. Try again shortly.',
    keyForRequest: req => req.orderIntake?.clientId,
});

router.use(requireOrderIntakeAuth, requestLimit);

function respondError(res, error, operation, context = {}) {
    if (!error?.statusCode || Number(error.statusCode) >= 500) {
        logger.error({ err: error, operation, intakeClientId: context.clientId }, 'Order-intake request failed.');
    }
    if (error?.publicData && Number(error.statusCode) >= 400 && Number(error.statusCode) < 500) {
        return res.status(error.statusCode).json({
            success: false,
            code: error.publicCode || null,
            message: error.message,
            ...error.publicData,
        });
    }
    const statusCode = Number(error?.statusCode) || 500;
    const exposeMessage = statusCode < 500 || process.env.NODE_ENV !== 'production';
    const message = exposeMessage
        ? (error?.message || 'Order intake failed. Try again.')
        : 'Order intake failed. Try again.';
    return sendError(
        res,
        statusCode,
        message,
        error?.publicCode || null
    );
}

router.get('/status', async (req, res) => {
    try {
        const orderTypes = await service.listOrderTypes(req.orderIntake);
        return sendSuccess(res, {
            client_id: req.orderIntake.clientId,
            dispatch_policy: 'hold_only',
            capabilities: ['catalog.browse', 'catalog.search', 'customer.lookup', 'order.quote', 'held_order.create', 'request.lookup'],
            order_type_count: orderTypes.length,
        });
    } catch (error) {
        return respondError(res, error, 'status', req.orderIntake);
    }
});

router.get('/order-types', async (req, res) => {
    try {
        return sendSuccess(res, { order_types: await service.listOrderTypes(req.orderIntake) });
    } catch (error) {
        return respondError(res, error, 'order-types', req.orderIntake);
    }
});

router.get('/catalog/search', async (req, res) => {
    try {
        const result = await service.searchCatalog(req.query?.q, req.query?.limit, req.orderIntake);
        return sendSuccess(res, result);
    } catch (error) {
        return respondError(res, error, 'catalog-search', req.orderIntake);
    }
});

router.get('/catalog/browse', async (req, res) => {
    try {
        const result = await service.browseCatalog(
            req.query?.category_id,
            req.query?.cursor,
            req.query?.limit,
            req.orderIntake
        );
        return sendSuccess(res, result);
    } catch (error) {
        return respondError(res, error, 'catalog-browse', req.orderIntake);
    }
});

router.post('/customers/lookup', async (req, res) => {
    try {
        const phone = normalizeCustomerLookup(req.body);
        return sendSuccess(res, { customer: await service.lookupCustomer(phone, req.orderIntake) });
    } catch (error) {
        return respondError(res, error, 'customer-lookup', req.orderIntake);
    }
});

router.post('/quotes', async (req, res) => {
    try {
        const quoted = await service.quoteOrder(req.body, req.orderIntake);
        return sendSuccess(res, quoted.response);
    } catch (error) {
        return respondError(res, error, 'quote', req.orderIntake);
    }
});

router.post('/held-orders', creationLimit, async (req, res) => {
    try {
        const heldOrder = await service.submitHeldOrder(req.body, req.orderIntake, req.io);
        return sendSuccess(res, { held_order: heldOrder });
    } catch (error) {
        return respondError(res, error, 'held-order-create', req.orderIntake);
    }
});

router.get('/requests/:external_request_id', async (req, res) => {
    try {
        const requestResult = await service.lookupRequest(req.params.external_request_id, req.orderIntake);
        return sendSuccess(res, { request: requestResult });
    } catch (error) {
        return respondError(res, error, 'request-lookup', req.orderIntake);
    }
});

module.exports = router;
