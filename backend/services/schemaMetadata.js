// Read metadata once per validation. Repeated information_schema subqueries can
// reopen the same table hundreds of times on MariaDB. The original SQL checks
// still run unchanged, against bound, statement-local metadata snapshots.
async function querySchemaChecks(db, sql) {
    const definitions = [];
    const params = [];
    for (const source of new Set(sql.match(/information_schema\.[A-Z_]+/g))) {
        const schemaColumn = source.includes('CONSTRAINTS') ? 'CONSTRAINT_SCHEMA' : 'TABLE_SCHEMA';
        const [rows, fields] = await db.query(`SELECT * FROM ${source} WHERE ${schemaColumn}=DATABASE()`);
        const columns = fields.map(field => field.name)
            .filter(name => /^[A-Z_]+$/.test(name) && new RegExp(`\\b${name}\\b`).test(sql));
        if (!columns.length) throw new Error(`Unable to inspect ${source}.`);
        const alias = `metadata_${source.split('.')[1]}`;
        const selects = rows.map((row, index) => 'SELECT ' + columns.map(column => {
            params.push(row[column]);
            return '?' + (index ? '' : ` AS ${column}`);
        }).join(','));
        definitions.push(`${alias} AS (${selects.length ? selects.join(' UNION ALL ') :
            'SELECT ' + columns.map(column => `NULL AS ${column}`).join(',') + ' WHERE 0'})`);
        sql = sql.replaceAll(source, alias);
    }
    return db.query(`WITH ${definitions.join(',')} ${sql}`, params);
}
module.exports = { querySchemaChecks };
