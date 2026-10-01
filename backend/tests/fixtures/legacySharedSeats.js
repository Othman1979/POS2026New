// Pre-seating-migration bills may still have multiple table aliases. Public Join
// now changes physical seating only; money-path regressions seed the old shape
// explicitly so they continue to exercise issued shared bills.
async function seedLegacySharedSeats(executor, parentId, childIds) {
    await executor.query(`UPDATE restaurant_tables child JOIN restaurant_tables root ON root.id=?
        SET child.parent_table_id=root.id, child.seating_parent_id=root.id,
            child.current_order_id=root.current_order_id, child.status=root.status
        WHERE child.id IN (?)`, [parentId, childIds]);
}
module.exports = { seedLegacySharedSeats };
