const { getBusinessDayRange, getBusinessDateRange } = require('../utils/businessDate');
const { buildHeldPresentations } = require('./ReceiptPresentationSources');
const { getStoreInfo } = require('./auditReportBuilder');
const {
    normalizeCartItems,
    calculateLineSubtotal,
    stampLineTax,
} = require('./PosCalculator');

const toMoney = value => Number(Number(value || 0).toFixed(2));
const toQty = value => Number(Number(value || 0).toFixed(3));
const cents = value => Math.round((Number(value || 0) + Number.EPSILON) * 100);

function parseCartData(value) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.items)) {
        const error = new Error('Invalid Y held-order data.');
        error.statusCode = 422;
        throw error;
    }
    return parsed;
}

async function getConfiguredYOrderTypeId(executor) {
    const [[setting]] = await executor.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'y_order_type_id'"
    );
    const orderTypeId = Number(setting?.setting_value);
    if (!Number.isInteger(orderTypeId) || orderTypeId <= 0) {
        const error = new Error('Configure the Y order type in the database before printing this report.');
        error.statusCode = 409;
        throw error;
    }
    return orderTypeId;
}

function apportionGross(lines, targetTotal) {
    const values = lines.map(line => Math.max(0, Number(line.grossRaw || 0)));
    const assigned = values.map(cents);
    let delta = cents(targetTotal) - assigned.reduce((sum, value) => sum + value, 0);
    const order = values
        .map((value, index) => ({ index, fraction: value * 100 - Math.floor(value * 100) }))
        .sort((a, b) => delta >= 0
            ? b.fraction - a.fraction || a.index - b.index
            : a.fraction - b.fraction || a.index - b.index);

    for (let cursor = 0; delta !== 0 && order.length > 0; cursor += 1) {
        const index = order[cursor % order.length].index;
        const next = assigned[index] + Math.sign(delta);
        if (next < 0) continue;
        assigned[index] = next;
        delta -= Math.sign(delta);
    }
    return assigned.map(value => value / 100);
}

function addBucket(map, key, name, qty, revenue) {
    const bucket = map.get(key) || { name, qty: 0, revenue: 0 };
    bucket.qty += Number(qty || 0);
    bucket.revenue += Number(revenue || 0);
    map.set(key, bucket);
}

function resolveRootId(categoryMap, categoryId) {
    const visited = new Set();
    let currentId = categoryId;
    while (categoryMap.has(currentId) && !visited.has(currentId)) {
        visited.add(currentId);
        const current = categoryMap.get(currentId);
        if (current.parent_id === null) return currentId;
        currentId = current.parent_id;
    }
    return categoryId;
}

function buildSections(itemBuckets, categoryBuckets, categoryRows) {
    const categoryMap = new Map(categoryRows.map(row => [Number(row.id), {
        name: row.name,
        parent_id: row.parent_id === null ? null : Number(row.parent_id),
    }]));
    const rootTotals = new Map();
    const subcategoryTotals = new Map();

    for (const [categoryId, bucket] of categoryBuckets) {
        if (categoryId === 'uncategorized') {
            addBucket(rootTotals, categoryId, 'Uncategorized', bucket.qty, bucket.revenue);
            continue;
        }
        const rootId = resolveRootId(categoryMap, categoryId);
        const own = categoryMap.get(categoryId);
        const root = categoryMap.get(rootId);
        addBucket(rootTotals, rootId, root?.name || bucket.name, bucket.qty, bucket.revenue);
        if (own && own.parent_id !== null) {
            if (!subcategoryTotals.has(rootId)) subcategoryTotals.set(rootId, new Map());
            addBucket(subcategoryTotals.get(rootId), categoryId, own.name, bucket.qty, bucket.revenue);
        }
    }

    const roots = [...rootTotals.entries()].sort((a, b) =>
        b[1].revenue - a[1].revenue || a[1].name.localeCompare(b[1].name));

    return {
        categories: roots.map(([, bucket]) => ({
            category_name: bucket.name,
            qty_sold: toQty(bucket.qty),
            gross_revenue: toMoney(bucket.revenue),
        })),
        subcategories: roots
            .filter(([rootId]) => subcategoryTotals.has(rootId))
            .map(([rootId, root]) => ({
                category_name: root.name,
                rows: [...subcategoryTotals.get(rootId).values()]
                    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name))
                    .map(bucket => ({
                        category_name: bucket.name,
                        qty_sold: toQty(bucket.qty),
                        gross_revenue: toMoney(bucket.revenue),
                    })),
            })),
        items: [...itemBuckets.values()]
            .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name))
            .map(bucket => ({
                item_name: bucket.name,
                qty_sold: toQty(bucket.qty),
                gross_revenue: toMoney(bucket.revenue),
            })),
    };
}

