const express = require('express');
const router = express.Router();
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { sendAdminError, sendAdminSuccess } = require('../../http/jsonResponse');
const { announceStockDocument: announce } = require('../../services/StockEventScope');
const counts = require('../../services/StockCountService');

// Admin only: backend/routes/admin.js guards every route mounted under it.

const actorOf = (req) => ({ id: req.user.id, name: req.user.name });

function sendFailure(req, res, error) {
    if (error instanceof counts.CountError) {
        // STOCK_COUNT_ALREADY_OPEN carries the open count's id so the screen can jump to it.
        if (error.data) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message, data: error.data });
        return sendAdminError(res, error.statusCode, error.message, error.code);
    }
    logger.error({ err: error, route: req.originalUrl, method: req.method, userId: req.user?.id }, 'Stock count operation failed.');
    return sendAdminError(res, 500, 'Stock count operation failed.');
}

const handle = (work) => async (req, res) => {
    try {
        return await work(req, res);
    } catch (error) {
        return sendFailure(req, res, error);
    }
};

function countId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0 || !/^\d+$/.test(String(value))) throw new counts.CountError(400, 'STOCK_COUNT_INVALID', 'Stock count is invalid.');
    return id;
}

function pageLimit(value, fallback, max) {
    if (value == null || value === '') return fallback;
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new counts.CountError(400, 'STOCK_COUNT_INVALID', 'limit is invalid.');
    return Math.min(limit, max);
}

router.get('/', handle(async (req, res) => {
    const status = req.query.status == null || req.query.status === '' ? null : String(req.query.status);
    if (status && !['draft', 'posted'].includes(status)) throw new counts.CountError(400, 'STOCK_COUNT_INVALID', 'status is invalid.');
    const beforeId = req.query.before_id == null || req.query.before_id === '' ? null : countId(req.query.before_id);
    const page = await counts.listCounts(pool, { status, beforeId, limit: pageLimit(req.query.limit, 30, 100) });
    return sendAdminSuccess(res, page);
}));

// Registered before /:id so these words are not read as an id.
router.get('/groups', handle(async (_req, res) => sendAdminSuccess(res, { data: await counts.listGroups(pool) })));

router.get('/items', handle(async (req, res) => {
    const data = await counts.searchItems(pool, { q: String(req.query.q ?? ''), limit: pageLimit(req.query.limit, 30, 200) });
    return sendAdminSuccess(res, { data });
}));

router.post('/', handle(async (req, res) => {
    const { count } = await counts.createCount(pool, req.body || {}, actorOf(req));
    return sendAdminSuccess(res, { data: count });
}));

router.get('/:id', handle(async (req, res) => sendAdminSuccess(res, { data: await counts.getCount(pool, countId(req.params.id)) })));

router.put('/:id/lines', handle(async (req, res) => {
    return sendAdminSuccess(res, { data: await counts.saveLines(pool, countId(req.params.id), req.body || {}, actorOf(req)) });
}));

router.post('/:id/lines', handle(async (req, res) => {
    return sendAdminSuccess(res, { data: await counts.addLine(pool, countId(req.params.id), req.body || {}) });
}));

router.get('/:id/review', handle(async (req, res) => sendAdminSuccess(res, { data: await counts.review(pool, countId(req.params.id)) })));

router.post('/:id/post', handle(async (req, res) => {
    const result = await counts.postCount(pool, { id: countId(req.params.id), body: req.body || {}, actor: actorOf(req), ipAddress: req.ip });
    announce(req, result.scope);
    return sendAdminSuccess(res, { data: result.count });
}));

router.delete('/:id', handle(async (req, res) => {
    return sendAdminSuccess(res, { data: await counts.deleteCount(pool, countId(req.params.id), actorOf(req), req.ip) });
}));

module.exports = router;
