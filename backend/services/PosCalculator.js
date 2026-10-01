/**
 * PosCalculator — Pure mathematical functions for cart line totals,
 * tax calculation, and order discounts. Keeps business rules isolated
 * and easily testable without HTTP or database adapters.
 */

const {
    TAX_REGISTRATION_TYPES,
    normalizeTaxRegistrationType
} = require('../config/taxRegistration');
const { netToGross } = require('./categoryPriceLists');

const toFiniteNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const roundMoney = (value) => Math.round((toFiniteNumber(value) + Number.EPSILON) * 100) / 100;
const roundSix = (value) => Math.round((toFiniteNumber(value) + Number.EPSILON) * 1_000_000) / 1_000_000;

const normalizeDiscount = (type, value, label) => {
    const normalizedType = type === 'fixed' || type === 'percent' ? type : null;
    const normalizedValue = toFiniteNumber(value, 0);
    const bad = (msg) => { const e = new Error(`${label} ${msg}`); e.statusCode = 400; return e; };
    if (normalizedValue < 0) throw bad('cannot be negative.');
    if (normalizedValue > 0 && !normalizedType) throw bad('type is invalid.');
    if (normalizedType === 'percent' && normalizedValue > 100) throw bad('cannot exceed 100%.');
    return { type: normalizedType, value: normalizedValue };
};

const normalizeProductId = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const MOD_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const safeNoteProductId = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

// modifier_surcharge is per-unit, server-authored money metadata: the DB fold
// (applyDatabasePrices) and the frozen-price pins overwrite it on every
// persisting path. This sanitizer only bounds what flows through preview /
// held payloads. 0/absent/garbage all collapse to null (≡ legacy full-price tax).
const sanitizeModifierSurcharge = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 10000 ? parsed : null;
};

// Trust boundary: selectedModifiers arrives from the client (checkout, hold,
// table save, split). Money never derives from it (DB prices win), but it is
// persisted and replayed — so cap sizes and strip everything non-conforming.
const sanitizeSelectedModifiers = (value) => {
    if (!Array.isArray(value) || value.length === 0) return null;
    const out = [];
    for (const raw of value.slice(0, 50)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const group = typeof raw.group === 'string' ? raw.group.trim().slice(0, 120) : '';
        const option = typeof raw.option === 'string' ? raw.option.trim().slice(0, 120) : '';
        const noteProductId = safeNoteProductId(raw.noteProductId);
        if (noteProductId) {
            const entry = { noteProductId };
            if (group) entry.group = group;
            if (option) entry.option = option;
            const price = Number(raw.price);
            if (raw.price !== undefined && Number.isFinite(price) && price >= 0 && price <= 10000) entry.price = price;
            out.push(entry);
            continue;
        }
        if (!group || !option) continue;
        const entry = { group, option };
        if (typeof raw.gid === 'string' && MOD_ID_RE.test(raw.gid)) entry.gid = raw.gid;
        if (typeof raw.oid === 'string' && MOD_ID_RE.test(raw.oid)) entry.oid = raw.oid;
        const price = Number(raw.price);
        if (raw.price !== undefined && Number.isFinite(price) && price >= 0 && price <= 10000) entry.price = price;
        out.push(entry);
    }
    return out.length > 0 ? out : null;
};

// id-first, name-fallback resolution of one selection against the product's
// definition. Ids survive renames; names keep legacy (pre-id) payloads working.
const findModifierOption = (product, selected) => {
    if (!product || !Array.isArray(product.modifiers)) return null;
    const group =
        (selected.gid && product.modifiers.find((m) => m && m.id === selected.gid)) ||
        product.modifiers.find((m) => m && m.name === selected.group);
    if (!group || !Array.isArray(group.options)) return null;
    const option =
        (selected.oid && group.options.find((o) => o && o.id === selected.oid)) ||
        group.options.find((o) => o && o.name === selected.option);
    return option ? { group, option } : null;
};

const noteProductUnavailable = () => Object.assign(
    new Error('A priced note changed or is unavailable. Refresh and re-add it.'),
    { statusCode: 409, publicCode: 'NOTE_PRODUCT_UNAVAILABLE' }
);

