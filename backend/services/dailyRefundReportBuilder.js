const { roundMoney } = require('./PosCalculator');
const { allocateRefundPayment } = require('./dailyReportBuilder');
const { businessLocalTimestampSql } = require('../utils/businessDate');
const { invoiceIdentitySelect, refundItemsValueJoin, refundVoidValueSql, refundEventValueSql } = require('./financialSql');

async function buildRefundReport(executor, period, filters = {}) {
    const { business_start_at, business_end_at } = period;
    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(filters.limit) || 50), 200);
    const offset = (page - 1) * limit;

    const voidValueSql = refundVoidValueSql('r', 'o', 'riv');
    const eventValueSql = refundEventValueSql('r', 'o', 'riv');

    // 1. Summary:
    const [salesSumRows] = await executor.query(`
        SELECT COALESCE(SUM(o.total), 0) AS sales_processed
        FROM orders o
        WHERE COALESCE(o.invoice_issued_at, o.created_at) >= ?
          AND COALESCE(o.invoice_issued_at, o.created_at) < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
    `, [business_start_at, business_end_at]);
    const salesProcessed = Number(salesSumRows[0]?.sales_processed) || 0;

    const [refundRows] = await executor.query(`
        SELECT
          r.kind, r.amount_refunded, r.refund_method,
          o.cash_amount AS original_cash_amount,
          o.card_amount AS original_card_amount,
          o.payment_method AS original_payment_method,
          ${voidValueSql} AS event_void_value
        FROM refunds r
        LEFT JOIN orders o ON o.invoice_id = r.invoice_id
        ${refundItemsValueJoin('r', 'riv')}
        WHERE r.created_at >= ? AND r.created_at < ?
    `, [business_start_at, business_end_at]);

    let refundTotal = 0;
    let refundCash = 0;
    let refundCard = 0;
    let refundPlatform = 0;
    let refundCount = 0;
    let voidCount = 0;
    let voidValue = 0;
    for (const refund of refundRows) {
        if (refund.kind === 'refund') {
            refundTotal += Number(refund.amount_refunded) || 0;
            refundCount += 1;
            const allocation = allocateRefundPayment(refund, {
                cash_amount: refund.original_cash_amount,
                card_amount: refund.original_card_amount,
                payment_method: refund.original_payment_method,
            });
            refundCash += allocation.cash;
            refundCard += allocation.card;
            refundPlatform += allocation.platform;
        } else if (refund.kind === 'void') {
            voidCount += 1;
            voidValue += Number(refund.event_void_value) || 0;
        }
    }

    const refundRate = salesProcessed > 0
      ? roundMoney((refundTotal / salesProcessed) * 100)
      : null;

    const summary = {
        sales_processed: roundMoney(salesProcessed),
        refund_total: roundMoney(refundTotal),
        refund_rate: refundRate,
        refund_cash: roundMoney(refundCash),
        refund_card: roundMoney(refundCard),
        refund_platform: roundMoney(refundPlatform),
        refund_count: refundCount,
        void_count: voidCount,
        void_value: roundMoney(voidValue)
    };

    // 2. by_staff (Neutral count/value by user):
    const [byStaffRows] = await executor.query(`
        SELECT r.user_id, u.name,
          SUM(CASE WHEN r.kind='refund' THEN 1 ELSE 0 END) AS refund_count,
          COALESCE(SUM(CASE WHEN r.kind='refund' THEN r.amount_refunded ELSE 0 END), 0) AS refund_value,
          SUM(CASE WHEN r.kind='void' THEN 1 ELSE 0 END) AS void_count,
          COALESCE(SUM(CASE WHEN r.kind='void' THEN ${voidValueSql} ELSE 0 END), 0) AS void_value
        FROM refunds r
        LEFT JOIN users u ON u.id = r.user_id
        LEFT JOIN orders o ON o.invoice_id = r.invoice_id
        ${refundItemsValueJoin('r', 'riv')}
        WHERE r.created_at >= ? AND r.created_at < ?
        GROUP BY r.user_id, u.name
        ORDER BY refund_value DESC, void_value DESC
    `, [business_start_at, business_end_at]);

    const by_staff = byStaffRows.map(row => ({
        user_id: row.user_id,
        name: row.name || '—',
        refund_count: Number(row.refund_count) || 0,
        refund_value: roundMoney(Number(row.refund_value) || 0),
        void_count: Number(row.void_count) || 0,
        void_value: roundMoney(Number(row.void_value) || 0)
    }));

    // 3. top_reasons:
    const [topReasonRows] = await executor.query(`
        SELECT COALESCE(NULLIF(TRIM(reason),''),'—') AS reason,
               COUNT(*) AS count, COALESCE(SUM(${eventValueSql}),0) AS value
        FROM refunds r
        LEFT JOIN orders o ON o.invoice_id = r.invoice_id
        ${refundItemsValueJoin('r', 'riv')}
        WHERE r.created_at >= ? AND r.created_at < ?
        GROUP BY COALESCE(NULLIF(TRIM(reason),''),'—')
        ORDER BY count DESC, value DESC LIMIT 15
    `, [business_start_at, business_end_at]);

    const top_reasons = topReasonRows.map(row => ({
        reason: row.reason,
        count: Number(row.count) || 0,
        value: roundMoney(Number(row.value) || 0)
    }));

    // 4. Bounded log query:
    const logWhere = ['r.created_at >= ?', 'r.created_at < ?'];
    const logParams = [business_start_at, business_end_at];

    const kind = (filters.kind === 'refund' || filters.kind === 'void') ? filters.kind : null;
    if (kind) { logWhere.push('r.kind = ?'); logParams.push(kind); }
    const userId = parseInt(filters.user_id) || null;
    if (userId) { logWhere.push('r.user_id = ?'); logParams.push(userId); }
    const method = ['cash', 'card', 'split', 'platform'].includes(filters.method) ? filters.method : null;
    if (method) { logWhere.push('r.refund_method = ?'); logParams.push(method); }
    const q = String(filters.q || '').trim();
    if (q) {
        logWhere.push('(o.invoice_number = ? OR r.invoice_id = ? OR r.reason LIKE ? OR COALESCE(NULLIF(r.table_number, \'\'), rt.table_number) LIKE ?)');
        logParams.push(parseInt(q) || 0, parseInt(q) || 0, `%${q}%`, `%${q}%`);
    }

    const logWhereSql = logWhere.join(' AND ');

    const [logRows] = await executor.query(`
        SELECT r.id AS refund_id, r.invoice_id, o.order_id,
               ${invoiceIdentitySelect('o')},
               COALESCE(NULLIF(r.table_number, ''), rt.table_number) AS table_number,
               r.kind, r.amount_refunded, ${eventValueSql} AS event_value,
               r.refund_method, r.reason, r.user_id, u.name AS cashier_name, r.created_at,
               DATE_FORMAT(${businessLocalTimestampSql('r.created_at')}, '%Y-%m-%d %H:%i') AS occurred_at_local,
               ri_agg.first_item_name, ri_agg.item_count
        FROM refunds r
        LEFT JOIN orders o ON o.invoice_id = r.invoice_id
        LEFT JOIN restaurant_tables rt ON rt.id = r.table_id
        LEFT JOIN users u ON u.id = r.user_id
        ${refundItemsValueJoin('r', 'riv')}
        LEFT JOIN (
            SELECT ri.refund_id,
                   COALESCE(NULLIF(
                     (SELECT COALESCE(NULLIF(ri2.item_name, ''), p2.name, '—')
                      FROM refund_items ri2
                      LEFT JOIN products p2 ON p2.id = ri2.product_id
                      WHERE ri2.refund_id = ri.refund_id
                      ORDER BY ri2.id LIMIT 1), ''), '—') AS first_item_name,
                   COUNT(*) AS item_count
            FROM refund_items ri
            GROUP BY ri.refund_id
        ) ri_agg ON ri_agg.refund_id = r.id
        WHERE ${logWhereSql}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ? OFFSET ?
    `, [...logParams, limit, offset]);

    const [logCountRows] = await executor.query(`
        SELECT COUNT(*) AS total
        FROM refunds r
        LEFT JOIN orders o ON o.invoice_id = r.invoice_id
        LEFT JOIN restaurant_tables rt ON rt.id = r.table_id
        WHERE ${logWhereSql}
    `, logParams);

    const totalCount = logCountRows[0]?.total || 0;

    return {
        period,
        summary,
        by_staff,
        top_reasons,
        log: {
            rows: logRows,
            pagination: {
                total: totalCount,
                page,
                limit,
                total_pages: Math.max(1, Math.ceil(totalCount / limit))
            }
        }
    };
}

