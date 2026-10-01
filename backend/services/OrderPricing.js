const pool = require('../config/db');
const logger = require('../config/logger');
const { getSettings } = require('../config/settingsHelper');
const { canPriceOverride } = require('./PermissionService');
const {
    calculateExpectedTotals,
    computeModifierSurcharge,
    deriveModifierTaxAmount,
    resolveTaxRate,
    resolveEffectiveTaxRate,
    stampLineTax
} = require('./PosCalculator');
const { assertOrderItemBundleIntegrity } = require('./bundleIntegrity');
const { TAX_REGISTRATION_TYPES, normalizeTaxRegistrationType, resolveJofotaraSaleTaxCategory } = require('../config/taxRegistration');
const { fetchCartProducts } = require('./InventoryService');
const { broadcastTableUpdate } = require('./TableRealtime');
const { savedLineKey } = require('../modules/orders/SavedOrderLines');

const resolveProductPrice = (product, item, productMap) => {
    const extraPrice = computeModifierSurcharge(product, item, productMap);
    const expected = Number((Number(product.effective_price ?? product.price) + extraPrice).toFixed(4));
    return { extraPrice, expected };
};

const hasUnfrozenPriceOverride = (cartItems, productMap, savedPriceMap = null) => cartItems.some(item => {
    if (!item.product_id || savedPriceMap?.has(savedLineKey(item))) return false;
    const product = productMap.get(item.product_id);
    if (!product || Number(product.category_is_notes) === 1) return false;
    const { expected } = resolveProductPrice(product, item, productMap);
    return Math.abs(Number(item.price) - expected) > 0.0001;
});

const applyDatabasePrices = (cartItems, productMap, user, trustClientPrices = false, savedPriceMap = null, { priceOverrideApproved = false } = {}) => {
    const overrides = [];
    if (trustClientPrices) return overrides;
    const mayOverridePrice = canPriceOverride(user) || priceOverrideApproved === true;
    for (const item of cartItems) {
        if (item.product_id) {
            const product = productMap.get(item.product_id);
            if (!product) throw new Error('One or more products in the cart no longer exist.');
            const key = savedLineKey(item);
            if (savedPriceMap && savedPriceMap.has(key)) continue;
            if (Number(product.category_is_notes) === 1) {
                throw Object.assign(
                    new Error('Note products must be added to an item.'),
                    { statusCode: 409, publicCode: 'NOTE_PRODUCT_REQUIRES_ITEM' }
                );
            }
            const { extraPrice, expected } = resolveProductPrice(product, item, productMap);
            item.modifier_surcharge = extraPrice > 0 ? Number(extraPrice.toFixed(6)) : null;
            item.modifier_tax_amount = extraPrice > 0
                ? Number(deriveModifierTaxAmount(extraPrice, product.tax_rate).toFixed(6))
                : null;
            if (!mayOverridePrice) item.price = expected;
            else if (Math.abs(Number(item.price) - expected) > 0.0001) {
                overrides.push({ product_id: item.product_id, base: expected, override: Number(item.price) });
            }
        }
    }
    return overrides;
};

const loadCheckoutSettings = async (conn) => {
    const s = await getSettings(conn, ['stock_enabled', 'tables_enabled', 'tax_inclusive_pricing', 'tax_registration_type', 'service_charge_enabled', 'service_charge_percentage', 'service_charge_tax_rate', 'service_charge_jofotara_tax_category', 'auto_apply_service_charge', 'default_order_type_id', 'recipe_ledger_enabled', 'order_type_numbering']);
    const defaultOrderTypeId = Number(s.default_order_type_id);
    return {
        stockEnabled: s.stock_enabled === '1',
        orderTypeNumbering: s.order_type_numbering === '1',
        tablesEnabled: s.tables_enabled === '1',
        // This setting is a customer-copy presentation preference. New sale
        // calculations must not consume it as an accounting mode.
        receiptTaxInclusiveDisplay: s.tax_inclusive_pricing === '1',
        taxRegistrationType: s.tax_registration_type == null
            ? TAX_REGISTRATION_TYPES.SALES_TAX
            : normalizeTaxRegistrationType(s.tax_registration_type),
        serviceChargeEnabledSetting: s.service_charge_enabled === '1',
        serviceChargePct: parseFloat(s.service_charge_percentage || '10'),
        serviceChargeTax: parseFloat(s.service_charge_tax_rate || '0'),
        serviceChargeTaxCategory: s.service_charge_jofotara_tax_category || 'O',
        autoApplyServiceCharge: s.auto_apply_service_charge === '1',
        defaultOrderTypeId: Number.isInteger(defaultOrderTypeId) && defaultOrderTypeId > 0
            ? defaultOrderTypeId
            : null,
        recipeLedgerEnabled: s.recipe_ledger_enabled === '1'
    };
};

// Bound each restamp's SQL/parameter size.
const writeLineTaxUpdates = async (conn, invoiceId, taxUpdates) => {
    for (let offset = 0; offset < taxUpdates.length; offset += 200) {
        const batch = taxUpdates.slice(offset, offset + 200);
        const cases = batch.map(() => 'WHEN ? THEN ?').join(' ');
        const values = field => batch.flatMap(row => [row.id, row[field]]);
        await conn.query(`UPDATE order_items SET tax_rate = CASE id ${cases} END,
            jofotara_tax_category = CASE id ${cases} END,
            tax_amount = CASE id ${cases} END
            WHERE invoice_id = ? AND id IN (?)`, [
            ...values('taxRate'), ...values('taxCategory'), ...values('taxAmount'),
            invoiceId, batch.map(row => row.id)
        ]);
    }
};

