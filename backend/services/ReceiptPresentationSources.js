const {
    calculateExpectedTotals,
    calculateLineTotal,
    calculateLineSubtotal,
    taxableLineTotal,
    normalizeCartItems,
    resolveTaxRate,
    roundMoney,
    resolveLineTaxRate,
    exemptUnitPrice
} = require('./PosCalculator');
const { TAX_REGISTRATION_TYPES, normalizeTaxRegistrationType } = require('../config/taxRegistration');

const {
    buildReceiptPresentation,
    validateReceiptPresentation,
    normalizeStoredTaxMode,
    receiptTaxMode
} = require('./ReceiptPresentation');
const { validateSplitMoneyCents } = require('./SplitMoneyAllocator');
const {
    BUNDLE_ORDER_CORRUPT,
    assertOrderItemBundleIntegrity,
    assertNestedBundleIntegrity
} = require('./bundleIntegrity');

function parseHeldCartData(cart_data) {
    const invalid = reason => {
        const err = new Error('Invalid JSON shape in held order.');
        err.code = 'RECEIPT_PRESENTATION_INVALID';
        err.reason = reason;
        return err;
    };
    if (!cart_data) {
        return { items: [] };
    }
    let parsed;
    try {
        parsed = typeof cart_data === 'string' ? JSON.parse(cart_data) : cart_data;
    } catch (error) {
        throw invalid(error.message);
    }
    // Structural gate: everything downstream (loadLegacyTaxEvidence runs BEFORE the
    // per-row catch) iterates items and reads item properties, so a non-array items
    // or a non-object row must fail HERE, inside the isolated parse phase — not
    // throw a raw TypeError that 500s the whole list.
    if (parsed == null || typeof parsed !== 'object') {
        return { items: [] }; // primitive legacy payload -> empty cart, rejected per-row
    }
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (items !== undefined && !Array.isArray(items)) {
        throw invalid('held cart items is not an array');
    }
    for (const item of items || []) {
        if (item == null || typeof item !== 'object' || Array.isArray(item)) {
            throw invalid('held cart contains a non-object item');
        }
    }
    return parsed;
}

function receiptBuilderItems(items, taxInclusive, taxExempt = false) {
    if (taxInclusive || taxExempt) return items;
    return items.map(item => {
        if (item.modifier_surcharge == null || item.modifier_tax_amount == null) return item;
        return {
            ...item,
            price: Math.max(0, Number(item.price || 0) - Number(item.modifier_tax_amount || 0)),
            modifier_surcharge: null,
            modifier_tax_amount: null
        };
    });
}

/**
 * Resolve the customer-copy mode without changing the accounting mode.  The
 * receipt snapshot is authoritative for new orders; the old accounting flag
 * remains the compatibility fallback for invoices created before the snapshot
 * column existed.  A legacy order with no positive stored tax is intentionally
 * left unknown/exclusive rather than inventing a gross conversion.
 */
function receiptDisplayInclusive(order = {}) {
    const explicit = normalizeStoredTaxMode(order.receipt_tax_inclusive_at_sale);
    if (explicit !== null) return explicit ? 'inclusive' : 'exclusive';
    const historical = normalizeStoredTaxMode(order.tax_inclusive_at_sale);
    if (historical !== null) return historical ? 'inclusive' : 'exclusive';
    return Number(order.tax || 0) > 0 ? 'exclusive' : 'legacy_unknown';
}

function calculateReceiptLineGross(line, taxRate, { taxExempt = false, taxRegistrationType } = {}) {
    const profile = normalizeTaxRegistrationType(taxRegistrationType);
    const net = calculateLineSubtotal(line, taxRate, false, {
        taxRegistrationType: profile,
        taxExempt,
        pricesAlreadyExempt: taxExempt
    });
    if (taxExempt) return net;
    const effectiveRate = profile === TAX_REGISTRATION_TYPES.INCOME_TAX ? 0 : Number(taxRate || 0);
    if (effectiveRate <= 0) return net;
    return net + taxableLineTotal(line, taxRate, false, { taxRegistrationType: profile }) * (effectiveRate / 100);
}

