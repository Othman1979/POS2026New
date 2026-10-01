const { formatOrderNumber } = require('./orderNumber');
// Finalized invoice methods. The historical names remain exported for callers.
const FINALIZED_PAYMENT_METHODS = new Set(['cash', 'card', 'split', 'receivable', 'platform']);
const PAID_PAYMENT_METHODS = FINALIZED_PAYMENT_METHODS;

function isPaidPaymentMethod(paymentMethod) {
  return FINALIZED_PAYMENT_METHODS.has(String(paymentMethod || '').toLowerCase());
}

function buildOrderIdentity(row = {}) {
  const invoiceNumber = row.invoice_number == null ? null : Number(row.invoice_number);
  const orderId = row.order_id == null ? null : row.order_id;
  const tableNumber = row.table_number == null ? null : String(row.table_number);
  const isOpenTable = invoiceNumber == null && orderId == null;

  return {
    invoice_number: invoiceNumber,
    invoice_issued_at: row.invoice_issued_at || null,
    invoice_display_no: invoiceNumber == null ? null : String(invoiceNumber),
    order_display_no: formatOrderNumber(row),
    ticket_display_no: invoiceNumber == null ? formatOrderNumber(row) : null,
    table_display_no: isOpenTable && tableNumber != null ? tableNumber : null
  };
}

module.exports = {
  FINALIZED_PAYMENT_METHODS,
  PAID_PAYMENT_METHODS,
  isPaidPaymentMethod,
  buildOrderIdentity
};
