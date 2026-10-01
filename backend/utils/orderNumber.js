// The numeric order_id remains a database value. The issued scope freezes its
// display prefix so later settings/catalog changes cannot relabel old tickets.
function formatOrderNumber(row = {}) {
  if (row.order_id == null) return null;
  const match = /^type:\d{4}-\d{2}-\d{2}:\d+:([A-Z]+)$/.exec(row.order_seq_scope || '');
  return match ? `${match[1]}-${row.order_id}` : String(row.order_id);
}

function orderDisplayNoSql(alias = 'o') {
  const column = name => alias ? `${alias}.${name}` : name;
  return `CASE WHEN ${column('order_seq_scope')} LIKE 'type:%' THEN CONCAT(SUBSTRING_INDEX(${column('order_seq_scope')}, ':', -1), '-', ${column('order_id')}) ELSE CAST(${column('order_id')} AS CHAR) END`;
}

module.exports = { formatOrderNumber, orderDisplayNoSql };
