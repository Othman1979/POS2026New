const parseFinite = (value, fallback = 0) => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const roundMoney = (value) => {
    const parsed = Number(value);
    const finite = Number.isFinite(parsed) ? parsed : 0;
    return Math.round((finite + Number.EPSILON) * 100) / 100;
};

export const roundSix = (value) => {
    const parsed = Number(value);
    const finite = Number.isFinite(parsed) ? parsed : 0;
    return Math.round((finite + Number.EPSILON) * 1_000_000) / 1_000_000;
};

const hasInclusiveModifierSnapshot = item =>
    item?.modifier_surcharge != null && item?.modifier_tax_amount != null;

export const modifierTaxAmount = (surcharge, taxRate) => {
    const gross = parseFinite(surcharge);
    if (!(gross > 0)) return null;
    const rate = Math.max(0, parseFinite(taxRate));
    if (rate === 0) return 0;
    return gross - (gross / (1 + rate / 100));
};

export const exemptUnitPrice = (item = {}, taxRate = item?.tax_rate, taxInclusive = false, { alreadyExempt = false } = {}) => {
    const price = parseFinite(item.price);
    const surcharge = Math.max(0, parseFinite(item.modifier_surcharge));
    const rate = Math.max(0, parseFinite(taxRate));
    if (alreadyExempt || !taxInclusive || rate === 0) return roundSix(price);
    const base = Math.max(0, price - surcharge);
    return roundSix(base / (1 + rate / 100) + surcharge);
};

export const lineNet = (item = {}, opts = {}) => {
    const qty = parseFinite(item.qty);
    let price = opts.taxExempt
        ? exemptUnitPrice(item, item.tax_rate, opts.taxInclusive, {
            alreadyExempt: opts.pricesAlreadyExempt || item?.note === 'Auto-Gratuity'
        })
        : parseFinite(item.price);
    if (!opts.taxExempt && !opts.taxInclusive && hasInclusiveModifierSnapshot(item)) {
        price = Math.max(0, price - parseFinite(item.modifier_tax_amount));
    }
    let total = price * qty;
    const discountValue = parseFinite(item.discountValue);

    if (item.discountType === 'fixed') total -= discountValue * qty;
    if (item.discountType === 'percent') total -= total * (discountValue / 100);

    return Math.max(0, total);
};

// New rows carry the tax embedded in the folded modifier price. Historical
// rows with only modifier_surcharge retain their original tax treatment.
export const taxableLineNet = (item = {}) => {
    if (hasInclusiveModifierSnapshot(item)) return lineNet(item);
    const surcharge = parseFinite(item.modifier_surcharge);
    if (surcharge <= 0) return lineNet(item);
    return lineNet({ ...item, price: Math.max(0, parseFinite(item.price) - surcharge) });
};

export const orderDiscountAmount = (rawSubtotal, discount = {}) => {
    const subtotal = Math.max(0, parseFinite(rawSubtotal));
    const value = parseFinite(discount?.value);
    if (!(value > 0)) return 0;
    if (discount?.type === 'fixed') return Math.min(subtotal, value);
    if (discount?.type === 'percent') return subtotal * (value / 100);
    return 0;
};

export const lineTax = (item, discountRatio = 1, opts = {}) => {
    if (opts.taxInclusive || opts.taxExempt) return 0;
    const rate = parseFinite(item?.tax_rate);
    if (rate === 0) return 0;
    const parsedRatio = Number(discountRatio);
    const ratio = Number.isFinite(parsedRatio) ? parsedRatio : 1;
    return taxableLineNet(item) * ratio * (rate / 100);
};

export const lineGross = (item, opts = {}) => {
    const net = lineNet(item, opts);
    if (opts.taxInclusive || opts.taxExempt) return net;
    return net + taxableLineNet(item) * (parseFinite(item?.tax_rate) / 100);
};

export const serviceChargeBase = (items, opts = {}) => {
    const cart = Array.isArray(items) ? items : [];
    return cart
        .filter(item => item?.note !== 'Auto-Gratuity')
        .reduce((sum, item) => sum + lineNet(item, opts), 0);
};

export const serviceChargeFee = (items, percentage, opts = {}) => {
    const parsed = Number(percentage);
    const rate = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0;
    return roundMoney(serviceChargeBase(items, opts) * (rate / 100));
};

export const posTotals = (items, discount = {}, opts = {}) => {
    const cart = Array.isArray(items) ? items : [];
    const rawSubtotal = cart.reduce((sum, item) => sum + lineNet(item, opts), 0);
    const rawDiscount = orderDiscountAmount(rawSubtotal, discount);
    const rawDiscountedSubtotal = Math.max(0, rawSubtotal - rawDiscount);
    const discountRatio = rawSubtotal > 0.0001
        ? rawDiscountedSubtotal / rawSubtotal
        : 1;
    const rawTax = cart.reduce(
        (sum, item) => sum + lineTax(item, discountRatio, opts),
        0
    );

    return {
        subtotal: roundMoney(rawSubtotal),
        discount: roundMoney(rawDiscount),
        discountedSubtotal: roundMoney(rawDiscountedSubtotal),
        tax: roundMoney(rawTax),
        total: opts.taxInclusive
            ? roundMoney(rawDiscountedSubtotal)
            : roundMoney(rawDiscountedSubtotal + rawTax),
        discountRatio
    };
};
