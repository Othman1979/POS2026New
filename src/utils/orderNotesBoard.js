// Pure presentational helper for the Order Notes board's phone view. Flattens the
// per-column grouped orders into one list ordered by time (scheduled delivery_date if
// present, else created_at), ascending — matching the desktop per-column sort.

import { parseBackendTimestamp, parseScheduledTimestamp } from './businessDate.js';

function timeOf(order) {
  const t = (order?.delivery_date ? parseScheduledTimestamp(order.delivery_date) : parseBackendTimestamp(order?.created_at)).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function sortedByTime(orders) {
  // Parse a timestamp once per card, not again for every sort comparison.
  return orders.map(order => ({ order, time: timeOf(order) }))
    .sort((a, b) => a.time - b.time)
    .map(entry => entry.order);
}

export function buildOrderTypeBoard(orders = [], configuredTypeNames = [], unspecifiedLabel = 'Unspecified') {
  const columns = [];
  const addColumn = (name) => {
    const normalized = String(name || '').trim();
    if (normalized && !columns.includes(normalized)) columns.push(normalized);
  };

  configuredTypeNames.forEach(addColumn);
  orders.forEach((order) => addColumn(order?.order_type_name));

  const hasUnspecified = orders.some((order) => !String(order?.order_type_name || '').trim());
  if (hasUnspecified || columns.length === 0) addColumn(unspecifiedLabel);

  const groups = Object.fromEntries(columns.map((column) => [column, []]));
  for (const order of orders) {
    const column = String(order?.order_type_name || '').trim() || unspecifiedLabel;
    if (!groups[column]) {
      columns.push(column);
      groups[column] = [];
    }
    groups[column].push(order);
  }

  for (const column of columns) {
    groups[column] = sortedByTime(groups[column]);
  }

  return { columns, groups };
}

export function mergedCardsByTime(groupedOrders, columns) {
  const all = [];
  for (const col of columns) {
    const list = groupedOrders && groupedOrders[col];
    if (Array.isArray(list)) all.push(...list);
  }
  return sortedByTime(all);
}

export function filterOrdersBySource(orders = [], source = 'all') {
  if (source === 'phone') return orders.filter(order => Number(order?.call_center_user_id) > 0);
  if (source === 'other') return orders.filter(order => !(Number(order?.call_center_user_id) > 0));
  return orders;
}

export function platformSettlementSummary(orders = []) {
  const held = orders.filter((order) => order?.isHeld);
  const totalCents = held.reduce(
    (sum, order) => sum + Math.round((Number(order.total) || 0) * 100),
    0
  );
  return { held, count: held.length, total: totalCents / 100 };
}

export async function printSettledReceipts(successes = [], printReceipt) {
  let attempted = 0;
  let failed = 0;
  for (const result of successes) {
    if (result?.duplicate) continue;
    attempted++;
    if (!(await printReceipt({ invoice_id: result.invoice_id, print_request_id: `checkout-receipt:${result.invoice_id}:primary` }))) failed++;
  }
  return { attempted, failed };
}
