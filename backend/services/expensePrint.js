const pool = require('../config/db');
const logger = require('../config/logger');
const { dispatchReceiptPrint } = require('./printDispatch');
const { getPrintStoreInfo } = require('./printStoreInfo');

async function queueExpensePrint(req, expense, printType, printerId = null) {
    try {
        // Only the approved print subset: the full settings rows include JoFotara API
        // secrets, and print payloads are persisted in print_queue.
        const storeInfo = await getPrintStoreInfo(pool);
        await dispatchReceiptPrint({
            io: req.io,
            printerId,
            printType,
            data: {
                ...expense,
                storeInfo,
                language: req.body?.language === 'ar' ? 'ar' : 'en',
                direction: req.body?.language === 'ar' ? 'rtl' : 'ltr',
            },
        });
        return true;
    } catch (error) {
        logger.warn({ err: error, expenseId: expense.id, printType }, 'Expense saved but its print job could not be queued.');
        return false;
    }
}

module.exports = { queueExpensePrint };
