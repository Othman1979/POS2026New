const express = require('express');
const router = express.Router();

const catalogRouter = require('./pos/catalog');
const checkoutRouter = require('./pos/checkout');
const tablesRouter = require('./pos/tables');
const ordersRouter = require('./pos/orders');
const refundsRouter = require('./pos/refunds');
const serviceChargesRouter = require('./pos/serviceCharges');
const expensesRouter = require('./pos/expenses');

router.use('/', catalogRouter);
router.use('/', checkoutRouter);
router.use('/', ordersRouter);
router.use('/', tablesRouter);
router.use('/', refundsRouter);
router.use('/', serviceChargesRouter);
router.use('/', expensesRouter);
// Reject stale subscription clients explicitly after retirement.
router.use(['/subscription-plans', '/customer-subscriptions', '/subscription-redemptions', '/subscriptions'], (_req, res) => {
    res.status(410).json({ success: false, code: 'SUBSCRIPTIONS_RETIRED', message: 'Subscriptions are no longer available.' });
});

module.exports = router;
