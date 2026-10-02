const { roundMoney } = require('./PosCalculator');
const { lineSubtotalAfterOrderDiscount, paidOrderRangeWhere } = require('./financialSql');

const roundCost = (value) => Number(Number(value || 0).toFixed(4));
const roundQty = (value) => Number(Number(value || 0).toFixed(3));

// Net of tax: purchase costs are compared with revenue before sales tax.
// A pack sale counts as its factor of base units of the product it packs.
async function getProductNetSales(executor, range) {
    const [rows] = await executor.query(`
        SELECT p.id AS product_id, p.name AS item_name, p.category_id, c.name AS category_name,
               SUM(e.sold_qty * COALESCE(pk.factor, 1)) AS sold_qty, SUM(e.returned_qty * COALESCE(pk.factor, 1)) AS returned_qty,
               SUM(e.sold_amount) AS sold_amount, SUM(e.returned_amount) AS returned_amount
        FROM (
            SELECT oi.product_id, SUM(oi.quantity) AS sold_qty, 0 AS returned_qty,
                   SUM(${lineSubtotalAfterOrderDiscount('oi', 'o')}) AS sold_amount, 0 AS returned_amount
            FROM order_items oi
            JOIN orders o ON o.invoice_id=oi.invoice_id
            WHERE ${paidOrderRangeWhere('o')}
              AND oi.product_id IS NOT NULL AND oi.parent_item_id IS NULL AND COALESCE(oi.note,'') <> 'Auto-Gratuity'
            GROUP BY oi.product_id
            UNION ALL
            SELECT COALESCE(ri.product_id, source_oi.product_id), 0, SUM(ri.quantity), 0, SUM(ri.line_subtotal)
            FROM refund_items ri
            JOIN refunds r ON r.id=ri.refund_id
            JOIN order_items source_oi ON source_oi.id=ri.order_item_id
            WHERE r.kind='refund' AND r.created_at >= ? AND r.created_at < ?
              AND source_oi.parent_item_id IS NULL AND COALESCE(ri.note,'') <> 'Auto-Gratuity'
              AND COALESCE(ri.product_id, source_oi.product_id) IS NOT NULL
            GROUP BY COALESCE(ri.product_id, source_oi.product_id)
        ) e
        LEFT JOIN product_packs pk ON pk.sale_product_id=e.product_id
        JOIN products p ON p.id=COALESCE(pk.product_id, e.product_id)
        LEFT JOIN categories c ON c.id=p.category_id
        GROUP BY p.id, p.name, p.category_id, c.name
    `, [range.start, range.end, range.start, range.end, range.start, range.end]);
    return rows;
}

// Weighted average cost per sold unit over every posted purchase invoice dated up to the period end.
async function getWeightedPurchaseCosts(executor, endDate, productIds) {
    if (!productIds.length) return new Map();
    const [rows] = await executor.query(`
        SELECT l.product_id,
               SUM(l.qty * l.unit_factor + l.bonus_qty) AS purchased_qty,
               SUM(CASE WHEN d.cost_includes_tax=1 THEN l.line_total ELSE l.line_subtotal END) AS purchased_amount,
               COUNT(DISTINCT d.id) AS invoice_count
        FROM stock_document_lines l
        JOIN stock_documents d ON d.id=l.document_id
        WHERE d.doc_type='purchase' AND d.status='posted' AND d.doc_date <= ?
          AND l.product_id IN (?) AND l.qty > 0
        GROUP BY l.product_id
    `, [endDate, productIds]);
    return new Map(rows
        .filter(row => Number(row.purchased_qty) > 0)
        .map(row => [Number(row.product_id), {
            unit_cost: Number(row.purchased_amount) / Number(row.purchased_qty),
            purchased_qty: Number(row.purchased_qty),
            invoice_count: Number(row.invoice_count),
        }]));
}

async function buildProductProfitReport(executor, period) {
    const range = { start: period.business_start_at, end: period.business_end_at };
    const sales = await getProductNetSales(executor, range);
    const ids = sales.map(row => Number(row.product_id));
    const [costs, [productCosts]] = await Promise.all([
        getWeightedPurchaseCosts(executor, period.end_date, ids),
        ids.length ? executor.query('SELECT id, cost_price FROM products WHERE id IN (?)', [ids]) : [[]],
    ]);
    const fallback = new Map(productCosts.map(row => [Number(row.id), Number(row.cost_price || 0)]));

    const totals = { net_sales: 0, known_cost: 0, profit: 0, margin_pct: null, products: 0, missing_cost: 0 };
    const products = sales.map(row => {
        const id = Number(row.product_id);
        const netQty = roundQty(Number(row.sold_qty || 0) - Number(row.returned_qty || 0));
        const netSales = roundMoney(Number(row.sold_amount || 0) - Number(row.returned_amount || 0));
        const purchase = costs.get(id);
        let unitCost = null;
        let costSource = 'unknown';
        if (purchase) { unitCost = purchase.unit_cost; costSource = 'purchase_average'; }
        else if (fallback.get(id) > 0) { unitCost = fallback.get(id); costSource = 'product_cost'; }
        const cost = unitCost === null ? null : roundMoney(netQty * unitCost);
        const profit = cost === null ? null : roundMoney(netSales - cost);
        totals.products += 1;
        totals.net_sales += netSales;
        if (cost === null) totals.missing_cost += 1;
        else { totals.known_cost += cost; totals.profit += profit; }
        return {
            product_id: id,
            item_name: row.item_name,
            category_name: row.category_name || null,
            sold_qty: roundQty(row.sold_qty),
            returned_qty: roundQty(row.returned_qty),
            net_qty: netQty,
            net_sales: netSales,
            unit_cost: unitCost === null ? null : roundCost(unitCost),
            cost_source: costSource,
            purchase_invoices: purchase ? purchase.invoice_count : 0,
            cost,
            profit,
            margin_pct: profit === null || netSales === 0 ? null : Number((profit / netSales * 100).toFixed(1)),
        };
    }).sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity) || b.net_sales - a.net_sales);

    totals.net_sales = roundMoney(totals.net_sales);
    totals.known_cost = roundMoney(totals.known_cost);
    totals.profit = roundMoney(totals.profit);
    const costedSales = roundMoney(products.filter(p => p.cost !== null).reduce((sum, p) => sum + p.net_sales, 0));
    totals.margin_pct = costedSales === 0 ? null : Number((totals.profit / costedSales * 100).toFixed(1));

    return { period, costing_method: 'weighted_average', totals, products };
}

module.exports = { buildProductProfitReport };
