'use strict';

const {
    normalizeCartItems,
    calculateLineSubtotal,
    validateTaxRate,
    buildSelectedModifiersSnapshot,
    resolveEffectiveTaxRate
} = require('./PosCalculator');
const { fetchCartProducts } = require('./InventoryService');
const { applyDatabasePrices, loadCheckoutSettings } = require('./OrderPricing');
const { attachRegisterPrices } = require('./categoryPriceLists');
const { validateBundleCartLines, canonicalizeBundleCartLines } = require('./bundleOrderItems');
const {
    assertHeldItemStructure,
    assertOrderItemBundleIntegrity,
    assertNestedBundleIntegrity
} = require('./bundleIntegrity');
const { normalizeTaxRegistrationType } = require('../config/taxRegistration');

async function canonicalizeHeldCart(
    conn,
    actor,
    submitted,
    {
        accountingTaxInclusive = false,
        savedTaxRegistrationType = null,
        catalogProductMap = null,
        validatedMembersByBundleId = null,
        registerPricesResolved = false
    } = {}
) {
    assertHeldItemStructure(submitted.items);
    assertNestedBundleIntegrity(submitted.items);
    assertOrderItemBundleIntegrity(submitted.items);
    const canonicalItems = normalizeCartItems(submitted.items.map(item => ({
        ...item,
        price: item.price ?? item.price_at_sale ?? 0,
    })));
    const bundleDefinitions = validatedMembersByBundleId || await validateBundleCartLines(conn, canonicalItems, {
        requireBundleItems: true,
        trustedProductMap: catalogProductMap
    });
    await canonicalizeBundleCartLines(conn, canonicalItems, { validatedMembersByBundleId: bundleDefinitions });
    for (const item of canonicalItems) {
        if (Array.isArray(item.bundleItems)) item.bundle_snapshot_version = 1;
    }
    const productMap = catalogProductMap || await fetchCartProducts(conn, canonicalItems);
    if (!registerPricesResolved) await attachRegisterPrices(conn, productMap);
    applyDatabasePrices(canonicalItems, productMap, { ...actor, role: 'cashier', permissions: [] }, false, null);
    const taxRegistrationType = savedTaxRegistrationType == null
        ? (await loadCheckoutSettings(conn)).taxRegistrationType
        : normalizeTaxRegistrationType(savedTaxRegistrationType);
    for (const item of canonicalItems) {
        if (item.note === 'Auto-Gratuity') continue;
        const product = item.product_id != null ? productMap.get(item.product_id) : null;
        item.tax_rate = resolveEffectiveTaxRate(
            product ? Number(product.tax_rate) || 0 : validateTaxRate(item.tax_rate ?? 0),
            taxRegistrationType
        );
        item.jofotara_tax_category = product?.jofotara_tax_category || item.jofotara_tax_category || 'O';
        if (product) {
            item.name = product.name;
            item.category_id = product.category_id;
        }
        item.selectedModifiers = buildSelectedModifiersSnapshot(product, item, productMap);
        if (item.product_id != null) delete item.manual_price_override;
    }
    const canonicalSubtotal = canonicalItems.reduce(
        (sum, item) => sum + calculateLineSubtotal(
            item,
            item.tax_rate,
            accountingTaxInclusive,
            { taxRegistrationType }
        ),
        0
    );
    return {
        canonicalItems,
        accountingTaxInclusive,
        taxRegistrationType,
        canonicalSubtotal,
        productMap
    };
}

module.exports = { canonicalizeHeldCart };
