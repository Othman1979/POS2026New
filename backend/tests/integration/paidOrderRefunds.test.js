const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('POST /api/pos/refunds on paid orders', () => {
  let adminCookie;

  beforeEach(async () => {
    await seedDatabase();
    adminCookie = await login(SEED.adminUser.user_number);
  });

  async function login(userNumber) {
    const res = await request(app).post('/api/auth/login').send({ user_number: userNumber });
    return res.headers['set-cookie'][0];
  }

  async function insertPaidOrder({ subtotal, tax, total, discountType = null, discountValue = 0 }) {
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, discount_type, discount_value, cash_amount, amount_tendered)
       VALUES (1, 1, ?, ?, ?, 'cash', ?, ?, ?, ?)`,
      [subtotal, tax, total, discountType, discountValue, total, total]
    );
    return r.insertId;
  }

  async function insertLine(invoiceId, { productId = 1, quantity, price, taxRate = 0, taxAmount = 0 }) {
    const [r] = await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, ?, 'Test Item', ?, ?, ?, ?)`,
      [invoiceId, productId, quantity, price, taxRate, taxAmount]
    );
    return r.insertId;
  }

  function refund(cookie, body) {
    return request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ intent: 'refund', refund_method: 'cash', ...body });
  }

  it('refuses a paid-order refund from a cashier without pos.refund and writes no refund', async () => {
    const cashierCookie = await login(SEED.cashierUser.user_number);
    const invoiceId = await insertPaidOrder({ subtotal: 10, tax: 1.6, total: 11.6 });
    await insertLine(invoiceId, { quantity: 2, price: 5, taxRate: 16, taxAmount: 1.6 });

    const res = await refund(cashierCookie, { invoice_id: invoiceId });

    expect(res.status).toBe(403);
    const [[{ c }]] = await pool.query('SELECT COUNT(*) c FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(c)).toBe(0);
  });

  it('refunds one item of an order-level 50% discounted order at its discounted price', async () => {
    const invoiceId = await insertPaidOrder({ subtotal: 10, tax: 0.8, total: 5.8, discountType: 'percent', discountValue: 50 });
    const lineId = await insertLine(invoiceId, { quantity: 2, price: 5, taxRate: 16, taxAmount: 0.8 });

    const res = await refund(adminCookie, { invoice_id: invoiceId, items: [{ order_item_id: lineId, qty: 1 }] });

    expect(res.status).toBe(200);
    const [[row]] = await pool.query(
      'SELECT subtotal_refunded, tax_refunded, amount_refunded FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(row).toMatchObject({ subtotal_refunded: '2.50', tax_refunded: '0.40', amount_refunded: '2.90' });
  });

  it('rejects re-refunding a fully refunded line on an order that still has other lines', async () => {
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    await pool.query('UPDATE products SET stock=10 WHERE id=1');
    const invoiceId = await insertPaidOrder({ subtotal: 20, tax: 0, total: 20 });
    const lineA = await insertLine(invoiceId, { productId: 1, quantity: 2, price: 5 });
    await insertLine(invoiceId, { productId: 2, quantity: 2, price: 5 });

    const first = await refund(adminCookie, { invoice_id: invoiceId, items: [{ order_item_id: lineA, qty: 2 }] });
    expect(first.status).toBe(200);
    const second = await refund(adminCookie, { invoice_id: invoiceId, items: [{ order_item_id: lineA, qty: 1 }] });

    expect(second.status).toBe(400);
    const [[{ c }]] = await pool.query('SELECT COUNT(*) c FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(c)).toBe(1);
    const [[product]] = await pool.query('SELECT stock FROM products WHERE id=1');
    expect(Number(product.stock)).toBe(12);
  });

  it('gives the rounding cent to the last line so clamped refund lines sum to the header', async () => {
    // Three 3.34 lines (10.02) on an order saved at 10.00: the header clamps to 10.00
    // and 1000 cents do not split evenly over three lines.
    const invoiceId = await insertPaidOrder({ subtotal: 10, tax: 0, total: 10 });
    for (let i = 0; i < 3; i++) await insertLine(invoiceId, { quantity: 1, price: 3.34 });

    const res = await refund(adminCookie, { invoice_id: invoiceId });

    expect(res.status).toBe(200);
    const [[header]] = await pool.query('SELECT id, subtotal_refunded FROM refunds WHERE invoice_id=?', [invoiceId]);
    const [lines] = await pool.query('SELECT line_subtotal FROM refund_items WHERE refund_id=? ORDER BY id', [header.id]);
    expect(header.subtotal_refunded).toBe('10.00');
    expect(lines.map(line => line.line_subtotal)).toEqual(['3.33', '3.33', '3.34']);
  });
});