async function buildYHeldItemsReportPayload(executor, options) {
    const isPeriod = Boolean(options.startDate);
    const businessDate = options.businessDate || null;
    const periodStartDate = isPeriod ? options.startDate : null;
    const periodEndDate = isPeriod ? (options.endDate || options.startDate) : null;
    const range = isPeriod
        ? getBusinessDateRange(periodStartDate, periodEndDate)
        : getBusinessDayRange(businessDate);

    const yOrderTypeId = options.heldRows ? null : await getConfiguredYOrderTypeId(executor);
    const heldRowsQuery = options.heldRows
        ? Promise.resolve([options.heldRows])
        : executor.query(
            `SELECT h.*, u.name AS cashier_name
             FROM held_orders h
             LEFT JOIN users u ON u.id = h.user_id
             WHERE h.created_at >= ? AND h.created_at < ?
               AND CASE WHEN JSON_VALID(h.cart_data)
                    THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(h.cart_data, '$.order_type_id')) AS UNSIGNED)
                    ELSE NULL END = ?
             ORDER BY h.created_at ASC, h.id ASC`,
            [range.start, range.end, yOrderTypeId]
        );
    const [storeInfo, [heldRows], [categoryRows]] = await Promise.all([
        getStoreInfo(executor),
        heldRowsQuery,
        executor.query('SELECT id, parent_id, name FROM categories'),
    ]);
    const presentations = await buildHeldPresentations(executor, heldRows, { split: false });
    const userIds = [...new Set(heldRows.map(row => Number(row.user_id)).filter(Number.isInteger))];
    const [users] = userIds.length > 0
        ? await executor.query(
            `SELECT id, name FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
            userIds
        )
        : [[]];
    const cashierNames = new Map(users.map(user => [Number(user.id), user.name]));
    const itemBuckets = new Map();
    const categoryBuckets = new Map();
    const orders = [];
    const summary = {
        order_count: heldRows.length,
        subtotal: 0,
        lineDiscount: 0,
        orderDiscount: 0,
        tax: 0,
        total: 0,
    };

    for (let index = 0; index < heldRows.length; index += 1) {
        const result = presentations[index];
        if (result.error) {
            const error = new Error(`Y order #${heldRows[index].id} cannot be reported because its saved data is invalid.`);
            error.statusCode = 422;
            throw error;
        }
        const presentation = result.presentation;
        const parsed = parseCartData(heldRows[index].cart_data);
        const normalized = normalizeCartItems(parsed.items.map(item => ({
            ...item,
            price: item.price ?? item.price_at_sale ?? 0,
        })));
        normalized.forEach((item, itemIndex) => {
            const stored = Number(parsed.items[itemIndex]?.modifier_surcharge);
            item.modifier_surcharge = Number.isFinite(stored) && stored > 0 ? stored : null;
            const storedTax = Number(parsed.items[itemIndex]?.modifier_tax_amount);
            item.modifier_tax_amount = parsed.items[itemIndex]?.modifier_tax_amount != null && Number.isFinite(storedTax) && storedTax >= 0
                ? storedTax : null;
        });

        const subtotal = Number(presentation.summary.subtotal || 0);
        const orderDiscount = Number(presentation.summary.orderDiscountAmount || 0);
        const discountRatio = subtotal > 0 ? Math.max(0, subtotal - orderDiscount) / subtotal : 1;
        const taxInclusive = presentation.taxMode === 'inclusive';
        const financialLines = normalized.map((item, itemIndex) => ({
            item,
            raw: parsed.items[itemIndex],
            display: presentation.rows[itemIndex],
            grossRaw: calculateLineSubtotal(item, Number(item.tax_rate || 0), taxInclusive) * discountRatio +
                stampLineTax(item, Number(item.tax_rate || 0), discountRatio, taxInclusive),
        }));
        const allocatedGross = apportionGross(financialLines, presentation.summary.total);

        financialLines.forEach((line, lineIndex) => {
            const name = line.display?.name || line.raw.name || line.raw.item_name || 'Unknown Item';
            const categoryId = Number(line.raw.category_id);
            const categoryKey = Number.isInteger(categoryId) && categoryId > 0 ? categoryId : 'uncategorized';
            addBucket(itemBuckets, name, name, line.item.qty, allocatedGross[lineIndex]);
            addBucket(categoryBuckets, categoryKey, categoryMapName(categoryRows, categoryKey), line.item.qty, allocatedGross[lineIndex]);

            for (const child of line.raw.bundleItems || []) {
                if (child?.removed === true) continue;
                const childName = child?.name || 'Unknown Item';
                const childQty = Number(child?.qty || 0) * Number(line.item.qty || 0);
                const childCategoryId = Number(child?.category_id);
                const childCategoryKey = Number.isInteger(childCategoryId) && childCategoryId > 0
                    ? childCategoryId
                    : 'uncategorized';
                addBucket(itemBuckets, childName, childName, childQty, 0);
                addBucket(categoryBuckets, childCategoryKey, categoryMapName(categoryRows, childCategoryKey), childQty, 0);
            }
        });

        const lineDiscount = presentation.rows.reduce((sum, row) => sum + Number(row.lineDiscountAmount || 0), 0);
        orders.push({
            held_order_id: Number(heldRows[index].id),
            reference_name: heldRows[index].reference_name,
            cashier_name: cashierNames.get(Number(heldRows[index].user_id)) || 'Unknown',
            created_at: heldRows[index].created_at,
            kitchen_fired: Number(heldRows[index].kitchen_fired || 0) === 1,
            order_type_id: parsed.order_type_id || null,
            tax_mode: presentation.taxMode,
            items: presentation.rows.map(row => ({
                item_name: row.name,
                note: row.note || '',
                qty: toQty(row.qty),
                unit_price: toMoney(row.unitPrice),
                line_discount: toMoney(row.lineDiscountAmount),
                net_amount: toMoney(row.netAmount),
                kind: row.kind,
            })),
            summary: {
                subtotal: toMoney(presentation.summary.subtotal),
                line_discount: toMoney(lineDiscount),
                order_discount: toMoney(presentation.summary.orderDiscountAmount),
                tax: toMoney(presentation.summary.taxAmount),
                total: toMoney(presentation.summary.total),
            },
        });

        summary.subtotal += presentation.summary.subtotal;
        summary.lineDiscount += lineDiscount;
        summary.orderDiscount += presentation.summary.orderDiscountAmount;
        summary.tax += presentation.summary.taxAmount;
        summary.total += presentation.summary.total;
    }

    const sections = buildSections(itemBuckets, categoryBuckets, categoryRows);
    return {
        print_type: 'y_held_items_report',
        is_period: isPeriod,
        business_date: businessDate,
        period_start_date: periodStartDate,
        period_end_date: periodEndDate,
        business_start_at: range.start,
        business_end_at: range.end,
        generated_at: new Date().toISOString(),
        generated_by: {
            id: options.generatedByUser?.id || null,
            name: options.generatedByUser?.name || 'Unknown',
        },
        storeInfo,
        summary: {
            order_count: summary.order_count,
            subtotal: toMoney(summary.subtotal),
            line_discount: toMoney(summary.lineDiscount),
            order_discount: toMoney(summary.orderDiscount),
            discount_total: toMoney(summary.lineDiscount + summary.orderDiscount),
            tax: toMoney(summary.tax),
            total: toMoney(summary.total),
        },
        orders,
        ...sections,
    };
}

