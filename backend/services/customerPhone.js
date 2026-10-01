function phoneError() {
    const error = new Error('Enter a valid customer phone number.');
    error.statusCode = 400;
    error.publicCode = 'CUSTOMER_PHONE_INVALID';
    return error;
}

// Any number is a customer phone: the venue decides what it types (short house numbers included).
// Only digits and the usual separators are accepted, up to the 20 digits customers.phone_normalized holds.
function normalizeCustomerPhone(value) {
    if (typeof value !== 'string') throw phoneError();
    const input = value.trim();
    // Keep accepted separators identical to the generated SQL normalizer. In
    // particular, reject non-breaking and other Unicode whitespace that would
    // otherwise survive in customers.phone_normalized.
    if (!input || /[^0-9+().\- \t\r\n]/.test(input)) throw phoneError();
    const digits = input.replace(/\D/g, '');
    if (!digits || digits.length > 20) throw phoneError();
    return digits;
}

function redactCustomerPhone(value) {
    try {
        const digits = normalizeCustomerPhone(value);
        // Up to the last 4 digits stay visible, never more than the masked part, so a short number is never logged whole.
        const shown = Math.max(0, Math.min(4, digits.length - 4));
        return `${'*'.repeat(Math.max(2, digits.length - shown))}${shown ? digits.slice(-shown) : ''}`;
    } catch (_) {
        return '[invalid-phone]';
    }
}

module.exports = {
    normalizeCustomerPhone,
    redactCustomerPhone
};
