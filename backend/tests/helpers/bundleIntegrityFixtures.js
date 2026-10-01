async function withBundleIntegrityChecksDisabled(pool, callback) {
    const conn = await pool.getConnection();
    try {
        await conn.query('SET SESSION FOREIGN_KEY_CHECKS=0');
        await conn.query('SET SESSION check_constraint_checks=OFF');
        return await callback(conn);
    } finally {
        await conn.query('SET SESSION check_constraint_checks=ON').catch(() => {});
        await conn.query('SET SESSION FOREIGN_KEY_CHECKS=1').catch(() => {});
        conn.release();
    }
}

module.exports = { withBundleIntegrityChecksDisabled };
