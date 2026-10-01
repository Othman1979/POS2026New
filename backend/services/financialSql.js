const { orderDisplayNoSql } = require('../utils/orderNumber');
// Shared financial SQL belongs below HTTP routes so reports and route handlers use
// one set of refund, discount, invoice-time, and paid-order definitions.
const { roundMoney } = require('./PosCalculator');

const REFUNDS_ROLLUP_JOIN = `
  LEFT JOIN (
    SELECT r.invoice_id,
           SUM(r.amount_refunded)   AS amt,
           SUM(r.subtotal_refunded) AS sub,
           SUM(r.tax_refunded)      AS tax,
           SUM(CASE
             WHEN r.refund_method = 'cash' THEN r.amount_refunded
             WHEN r.refund_method = 'split' THEN ROUND(
               r.amount_refunded * COALESCE(refund_order.cash_amount, 0) /
               NULLIF(COALESCE(refund_order.cash_amount, 0) + COALESCE(refund_order.card_amount, 0), 0),
               2
             )
             ELSE 0
           END) AS cash,
           SUM(CASE
             WHEN r.refund_method = 'card' THEN r.amount_refunded
             WHEN r.refund_method = 'split' THEN r.amount_refunded - ROUND(
               r.amount_refunded * COALESCE(refund_order.cash_amount, 0) /
               NULLIF(COALESCE(refund_order.cash_amount, 0) + COALESCE(refund_order.card_amount, 0), 0),
               2
             )
             ELSE 0
           END) AS card,
           SUM(CASE WHEN r.refund_method = 'platform' THEN r.amount_refunded ELSE 0 END) AS platform
    FROM refunds r
    LEFT JOIN orders refund_order ON refund_order.invoice_id = r.invoice_id
    WHERE r.kind = 'refund'
    GROUP BY r.invoice_id
  ) rf ON rf.invoice_id = o.invoice_id`;

const NET_TOTAL = `(o.total - COALESCE(rf.amt, 0))`;
const NET_SUBTOTAL = `(o.subtotal - COALESCE(rf.sub, 0))`;
const NET_TAX = `(o.tax - COALESCE(rf.tax, 0))`;
const NET_CASH = `(COALESCE(o.cash_amount,0) - COALESCE(rf.cash, 0))`;
const NET_CARD = `(COALESCE(o.card_amount,0) - COALESCE(rf.card, 0))`;
const NET_PLATFORM = `(CASE WHEN o.payment_method = 'platform' THEN o.total ELSE 0 END - COALESCE(rf.platform, 0))`;


function allocateRefundPayment(refund, originalPayment) {
  const amount = Number(refund.amount_refunded) || 0;
  const method = refund.refund_method;

  if (method === 'cash') return { cash: roundMoney(amount), card: 0, platform: 0 };
  if (method === 'card') return { cash: 0, card: roundMoney(amount), platform: 0 };
  if (method === 'platform') return { cash: 0, card: 0, platform: roundMoney(amount) };
  if (method !== 'split') return { cash: 0, card: 0, platform: 0 };

  const originalCash = Number(originalPayment.cash_amount) || 0;
  const originalCard = Number(originalPayment.card_amount) || 0;
  const originalTotal = originalCash + originalCard;
  if (originalTotal <= 0) throw new Error('Impossible zero-tender split data.');
  if (originalCash === 0) return { cash: 0, card: roundMoney(amount), platform: 0 };
  if (originalCard === 0) return { cash: roundMoney(amount), card: 0, platform: 0 };

  const cash = roundMoney(amount * (originalCash / originalTotal));
  return { cash, card: roundMoney(amount - cash), platform: 0 };
}

const orderDiscountApplied = (alias = 'o') => `(
  CASE
    WHEN ${alias}.discount_type = 'fixed' THEN LEAST(COALESCE(${alias}.subtotal, 0), GREATEST(0, COALESCE(${alias}.discount_value, 0)))
    WHEN ${alias}.discount_type = 'percent' THEN COALESCE(${alias}.subtotal, 0) * (LEAST(100, GREATEST(0, COALESCE(${alias}.discount_value, 0))) / 100)
    ELSE 0
  END
)`;

