const mysql = require('mysql2');
const catalog = require('./permissionCatalog.json');

const columns = ['perm_key', 'label', 'label_ar', 'description', 'description_ar', 'category', 'sort_order', 'implemented', 'default_cashier', 'overridable'];

// One seed for the installer, migration generation and isolated fixtures.
// Existing grants and deployment defaults are preserved during catalog repair.
function permissionCatalogSql() {
    const rows = catalog.map(row => `(${columns.map(key => mysql.escape(row[key])).join(', ')})`);
    const updated = ['label', 'label_ar', 'description', 'description_ar', 'category', 'sort_order', 'implemented'];
    return `INSERT INTO permissions (${columns.join(', ')})\nVALUES\n${rows.join(',\n')}\nON DUPLICATE KEY UPDATE\n${updated.map(key => `  ${key}=VALUES(${key})`).join(',\n')};`;
}

module.exports = { catalog, permissionCatalogSql };
