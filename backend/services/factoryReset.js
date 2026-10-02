const { appendAuditEvent } = require('./auditEvents');

// Users, permissions, settings, order types, tables, sections, expense categories,
// printers, print templates, spooler and sign-in records are kept.
const CLEARED_TABLES = [
    'bundle_modifications', 'refund_items', 'refunds', 'jofotara_documents', 'order_items', 'orders', 'deleted',
    'held_orders', 'qr_table_drafts', 'master_held', 'order_intake_requests', 'table_action_operations',
    'print_queue', 'service_charge_snapshots', 'invoice_sequences', 'daily_sequences', 'daily_order_type_sequences',
    'audit_report_documents', 'expenses', 'platform_remittance_adjustments', 'platform_remittance_lines',
    'platform_remittances', 'shifts',
    'stock_document_lines', 'stock_documents', 'stock_movements', 'stock_operation_sources', 'stock_operations',
    'stock_report_count_corrections', 'stock_report_counts', 'stock_report_daily', 'stock_report_events',
    'stock_report_ingredients', 'stock_report_meals', 'stock_report_operations', 'stock_report_dirty',
    'stock_report_builds', 'stock_report_worker',
    'product_barcodes', 'product_bundle_items', 'product_packs', 'product_price_overrides', 'product_recipe_lines',
    'product_stock_links', 'recipe_ledger_lines', 'stock_balances', 'stock_items', 'ingredients', 'price_history',
    'products', 'printer_categories', 'categories', 'purchase_suppliers', 'customers', 'audit_events'
];

async function factoryReset(conn, auditContext) {
    await conn.query('SELECT spooler_id FROM spooler_stations ORDER BY spooler_id FOR UPDATE');
    await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' FOR UPDATE");
    const [[before]] = await conn.query(`
        SELECT
            (SELECT COUNT(*) FROM products) AS products,
            (SELECT COUNT(*) FROM categories) AS categories,
            (SELECT COUNT(*) FROM ingredients) AS ingredients,
            (SELECT COUNT(*) FROM orders) AS orders,
            (SELECT COUNT(*) FROM shifts) AS shifts,
            (SELECT COUNT(*) FROM stock_documents) AS stock_documents,
            (SELECT COUNT(*) FROM stock_operations) AS stock_operations
    `);

    await conn.query('UPDATE restaurant_tables SET current_order_id = NULL, status = ?', ['available']);
    await conn.query('UPDATE printers SET last_printed_at = NULL');
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const table of CLEARED_TABLES) await conn.query(`DELETE FROM \`${table}\``);
    } finally {
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    await conn.query('UPDATE stock_report_backfill SET last_id = 0, complete = 1');

    const summary = Object.fromEntries(
        Object.entries(before).map(([key, value]) => [key, Number(value) || 0])
    );
    await appendAuditEvent(conn, {
        eventType: 'factory_reset',
        entityType: 'system',
        oldValue: summary,
        newValue: { status: 'cleared' },
        ...auditContext
    });
    return summary;
}

module.exports = { factoryReset, CLEARED_TABLES };
