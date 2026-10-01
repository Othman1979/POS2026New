const pool = require('../../config/db');

// Existing money/stock fixtures deliberately edit the current bill. Read its
// revision explicitly so those tests still reach their own validation boundary.
// Stale-save tests must retain the revision from their original load instead.
async function currentTableRevision(invoiceId) {
    if (!invoiceId) return null;
    const [[order]] = await pool.query('SELECT version FROM orders WHERE invoice_id=?', [invoiceId]);
    return Number(order?.version ?? 1);
}

module.exports = { currentTableRevision };
