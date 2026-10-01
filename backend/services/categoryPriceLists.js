const MAX_NET_PRICE = 9999.999999;

function numeric(value, label) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
        throw new TypeError(`${label} must be a finite number.`);
    }
    return Number(value);
}

function taxRate(value) {
    const rate = numeric(value, 'Tax rate');
    if (rate < 0 || rate > 100) throw new RangeError('Tax rate must be between 0 and 100.');
    return rate;
}

function netPrice(value) {
    const price = numeric(value, 'Price');
    if (price < 0 || price > MAX_NET_PRICE) {
        throw new RangeError('Price is outside the supported DECIMAL(10,6) range.');
    }
    return price;
}

function roundSix(value) {
    return Number(value.toFixed(6));
}

function grossToNet(grossPrice, currentTaxRate) {
    const gross = numeric(grossPrice, 'Gross price');
    if (gross < 0) throw new RangeError('Gross price cannot be negative.');
    return netPrice(roundSix(gross / (1 + taxRate(currentTaxRate) / 100)));
}

function netToGross(currentNetPrice, currentTaxRate) {
    return roundSix(netPrice(currentNetPrice) * (1 + taxRate(currentTaxRate) / 100));
}

function categoryFrom(categoriesById, id) {
    if (id == null) return null;
    return categoriesById.get(Number(id)) || categoriesById.get(String(id)) || null;
}

function resolveInheritedRootId(categoriesById, parentId) {
    const parent = categoryFrom(categoriesById, parentId);
    if (!parent || parent.price_list_root_id == null) return null;
    const root = categoryFrom(categoriesById, parent.price_list_root_id);
    if (!root || Number(root.id) !== Number(root.price_list_root_id) || root.parent_id != null || Number(root.is_notes) === 1) {
        return null;
    }
    return Number(root.id);
}

function collectCategorySubtree(categories, rootId) {
    const root = categories.find(row => Number(row.id) === Number(rootId));
    if (!root) return [];
    const children = new Map();
    for (const row of categories) {
        const key = row.parent_id == null ? null : Number(row.parent_id);
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(row);
    }
    const result = [];
    const queue = [root];
    const seen = new Set();
    while (queue.length > 0) {
        const row = queue.shift();
        const id = Number(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(row);
        queue.push(...(children.get(id) || []));
    }
    return result;
}

async function loadRegisterPriceContext(executor, productIds) {
    const ids = [...new Set((productIds || [])
        .map(Number)
        .filter(id => Number.isInteger(id) && id > 0))]
        .sort((a, b) => a - b);
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await executor.query(`
        SELECT p.id AS product_id, p.name, p.price AS base_price, p.tax_rate, p.category_id,
               direct_category.is_notes AS category_is_notes,
               valid_root.id AS price_list_root_id,
               valid_root.name AS price_list_root_name,
               price_override.price AS override_price
          FROM products p
          LEFT JOIN categories direct_category ON direct_category.id = p.category_id
          LEFT JOIN categories valid_root
            ON valid_root.id = direct_category.price_list_root_id
           AND valid_root.price_list_root_id = valid_root.id
           AND valid_root.parent_id IS NULL
           AND valid_root.is_notes = 0
           AND valid_root.is_active = 1
          LEFT JOIN product_price_overrides price_override
            ON price_override.price_list_root_id = valid_root.id
           AND price_override.product_id = p.id
         WHERE p.id IN (${placeholders})
    `, ids);

    return new Map(rows.map(row => {
        const productId = Number(row.product_id);
        const basePrice = Number(row.base_price);
        const rootId = Number(row.category_is_notes) === 1 || row.price_list_root_id == null
            ? null
            : Number(row.price_list_root_id);
        const hasOverride = rootId != null && row.override_price != null;
        return [productId, {
            product_id: productId,
            name: row.name,
            base_price: basePrice,
            effective_price: hasOverride ? Number(row.override_price) : basePrice,
            tax_rate: Number(row.tax_rate) || 0,
            category_id: row.category_id == null ? null : Number(row.category_id),
            price_list_root_id: rootId,
            price_list_root_name: rootId == null ? null : row.price_list_root_name,
            has_price_override: hasOverride ? 1 : 0
        }];
    }));
}

async function attachRegisterPrices(executor, productMap) {
    const context = await loadRegisterPriceContext(executor, [...productMap.keys()]);
    for (const [productId, product] of productMap) {
        const resolved = context.get(Number(productId));
        if (resolved) Object.assign(product, resolved);
    }
    return productMap;
}

module.exports = {
    MAX_NET_PRICE,
    grossToNet,
    netToGross,
    loadRegisterPriceContext,
    attachRegisterPrices,
    collectCategorySubtree,
    resolveInheritedRootId
};
