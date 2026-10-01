const { getBusinessDayRange, getBusinessDateRange } = require('../utils/businessDate');
const { lineSubtotalAfterOrderDiscount, paidOrderTimeSql } = require('./financialSql');
const { getItems, getStoreInfo } = require('./auditReportBuilder');

const toMoney = (value) => Number(Number(value || 0).toFixed(2));
const toQty = (value) => Number(Number(value || 0).toFixed(3));

// Walks a category's parent_id chain up to its root (parent_id IS NULL) and returns that
// root's id. Cycle-safe: if a cycle is ever detected (should be impossible — product edits
// already reject cyclical parent_id assignment), the original id is returned as its own root.
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

async function getCategorySalesByCategoryId(executor, range) {
    const [rows] = await executor.query(`
        SELECT
            p.category_id AS category_id,
            COALESCE(c.name, 'Uncategorized') AS category_name,
            SUM(GREATEST(0, oi.quantity - COALESCE(rfi.rq, 0))) AS qty_sold,
            SUM(GREATEST(0,
                ${lineSubtotalAfterOrderDiscount('oi', 'o')}
                + COALESCE(oi.tax_amount, 0)
                - COALESCE(rfi.rs, 0)
                - COALESCE(rfi.rt, 0)
            )) AS gross_revenue
        FROM order_items oi
        JOIN orders o ON oi.invoice_id = o.invoice_id
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN (
            SELECT ri.order_item_id, SUM(ri.quantity) AS rq, SUM(ri.line_subtotal) AS rs, SUM(ri.line_tax) AS rt
            FROM refund_items ri
            JOIN refunds r ON r.id = ri.refund_id
            WHERE r.kind = 'refund'
            GROUP BY ri.order_item_id
        ) rfi ON rfi.order_item_id = oi.id
        WHERE ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
        GROUP BY p.category_id, COALESCE(c.name, 'Uncategorized')
    `, [range.start, range.end]);
    return rows;
}

async function buildCategorySections(executor, range) {
    const salesRows = await getCategorySalesByCategoryId(executor, range);
    const [categoryRows] = await executor.query('SELECT id, parent_id, name FROM categories');
    const categoryMap = new Map(categoryRows.map(row => [row.id, { name: row.name, parent_id: row.parent_id }]));

    const categoryTotals = new Map(); // rootId (number) or 'uncategorized' -> { category_name, qty_sold, gross_revenue }
    const subcategoryTotals = new Map(); // rootId -> Map(categoryId -> { category_name, qty_sold, gross_revenue })

    for (const row of salesRows) {
        const categoryId = row.category_id;
        const qty = Number(row.qty_sold || 0);
        const revenue = Number(row.gross_revenue || 0);

        if (categoryId === null) {
            const bucket = categoryTotals.get('uncategorized') || { category_name: 'Uncategorized', qty_sold: 0, gross_revenue: 0 };
            bucket.qty_sold += qty;
            bucket.gross_revenue += revenue;
            categoryTotals.set('uncategorized', bucket);
            continue;
        }

        const ownCategory = categoryMap.get(categoryId) || null;
        const rootId = resolveRootId(categoryMap, categoryId);
        const rootInfo = categoryMap.get(rootId);
        const rootName = rootInfo ? rootInfo.name : row.category_name;

        const rootBucket = categoryTotals.get(rootId) || { category_name: rootName, qty_sold: 0, gross_revenue: 0 };
        rootBucket.qty_sold += qty;
        rootBucket.gross_revenue += revenue;
        categoryTotals.set(rootId, rootBucket);

        const isOwnCategoryARoot = ownCategory ? ownCategory.parent_id === null : true;
        if (!isOwnCategoryARoot) {
            if (!subcategoryTotals.has(rootId)) subcategoryTotals.set(rootId, new Map());
            const subMap = subcategoryTotals.get(rootId);
            const subBucket = subMap.get(categoryId) || { category_name: row.category_name, qty_sold: 0, gross_revenue: 0 };
            subBucket.qty_sold += qty;
            subBucket.gross_revenue += revenue;
            subMap.set(categoryId, subBucket);
        }
    }

    const rootIds = [...categoryTotals.keys()].sort(
        (a, b) => categoryTotals.get(b).gross_revenue - categoryTotals.get(a).gross_revenue
    );

    const categories = rootIds.map(rootId => {
        const bucket = categoryTotals.get(rootId);
        return {
            category_name: bucket.category_name,
            qty_sold: toQty(bucket.qty_sold),
            gross_revenue: toMoney(bucket.gross_revenue),
        };
    });

    const subcategories = rootIds
        .filter(rootId => subcategoryTotals.has(rootId))
        .map(rootId => ({
            category_name: categoryTotals.get(rootId).category_name,
            rows: [...subcategoryTotals.get(rootId).values()]
                .sort((a, b) => b.gross_revenue - a.gross_revenue)
                .map(sub => ({
                    category_name: sub.category_name,
                    qty_sold: toQty(sub.qty_sold),
                    gross_revenue: toMoney(sub.gross_revenue),
                })),
        }));

    return { categories, subcategories };
}

async function buildCategoryItemsReportPayload(executor, options) {
    const isPeriod = Boolean(options.startDate);
    const businessDate = options.businessDate || null;
    const periodStartDate = isPeriod ? options.startDate : null;
    const periodEndDate = isPeriod ? (options.endDate || options.startDate) : null;
    const range = isPeriod
        ? getBusinessDateRange(periodStartDate, periodEndDate)
        : getBusinessDayRange(businessDate);

    const [storeInfo, sections, items] = await Promise.all([
        getStoreInfo(executor),
        buildCategorySections(executor, range),
        getItems(executor, range),
    ]);
    const summary = items.reduce((totals, item) => {
        totals.total_quantity += Number(item.qty_sold || 0);
        totals.gross_revenue += Number(item.gross_revenue || 0);
        return totals;
    }, { product_count: items.length, total_quantity: 0, gross_revenue: 0 });
    summary.total_quantity = toQty(summary.total_quantity);
    summary.gross_revenue = toMoney(summary.gross_revenue);

    return {
        print_type: 'category_items_report',
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
        summary,
        categories: sections.categories,
        subcategories: sections.subcategories,
        items,
    };
}

module.exports = {
    buildCategoryItemsReportPayload,
};
