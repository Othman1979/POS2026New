const {
    TAX_REGISTRATION_TYPES,
    normalizeTaxRegistrationType,
    taxRegistrationTypeFromSettings,
    profileSettingKeys,
    jofotaraConfigFromSettings,
    JOFOTARA_SALES_TAX_RATES,
    isSupportedJofotaraSalesTaxRate,
    requiresJofotaraSalesTaxRates,
    JOFOTARA_TAX_CATEGORIES,
    normalizeJofotaraTaxCategory,
    resolveJofotaraSaleTaxCategory
} = require('../../config/taxRegistration');

describe('tax registration profiles', () => {
    it('normalizes only the two supported registration types', () => {
        expect(normalizeTaxRegistrationType('sales_tax')).toBe(TAX_REGISTRATION_TYPES.SALES_TAX);
        expect(normalizeTaxRegistrationType('income_tax')).toBe(TAX_REGISTRATION_TYPES.INCOME_TAX);
        expect(() => normalizeTaxRegistrationType('vat')).toThrow('tax registration type');
    });

    it('requires an explicit supported profile selector', () => {
        expect(taxRegistrationTypeFromSettings({ tax_registration_type: 'sales_tax' })).toBe(TAX_REGISTRATION_TYPES.SALES_TAX);
        expect(taxRegistrationTypeFromSettings({ tax_registration_type: 'income_tax' })).toBe(TAX_REGISTRATION_TYPES.INCOME_TAX);
        expect(() => taxRegistrationTypeFromSettings({})).toThrow('tax registration type');
        expect(() => taxRegistrationTypeFromSettings({ tax_registration_type: 'vat' })).toThrow('tax registration type');
    });

    it('maps each profile to five isolated JoFotara settings', () => {
        expect(profileSettingKeys(TAX_REGISTRATION_TYPES.SALES_TAX)).toEqual({
            clientId: 'jofotara_sales_tax_client_id',
            secretKey: 'jofotara_sales_tax_secret_key',
            incomeSourceSequence: 'jofotara_sales_tax_income_source_sequence',
            sellerTaxNumber: 'jofotara_sales_tax_seller_tax_number',
            sellerRegisteredName: 'jofotara_sales_tax_seller_registered_name'
        });
        expect(profileSettingKeys(TAX_REGISTRATION_TYPES.INCOME_TAX)).toEqual({
            clientId: 'jofotara_income_tax_client_id',
            secretKey: 'jofotara_income_tax_secret_key',
            incomeSourceSequence: 'jofotara_income_tax_income_source_sequence',
            sellerTaxNumber: 'jofotara_income_tax_seller_tax_number',
            sellerRegisteredName: 'jofotara_income_tax_seller_registered_name'
        });
    });

    it('reads only the selected profile into JoFotara configuration', () => {
        const settings = {
            jofotara_enabled: '1',
            jofotara_sales_tax_client_id: 'sales-client',
            jofotara_sales_tax_secret_key: 'sales-secret',
            jofotara_sales_tax_income_source_sequence: '100',
            jofotara_sales_tax_seller_tax_number: '200',
            jofotara_sales_tax_seller_registered_name: 'Sales Seller',
            jofotara_income_tax_client_id: 'income-client',
            jofotara_income_tax_secret_key: 'income-secret',
            jofotara_income_tax_income_source_sequence: '300',
            jofotara_income_tax_seller_tax_number: '400',
            jofotara_income_tax_seller_registered_name: 'Income Seller'
        };

        expect(jofotaraConfigFromSettings(settings, TAX_REGISTRATION_TYPES.INCOME_TAX)).toEqual({
            enabled: true,
            clientId: 'income-client',
            secretKey: 'income-secret',
            incomeSourceSequence: '300',
            sellerTaxNumber: '400',
            sellerRegisteredName: 'Income Seller'
        });
    });

    it('pins the supported JoFotara sales-tax rates and rejects malformed values', () => {
        expect(JOFOTARA_SALES_TAX_RATES).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 10, 16]);
        for (const rate of JOFOTARA_SALES_TAX_RATES) expect(isSupportedJofotaraSalesTaxRate(rate)).toBe(true);
        for (const rate of [-1, 6.5, 17, 101, NaN, '', '6.5', '16%', null, undefined]) {
            expect(isSupportedJofotaraSalesTaxRate(rate)).toBe(false);
        }
    });

    it('requires sales-tax rate enforcement only for enabled sales-tax JoFotara', () => {
        expect(requiresJofotaraSalesTaxRates({ jofotara_enabled: '1', tax_registration_type: 'sales_tax' })).toBe(true);
        expect(requiresJofotaraSalesTaxRates({ jofotara_enabled: '0', tax_registration_type: 'sales_tax' })).toBe(false);
        expect(requiresJofotaraSalesTaxRates({ jofotara_enabled: '1', tax_registration_type: 'income_tax' })).toBe(false);
    });

    it('keeps only cash and receivable names for legal invoices', () => {
        const { JOFOTARA_INVOICE_TYPE_NAMES: names } = require('../../config/taxRegistration');
        expect(names.sales_tax).toEqual({ cash: '012', receivable: '022' });
        expect(names.income_tax).toEqual({ cash: '011', receivable: '021' });
    });

    it('normalizes the three authorized JoFotara line categories against the tax rate', () => {
        expect(JOFOTARA_TAX_CATEGORIES).toEqual({ STANDARD: 'S', EXEMPT: 'Z', ZERO_RATED: 'O' });
        expect(normalizeJofotaraTaxCategory(undefined, 16)).toBe('S');
        expect(normalizeJofotaraTaxCategory('S', 8)).toBe('S');
        expect(normalizeJofotaraTaxCategory(undefined, 0)).toBe('O');
        expect(normalizeJofotaraTaxCategory('O', 0)).toBe('O');
        expect(normalizeJofotaraTaxCategory('Z', 0)).toBe('Z');
        expect(() => normalizeJofotaraTaxCategory('Z', 16)).toThrow('category');
        expect(() => normalizeJofotaraTaxCategory('S', 0)).toThrow('category');
        expect(() => normalizeJofotaraTaxCategory('X', 0)).toThrow('category');
    });

    it('canonicalizes legacy positive-rate sale rows to S while keeping configuration validation strict', () => {
        expect(resolveJofotaraSaleTaxCategory('O', 16)).toBe('S');
        expect(resolveJofotaraSaleTaxCategory('O', 16, { taxExempt: true })).toBe('Z');
        expect(() => normalizeJofotaraTaxCategory('O', 16)).toThrow('category');
    });
});