/**
 * Convert authoritative net sale rows into a customer-only gross model.  The
 * returned lines retain enough precision for the v1 builder to apportion row
 * cents; the stored order total remains authoritative and is never recomputed.
 */
function grossReceiptInput(input, { storedTotal, taxExempt = false, taxRegistrationType } = {}) {
    const grossItems = (input.items || []).map(item => {
        if (item.kind === 'bundle_child') return { ...item, price: 0, discountType: null, discountValue: 0 };

        const originalLine = { ...item, discountType: null, discountValue: 0 };
        const grossOriginal = calculateReceiptLineGross(originalLine, item.tax_rate, { taxExempt, taxRegistrationType });
        const grossAfterDiscount = calculateReceiptLineGross(item, item.tax_rate, { taxExempt, taxRegistrationType });
        const qty = Number(item.qty);
        const grossUnitPrice = grossOriginal / qty;
        let discountValue = Number(item.discountValue || 0);
        if (item.discountType === 'fixed') {
            discountValue = Math.max(0, grossOriginal - grossAfterDiscount) / qty;
        }
        return {
            ...item,
            price: grossUnitPrice,
            discountValue
        };
    });

    const grossSubtotal = roundMoney(grossItems
        .filter(item => item.kind !== 'bundle_child')
        .reduce((sum, item) => sum + calculateLineTotal(item), 0));
    const total = roundMoney(storedTotal);
    // Per-line gross prices can round a cent or two away from the stored total
    // (e.g. a split half of 5.51 shows 2.76 but carries 2.75). With no real order
    // discount that gap is rounding, not a discount the customer never got.
    const residue = roundMoney(grossSubtotal - total);
    // A discount rule counts even when its amount rounds to 0.00 (10% of 0.04).
    const hasOrderDiscount = Number(input.orderDiscount?.amount || 0) > 0
        || Number(input.orderDiscount?.value || 0) > 0;
    const grossOrderDiscount = !hasOrderDiscount && Math.abs(residue) <= 0.02
        ? 0
        : roundMoney(Math.max(0, residue));
    return {
        ...input,
        taxMode: 'inclusive',
        summary: { ...input.summary, subtotal: grossSubtotal, tax: 0, total },
        orderDiscount: { ...input.orderDiscount, amount: grossOrderDiscount },
        subtotalAllocationToleranceCents: Math.max(1, Number(input.subtotalAllocationToleranceCents || 0)),
        items: grossItems
    };
}

function asRoutePresentationError(error) {
    if (error?.code !== 'RECEIPT_PRESENTATION_INVALID') return error;
    error.statusCode = 422;
    error.publicCode = error.code;
    return error;
}

