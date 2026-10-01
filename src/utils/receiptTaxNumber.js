export function resolveReceiptTaxNumber(order = {}, settings = {}) {
    if (order?.provisional === true || order?.guest_check === true || order?.invoice_id === 'GUEST CHECK') return '';
    const profile = order?.tax_registration_type_at_sale === 'income_tax'
        ? 'income_tax'
        : order?.tax_registration_type_at_sale === 'sales_tax'
            ? 'sales_tax'
            : settings?.tax_registration_type === 'income_tax' ? 'income_tax' : 'sales_tax';
    const key = profile === 'income_tax'
        ? 'jofotara_income_tax_seller_tax_number'
        : 'jofotara_sales_tax_seller_tax_number';
    return String(settings?.[key] ?? '').trim();
}
