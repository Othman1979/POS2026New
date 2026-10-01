const pool = require('./db');

// Settings projected into the POS catalog payload and its cached snapshot.
const POS_CATALOG_SETTING_KEYS = Object.freeze([
    'stock_enabled', 'service_charge_enabled', 'service_charge_percentage',
    'tables_enabled', 'auto_apply_service_charge'
]);

/**
 * Reduce MySQL settings rows to a flat key-value dictionary.
 * @param {Array} rows - Array of database rows containing setting_key and setting_value
 * @returns {Object} Key-value map of settings
 */
function parseSettings(rows) {
    const settings = {};
    if (!Array.isArray(rows)) return settings;
    for (const row of rows) {
        if (row && row.setting_key !== undefined) {
            settings[row.setting_key] = row.setting_value;
        }
    }
    return settings;
}

/**
 * Fetch specific settings or all settings from the database and parse them.
 * @param {Object} connectionOrPool - mysql2 connection or pool
 * @param {Array<string>} [keys] - Optional specific setting keys to fetch
 * @returns {Promise<Object>} Key-value map of fetched settings
 */
async function getSettings(connectionOrPool, keys = []) {
    const conn = connectionOrPool || pool;
    let rows;
    if (Array.isArray(keys) && keys.length > 0) {
        const placeholders = keys.map(() => '?').join(',');
        const policyLock = keys.includes('stock_enabled') || keys.includes('recipe_ledger_enabled') ? ' LOCK IN SHARE MODE' : '';
        [rows] = await conn.query(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${placeholders})${policyLock}`, keys);
    } else {
        [rows] = await conn.query("SELECT setting_key, setting_value FROM settings");
    }
    return parseSettings(rows);
}

module.exports = {
    POS_CATALOG_SETTING_KEYS,
    parseSettings,
    getSettings
};