function orderPresentationInput(order, items) {
    assertOrderItemBundleIntegrity(items);
    let subtotal = Number(order.subtotal);
    let tax = Number(order.tax);
    let total = Number(order.total);
    
    if (order.payment_method === 'voided' || order.status === 'voided') {
        if (order.original_subtotal !== null && order.original_subtotal !== undefined) {
            subtotal = Number(order.original_subtotal);
        }
        if (order.original_tax !== null && order.original_tax !== undefined) {
            tax = Number(order.original_tax);
        }
        if (order.original_total !== null && order.original_total !== undefined) {
            total = Number(order.original_total);
        }
    }

    let status = 'original';
    if (order.payment_method === 'voided' || order.status === 'voided') {
        status = 'voided';
    } else if (order.payment_method === 'refunded' || order.refund_status === 'full') {
        status = 'fully_refunded';
    } else if (order.refund_status === 'partial') {
        status = 'partially_refunded';
    }

    const accountingTaxMode = receiptTaxMode({ stored: order.tax_inclusive_at_sale, tax: order.tax });
    const displayMode = receiptDisplayInclusive(order);
    const taxExempt = order.tax_exempt_at_sale === true || Number(order.tax_exempt_at_sale) === 1;
    const taxRegistrationType = normalizeTaxRegistrationType(
        order.tax_registration_type_at_sale || TAX_REGISTRATION_TYPES.SALES_TAX
    );

    const builderItems = (items || []).map((item, index) => {
        const key = item.id ? `order-item-${item.id}` : (item.key || item.cartId || `row-${index}`);
        const kind = item.parent_item_id != null ? 'bundle_child' : 'item';
        return {
            key,
            kind,
            name: item.item_name || item.name || 'Unknown Item',
            note: item.note,
            selectedModifiers: item.selectedModifiers ?? item.selected_modifiers ?? null,
            qty: Number(item.quantity ?? item.qty ?? 0),
            price: Number(item.price_at_sale ?? item.price ?? 0),
            discountType: item.discount_type ?? item.discountType ?? null,
            discountValue: Number(item.discount_value ?? item.discountValue ?? 0),
            tax_rate: Number(item.tax_rate ?? 0),
            parent_item_id: item.parent_item_id,
            modifier_surcharge: item.modifier_surcharge ?? null,
            modifier_tax_amount: item.modifier_tax_amount ?? null
        };
    });

    const rawSubtotal = builderItems
        .filter(it => it.kind === 'item')
        .reduce((sum, it) => sum + calculateLineSubtotal(
            it,
            it.tax_rate,
            accountingTaxMode === 'inclusive',
            { taxExempt, pricesAlreadyExempt: taxExempt, taxRegistrationType }
        ), 0);

    const isSplitChild = order.parent_invoice_id != null;
    const discType = order.discount_type || null;
    const discVal = Number(order.discount_value || 0);
    let orderDiscountAmount = 0;
    if (isSplitChild) {
        orderDiscountAmount = roundMoney(Math.max(0, subtotal + tax - total));
    } else if (discType === 'fixed') {
        orderDiscountAmount = discVal;
    } else if (discType === 'percent') {
        orderDiscountAmount = rawSubtotal * (discVal / 100);
    }
    // Checkout clamps the charged deduction at the subtotal (discountedSubtotal
    // floors at 0), so an over-discount order stores discount_value > subtotal.
    // The receipt must show the actual money deducted, never the raw rule value —
    // unclamped it fails the builder's amount<=subtotal invariant and a legal
    // full-discount sale would roll back at checkout's pre-commit v1 build.
    orderDiscountAmount = Math.min(roundMoney(orderDiscountAmount), subtotal);

    const collectedAmount = Math.max(0, Number(order.subscription_collected_amount || 0));
    const billing = order.payment_method === 'receivable' && status !== 'fully_refunded' ? {
        terms: 'receivable',
        issuedOn: order.invoice_issued_at || order.created_at,
        dueOn: order.payment_due_on,
        invoiceTotal: total,
        collectedAmount,
        outstandingAmount: Math.max(0, roundMoney(total - collectedAmount))
    } : null;

    const baseInput = {
        taxMode: accountingTaxMode,
        ...(taxExempt ? { taxExempt: true } : {}),
        status,
        summary: {
            subtotal,
            tax: taxExempt ? 0 : tax,
            total
        },
        orderDiscount: {
            type: discType,
            value: discVal,
            amount: orderDiscountAmount
        },
        ...(isSplitChild ? { subtotalAllocationToleranceCents: 1 } : {}),
        ...(billing ? { billing } : {}),
        items: receiptBuilderItems(builderItems, accountingTaxMode === 'inclusive', taxExempt)
    };

    if (displayMode === 'inclusive' && accountingTaxMode !== 'inclusive') {
        return grossReceiptInput(baseInput, { storedTotal: total, taxExempt, taxRegistrationType });
    }
    return baseInput;
}

function buildOrderPresentation({ order, items }) {
    try {
        return buildReceiptPresentation(orderPresentationInput(order, items));
    } catch (error) {
        throw asRoutePresentationError(error);
    }
}