const isEligibleNoteProduct = (product) => product &&
    Number(product.product_is_active) === 1 &&
    Number(product.category_is_active) === 1 &&
    Number(product.category_is_notes) === 1;

// Canonical display/identity snapshot persisted to order_items.selected_modifiers.
// Client-supplied note money is never used; matched formal modifiers retain their
// existing ID-first/name-fallback behavior.
//
// dropUnavailableNotes is for reviving an artifact the cashier already owns (a held
// order), not for fresh writes. A fresh write must fail loudly so the cashier can
// re-add the note; a hold cannot be repaired that way, because the browser recovery
// path in categoryPriceSync only reaches a cart draft, and a hold that refuses to
// claim never becomes one. Dropping lowers the line price, which already sets
// pricing_context_changed.prices and raises the existing "totals updated" toast.
const resolveModifierSelections = (product, line, productMap = new Map(), { dropUnavailableNotes = false } = {}) => {
    const selected = sanitizeSelectedModifiers(line?.selectedModifiers) || [];
    const snapshot = [];
    const seenNoteProducts = new Set();
    let surcharge = 0;

    for (const selection of selected) {
        if (selection.noteProductId) {
            if (seenNoteProducts.has(selection.noteProductId)) continue;
            seenNoteProducts.add(selection.noteProductId);
            const noteProduct = productMap.get(selection.noteProductId);
            if (!isEligibleNoteProduct(noteProduct)) {
                if (dropUnavailableNotes) continue;
                throw noteProductUnavailable();
            }
            let price;
            try {
                price = netToGross(
                    Number(noteProduct.effective_price ?? noteProduct.price),
                    Number(noteProduct.tax_rate ?? 0)
                );
            } catch (_) {
                if (dropUnavailableNotes) continue;
                throw noteProductUnavailable();
            }
            snapshot.push({
                noteProductId: selection.noteProductId,
                group: noteProduct.name,
                option: noteProduct.name,
                price
            });
            surcharge += price;
            continue;
        }

        const match = findModifierOption(product, selection);
        if (!match) {
            snapshot.push(selection);
            continue;
        }
        const price = toFiniteNumber(match.option.price, 0);
        const canonical = { group: match.group.name, option: match.option.name, price };
        if (match.group.id) canonical.gid = match.group.id;
        if (match.option.id) canonical.oid = match.option.id;
        snapshot.push(canonical);
        surcharge += price;
    }

    return { selectedModifiers: snapshot.length ? snapshot : null, surcharge };
};

const buildSelectedModifiersSnapshot = (product, line, productMap, options) =>
    resolveModifierSelections(product, line, productMap, options).selectedModifiers;

