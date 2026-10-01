const {
    normalizeCustomerPhone,
    redactCustomerPhone
} = require('../../services/customerPhone');

describe('customerPhone', () => {
    it('normalizes presentation separators without guessing country-code equivalence', () => {
        expect(normalizeCustomerPhone(' 079-123 4567 ')).toBe('0791234567');
        expect(normalizeCustomerPhone('+962 (79) 123.4567')).toBe('962791234567');
        expect(normalizeCustomerPhone('0791234567')).not.toBe(normalizeCustomerPhone('+962791234567'));
    });

    it('accepts any number, however short', () => {
        expect(normalizeCustomerPhone('5')).toBe('5');
        expect(normalizeCustomerPhone('123')).toBe('123');
        expect(normalizeCustomerPhone(' 12-34 ')).toBe('1234');
        expect(normalizeCustomerPhone('1'.repeat(20))).toBe('1'.repeat(20));
    });

    it('rejects values that are not a number, and numbers longer than the stored 20 digits', () => {
        for (const value of ['', '  ', '+-()', '07912abc67', `07912\u00a034567`, '1'.repeat(21), null]) {
            expect(() => normalizeCustomerPhone(value)).toThrow(expect.objectContaining({
                publicCode: 'CUSTOMER_PHONE_INVALID'
            }));
        }
    });

    it('redacts phone values before logging them', () => {
        expect(redactCustomerPhone('079-123-4567')).toBe('******4567');
        expect(redactCustomerPhone('bad')).toBe('[invalid-phone]');
        // A short number is never logged whole.
        expect(redactCustomerPhone('123456')).toBe('****56');
        expect(redactCustomerPhone('1234')).toBe('****');
        expect(redactCustomerPhone('5')).toBe('**');
    });
});