function buildOrderPresentationForRead({ order, items }) {
    try {
        return { presentation: buildOrderPresentation({ order, items }), legacyReason: null };
    } catch (error) {
        if (error.code !== 'RECEIPT_PRESENTATION_INVALID' ||
            error.reason !== 'subtotal does not match receipt rows' ||
            order.tax_inclusive_at_sale != null) {
            throw error;
        }
        return { presentation: null, legacyReason: 'PRE_V1_CENT_MISMATCH' };
    }
}

async function loadLegacyTaxEvidence(queryable, validEntries, { split }) {
    const parentItemsMap = new Map();
    const catalogProductsMap = new Map();

    const parentInvoiceIds = [];
    if (split) {
        for (const entry of validEntries) {
            const parsed = entry.parsed;
            if (parsed && parsed.parent_invoice_id != null) {
                parentInvoiceIds.push(parsed.parent_invoice_id);
            }
        }
    }

    if (split && parentInvoiceIds.length > 0) {
        const uniqueParentInvoiceIds = [...new Set(parentInvoiceIds)];
        const [rows] = await queryable.query(
            "SELECT id, tax_rate FROM order_items WHERE invoice_id IN (?)",
            [uniqueParentInvoiceIds]
        );
        for (const row of rows) {
            parentItemsMap.set(row.id, Number(row.tax_rate));
        }
    }

    const productIdsToLoad = [];
    for (const entry of validEntries) {
        const parsed = entry.parsed;
        if (parsed) {
            const items = Array.isArray(parsed) ? parsed : (parsed.items || []);
            const isLegacy = parsed.tax_context_version !== 1;
            for (const item of items) {
                if (item.product_id != null && item.note !== 'Auto-Gratuity') {
                    if (isLegacy) {
                        if (split) {
                            const hasParentMatch = item.order_item_id != null && parentItemsMap.has(Number(item.order_item_id));
                            if (!hasParentMatch) {
                                productIdsToLoad.push(item.product_id);
                            }
                        } else {
                            productIdsToLoad.push(item.product_id);
                        }
                    }
                }
            }
        }
    }

    if (productIdsToLoad.length > 0) {
        const uniqueProductIds = [...new Set(productIdsToLoad)];
        const [rows] = await queryable.query(
            "SELECT id, tax_rate FROM products WHERE id IN (?)",
            [uniqueProductIds]
        );
        for (const row of rows) {
            catalogProductsMap.set(row.id, { tax_rate: Number(row.tax_rate) });
        }
    }

    return { parentItemsMap, catalogProductsMap };
}

