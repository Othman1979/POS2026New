function toPositiveIntOrNull(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function getKitchenProductId(item) {
    if (!item || typeof item !== 'object') return null;
    return toPositiveIntOrNull(item.product_id ?? item.id);
}

function buildKitchenCartId(item, index, productId, prefix) {
    if (item && item.cartId !== undefined && item.cartId !== null && String(item.cartId).trim() !== '') {
        return String(item.cartId);
    }
    const suffix = productId || (item && item.id !== undefined ? item.id : 'custom');
    return `${prefix}-${index + 1}-${suffix}`;
}

function collectProductIds(items, out = new Set()) {
    for (const item of Array.isArray(items) ? items : []) {
        const productId = getKitchenProductId(item);
        if (productId) out.add(productId);
        if (Array.isArray(item?.bundleItems)) collectProductIds(item.bundleItems, out);
    }
    return out;
}

async function loadProductsById(db, productIds) {
    if (!db || typeof db.query !== 'function') {
        throw new Error('normalizeKitchenTicketItems requires a db query object.');
    }
    if (productIds.length === 0) return new Map();

    const placeholders = productIds.map(() => '?').join(',');
    const [products] = await db.query(
        `SELECT id, name, category_id, is_bundle FROM products WHERE id IN (${placeholders})`,
        productIds
    );

    const productById = new Map();
    for (const product of products) productById.set(Number(product.id), product);
    return productById;
}

function normalizeBundleItems(bundleItems, { parentCartId, productById }) {
    return bundleItems.map((subItem, subIndex) => {
        const productId = getKitchenProductId(subItem);
        const product = productId ? productById.get(productId) : null;
        const cartId = buildKitchenCartId(subItem, subIndex, productId, `${parentCartId}-bundle`);

        return {
            ...subItem,
            id: subItem.id ?? productId ?? cartId,
            product_id: productId,
            cartId,
            category_id: product ? product.category_id : subItem.category_id,
            name: subItem.name || product?.name || '',
            qty: subItem.qty ?? subItem.quantity ?? 1,
            note: subItem.note || '',
            is_bundle: subItem.is_bundle || product?.is_bundle || 0
        };
    });
}

async function normalizeKitchenTicketItems(rawItems, {
    db,
    linePrefix = 'kitchen-line',
    deriveBundleParentsFromLinks = false,
    productLookup = true
} = {}) {
    const list = Array.isArray(rawItems) ? rawItems : [];
    const productIds = productLookup ? [...collectProductIds(list)].sort((a, b) => a - b) : [];
    const productById = productLookup ? await loadProductsById(db, productIds) : new Map();
    const persistedBundleParentIds = new Set(
        list.map(item => toPositiveIntOrNull(item?.parent_item_id)).filter(Boolean)
    );

    return list.map((item, index) => {
        const productId = getKitchenProductId(item);
        const product = productId ? productById.get(productId) : null;
        const cartId = buildKitchenCartId(item, index, productId, linePrefix);
        const bundleItems = Array.isArray(item.bundleItems)
            ? normalizeBundleItems(item.bundleItems, { parentCartId: cartId, productById })
            : null;

        return {
            ...item,
            id: item.id ?? productId ?? cartId,
            product_id: productId,
            cartId,
            category_id: product ? product.category_id : item.category_id,
            name: item.name || item.item_name || product?.name || 'Unknown Item',
            qty: item.qty ?? item.quantity ?? 1,
            note: item.note || '',
            is_bundle: deriveBundleParentsFromLinks
                ? (persistedBundleParentIds.has(toPositiveIntOrNull(item.id)) ? 1 : 0)
                : (item.is_bundle || product?.is_bundle || 0),
            ...(bundleItems ? { bundleItems } : {})
        };
    });
}

module.exports = {
    normalizeKitchenTicketItems,
    toPositiveIntOrNull,
    getKitchenProductId,
    buildKitchenCartId
};