const recomputeOrderTotals = async (conn, invoiceId, { preserveSavedTax = false } = {}) => {
    const [[order]] = await conn.query(
        'SELECT payment_method, discount_type, discount_value, tax_inclusive_at_sale, tax_registration_type_at_sale, tax_exempt_at_sale FROM orders WHERE invoice_id = ? FOR UPDATE',
        [invoiceId]
    );
    if (!order || order.payment_method !== 'unpaid_table') return false;

    const taxRegistrationType = order.tax_registration_type_at_sale == null
        ? TAX_REGISTRATION_TYPES.SALES_TAX
        : normalizeTaxRegistrationType(order.tax_registration_type_at_sale);
    if (order.tax_registration_type_at_sale == null) {
        await conn.query(
            'UPDATE orders SET tax_registration_type_at_sale = ? WHERE invoice_id = ?',
            [taxRegistrationType, invoiceId]
        );
    }
    const taxExempt = Number(order.tax_exempt_at_sale) === 1;

    let taxInclusivePricing;
    if (order.tax_inclusive_at_sale == null && !preserveSavedTax) {
        const taxSetting = await getSettings(conn, ['tax_inclusive_pricing']);
        taxInclusivePricing = taxSetting.tax_inclusive_pricing === '1';
    } else {
        taxInclusivePricing = Number(order.tax_inclusive_at_sale) === 1;
    }

    const [items] = await conn.query(
        'SELECT id, invoice_id, product_id, quantity, price_at_sale, discount_type, discount_value, tax_rate, jofotara_tax_category, parent_item_id, modifier_surcharge, modifier_tax_amount FROM order_items WHERE invoice_id = ?',
        [invoiceId]
    );
    assertOrderItemBundleIntegrity(items);
    if (items.length === 0) return false;

    const cartItems = items.map((it) => ({
        product_id: it.product_id,
        qty: Number(it.quantity),
        price: Number(it.price_at_sale),
        discountType: it.discount_type,
        discountValue: Number(it.discount_value || 0),
        tax_rate: Number(it.tax_rate || 0),
        modifier_surcharge: it.modifier_surcharge != null ? Number(it.modifier_surcharge) : null,
        modifier_tax_amount: it.modifier_tax_amount != null ? Number(it.modifier_tax_amount) : null
    }));

    // Merge already-saved lines using their own rates/categories, including
    // distinct tax contexts for the same product. The existing calculator and
    // stamping helpers fall back to the saved row when no catalog product is
    // supplied. Catalog healing and partial voids retain their live-tax policy.
    const productMap = preserveSavedTax ? new Map() : await fetchCartProducts(conn, cartItems);
    const expected = calculateExpectedTotals(
        { order_discount_type: order.discount_type, order_discount_value: order.discount_value },
        cartItems,
        productMap,
        taxInclusivePricing,
        { taxRegistrationType, taxExempt, pricesAlreadyExempt: taxExempt }
    );

    const taxUpdates = [];
    for (const it of items) {
        if (it.parent_item_id != null) continue;
        const product = it.product_id ? productMap.get(Number(it.product_id)) : null;
        const taxRate = resolveEffectiveTaxRate(
            resolveTaxRate(product, it.tax_rate),
            taxRegistrationType
        );
        const lineLike = {
            price: it.price_at_sale,
            qty: it.quantity,
            discountType: it.discount_type,
            discountValue: it.discount_value,
            modifier_surcharge: it.modifier_surcharge != null ? Number(it.modifier_surcharge) : null,
            modifier_tax_amount: it.modifier_tax_amount != null ? Number(it.modifier_tax_amount) : null
        };
        const taxAmount = stampLineTax(
            lineLike,
            taxRate,
            expected.discountRatio,
            taxInclusivePricing,
            { taxRegistrationType, taxExempt }
        );
        const taxCategory = product
            ? resolveJofotaraSaleTaxCategory(product.jofotara_tax_category, product.tax_rate, { taxRegistrationType, taxExempt })
            : resolveJofotaraSaleTaxCategory(it.jofotara_tax_category, it.tax_rate, { taxRegistrationType, taxExempt });
        taxUpdates.push({ id: it.id, taxRate, taxCategory, taxAmount });
    }
    await writeLineTaxUpdates(conn, invoiceId, taxUpdates);

    await conn.query(
        'UPDATE orders SET version=COALESCE(version, 1)+1, subtotal = ?, tax = ?, total = ? WHERE invoice_id = ?',
        [expected.subtotal, expected.tax, expected.total, invoiceId]
    );
    return true;
};

const healOpenOrdersForProduct = async (productId, io) => {
    let affected = [];
    try {
        const [rows] = await pool.query(
            `SELECT DISTINCT o.invoice_id, o.table_id
             FROM order_items oi
             JOIN orders o ON o.invoice_id = oi.invoice_id
             WHERE oi.product_id = ? AND o.payment_method = 'unpaid_table'`,
            [productId]
        );
        affected = rows;
    } catch (err) {
        logger.error({ err, productId }, 'healOpenOrdersForProduct: lookup failed');
        return;
    }

    for (const row of affected) {
        let conn;
        try {
            conn = await pool.getConnection();
            await conn.beginTransaction();
            await recomputeOrderTotals(conn, row.invoice_id);
            await conn.commit();
            if (io && row.table_id) broadcastTableUpdate(io, row.table_id);
        } catch (err) {
            if (conn) await conn.rollback().catch(() => {});
            logger.error({ err, productId, invoiceId: row.invoice_id }, 'healOpenOrdersForProduct: recompute failed');
        } finally {
            if (conn) conn.release();
        }
    }
};

module.exports = {
    applyDatabasePrices,
    hasUnfrozenPriceOverride,
    loadCheckoutSettings,
    recomputeOrderTotals,
    healOpenOrdersForProduct
};