async function buildRefundPrintData(executor, period) {
    const { business_start_at, business_end_at } = period;
    const voidValueSql = refundVoidValueSql('r', 'o', 'riv');
    const eventValueSql = refundEventValueSql('r', 'o', 'riv');

    const reportData = await buildRefundReport(executor, period);

    const [eventRows] = await executor.query(`
        SELECT r.id AS refund_id, r.invoice_id, o.order_id,
               ${invoiceIdentitySelect('o')},
               COALESCE(NULLIF(r.table_number, ''), rt.table_number) AS table_number,
               r.kind, r.amount_refunded, ${eventValueSql} AS event_value,
               r.refund_method, r.reason, r.user_id, u.name AS cashier_name, r.created_at,
               DATE_FORMAT(${businessLocalTimestampSql('r.created_at')}, '%Y-%m-%d %H:%i') AS occurred_at_local
        FROM refunds r
        LEFT JOIN orders o ON o.invoice_id = r.invoice_id
        LEFT JOIN restaurant_tables rt ON rt.id = r.table_id
        LEFT JOIN users u ON u.id = r.user_id
        ${refundItemsValueJoin('r', 'riv')}
        WHERE r.created_at >= ? AND r.created_at < ?
        ORDER BY r.created_at ASC, r.id ASC
    `, [business_start_at, business_end_at]);

    if (eventRows.length === 0) {
        return {
            period,
            summary: reportData.summary,
            by_staff: reportData.by_staff,
            top_reasons: reportData.top_reasons,
            events: []
        };
    }

    const eventIds = eventRows.map(e => e.refund_id);
    const placeholders = eventIds.map(() => '?').join(',');

    const [itemRows] = await executor.query(`
        SELECT ri.refund_id, ri.order_item_id, ri.product_id,
               COALESCE(NULLIF(ri.item_name, ''), p.name, '—') AS item_name,
               ri.note, ri.quantity, ri.unit_price, ri.line_subtotal, ri.line_tax, ri.line_total
        FROM refund_items ri
        LEFT JOIN products p ON p.id = ri.product_id
        WHERE ri.refund_id IN (${placeholders})
        ORDER BY ri.id ASC
    `, eventIds);

    const itemsMap = new Map();
    for (const item of itemRows) {
        if (!itemsMap.has(item.refund_id)) {
            itemsMap.set(item.refund_id, []);
        }
        itemsMap.get(item.refund_id).push({
            order_item_id: item.order_item_id,
            product_id: item.product_id,
            item_name: item.item_name,
            note: item.note,
            quantity: Number(item.quantity) || 0,
            unit_price: roundMoney(Number(item.unit_price) || 0),
            line_subtotal: roundMoney(Number(item.line_subtotal) || 0),
            line_tax: roundMoney(Number(item.line_tax) || 0),
            line_total: roundMoney(Number(item.line_total) || 0)
        });
    }

    const events = eventRows.map(event => ({
        ...event,
        items: itemsMap.get(event.refund_id) || []
    }));

    return {
        period,
        summary: reportData.summary,
        by_staff: reportData.by_staff,
        top_reasons: reportData.top_reasons,
        events
    };
}

module.exports = {
    buildRefundReport,
    buildRefundPrintData
};
