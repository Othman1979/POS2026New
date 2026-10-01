const express = require('express');
const router = express.Router();
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { sendAdminError, sendAdminSuccess } = require('../../http/jsonResponse');
const { announceStockDocument: announce } = require('../../services/StockEventScope');
const purchases = require('../../services/PurchaseInvoiceService');

// Admin only: backend/routes/admin.js guards every route mounted under it.

const actorOf = (req) => ({ id: req.user.id, name: req.user.name });

function sendFailure(req, res, error) {
    if (error instanceof purchases.PurchaseError) return sendAdminError(res, error.statusCode, error.message, error.code);
    logger.error({ err: error, route: req.originalUrl, method: req.method, userId: req.user?.id }, 'Purchase invoice operation failed.');
    return sendAdminError(res, 500, 'Purchase invoice operation failed.');
}

const handle = (work) => async (req, res) => {
    try {
        return await work(req, res);
    } catch (error) {
        return sendFailure(req, res, error);
    }
};

function positive(value, label) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new purchases.PurchaseError(400, 'PURCHASE_REQUEST_INVALID', `${label} is invalid.`);
    return id;
}

const optionalPositive = (value, label) => (value == null || value === '' ? null : positive(value, label));

function beforeGroup(value) {
    if (value == null || value === '') return null;
    if (value !== 'draft' && value !== 'other') throw new purchases.PurchaseError(400, 'PURCHASE_REQUEST_INVALID', 'before_group is invalid.');
    return value;
}

function pageLimit(value, fallback, max) {
    if (value == null || value === '') return fallback;
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new purchases.PurchaseError(400, 'PURCHASE_REQUEST_INVALID', 'limit is invalid.');
    return Math.min(limit, max);
}

router.get('/suppliers', handle(async (req, res) => {
    const data = await purchases.listSuppliers(pool, { activeOnly: req.query.active === '1' });
    return sendAdminSuccess(res, { data });
}));

router.post('/suppliers', handle(async (req, res) => {
    return sendAdminSuccess(res, { data: await purchases.createSupplier(pool, req.body || {}) });
}));

router.put('/suppliers/:id', handle(async (req, res) => {
    return sendAdminSuccess(res, { data: await purchases.updateSupplier(pool, positive(req.params.id, 'Supplier'), req.body || {}) });
}));

router.get('/items', handle(async (req, res) => {
    const data = await purchases.searchItems(pool, {
        kind: purchases.purchaseKind(req.query.kind),
        q: String(req.query.q ?? ''),
        supplierId: optionalPositive(req.query.supplier_id, 'supplier_id'),
        categoryId: optionalPositive(req.query.category_id, 'category_id'),
        barcode: String(req.query.barcode ?? ''),
        limit: pageLimit(req.query.limit, 30, 200),
    });
    return sendAdminSuccess(res, { data });
}));

router.get('/items/insights', handle(async (req, res) => {
    const keys = String(req.query.keys ?? '').split(',').map((key) => key.trim()).filter(Boolean);
    const data = await purchases.itemInsights(pool, {
        kind: purchases.purchaseKind(req.query.kind),
        itemKeys: keys,
        supplierId: optionalPositive(req.query.supplier_id, 'supplier_id'),
    });
    return sendAdminSuccess(res, { data });
}));

router.get('/categories', handle(async (_req, res) => {
    return sendAdminSuccess(res, { data: await purchases.listCategories(pool) });
}));

router.get('/invoices', handle(async (req, res) => {
    const status = req.query.status == null || req.query.status === '' ? null : String(req.query.status);
    if (status && !['draft', 'posted', 'reversed'].includes(status)) {
        throw new purchases.PurchaseError(400, 'PURCHASE_REQUEST_INVALID', 'status is invalid.');
    }
    const page = await purchases.listInvoices(pool, {
        kind: purchases.purchaseKind(req.query.kind),
        status,
        supplierId: optionalPositive(req.query.supplier_id, 'supplier_id'),
        q: String(req.query.q ?? ''),
        beforeId: optionalPositive(req.query.before_id, 'before_id'),
        beforeGroup: beforeGroup(req.query.before_group),
        limit: pageLimit(req.query.limit, 30, 100),
    });
    return sendAdminSuccess(res, page);
}));

// Registered before /invoices/:id so "last" is not read as an id.
router.get('/invoices/last', handle(async (req, res) => {
    const last = await purchases.lastInvoiceForSupplier(pool, positive(req.query.supplier_id, 'supplier_id'), purchases.purchaseKind(req.query.kind));
    return sendAdminSuccess(res, last ? { data: last.lines, invoice: last.invoice } : { data: null });
}));

router.get('/invoices/:id', handle(async (req, res) => {
    return sendAdminSuccess(res, { data: await purchases.getInvoice(pool, positive(req.params.id, 'Invoice')) });
}));

router.post('/invoices', handle(async (req, res) => {
    const { invoice } = await purchases.createDraft(pool, req.body || {}, actorOf(req));
    return sendAdminSuccess(res, { data: invoice });
}));

router.put('/invoices/:id', handle(async (req, res) => {
    return sendAdminSuccess(res, { data: await purchases.updateDraft(pool, positive(req.params.id, 'Invoice'), req.body || {}) });
}));

router.delete('/invoices/:id', handle(async (req, res) => {
    const data = await purchases.deleteDraft(pool, positive(req.params.id, 'Invoice'), req.body || {}, actorOf(req), req.ip);
    return sendAdminSuccess(res, { data });
}));

router.post('/invoices/:id/post', handle(async (req, res) => {
    const result = await purchases.postInvoice(pool, { id: positive(req.params.id, 'Invoice'), body: req.body || {}, actor: actorOf(req), ipAddress: req.ip });
    announce(req, result.scope);
    return sendAdminSuccess(res, { data: result.invoice });
}));

router.post('/invoices/:id/reverse', handle(async (req, res) => {
    const result = await purchases.reverseInvoice(pool, { id: positive(req.params.id, 'Invoice'), body: req.body || {}, actor: actorOf(req), ipAddress: req.ip });
    announce(req, result.scope);
    return sendAdminSuccess(res, { data: result.invoice });
}));

module.exports = router;
