const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Apply middleware to ALL admin routes
router.use(requireAuth);

const { userHas, PERMISSIONS } = require('../services/PermissionService');

// The admin dashboard is admin/programmer-only. These two GETs are NOT the panel —
// they are data endpoints the POS app consumes through the /api/admin prefix, so they
// stay reachable without admin rights:
//   - /printers       : the POS terminal loads the printer list (any authenticated user)
//   - /order_details  : the POS order-history page + order recall read a single order
//                       (gated by orders.view, the cashier history permission)
// Everything else under /api/admin requires admin/programmer.
const requireAdminUnlessExceptions = (req, res, next) => {
    if (req.user?.role === 'call_center' && req.path === '/printers' && req.method === 'GET') {
        return res.status(403).json({ success: false, message: 'Forbidden: Call center users cannot access printer configuration.' });
    }
    if (req.path === '/printers' && req.method === 'GET') {
        return next();
    }
    if (
        req.method === 'POST' &&
        /^\/print-queue\/\d+\/reprint$/.test(req.path) &&
        userHas(req.user, PERMISSIONS.POS_REPRINT_RECEIPT)
    ) {
        return next();
    }
    if (
        req.method === 'GET' &&
        req.path === '/order_details' &&
        userHas(req.user, PERMISSIONS.ORDERS_VIEW)
    ) {
        return next();
    }
    // The POS failed-print bell lists the jobs it offers to reprint. Gated on the same
    // permission as the reprint itself: a cashier who cannot reprint has no use for the
    // list, and this exposes nothing the reprint action does not already.
    if (
        req.method === 'GET' &&
        req.path === '/print-queue/failed' &&
        userHas(req.user, PERMISSIONS.POS_REPRINT_RECEIPT)
    ) {
        return next();
    }
    requireAdmin(req, res, next);
};

router.use(requireAdminUnlessExceptions);

// Mount sub-routers
router.use('/', require('./admin/dashboard'));
router.use('/', require('./admin/products'));
router.use('/', require('./admin/categoryPriceLists'));
router.use('/', require('./admin/bundle-items'));
router.use('/', require('./admin/orders'));
router.use('/', require('./admin/users'));
router.use('/', require('./admin/customers'));
router.use('/', require('./admin/shifts'));
router.use('/', require('./admin/printers'));
router.use('/', require('./admin/reports'));
router.use('/', require('./admin/auditReports'));
router.use('/', require('./admin/audit'));
router.use('/', require('./admin/printQueue'));
router.use('/', require('./admin/printTemplates'));
router.use('/', require('./admin/expenses'));
router.use('/', require('./admin/recipeLedger'));
router.use('/purchases', require('./admin/purchases'));
router.use('/stock-counts', require('./admin/stockCounts'));
// Reject stale subscription management clients after retirement.
router.use(['/subscription-plans', '/subscriptions', '/subscription-metrics'], (_req, res) => {
    res.status(410).json({ success: false, code: 'SUBSCRIPTIONS_RETIRED', message: 'Subscriptions are no longer available.' });
});
router.use('/', require('./admin/jofotara'));
router.use('/', require('./admin/platformRemittances'));
router.use('/', require('./admin/maintenance'));
router.use('/', require('./admin/deviceAccess'));
router.use('/import', require('./admin/import'));

module.exports = router;
