const { appendAuditEvent } = require('./auditEvents');

async function resetOperationalData(conn, auditContext) {
    // Every sync locks its station row first, then printers and the queue. Taking every station
    // first serializes the reset with syncs, so the two can never deadlock on printers or queue rows.
    await conn.query('SELECT spooler_id FROM spooler_stations ORDER BY spooler_id FOR UPDATE');
    // Activation owns this same lock before publishing any item authority.
    // Removing source invoices would make retained stock movements untraceable.
    await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' FOR UPDATE");
    const [[stock]] = await conn.query("SELECT id FROM stock_items WHERE tracking_state='active' LIMIT 1 FOR UPDATE");
    if (stock) throw Object.assign(new Error('Operational reset is blocked while stock movement records are active.'), { statusCode: 409 });
    const [[ingredientHistory]]=await conn.query("SELECT id FROM stock_movements WHERE movement_type='ingredient' LIMIT 1");
    if(ingredientHistory)throw Object.assign(new Error('Operational reset is blocked while ingredient movement history exists.'),{statusCode:409});
    const [[before]] = await conn.query(`
        SELECT
            (SELECT COUNT(*) FROM orders) AS orders,
            (SELECT COUNT(*) FROM held_orders) AS held_orders,
            (SELECT COUNT(*) FROM shifts) AS shifts,
            (SELECT COUNT(*) FROM jofotara_documents) AS jofotara_documents
    `);

    await conn.query('UPDATE restaurant_tables SET current_order_id = NULL, status = ?', ['available']);
    // Expenses are operational data too. Drawer expenses cannot lose their shift.
    await conn.query('DELETE FROM expenses');

    await conn.query('DELETE FROM platform_remittance_adjustments');
    await conn.query('DELETE FROM platform_remittance_lines');
    await conn.query("DELETE FROM platform_remittances WHERE kind = 'reversal'");
    await conn.query('DELETE FROM platform_remittances');

    await conn.query('DELETE FROM bundle_modifications');
    await conn.query('DELETE FROM refund_items');
    await conn.query('UPDATE jofotara_documents SET original_document_id = NULL');
    await conn.query('DELETE FROM jofotara_documents');
    await conn.query('DELETE FROM refunds');
    await conn.query('UPDATE order_items SET parent_item_id = NULL');
    await conn.query('DELETE FROM order_items');
    await conn.query('DELETE FROM held_orders');
    await conn.query('DELETE FROM qr_table_drafts');
    await conn.query('DELETE FROM master_held');
    // Last printed is derived from the queue being cleared.
    await conn.query('UPDATE printers SET last_printed_at = NULL');
    await conn.query('DELETE FROM print_queue');
    await conn.query('DELETE FROM orders');
    // Retain table_action_operations and order_intake_requests: an old delayed
    // request must still resolve to its committed result after operational data
    // is cleared instead of recreating a table action or phone order.

    await conn.query('UPDATE service_charge_snapshots SET parent_snapshot_id = NULL');
    await conn.query('DELETE FROM service_charge_snapshots');
    await conn.query('DELETE FROM invoice_sequences');
    await conn.query('DELETE FROM daily_sequences');
    await conn.query('DELETE FROM daily_order_type_sequences');
    await conn.query('DELETE FROM audit_report_documents');
    await conn.query('DELETE FROM shifts');

    // Withdraw financial publications in the same destructive source transaction.
    // Old fact bodies are drained by the bounded cleanup worker after commit.
    await conn.query('INSERT IGNORE INTO stock_report_worker(id) VALUES (1)');
    await conn.query('SELECT id FROM stock_report_worker WHERE id=1 FOR UPDATE');
    await conn.query('UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1');
    await conn.query(`UPDATE stock_report_dirty SET generation=generation+1,pending=1,dirty_at=NOW(6),
        active_build_id=NULL,published_build_id=NULL,published_generation=NULL,as_of=NULL,lease_owner=NULL,lease_until=NULL`);
    await conn.query("UPDATE stock_report_builds SET state=IF(state='building','abandoned','obsolete') WHERE state IN ('building','published')");
    await conn.query('UPDATE stock_report_backfill SET last_id=0,complete=0');

    const summary = Object.fromEntries(
        Object.entries(before).map(([key, value]) => [key, Number(value) || 0])
    );
    await appendAuditEvent(conn, {
        eventType: 'operational_data_reset',
        entityType: 'system',
        oldValue: summary,
        newValue: { status: 'cleared' },
        ...auditContext
    });
    return summary;
}

module.exports = { resetOperationalData };