function heldPresentationInput({ heldRow, parsed, legacyTaxEvidence, split, currentTaxInclusive }) {
    const isVersion1 = parsed && parsed.tax_context_version === 1;
    // Pre-plan payloads carry no mode flag. Settle/claim resolve a null flag to the
    // CURRENT system mode, so the preview must too — hardcoding exclusive showed
    // phantom tax on every legacy hold/split at an inclusive venue.
    const storedFlag = split
        ? (parsed && !Array.isArray(parsed) ? parsed.tax_inclusive_at_sale : null)
        : (parsed && !Array.isArray(parsed) ? parsed.tax_inclusive_at_hold : null);
    const accountingTaxInclusive = storedFlag != null
        ? Number(storedFlag) === 1
        : Boolean(currentTaxInclusive);
    const storedReceiptFlag = parsed && !Array.isArray(parsed)
        ? (split
            ? (parsed.receipt_tax_inclusive_at_hold ?? parsed.receipt_tax_inclusive_at_sale)
            : parsed.receipt_tax_inclusive_at_hold)
        : null;
    const receiptDisplayInclusive = storedReceiptFlag != null
        ? Number(storedReceiptFlag) === 1
        : accountingTaxInclusive;
    const taxRegistrationType = normalizeTaxRegistrationType(
        (parsed && !Array.isArray(parsed)
            ? (split ? parsed.tax_registration_type_at_sale : parsed.tax_registration_type_at_hold)
            : null) || TAX_REGISTRATION_TYPES.SALES_TAX
    );
    const taxExemptFlag = parsed && !Array.isArray(parsed)
        ? (split ? (parsed.tax_exempt_at_sale ?? parsed.tax_exempt_at_hold) : parsed.tax_exempt_at_hold)
        : undefined;
    if (taxExemptFlag !== undefined && taxExemptFlag !== null &&
        ![true, false, 1, 0, '1', '0'].includes(taxExemptFlag)) {
        const error = new Error('Invalid tax exemption flag in held order.');
        error.code = 'RECEIPT_PRESENTATION_INVALID';
        throw error;
    }
    const taxExempt = taxExemptFlag === true || taxExemptFlag === 1 || taxExemptFlag === '1';

    const rawItems = parsed ? (Array.isArray(parsed) ? parsed : (parsed.items || [])) : [];
    assertNestedBundleIntegrity(rawItems);
    assertOrderItemBundleIntegrity(rawItems);

    const builderItems = rawItems.map((item, idx) => {
        const key = `held-row-${item.order_item_id ?? item.cartId ?? idx}-${idx}`;
        const kind = item.parent_item_id != null ? 'bundle_child' : 'item';
        
        let resolvedTaxRate;
        if (item.note === 'Auto-Gratuity') {
            resolvedTaxRate = Number(item.tax_rate || 0);
        } else if (isVersion1) {
            resolvedTaxRate = Number(item.tax_rate);
        } else {
            if (item.product_id == null) {
                resolvedTaxRate = Number(item.tax_rate || 0);
            } else {
                if (split && item.order_item_id != null && legacyTaxEvidence.parentItemsMap.has(Number(item.order_item_id))) {
                    resolvedTaxRate = legacyTaxEvidence.parentItemsMap.get(Number(item.order_item_id));
                } else if (legacyTaxEvidence.catalogProductsMap.has(item.product_id)) {
                    resolvedTaxRate = legacyTaxEvidence.catalogProductsMap.get(item.product_id).tax_rate;
                } else {
                    const err = new Error('One or more products in the cart no longer exist.');
                    err.code = 'RECEIPT_PRESENTATION_INVALID';
                    throw err;
                }
            }
        }

        const rawPrice = item.price ?? item.price_at_sale ?? 0;
        const price = taxExempt && item.note !== 'Auto-Gratuity'
            ? exemptUnitPrice({ ...item, price: rawPrice }, resolvedTaxRate, accountingTaxInclusive)
            : rawPrice;
        return {
            key,
            kind,
            name: item.name || item.item_name || 'Unknown Item',
            note: item.note,
            selectedModifiers: item.selectedModifiers ?? item.selected_modifiers ?? null,
            qty: item.qty ?? item.quantity ?? 1,
            price,
            discountType: item.discountType ?? item.discount_type ?? null,
            discountValue: item.discountValue ?? item.discount_value ?? 0,
            tax_rate: resolvedTaxRate,
            parent_item_id: item.parent_item_id,
            modifier_surcharge: item.modifier_surcharge ?? null,
            modifier_tax_amount: item.modifier_tax_amount ?? null
        };
    });

    const normalizedItems = normalizeCartItems(builderItems);

    normalizedItems.forEach((item, idx) => {
        const stored = Number(builderItems[idx]?.modifier_surcharge);
        item.modifier_surcharge = Number.isFinite(stored) && stored > 0 ? stored : null;
        const storedTax = Number(builderItems[idx]?.modifier_tax_amount);
        item.modifier_tax_amount = builderItems[idx]?.modifier_tax_amount != null && Number.isFinite(storedTax) && storedTax >= 0
            ? storedTax : null;
    });

    const productMap = new Map();
    for (const item of normalizedItems) {
        if (item.product_id != null) {
            productMap.set(item.product_id, {
                id: item.product_id,
                tax_rate: item.tax_rate
            });
        }
    }

    const disc = (parsed && parsed.order_discount) || {};
    const expectedTotals = calculateExpectedTotals(
        {
            order_discount_type: disc.type || null,
            order_discount_value: Number(disc.value) || 0
        },
        normalizedItems,
        productMap,
        accountingTaxInclusive,
        { taxExempt, pricesAlreadyExempt: taxExempt, taxRegistrationType }
    );

    const hasTrustedSplitAllocation = split
        && parsed
        && !Array.isArray(parsed)
        && Object.prototype.hasOwnProperty.call(parsed, 'split_money_cents');
    const splitMoney = hasTrustedSplitAllocation
        ? validateSplitMoneyCents(parsed.split_money_cents)
        : null;

    const baseInput = {
        taxMode: accountingTaxInclusive ? 'inclusive' : 'exclusive',
        ...(taxExempt ? { taxExempt: true } : {}),
        status: 'original',
        summary: {
            subtotal: splitMoney ? splitMoney.subtotal / 100 : expectedTotals.subtotal,
            tax: taxExempt ? 0 : (splitMoney ? splitMoney.tax / 100 : expectedTotals.tax),
            total: splitMoney ? splitMoney.total / 100 : expectedTotals.total
        },
        orderDiscount: {
            type: disc.type || null,
            value: Number(disc.value) || 0,
            amount: splitMoney ? splitMoney.discount / 100 : expectedTotals.discount
        },
        ...(splitMoney ? { subtotalAllocationToleranceCents: 1 } : {}),
        items: receiptBuilderItems(normalizedItems, accountingTaxInclusive, taxExempt)
    };

    if (receiptDisplayInclusive && !accountingTaxInclusive) {
        return grossReceiptInput(baseInput, {
            storedTotal: splitMoney ? splitMoney.total / 100 : expectedTotals.total,
            taxExempt,
            taxRegistrationType
        });
    }
    return baseInput;
}

