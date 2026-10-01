const { roundMoney } = require('./PosCalculator');
const { lineSubtotalAfterOrderDiscount } = require('./financialSql');
const { buildOrderTypeBreakdown } = require('./dailyReportDimensions');
const { getProductSalesForPeriod } = require('./productSalesMetrics');

async function buildDailySalesDetails(executor, period) {
    // 1. Check if tables are enabled
    const [settingsRows] = await executor.query("SELECT setting_value FROM settings WHERE setting_key = 'tables_enabled'");
    const tables_enabled = settingsRows[0]?.setting_value === '1';

    // 2. Query categories
    const [categoryRows] = await executor.query("SELECT id, parent_id, name FROM categories");
    const categoryMap = new Map(categoryRows.map(row => [row.id, { id: row.id, parent_id: row.parent_id, name: row.name }]));

    // A malformed category graph must never duplicate money across several nodes.
    function resolveCategory(categoryId) {
        if (!categoryId) return { isValid: false, path: 'Uncategorized', categoryIds: [] };
        const path = [];
        const categoryIds = [];
        let currentId = categoryId;
        const visited = new Set();
        while (currentId) {
            if (visited.has(currentId)) {
                return { isValid: false, path: 'Uncategorized', categoryIds: [] };
            }
            visited.add(currentId);
            const cat = categoryMap.get(currentId);
            if (!cat) {
                return { isValid: false, path: 'Uncategorized', categoryIds: [] };
            }
            path.unshift(cat.name);
            categoryIds.push(currentId);
            currentId = cat.parent_id;
        }
        return { isValid: true, path: path.join(' › '), categoryIds };
    }

    // 3. Shared sales and return events for products
    const productEvents = await getProductSalesForPeriod(executor, period);

    // Build product rows and category tree sums
    const products = [];
    const categoryNodes = new Map();
    for (const row of categoryRows) {
        categoryNodes.set(row.id, {
            category_id: row.id,
            name: row.name,
            parent_id: row.parent_id,
            sold_qty: 0,
            returned_qty: 0,
            sold_amount: 0,
            returned_amount: 0,
            net_sales: 0,
            subcategories: []
        });
    }

    let uncategorizedSoldQty = 0;
    let uncategorizedReturnedQty = 0;
    let uncategorizedSoldAmount = 0;
    let uncategorizedReturnedAmount = 0;

    for (const row of productEvents) {
        const soldQty = Number(row.sold_qty) || 0;
        const returnedQty = Number(row.returned_qty) || 0;
        const soldAmount = Number(row.sold_amount) || 0;
        const returnedAmount = Number(row.returned_amount) || 0;
        const netSales = roundMoney(soldAmount - returnedAmount);

        const category = resolveCategory(row.category_id);

        products.push({
            product_id: row.product_id,
            item_name: row.item_name,
            category_path: category.path,
            sold_qty: soldQty,
            returned_qty: returnedQty,
            sold_amount: roundMoney(soldAmount),
            returned_amount: roundMoney(returnedAmount),
            net_sales: netSales
        });

        if (category.isValid) {
            for (const currentId of category.categoryIds) {
                const node = categoryNodes.get(currentId);
                node.sold_qty += soldQty;
                node.returned_qty += returnedQty;
                node.sold_amount += soldAmount;
                node.returned_amount += returnedAmount;
                node.net_sales += (soldAmount - returnedAmount);
            }
        } else {
            uncategorizedSoldQty += soldQty;
            uncategorizedReturnedQty += returnedQty;
            uncategorizedSoldAmount += soldAmount;
            uncategorizedReturnedAmount += returnedAmount;
        }
    }

    // Build category tree
    const roots = [];
    for (const node of categoryNodes.values()) {
        node.sold_amount = roundMoney(node.sold_amount);
        node.returned_amount = roundMoney(node.returned_amount);
        node.net_sales = roundMoney(node.net_sales);

        if (node.parent_id && categoryNodes.has(node.parent_id)) {
            let parentCursor = node.parent_id;
            let isCycle = false;
            const visited = new Set();
            while (parentCursor) {
                if (parentCursor === node.category_id) {
                    isCycle = true;
                    break;
                }
                if (visited.has(parentCursor)) break;
                visited.add(parentCursor);
                const pNode = categoryNodes.get(parentCursor);
                parentCursor = pNode ? pNode.parent_id : null;
            }
            if (!isCycle) {
                categoryNodes.get(node.parent_id).subcategories.push(node);
            } else {
                roots.push(node);
            }
        } else {
            roots.push(node);
        }
    }

    function pruneAndSortCategoryTree(nodes) {
        const result = [];
        for (const node of nodes) {
            if (node.subcategories && node.subcategories.length > 0) {
                node.subcategories = pruneAndSortCategoryTree(node.subcategories);
            }
            const hasActivity = node.sold_qty !== 0 || node.returned_qty !== 0 || node.sold_amount !== 0 || node.returned_amount !== 0;
            if (hasActivity) {
                result.push(node);
            }
        }
        result.sort((a, b) => b.net_sales - a.net_sales);
        return result;
    }

    let categories = pruneAndSortCategoryTree(roots);

    if (uncategorizedSoldQty !== 0 || uncategorizedReturnedQty !== 0 || uncategorizedSoldAmount !== 0 || uncategorizedReturnedAmount !== 0) {
        categories.push({
            category_id: null,
            name: 'Uncategorized',
            sold_qty: uncategorizedSoldQty,
            returned_qty: uncategorizedReturnedQty,
            sold_amount: roundMoney(uncategorizedSoldAmount),
            returned_amount: roundMoney(uncategorizedReturnedAmount),
            net_sales: roundMoney(uncategorizedSoldAmount - uncategorizedReturnedAmount),
            subcategories: []
        });
    }

    categories.sort((a, b) => b.net_sales - a.net_sales);
    products.sort((a, b) => b.net_sales - a.net_sales);

    // Helper to query dimension rows
    async function queryDimension(fieldName, selectFieldSql, joinSql, selectExtraFieldsMap = () => ({})) {
        const saleSql = `
            SELECT o.${fieldName} AS id, ${selectFieldSql},
                   COUNT(o.invoice_id) AS orders,
                   COALESCE(SUM(o.total), 0) AS sold_amount
            FROM orders o
            ${joinSql}
            WHERE COALESCE(o.invoice_issued_at, o.created_at) >= ?
              AND COALESCE(o.invoice_issued_at, o.created_at) < ?
              AND o.payment_method NOT IN ('unpaid_table', 'voided')
              AND o.${fieldName} IS NOT NULL
            GROUP BY o.${fieldName}
        `;

        const refundSql = `
            SELECT o.${fieldName} AS id, ${selectFieldSql},
                   COALESCE(SUM(r.amount_refunded), 0) AS returned_amount
            FROM refunds r
            JOIN orders o ON o.invoice_id = r.invoice_id
            ${joinSql}
            WHERE r.kind = 'refund' AND r.created_at >= ? AND r.created_at < ?
              AND o.${fieldName} IS NOT NULL
            GROUP BY o.${fieldName}
        `;

        const [sales] = await executor.query(saleSql, [period.business_start_at, period.business_end_at]);
        const [refunds] = await executor.query(refundSql, [period.business_start_at, period.business_end_at]);

        const refundMap = new Map();
        for (const r of refunds) {
            refundMap.set(r.id, r);
        }

        const merged = sales.map(s => {
            const returned = Number(refundMap.get(s.id)?.returned_amount) || 0;
            return {
                id: s.id,
                orders: Number(s.orders) || 0,
                sold_amount: roundMoney(Number(s.sold_amount) || 0),
                returned_amount: roundMoney(returned),
                net_sales: roundMoney((Number(s.sold_amount) || 0) - returned),
                ...selectExtraFieldsMap(s)
            };
        });

        for (const r of refunds) {
            if (!merged.some(m => m.id === r.id)) {
                merged.push({
                    id: r.id,
                    orders: 0,
                    sold_amount: 0,
                    returned_amount: roundMoney(r.returned_amount),
                    net_sales: roundMoney(-r.returned_amount),
                    ...selectExtraFieldsMap(r)
                });
            }
        }

        merged.sort((a, b) => b.net_sales - a.net_sales);
        return merged;
    }

    const order_types = await buildOrderTypeBreakdown(executor, period);

    const cashiers = await queryDimension(
        'user_id',
        "u.name AS name",
        "JOIN users u ON o.user_id = u.id",
        s => ({ user_id: s.id, name: s.name })
    );

    const waiters = tables_enabled ? await queryDimension(
        'waiter_id',
        "u.name AS name",
        "JOIN users u ON o.waiter_id = u.id",
        s => ({ user_id: s.id, name: s.name })
    ) : [];

    const tables = tables_enabled ? await queryDimension(
        'table_id',
        "t.table_number, COALESCE(s.name, 'Main Floor') AS section_name",
        "JOIN restaurant_tables t ON o.table_id = t.id LEFT JOIN sections s ON t.section_id = s.id",
        s => ({ table_id: s.id, table_number: s.table_number, section_name: s.section_name })
    ) : [];

    // Service Charge totals
    const [scSalesRows] = await executor.query(`
        SELECT COALESCE(SUM(${lineSubtotalAfterOrderDiscount('oi', 'o')} + COALESCE(oi.tax_amount, 0)), 0) AS service_charges_sale
        FROM order_items oi
        JOIN orders o ON o.invoice_id = oi.invoice_id
        WHERE COALESCE(o.invoice_issued_at, o.created_at) >= ?
          AND COALESCE(o.invoice_issued_at, o.created_at) < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
          AND oi.parent_item_id IS NULL
          AND oi.note = 'Auto-Gratuity'
    `, [period.business_start_at, period.business_end_at]);

    const [scRefundRows] = await executor.query(`
        SELECT COALESCE(SUM(ri.line_total), 0) AS service_charges_refund
        FROM refund_items ri
        JOIN refunds r ON r.id = ri.refund_id
        WHERE r.kind = 'refund' AND r.created_at >= ? AND r.created_at < ?
          AND ri.note = 'Auto-Gratuity'
    `, [period.business_start_at, period.business_end_at]);

    const service_charges_collected = roundMoney(
        (Number(scSalesRows[0]?.service_charges_sale) || 0) -
        (Number(scRefundRows[0]?.service_charges_refund) || 0)
    );

    const [salesSumRows] = await executor.query(`
        SELECT COALESCE(SUM(o.total), 0) AS sales_processed
        FROM orders o
        WHERE COALESCE(o.invoice_issued_at, o.created_at) >= ?
          AND COALESCE(o.invoice_issued_at, o.created_at) < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
    `, [period.business_start_at, period.business_end_at]);

    const [refundSumRows] = await executor.query(`
        SELECT COALESCE(SUM(r.amount_refunded), 0) AS refunds_issued
        FROM refunds r
        WHERE r.kind = 'refund' AND r.created_at >= ? AND r.created_at < ?
    `, [period.business_start_at, period.business_end_at]);

    const sales_processed = Number(salesSumRows[0]?.sales_processed) || 0;
    const refunds_issued = Number(refundSumRows[0]?.refunds_issued) || 0;
    const sales_collected = roundMoney(sales_processed - refunds_issued);

    const reconciled_menu_sales = roundMoney(sales_collected - service_charges_collected);

    return {
        period,
        totals: {
            sales_collected,
            menu_sales: reconciled_menu_sales,
            service_charges_collected
        },
        categories,
        products,
        order_types,
        cashiers,
        waiters,
        tables,
        tables_enabled
    };
}

module.exports = {
    buildDailySalesDetails
};
