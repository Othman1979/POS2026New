import { describe, expect, it } from 'vitest';
import { resolveReceiptTaxNumber } from './receiptTaxNumber.js';

const settings = {
    tax_registration_type: 'sales_tax',
    jofotara_sales_tax_seller_tax_number: ' SALES-123 ',
    jofotara_income_tax_seller_tax_number: 'INCOME-456'
};

describe('receipt tax number', () => {
    it('uses the profile saved on the invoice and trims the value', () => {
        expect(resolveReceiptTaxNumber({ tax_registration_type_at_sale: 'sales_tax' }, settings)).toBe('SALES-123');
        expect(resolveReceiptTaxNumber({ tax_registration_type_at_sale: 'income_tax' }, settings)).toBe('INCOME-456');
    });

    it('falls back to the current profile and hides blank or provisional values', () => {
        expect(resolveReceiptTaxNumber({}, { ...settings, tax_registration_type: 'income_tax' })).toBe('INCOME-456');
        expect(resolveReceiptTaxNumber({}, { ...settings, jofotara_sales_tax_seller_tax_number: '   ' })).toBe('');
        expect(resolveReceiptTaxNumber({ provisional: true }, settings)).toBe('');
        expect(resolveReceiptTaxNumber({ invoice_id: 'GUEST CHECK' }, settings)).toBe('');
    });
});