const orderDiscountRatio = (alias = 'o') => `(
  CASE
    WHEN COALESCE(${alias}.subtotal, 0) > 0
      THEN GREATEST(0, COALESCE(${alias}.subtotal, 0) - ${orderDiscountApplied(alias)}) / COALESCE(${alias}.subtotal, 0)
    ELSE 1
  END
)`;

const lineSubtotalBeforeOrderDiscount = (alias = 'oi') => `GREATEST(0,
  CASE
    WHEN ${alias}.discount_type = 'fixed'
      THEN (COALESCE(${alias}.price_at_sale, 0) * COALESCE(${alias}.quantity, 0)) - (GREATEST(0, COALESCE(${alias}.discount_value, 0)) * COALESCE(${alias}.quantity, 0))
    WHEN ${alias}.discount_type = 'percent'
      THEN (COALESCE(${alias}.price_at_sale, 0) * COALESCE(${alias}.quantity, 0)) * (1 - (LEAST(100, GREATEST(0, COALESCE(${alias}.discount_value, 0))) / 100))
    ELSE COALESCE(${alias}.price_at_sale, 0) * COALESCE(${alias}.quantity, 0)
  END
)`;

const lineSubtotalAfterOrderDiscount = (lineAlias = 'oi', orderAlias = 'o') =>
  `(${lineSubtotalBeforeOrderDiscount(lineAlias)} * ${orderDiscountRatio(orderAlias)})`;

const orderDiscountAppliedToSubtotal = (alias = 'o', subtotalExpression) => `(
  CASE
    WHEN COALESCE(${alias}.subtotal, 0) > 0
      THEN LEAST(
        GREATEST(0, ${subtotalExpression}),
        ${orderDiscountApplied(alias)} * (GREATEST(0, ${subtotalExpression}) / COALESCE(${alias}.subtotal, 0))
      )
    ELSE 0
  END
)`;

function refundNettedOrderItemsSql(invoiceScope = null) {
  // invoiceScope names an internal query/CTE, never request input. For selected
  // invoices, look up refunds by item to avoid rematerializing the whole scope
  // for each invoice under MariaDB's lateral derived-table optimization.
  if (invoiceScope) return `(
  SELECT
    oi.id, oi.invoice_id, oi.price_at_sale, oi.discount_type, oi.discount_value,
    GREATEST(0, oi.quantity - COALESCE((
      SELECT SUM(ri.quantity)
      FROM refund_items ri
      JOIN refunds r ON r.id = ri.refund_id
      WHERE ri.order_item_id = oi.id AND r.kind = 'refund'
    ), 0)) AS quantity
  FROM order_items oi
  JOIN ${invoiceScope} item_scope ON item_scope.invoice_id = oi.invoice_id
)`;

  return `(
  SELECT
    oi.id, oi.invoice_id, oi.price_at_sale, oi.discount_type, oi.discount_value,
    GREATEST(0, oi.quantity - COALESCE(rfi_qty.refunded_qty, 0)) AS quantity
  FROM order_items oi
  LEFT JOIN (
    SELECT ri.order_item_id, SUM(ri.quantity) AS refunded_qty
    FROM refund_items ri
    JOIN refunds r ON r.id = ri.refund_id
    WHERE r.kind = 'refund'
    GROUP BY ri.order_item_id
  ) rfi_qty ON rfi_qty.order_item_id = oi.id
)`;
}

const REFUND_NETTED_ORDER_ITEMS = refundNettedOrderItemsSql();

function activeOrderDiscountSumsSql(invoiceScope = null) {
  return `(
  SELECT
    oi.invoice_id,
    COALESCE(SUM(${lineSubtotalBeforeOrderDiscount('oi')}), 0) AS active_subtotal_before_order_discount,
    COALESCE(SUM(GREATEST(0, (COALESCE(oi.price_at_sale, 0) * COALESCE(oi.quantity, 0)) - ${lineSubtotalBeforeOrderDiscount('oi')})), 0) AS line_discount_amount
  FROM ${refundNettedOrderItemsSql(invoiceScope)} oi
  GROUP BY oi.invoice_id
)`;
}

