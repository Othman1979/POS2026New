const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const {
  reserveInvoiceNumber,
  ensurePaidInvoiceNumber
} = require('../../utils/invoiceSequence');

async function captureQueries(conn, operation) {
  const originalQuery = conn.query;
  const statements = [];
  conn.query = async function capturedQuery(sql, ...args) {
    statements.push(String(sql).replace(/\s+/g, ' ').trim());
    return originalQuery.call(this, sql, ...args);
  };
  try {
    return { value: await operation(), statements };
  } finally {
    conn.query = originalQuery;
  }
}

describe('invoiceSequence', () => {
  beforeEach(async () => {
    await seedDatabase();
  });

  it('reserves numbers atomically and rollbacks do not burn the number', async () => {
    const conn1 = await pool.getConnection();
    try {
      await conn1.beginTransaction();
      const n1 = await reserveInvoiceNumber(conn1);
      expect(n1).toBe(1);
      await conn1.rollback();
    } finally {
      conn1.release();
    }

    const conn2 = await pool.getConnection();
    try {
      await conn2.beginTransaction();
      const n2 = await reserveInvoiceNumber(conn2);
      await conn2.commit();
      expect(n2).toBe(1);
    } finally {
      conn2.release();
    }
  });

  it('self-heals the global invoice sequence row if it is missing', async () => {
    await pool.query("DELETE FROM invoice_sequences WHERE sequence_name = 'global_invoice'");

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const invoiceNo = await reserveInvoiceNumber(conn);
      await conn.commit();
      expect(invoiceNo).toBe(1);
    } finally {
      conn.release();
    }

    const [[seq]] = await pool.query(
      "SELECT current_value FROM invoice_sequences WHERE sequence_name = 'global_invoice'"
    );
    expect(Number(seq.current_value)).toBe(1);
  });

  it('returns the global invoice number from its single DML statement', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const captured = await captureQueries(conn, () => reserveInvoiceNumber(conn));
      await conn.commit();

      expect(captured.value).toBe(1);
      expect(captured.statements).toHaveLength(1);
      expect(captured.statements[0]).toContain('LAST_INSERT_ID');
      expect(captured.statements).not.toContain('SELECT LAST_INSERT_ID() AS invoice_number');
    } finally {
      conn.release();
    }
  });

  it('returns the duplicate-key invoice increment from its single DML statement', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await reserveInvoiceNumber(conn);
      const captured = await captureQueries(conn, () => reserveInvoiceNumber(conn));
      await conn.commit();

      expect(captured.value).toBe(2);
      expect(captured.statements).toHaveLength(1);
      expect(captured.statements[0]).toContain('ON DUPLICATE KEY UPDATE');
    } finally {
      conn.release();
    }
  });

  it('assigns invoice_number only to paid orders and is idempotent for the same order', async () => {
    const [paid] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method)
       VALUES (10, 1, 5, 0, 5, 'cash')`
    );

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const first = await ensurePaidInvoiceNumber(conn, paid.insertId);
      const second = await ensurePaidInvoiceNumber(conn, paid.insertId);
      await conn.commit();
      expect(first.invoice_number).toBe(1);
      expect(second.invoice_number).toBe(1);
    } finally {
      conn.release();
    }
  });

  it('numbers every finalized payment method in sequence', async () => {
    const methods = ['cash', 'card', 'split', 'receivable', 'platform'];
    const invoiceIds = [];
    for (const [index, method] of methods.entries()) {
      const terms = method === 'receivable'
        ? ['2026-12-31', 'Monthly account', 'Acme Catering']
        : [null, null, null];
      const [order] = await pool.query(
        `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method,
           payment_due_on, receivable_reason, buyer_name_at_sale)
         VALUES (?, 1, 5, 0, 5, ?, ?, ?, ?)`,
        [20 + index, method, ...terms]
      );
      invoiceIds.push(order.insertId);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const numbers = [];
      for (const invoiceId of invoiceIds) {
        numbers.push((await ensurePaidInvoiceNumber(conn, invoiceId)).invoice_number);
      }
      await conn.commit();
      expect(numbers).toEqual([1, 2, 3, 4, 5]);
    } finally {
      conn.release();
    }
  });

  it('leaves unpaid and voided table orders without public invoice numbers', async () => {
    const [unpaid] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (11, 1, 1, 5, 0, 5, 'unpaid_table')`
    );
    const [voided] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (12, 1, 1, 5, 0, 5, 'voided')`
    );

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const unpaidResult = await ensurePaidInvoiceNumber(conn, unpaid.insertId);
      const voidedResult = await ensurePaidInvoiceNumber(conn, voided.insertId);
      await conn.commit();
      expect(unpaidResult.invoice_number).toBeNull();
      expect(voidedResult.invoice_number).toBeNull();
    } finally {
      conn.release();
    }
  });
});
