const LOCK = 'posapp:printer-configuration';
// Used before every new claim, including configurations installed before this
// validation existed. Correlation is over printer metadata, never order history.
const NETWORK_OWNER_CONFLICT_SQL = `p.type = 'network' AND EXISTS (
    SELECT 1 FROM printers peer WHERE peer.is_active = 1 AND peer.type = 'network'
      AND peer.id <> p.id AND (peer.spooler_id <> p.spooler_id OR peer.role = p.role)
      AND CAST(COALESCE(NULLIF(TRIM(peer.network_port), ''), '9100') AS UNSIGNED) = CAST(COALESCE(NULLIF(TRIM(p.network_port), ''), '9100') AS UNSIGNED)
      AND INET6_ATON(peer.network_ip) = INET6_ATON(p.network_ip))`;

function conflict(code, message) {
    return Object.assign(new Error(message), { code, statusCode: 409 });
}

async function conflictingPrinterIds(conn, spoolerId) {
    const [rows] = await conn.query(`SELECT p.id FROM printers p WHERE p.spooler_id = ? AND p.is_active = 1 AND (${NETWORK_OWNER_CONFLICT_SQL})`, [spoolerId]);
    return rows.map(row => Number(row.id));
}

// Serialize rare configuration edits, not printing. The existing endpoint unique
// key includes role, so it cannot prevent two roles assigning one IP to two agents.
async function withPrinterConfiguration(db, operation) {
    let conn = await db.getConnection();
    let locked = false;
    try {
        const [[result]] = await conn.query("SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':', ?), 256), 2) AS acquired", [LOCK]);
        if (Number(result.acquired) !== 1) throw conflict('PRINTER_CONFIGURATION_BUSY', 'Printer settings are being updated. Try again.');
        locked = true;
        await conn.beginTransaction();
        try {
            const result = await operation(conn);
            await conn.commit();
            return result;
        } catch (error) { await conn.rollback(); throw error; }
    } finally {
        if (locked) {
            try {
                const [[result]] = await conn.query("SELECT RELEASE_LOCK(SHA2(CONCAT(DATABASE(), ':', ?), 256)) AS released", [LOCK]);
                if (Number(result.released) !== 1) throw new Error('PRINTER_LOCK_RELEASE_FAILED');
            } catch { conn.destroy(); conn = null; }
        }
        conn?.release();
    }
}

async function validatePrinterOwnership(conn, desired, printerId = null) {
    const [[previous]] = printerId ? await conn.query('SELECT * FROM printers WHERE id = ?', [printerId]) : [[]];
    const stations = [...new Set([previous?.spooler_id, desired?.spooler_id].filter(Boolean))].sort();
    // Sync claims lock the station first too. A printer cannot change owner/target
    // while a previously claimed ticket is still owned by its old agent.
    if (stations.length) await conn.query('SELECT spooler_id FROM spooler_stations WHERE spooler_id IN (?) ORDER BY spooler_id FOR UPDATE', [stations]);
    const targetChanged = previous && (!desired || ['type', 'spooler_id', 'network_ip', 'network_port', 'windows_name']
        .some(key => String(previous[key] || '') !== String(desired[key] || '')));
    if (targetChanged) {
        const [[busy]] = await conn.query(`SELECT id FROM print_queue FORCE INDEX (idx_print_queue_owner_claim)
            WHERE printer_id = ? AND status IN ('pending','failed','processing','sent','local_accepted','cancel_requested') LIMIT 1 FOR UPDATE`, [printerId]);
        if (busy) throw conflict('PRINTER_HAS_ACTIVE_JOBS', 'Drain this printer before changing its station or connection.');
    }
    if (desired?.type !== 'network') return;
    // Configuration-only metadata read. INET6_ATON also catches alternate IPv6
    // spellings already stored by older versions; no history scan is involved.
    const [[other]] = await conn.query(`SELECT id, spooler_id FROM printers
        WHERE is_active = 1 AND type = 'network' AND CAST(COALESCE(NULLIF(TRIM(network_port), ''), '9100') AS UNSIGNED) = ?
          AND INET6_ATON(network_ip) = INET6_ATON(?) AND id <> ? AND (spooler_id <> ? OR role = ?) LIMIT 1`,
    [Number(desired.network_port), desired.network_ip, printerId || 0, desired.spooler_id, desired.role]);
    if (other) throw conflict('PRINTER_ENDPOINT_OWNED', 'This network printer is already assigned. Keep one entry per role and use the same print station.');
}

module.exports = { withPrinterConfiguration, validatePrinterOwnership, conflictingPrinterIds, NETWORK_OWNER_CONFLICT_SQL };
