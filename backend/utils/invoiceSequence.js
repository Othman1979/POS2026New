const { isPaidPaymentMethod, buildOrderIdentity } = require('./orderIdentity');
const { formatOrderNumber } = require('./orderNumber');

async function reserveInvoiceNumber(conn) {
  const [result] = await conn.query(`
    INSERT INTO invoice_sequences (sequence_name, current_value)
    VALUES ('global_invoice', LAST_INSERT_ID(1))
    ON DUPLICATE KEY UPDATE current_value = LAST_INSERT_ID(current_value + 1)
  `);

  const invoiceNumber = Number(result?.insertId || 0);
  if (!invoiceNumber) {
    throw new Error('Invoice sequence reservation failed.');
  }
  return invoiceNumber;
}

async function ensurePaidInvoiceNumber(conn, invoiceId, issuedAt = new Date()) {
  const [[order]] = await conn.query(
    `SELECT invoice_id, order_id, order_seq_scope, invoice_number, invoice_issued_at, payment_method
     FROM orders
     WHERE invoice_id = ?
     FOR UPDATE`,
    [invoiceId]
  );

  if (!order) {
    throw new Error('Order not found while assigning invoice number.');
  }

  if (!isPaidPaymentMethod(order.payment_method)) {
    return {
      invoice_id: Number(order.invoice_id),
      ...buildOrderIdentity(order)
    };
  }

  if (order.invoice_number != null) {
    return {
      invoice_id: Number(order.invoice_id),
      ...buildOrderIdentity(order)
    };
  }

  const invoiceNumber = await reserveInvoiceNumber(conn);
  await conn.query(
    `UPDATE orders
     SET invoice_number = ?, invoice_issued_at = COALESCE(invoice_issued_at, ?)
     WHERE invoice_id = ?`,
    [invoiceNumber, issuedAt, invoiceId]
  ).catch(err => {
    if (err?.code === 'ER_DUP_ENTRY') {
      const collision = new Error('Invoice sequence collision. Contact support.');
      collision.statusCode = 500;
      collision.cause = err;
      throw collision;
    }
    throw err;
  });

  return {
    invoice_id: Number(order.invoice_id),
    invoice_number: invoiceNumber,
    invoice_issued_at: issuedAt,
    invoice_display_no: String(invoiceNumber),
    order_display_no: formatOrderNumber(order),
    ticket_display_no: null
  };
}

module.exports = {
  reserveInvoiceNumber,
  ensurePaidInvoiceNumber
};