const ACTIVE_ORDER_DISCOUNT_SUMS = activeOrderDiscountSumsSql();

const activeOrderDiscountApplied = (orderAlias = 'o', sumsAlias = 'ads') =>
  orderDiscountAppliedToSubtotal(orderAlias, `COALESCE(${sumsAlias}.active_subtotal_before_order_discount, COALESCE(${orderAlias}.subtotal, 0))`);

const refundItemsValueJoin = (refundAlias = 'r', itemAlias = 'riv') => `
  LEFT JOIN (
    SELECT
      refund_id,
      COALESCE(SUM(line_total), 0) AS item_total,
      COALESCE(SUM(line_subtotal), 0) AS item_subtotal
    FROM refund_items
    GROUP BY refund_id
  ) ${itemAlias} ON ${itemAlias}.refund_id = ${refundAlias}.id`;

const refundVoidValueSql = (refundAlias = 'r', orderAlias = 'o', itemAlias = 'riv') => `(
  CASE
    WHEN ${itemAlias}.refund_id IS NOT NULL THEN ${itemAlias}.item_total
    WHEN COALESCE(${refundAlias}.subtotal_refunded, 0) + COALESCE(${refundAlias}.tax_refunded, 0) > 0
      THEN COALESCE(${refundAlias}.subtotal_refunded, 0) + COALESCE(${refundAlias}.tax_refunded, 0)
    ELSE COALESCE(${orderAlias}.original_total, ${orderAlias}.total, 0)
  END
)`;

const refundVoidSubtotalSql = (refundAlias = 'r', orderAlias = 'o', itemAlias = 'riv') => `(
  CASE
    WHEN ${itemAlias}.refund_id IS NOT NULL THEN ${itemAlias}.item_subtotal
    WHEN COALESCE(${refundAlias}.subtotal_refunded, 0) > 0 THEN COALESCE(${refundAlias}.subtotal_refunded, 0)
    ELSE COALESCE(${orderAlias}.original_subtotal, ${orderAlias}.subtotal, 0)
  END
)`;

const refundEventValueSql = (refundAlias = 'r', orderAlias = 'o', itemAlias = 'riv') => `(
  CASE
    WHEN ${refundAlias}.kind = 'refund' THEN COALESCE(${refundAlias}.amount_refunded, 0)
    WHEN ${refundAlias}.kind = 'void' THEN ${refundVoidValueSql(refundAlias, orderAlias, itemAlias)}
    ELSE 0
  END
)`;

async function getRefundsByShift(executor, shiftIds, range = null) {
  if (!Array.isArray(shiftIds) || shiftIds.length === 0) return {};
  const params = [...shiftIds];
  const where = ["r.kind = 'refund'", `r.shift_id IN (${shiftIds.map(() => '?').join(',')})`];
  if (range?.start && range?.end) {
    where.push('r.created_at >= ? AND r.created_at < ?');
    params.push(range.start, range.end);
  }
  const [rows] = await executor.query(
    `SELECT r.shift_id, r.amount_refunded, r.tax_refunded, r.refund_method,
            o.cash_amount AS original_cash_amount,
            o.card_amount AS original_card_amount
       FROM refunds r
       LEFT JOIN orders o ON o.invoice_id=r.invoice_id
      WHERE ${where.join(' AND ')}`,
    params
  );
  const map = {};
  for (const row of rows) {
    const shiftId = Number(row.shift_id);
    const totals = map[shiftId] || {
      refund_count: 0, amt: 0, cash: 0, card: 0, platform: 0, tax: 0
    };
    const allocated = allocateRefundPayment(row, {
      cash_amount: row.original_cash_amount,
      card_amount: row.original_card_amount,
    });
    totals.refund_count += 1;
    totals.amt = roundMoney(totals.amt + Number(row.amount_refunded || 0));
    totals.cash = roundMoney(totals.cash + allocated.cash);
    totals.card = roundMoney(totals.card + allocated.card);
    totals.platform = roundMoney(totals.platform + allocated.platform);
    totals.tax = roundMoney(totals.tax + Number(row.tax_refunded || 0));
    map[shiftId] = totals;
  }
  return map;
}

function sqlCol(alias, column) {
  return alias ? `${alias}.${column}` : column;
}

