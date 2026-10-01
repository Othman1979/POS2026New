const { paidOrderRangeWhere } = require('../../routes/admin/helpers');

describe('admin SQL helpers', () => {
    it('builds a sargable paid-order range across invoice and fallback creation time', () => {
        expect(paidOrderRangeWhere('o')).toBe(
            "((o.invoice_issued_at >= ? AND o.invoice_issued_at < ?) OR " +
            "(o.invoice_issued_at IS NULL AND o.created_at >= ? AND o.created_at < ?)) " +
            "AND o.payment_method NOT IN ('unpaid_table', 'voided')"
        );
    });
});
