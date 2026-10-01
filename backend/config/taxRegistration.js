const TAX_REGISTRATION_TYPES = Object.freeze({
    SALES_TAX: 'sales_tax',
    INCOME_TAX: 'income_tax'
});

const JOFOTARA_INVOICE_TYPE_NAMES = Object.freeze({
    [TAX_REGISTRATION_TYPES.SALES_TAX]: Object.freeze({ cash: '012', receivable: '022' }),
    [TAX_REGISTRATION_TYPES.INCOME_TAX]: Object.freeze({ cash: '011', receivable: '021' })
});

const JOFOTARA_SALES_TAX_RATES = Object.freeze([0, 1, 2, 3, 4, 5, 7, 8, 10, 16]);
const JOFOTARA_TAX_CATEGORIES = Object.freeze({
    STANDARD: 'S',
    EXEMPT: 'Z',
    ZERO_RATED: 'O'
});

function normalizeJofotaraTaxCategory(value, taxRate) {
    const rate = Number(taxRate);
    if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid JoFotara tax rate.');
    const category = value == null || String(value).trim() === ''
        ? null
        : String(value).trim().toUpperCase();
    if (rate > 0) {
        if (category != null && category !== JOFOTARA_TAX_CATEGORIES.STANDARD) {
            throw new Error('A positive tax rate requires JoFotara category S.');
        }
        return JOFOTARA_TAX_CATEGORIES.STANDARD;
    }
    if (category == null) return JOFOTARA_TAX_CATEGORIES.ZERO_RATED;
    if (![JOFOTARA_TAX_CATEGORIES.EXEMPT, JOFOTARA_TAX_CATEGORIES.ZERO_RATED].includes(category)) {
        throw new Error('A zero tax rate requires JoFotara category O or Z.');
    }
    return category;
}

function resolveJofotaraSaleTaxCategory(value, taxRate, { taxExempt = false, taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX } = {}) {
    if (taxRegistrationType === TAX_REGISTRATION_TYPES.INCOME_TAX) return JOFOTARA_TAX_CATEGORIES.ZERO_RATED;
    if (taxExempt) return JOFOTARA_TAX_CATEGORIES.EXEMPT;
    // Positive-rate sale rows can only be S. Canonicalize historical rows that
    // predate the category column instead of refusing an otherwise valid sale.
    if (Number(taxRate) > 0) return JOFOTARA_TAX_CATEGORIES.STANDARD;
    return normalizeJofotaraTaxCategory(value, taxRate);
}

function isSupportedJofotaraSalesTaxRate(value) {
    if (typeof value === 'string') {
        const text = value.trim();
        if (!/^\d+(?:\.0+)?$/.test(text)) return false;
        value = Number(text);
    }
    return typeof value === 'number' && Number.isFinite(value) && JOFOTARA_SALES_TAX_RATES.includes(value);
}

function requiresJofotaraSalesTaxRates(settings) {
    return (settings?.jofotara_enabled === '1' || settings?.jofotara_enabled === true)
        && settings?.tax_registration_type === TAX_REGISTRATION_TYPES.SALES_TAX;
}

function normalizeTaxRegistrationType(value) {
    if (value === TAX_REGISTRATION_TYPES.SALES_TAX || value === TAX_REGISTRATION_TYPES.INCOME_TAX) {
        return value;
    }
    throw new Error(`Invalid tax registration type: ${value}`);
}

function taxRegistrationTypeFromSettings(settings) {
    return normalizeTaxRegistrationType(settings?.tax_registration_type);
}

function profileSettingKeys(profile) {
    const normalizedProfile = normalizeTaxRegistrationType(profile);
    const prefix = `jofotara_${normalizedProfile}`;
    return {
        clientId: `${prefix}_client_id`,
        secretKey: `${prefix}_secret_key`,
        incomeSourceSequence: `${prefix}_income_source_sequence`,
        sellerTaxNumber: `${prefix}_seller_tax_number`,
        sellerRegisteredName: `${prefix}_seller_registered_name`
    };
}

function jofotaraConfigFromSettings(settings, profile) {
    const keys = profileSettingKeys(profile);
    return {
        enabled: settings?.jofotara_enabled === '1',
        clientId: settings?.[keys.clientId] || '',
        secretKey: settings?.[keys.secretKey] || '',
        incomeSourceSequence: settings?.[keys.incomeSourceSequence] || '',
        sellerTaxNumber: settings?.[keys.sellerTaxNumber] || '',
        sellerRegisteredName: settings?.[keys.sellerRegisteredName] || ''
    };
}

module.exports = {
    TAX_REGISTRATION_TYPES,
    JOFOTARA_INVOICE_TYPE_NAMES,
    normalizeTaxRegistrationType,
    taxRegistrationTypeFromSettings,
    profileSettingKeys,
    jofotaraConfigFromSettings,
    JOFOTARA_SALES_TAX_RATES,
    JOFOTARA_TAX_CATEGORIES,
    normalizeJofotaraTaxCategory,
    resolveJofotaraSaleTaxCategory,
    isSupportedJofotaraSalesTaxRate,
    requiresJofotaraSalesTaxRates
};