async function buildHeldPresentations(queryable, heldRows, { split = false } = {}) {
    const entries = heldRows.map(row => {
        try {
            return { row, parsed: parseHeldCartData(row.cart_data), error: null };
        } catch (error) {
            if (error.code !== 'RECEIPT_PRESENTATION_INVALID') throw error;
            return { row, parsed: null, error: asRoutePresentationError(error) };
        }
    });

    const validEntries = entries.filter(entry => !entry.error);
    const legacyTaxEvidence = await loadLegacyTaxEvidence(queryable, validEntries, { split });

    // Load the current mode only when a legacy row actually needs the fallback.
    const flagOf = parsed => (parsed && !Array.isArray(parsed)
        ? (split ? parsed.tax_inclusive_at_sale : parsed.tax_inclusive_at_hold)
        : null);
    let currentTaxInclusive = false;
    if (validEntries.some(entry => flagOf(entry.parsed) == null)) {
        const [[settingRow]] = await queryable.query(
            "SELECT setting_value FROM settings WHERE setting_key = 'tax_inclusive_pricing'"
        );
        currentTaxInclusive = settingRow ? settingRow.setting_value === '1' : false;
    }

    return entries.map(entry => {
        if (entry.error) return { presentation: null, error: entry.error };
        try {
            const input = heldPresentationInput({
                heldRow: entry.row,
                parsed: entry.parsed,
                legacyTaxEvidence,
                split,
                currentTaxInclusive
            });
            return { presentation: buildReceiptPresentation(input), error: null };
        } catch (error) {
            if (error.publicCode === BUNDLE_ORDER_CORRUPT) {
                return { presentation: null, error };
            }
            // heldPresentationInput/buildReceiptPresentation are pure computation
            // (evidence was batch-loaded above), so ANY throw here is that row's
            // data problem — normalizeCartItems and calculateExpectedTotals raise
            // plain Errors ('Cart is empty.', 'Invalid quantity...', 'Invalid tax
            // rate...') that must not escape and 500 every other row in the list.
            if (error.code !== 'RECEIPT_PRESENTATION_INVALID') {
                error.code = 'RECEIPT_PRESENTATION_INVALID';
                error.reason = error.reason || error.message;
            }
            return { presentation: null, error: asRoutePresentationError(error) };
        }
    });
}

module.exports = {
    buildOrderPresentation,
    buildOrderPresentationForRead,
    buildHeldPresentations,
    receiptBuilderItems,
    receiptDisplayInclusive,
    calculateReceiptLineGross,
    grossReceiptInput
};