function invoiceIdentitySelect(alias = 'o') {
  const invoiceNumber = sqlCol(alias, 'invoice_number');
  const invoiceIssuedAt = sqlCol(alias, 'invoice_issued_at');
  const orderId = sqlCol(alias, 'order_id');
  return `
    ${invoiceNumber} AS invoice_number,
    ${invoiceIssuedAt} AS invoice_issued_at,
    CASE
      WHEN ${invoiceNumber} IS NULL THEN NULL
      ELSE CAST(${invoiceNumber} AS CHAR)
    END AS invoice_display_no,
    ${orderDisplayNoSql(alias)} AS order_display_no,
    CASE
      WHEN ${invoiceNumber} IS NULL AND ${orderId} IS NOT NULL THEN ${orderDisplayNoSql(alias)}
      ELSE NULL
    END AS ticket_display_no
  `;
}

function paidOrderTimeSql(alias = 'o') {
  return `COALESCE(${sqlCol(alias, 'invoice_issued_at')}, ${sqlCol(alias, 'created_at')})`;
}

const ISSUED_PAYMENT_METHODS_SQL = "('cash','card','split','receivable','platform')";

function orderBusinessTimeSql(alias = 'o') {
  const paymentMethod = sqlCol(alias, 'payment_method');
  const createdAt = sqlCol(alias, 'created_at');
  return `CASE
    WHEN ${paymentMethod} IN ${ISSUED_PAYMENT_METHODS_SQL} THEN ${paidOrderTimeSql(alias)}
    ELSE ${createdAt}
  END`;
}

// Disjoint equivalents of orderBusinessTimeSql's range, for UNION ALL scans.
// Each branch binds [start, end] and leaves the date column indexable.
function orderBusinessRangeBranches(alias = 'o') {
  const method = sqlCol(alias, 'payment_method');
  const issued = sqlCol(alias, 'invoice_issued_at');
  const created = sqlCol(alias, 'created_at');
  return [
    `${method} IN ${ISSUED_PAYMENT_METHODS_SQL} AND ${issued} >= ? AND ${issued} < ?`,
    `${method} IN ${ISSUED_PAYMENT_METHODS_SQL} AND ${issued} IS NULL AND ${created} >= ? AND ${created} < ?`,
    `(${method} NOT IN ${ISSUED_PAYMENT_METHODS_SQL} OR ${method} IS NULL) AND ${created} >= ? AND ${created} < ?`,
  ];
}

const paidOrderWhere = (alias = 'o') =>
  `${paidOrderTimeSql(alias)} >= ? AND ${paidOrderTimeSql(alias)} < ? AND ${alias}.payment_method NOT IN ('unpaid_table', 'voided')`;

const paidOrderRangeWhere = (alias = 'o') =>
  `((${alias}.invoice_issued_at >= ? AND ${alias}.invoice_issued_at < ?) OR ` +
  `(${alias}.invoice_issued_at IS NULL AND ${alias}.created_at >= ? AND ${alias}.created_at < ?)) ` +
  `AND ${alias}.payment_method NOT IN ('unpaid_table', 'voided')`;

module.exports = {
  invoiceIdentitySelect,
  paidOrderTimeSql,
  orderBusinessTimeSql,
  orderBusinessRangeBranches,
  paidOrderWhere,
  paidOrderRangeWhere,
  REFUNDS_ROLLUP_JOIN,
  NET_TOTAL,
  NET_SUBTOTAL,
  NET_TAX,
  NET_CASH,
  NET_CARD,
  NET_PLATFORM,
  allocateRefundPayment,
  orderDiscountApplied,
  orderDiscountRatio,
  orderDiscountAppliedToSubtotal,
  activeOrderDiscountApplied,
  lineSubtotalBeforeOrderDiscount,
  lineSubtotalAfterOrderDiscount,
  REFUND_NETTED_ORDER_ITEMS,
  ACTIVE_ORDER_DISCOUNT_SUMS,
  activeOrderDiscountSumsSql,
  refundItemsValueJoin,
  refundVoidValueSql,
  refundVoidSubtotalSql,
  refundEventValueSql,
  getRefundsByShift
};
