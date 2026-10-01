const {
    calculateLineSubtotal,
    roundMoney,
    resolveEffectiveTaxRate
} = require('./PosCalculator');
const { TAX_REGISTRATION_TYPES } = require('../config/taxRegistration');

const SERVICE_NOTE = 'Auto-Gratuity';

const badRequest = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
};

const toRate = (value, label) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 100) {
        throw badRequest(`${label} must be between 0 and 100.`);
    }
    return number;
};

const serviceChargeBase = (items = [], {
    taxInclusivePricing = false,
    taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX,
    taxExempt = false,
    pricesAlreadyExempt = false
} = {}) => {
    if (!Array.isArray(items)) throw badRequest('Cart items must be an array.');
    return items
        .filter(item => item?.note !== SERVICE_NOTE)
        .reduce((sum, item) => sum + calculateLineSubtotal(
            item,
            item.tax_rate || 0,
            taxInclusivePricing,
            { taxRegistrationType, taxExempt, pricesAlreadyExempt }
        ), 0);
};

const serviceChargeFee = (items, percentage, options = {}) =>
    roundMoney(serviceChargeBase(items, options) * (toRate(percentage, 'Service charge percentage') / 100));

const canonicalName = (percentage) =>
    `${Number(percentage).toFixed(4).replace(/\.?0+$/, '')}% Service Charge`;

const canonicalizeServiceCharge = (items, snapshot, {
    repriceStaleFee = false,
    taxInclusivePricing = false,
    taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX,
    taxExempt = false,
    pricesAlreadyExempt = false
} = {}) => {
    if (!snapshot?.id) throw badRequest('A service-charge snapshot is required.');
    const percentage = toRate(snapshot.percentage, 'Service charge percentage');
    const taxRate = resolveEffectiveTaxRate(
        toRate(snapshot.taxRate, 'Service charge tax rate'),
        taxRegistrationType
    );
    const feeLines = items.filter(item => item?.note === SERVICE_NOTE);
    if (feeLines.length > 1) throw badRequest('Only one service-charge line is allowed.');

    const options = { taxInclusivePricing, taxRegistrationType, taxExempt, pricesAlreadyExempt };
    const base = serviceChargeBase(items, options);
    const fee = serviceChargeFee(items, percentage, options);
    if (feeLines.length === 0) return { items: [...items], base, fee, hasFee: false };

    const submitted = feeLines[0];
    if (Number(submitted.qty) !== 1) throw badRequest('Service-charge quantity must be 1.');
    if (submitted.product_id != null) throw badRequest('Service charge cannot reference a product.');
    if (submitted.discountType || Number(submitted.discountValue || 0) !== 0) {
        throw badRequest('Service charge cannot have a line discount.');
    }
    const priceRepriced = roundMoney(submitted.price) !== fee;
    if (priceRepriced && !repriceStaleFee) {
        const error = new Error('Service charge changed. Refresh the cart and try again.');
        error.statusCode = 409;
        throw error;
    }
    if (fee === 0) {
        const error = new Error('Service charge is zero. Refresh the cart and try again.');
        error.statusCode = 409;
        throw error;
    }

    const canonicalLine = {
        ...submitted,
        product_id: null,
        name: canonicalName(percentage),
        note: SERVICE_NOTE,
        price: fee,
        qty: 1,
        tax_rate: taxRate,
        jofotara_tax_category: snapshot.taxCategory,
        discountType: null,
        discountValue: 0
    };
    return {
        items: items.map(item => item === submitted ? canonicalLine : item),
        base,
        fee,
        hasFee: true,
        priceRepriced
    };
};

const allocateServiceChargeCents = (seats, parentFee, percentage, {
    taxInclusivePricing = false,
    taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX,
    taxExempt = false,
    pricesAlreadyExempt = false
} = {}) => {
    const target = Math.round(roundMoney(parentFee) * 100);
    const raw = seats.map(seat => serviceChargeBase(
        seat.items,
        { taxInclusivePricing, taxRegistrationType, taxExempt, pricesAlreadyExempt }
    ) * (toRate(percentage, 'Service charge percentage') / 100) * 100);
    const cents = raw.map(value => Math.floor(value));
    const remaining = target - cents.reduce((sum, value) => sum + value, 0);
    const order = raw
        .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
        .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let i = 0; i < remaining; i += 1) cents[order[i % order.length].index] += 1;
    if (cents.reduce((sum, value) => sum + value, 0) !== target) {
        throw badRequest('Split service-charge allocation does not conserve the parent fee.');
    }
    return cents;
};

module.exports = {
    SERVICE_NOTE,
    canonicalName,
    serviceChargeBase,
    serviceChargeFee,
    canonicalizeServiceCharge,
    allocateServiceChargeCents
};
