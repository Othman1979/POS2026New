// Validates a cash field coming from a request body before it touches the drawer.
// Reused by shift open/close/update_cash (auth.js + admin/shifts.js).
function validateCashAmount(raw) {
    const num = Number(raw);
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(num)) {
        return { valid: false, message: 'Cash amount is required and must be a number.' };
    }
    if (num < 0) return { valid: false, message: 'Cash amount cannot be negative.' };
    if (num > 99999999.99) return { valid: false, message: 'Cash amount exceeds the maximum allowed.' };
    return { valid: true, value: num };
}

module.exports = { validateCashAmount };
