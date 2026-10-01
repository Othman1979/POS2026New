const MAX_IDEMPOTENCY_KEY_LENGTH = 80;

function checkoutAttemptError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizeCheckoutAttemptKey(rawKey) {
    if (rawKey === null || rawKey === undefined || rawKey === '') return null;
    if (typeof rawKey !== 'string') {
        throw checkoutAttemptError('Invalid idempotency key.', 400);
    }
    const key = rawKey.trim();
    if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw checkoutAttemptError(`Invalid idempotency key. Maximum length is ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`, 400);
    }
    return key;
}

// A key is a per-attempt id (random, or platform-held:<id> for a held-order settle), so
// ownership is the user. The shift is
// deliberately not compared: executeCheckout reroutes a closed or foreign shift to the
// cashier's current open shift, so a committed sale may carry a different shift_id than
// the client's frozen payload, and a lost-response replay must still find it.
async function findOwnedCheckoutAttempt(db, { key, userId }) {
    if (!key) return null;
    const [rows] = await db.query(
        `SELECT invoice_id, order_id, invoice_number, invoice_issued_at, created_at, user_id
         FROM orders
         WHERE idempotency_key = ?
         LIMIT 1`,
        [key]
    );
    if (rows.length === 0) return null;
    if (String(rows[0].user_id) !== String(userId)) {
        throw checkoutAttemptError('Conflict: This checkout attempt belongs to another cashier.', 409);
    }
    return rows[0];
}

module.exports = {
    MAX_IDEMPOTENCY_KEY_LENGTH,
    normalizeCheckoutAttemptKey,
    findOwnedCheckoutAttempt
};
