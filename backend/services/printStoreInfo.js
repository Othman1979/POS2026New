const { getSettings } = require('../config/settingsHelper');

const PRINT_STORE_INFO_KEYS = [
    'store_name',
    'store_address',
    'store_phone',
    'receipt_config',
    'tax_inclusive_pricing',
    'tax_registration_type',
    'jofotara_sales_tax_seller_tax_number',
    'jofotara_income_tax_seller_tax_number',
];

async function getPrintStoreInfo(executor) {
    return getSettings(executor, PRINT_STORE_INFO_KEYS);
}

module.exports = { PRINT_STORE_INFO_KEYS, getPrintStoreInfo };