const normalizeCartItems = (cart) => {
    if (!Array.isArray(cart) || cart.length === 0) throw new Error('Cart is empty.');

    return cart.map((item, index) => {
        const qty = toFiniteNumber(item.qty, NaN);
        const price = toFiniteNumber(item.price, NaN);
        if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Invalid quantity on line ${index + 1}.`);
        if (!Number.isFinite(price) || price < 0) throw new Error(`Invalid price on line ${index + 1}.`);

        const discount = normalizeDiscount(item.discountType, item.discountValue || 0, `Line ${index + 1} discount`);
        return {
            ...item,
            product_id: normalizeProductId(item.product_id || item.id),
            qty,
            price,
            discountType: discount.type,
            discountValue: discount.value,
            selectedModifiers: sanitizeSelectedModifiers(item.selectedModifiers),
            // modifier_surcharge is server-authored money metadata. The ...item spread
            // would forward a client-sent value into the tax base, so strip it here;
            // applyDatabasePrices/frozen pins attach the real value on persisting paths.
            modifier_surcharge: undefined,
            modifier_tax_amount: undefined
        };
    });
};

/**
 * Compute the raw (un-rounded) per-line tax amount, prorated by the order
 * discountRatio so SUM(order_items.tax_amount) == orders.tax in the
 * exclusive-tax paths. (In tax-inclusive mode the rollup tax is 0 by design,
 * so that invariant does not apply there.)
 * discountRatio defaults to 1 (no order discount) when omitted.
 * Returns 0 for zero/negative lineTotals and for taxRate === 0.
 */
const calculateLineTax = (lineTotal, taxRate, discountRatio = 1) =>
    taxRate > 0 ? Math.max(0, lineTotal) * (discountRatio ?? 1) * (taxRate / 100) : 0;

const calculateLineTotal = (item) => {
    let total = item.price * item.qty;
    if (item.discountType === 'fixed') total -= item.discountValue * item.qty;
    if (item.discountType === 'percent') total -= total * (item.discountValue / 100);
    return Math.max(0, total);
};

// Priced modifiers are folded into item.price. New rows also store the tax
// embedded in that gross surcharge; NULL keeps the historical tax treatment.
const resolveTaxRate = (product, fallbackRate = 0) =>
    toFiniteNumber(product ? (Number(product.tax_rate) || 0) : fallbackRate, 0);

const validateTaxRate = value => {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    const error = new Error('Invalid tax rate on cart line.');
    error.statusCode = 400;
    throw error;
  }
  return rate;
};

const resolveEffectiveTaxRate = (
    storedRate,
    taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX
) => {
    const profile = normalizeTaxRegistrationType(taxRegistrationType);
    return profile === TAX_REGISTRATION_TYPES.INCOME_TAX
        ? 0
        : validateTaxRate(storedRate);
};

const deriveModifierTaxAmount = (surcharge, taxRate) => {
    const gross = sanitizeModifierSurcharge(surcharge);
    if (gross === null) return null;
    const rate = validateTaxRate(taxRate);
    if (rate === 0) return 0;
    return gross - (gross / (1 + rate / 100));
};

const hasInclusiveModifierSnapshot = item =>
    item?.modifier_surcharge != null && item?.modifier_tax_amount != null;

const exemptUnitPrice = (item = {}, taxRate = item?.tax_rate, taxInclusivePricing = false, { alreadyExempt = false } = {}) => {
    const price = toFiniteNumber(item.price);
    const surcharge = Math.max(0, toFiniteNumber(item.modifier_surcharge));
    const rate = Math.max(0, toFiniteNumber(taxRate));
    if (alreadyExempt || !taxInclusivePricing || rate === 0) return roundSix(price);
    const base = Math.max(0, price - surcharge);
    return roundSix(base / (1 + rate / 100) + surcharge);
};

const calculateLineSubtotal = (
    item,
    taxRate,
    taxInclusivePricing = false,
    { taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX, taxExempt = false, pricesAlreadyExempt = false } = {}
) => {
    const effectiveTaxRate = resolveEffectiveTaxRate(taxRate, taxRegistrationType);
    if (taxExempt) {
        const alreadyExempt = pricesAlreadyExempt || item?.note === 'Auto-Gratuity';
        return calculateLineTotal({
            ...item,
            price: exemptUnitPrice(item, effectiveTaxRate, taxInclusivePricing, { alreadyExempt })
        });
    }
    if (effectiveTaxRate === 0 && taxRegistrationType === TAX_REGISTRATION_TYPES.INCOME_TAX) {
        return calculateLineTotal(item);
    }
    if (taxInclusivePricing || !hasInclusiveModifierSnapshot(item)) {
        return calculateLineTotal(item);
    }
    return calculateLineTotal({
        ...item,
        price: Math.max(0, toFiniteNumber(item.price) - toFiniteNumber(item.modifier_tax_amount))
    });
};

// NULL modifier_tax_amount preserves legacy untaxed-surcharge calculations.
const taxableLineTotal = (
    item,
    taxRate = item?.tax_rate || 0,
    taxInclusivePricing = false,
    { taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX } = {}
) => {
    const effectiveTaxRate = resolveEffectiveTaxRate(taxRate, taxRegistrationType);
    if (effectiveTaxRate === 0 && taxRegistrationType === TAX_REGISTRATION_TYPES.INCOME_TAX) {
        return calculateLineTotal(item);
    }
    if (hasInclusiveModifierSnapshot(item)) {
        return calculateLineSubtotal(item, taxRate, taxInclusivePricing);
    }
    const surcharge = toFiniteNumber(item.modifier_surcharge, 0);
    if (surcharge <= 0) return calculateLineTotal(item);
    return calculateLineTotal({
        ...item,
        price: Math.max(0, toFiniteNumber(item.price) - surcharge)
    });
};

const resolveLineTaxRate = (
  item,
  productMap,
  taxRateOverrides,
  taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX
) => {
  if (taxRateOverrides?.has(item)) {
    return resolveEffectiveTaxRate(taxRateOverrides.get(item), taxRegistrationType);
  }
  const product = item.product_id ? productMap.get(item.product_id) : null;
  return resolveEffectiveTaxRate(resolveTaxRate(product, item.tax_rate), taxRegistrationType);
};

const stampLineTax = (
    item,
    taxRate,
    discountRatio = 1,
    taxInclusivePricing = false,
    { taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX, taxExempt = false } = {}
) =>
    taxInclusivePricing || taxExempt
        ? 0
        : calculateLineTax(
            taxableLineTotal(item, taxRate, false, { taxRegistrationType }),
            resolveEffectiveTaxRate(taxRate, taxRegistrationType),
            discountRatio
        );

const calculateExpectedTotals = (
    data,
    cartItems,
    productMap,
    taxInclusivePricing,
    {
        taxRateOverrides,
        taxRegistrationType = TAX_REGISTRATION_TYPES.SALES_TAX,
        taxExempt = false,
        pricesAlreadyExempt = false
    } = {}
) => {
    const profile = normalizeTaxRegistrationType(taxRegistrationType);
    const ratedItems = cartItems.map(item => ({
        item,
        taxRate: resolveLineTaxRate(item, productMap, taxRateOverrides, profile)
    }));
    const subtotal = ratedItems.reduce(
        (sum, { item, taxRate }) => sum + calculateLineSubtotal(
            item,
            taxRate,
            taxInclusivePricing,
            { taxRegistrationType: profile, taxExempt, pricesAlreadyExempt }
        ),
        0
    );
    const orderDiscount = normalizeDiscount(data.order_discount_type, data.order_discount_value || 0, 'Order discount');
    let discountedSubtotal = subtotal;

    if (orderDiscount.type === 'fixed') discountedSubtotal -= orderDiscount.value;
    if (orderDiscount.type === 'percent') discountedSubtotal -= discountedSubtotal * (orderDiscount.value / 100);
    discountedSubtotal = Math.max(0, discountedSubtotal);

    const discountRatio = subtotal > 0 ? discountedSubtotal / subtotal : 1;

    if (taxInclusivePricing || taxExempt) {
        return {
            subtotal: roundMoney(subtotal),
            tax: 0,
            total: roundMoney(discountedSubtotal),
            discount: roundMoney(subtotal - discountedSubtotal),
            orderDiscount,
            discountRatio
        };
    }

    const tax = ratedItems.reduce((sum, { item, taxRate }) => {
        return sum + (taxableLineTotal(
            item,
            taxRate,
            false,
            { taxRegistrationType: profile }
        ) * discountRatio * (taxRate / 100));
    }, 0);

    return {
        subtotal: roundMoney(subtotal),
        tax: roundMoney(tax),
        total: roundMoney(discountedSubtotal + tax),
        discount: roundMoney(subtotal - discountedSubtotal),
        orderDiscount,
        discountRatio
    };
};

/**
 * Validate and calculate the total surcharge of the selected modifiers for a product line
 * against the product's database modifier definition.
 * Any modifier option not defined in the product's definition is ignored (0 surcharge).
 * Returns the raw sum.
 */
const computeModifierSurcharge = (product, line, productMap) =>
    resolveModifierSelections(product, line, productMap).surcharge;

module.exports = {
    toFiniteNumber,
    roundMoney,
    roundSix,
    normalizeDiscount,
    normalizeCartItems,
    calculateLineTotal,
    calculateLineSubtotal,
    taxableLineTotal,
    calculateLineTax,
    calculateExpectedTotals,
    computeModifierSurcharge,
    resolveModifierSelections,
    resolveTaxRate,
    stampLineTax,
    resolveLineTaxRate,
    validateTaxRate,
    resolveEffectiveTaxRate,
    exemptUnitPrice,
    sanitizeSelectedModifiers,
    sanitizeModifierSurcharge,
    deriveModifierTaxAmount,
    hasInclusiveModifierSnapshot,
    buildSelectedModifiersSnapshot
};