function categoryMapName(categoryRows, categoryId) {
    if (categoryId === 'uncategorized') return 'Uncategorized';
    return categoryRows.find(row => Number(row.id) === Number(categoryId))?.name || 'Uncategorized';
}

async function cleanupExpiredYHeldReportArchives(executor) {
    const cutoff = new Date();
    const [archives] = await executor.query(
        'SELECT held_orders_payload FROM master_held WHERE expires_at <= ?',
        [cutoff]
    );
    const [activeArchives] = await executor.query(
        'SELECT held_orders_payload FROM master_held WHERE restored_at IS NULL AND expires_at > ?',
        [cutoff]
    );
    const snapshotIdsFrom = rows => rows.flatMap(archive => {
        try {
            const heldRows = typeof archive.held_orders_payload === 'string'
                ? JSON.parse(archive.held_orders_payload)
                : archive.held_orders_payload;
            return Array.isArray(heldRows)
                ? heldRows.map(row => row.service_charge_snapshot_id).filter(Boolean)
                : [];
        } catch (_) {
            return [];
        }
    });
    const protectedSnapshotIds = new Set(snapshotIdsFrom(activeArchives));
    const snapshotIds = [...new Set(snapshotIdsFrom(archives))]
        .filter(id => !protectedSnapshotIds.has(id));

    await executor.query('DELETE FROM master_held WHERE expires_at <= ?', [cutoff]);
    if (snapshotIds.length > 0) {
        const placeholders = snapshotIds.map(() => '?').join(',');
        await executor.query(
            `DELETE scs FROM service_charge_snapshots scs
             LEFT JOIN held_orders h ON h.service_charge_snapshot_id = scs.id
             LEFT JOIN orders o ON o.service_charge_snapshot_id = scs.id
             LEFT JOIN service_charge_snapshots child ON child.parent_snapshot_id = scs.id
             WHERE scs.id IN (${placeholders})
               AND h.id IS NULL AND o.invoice_id IS NULL AND child.id IS NULL`,
            snapshotIds
        );
    }
}

module.exports = {
    buildYHeldItemsReportPayload,
    cleanupExpiredYHeldReportArchives,
    getConfiguredYOrderTypeId,
};
