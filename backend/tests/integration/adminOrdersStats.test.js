const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

// Regression: the Orders-page revenue stats must be NET of refunds, and voided
// orders (cancelled, money never collected) must not count as revenue.
describe('GET /api/admin/orders — revenue stats net of refunds', () => {
  let adminCookie;

  beforeEach(async () => {
    await seedDatabase();
    adminCookie = (await request(app).post('/api/auth/login')
      .send({ user_number: '9001' })).headers['set-cookie'][0];
  });

  async function fetchStats() {
    const res = await request(app).get('/api/admin/orders').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    return res.body.stats;
  }

  async function seedPaidOrder(method = 'cash') {
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, amount_tendered)
       VALUES (1, 1, 10.00, 1.60, 11.60, ?, ?, ?)`,
      [method, method === 'cash' ? 11.60 : 0, method === 'cash' ? 11.60 : 0]
    );
    const invoiceId = r.insertId;
    const [it] = await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 2, 5.000000, 16.00, 1.600000)`,
      [invoiceId]
    );
    return { invoiceId, orderItemId: it.insertId };
  }

  async function seedOrder({ total = 10, refundStatus = 'none' } = {}) {
    const [result] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, refund_status)
       VALUES (1, 1, ?, 0.00, ?, 'cash', ?, ?)`,
      [total, total, total, refundStatus]
    );
    return result.insertId;
  }

  async function seedRefund(invoiceId, amount = 1) {
    const [result] = await pool.query(
      `INSERT INTO refunds (kind, invoice_id, scope, amount_refunded, user_id)
       VALUES ('refund', ?, 'order', ?, 1)`,
      [invoiceId, amount]
    );
    return result.insertId;
  }

  async function seedJofotaraDocument({ invoiceId, status, refundId = null, originalDocumentId = null }) {
    const kind = refundId ? 'credit_note' : 'invoice';
    const sourceKey = refundId ? `refund:${refundId}` : `invoice:${invoiceId}`;
    const [result] = await pool.query(
      `INSERT INTO jofotara_documents
       (source_key, order_invoice_id, refund_id, original_document_id, document_kind,
        tax_registration_type, document_number, document_uuid, status)
       VALUES (?, ?, ?, ?, ?, 'sales_tax', ?, UUID(), ?)`,
      [sourceKey, invoiceId, refundId, originalDocumentId, kind, sourceKey, status]
    );
    return result.insertId;
  }

  it('counts a paid order as revenue before any refund', async () => {
    await seedPaidOrder('cash');
    const stats = await fetchStats();
    expect(stats.total_revenue).toBeCloseTo(11.60, 2);
    expect(stats.cash_revenue).toBeCloseTo(11.60, 2);
  });

  it('reports platform sales as revenue without inflating cash or card', async () => {
    await seedPaidOrder('platform');
    const stats = await fetchStats();
    expect(stats.total_revenue).toBeCloseTo(11.60, 2);
    expect(stats.platform_revenue).toBeCloseTo(11.60, 2);
    expect(stats.cash_revenue).toBeCloseTo(0, 2);
    expect(stats.card_revenue).toBeCloseTo(0, 2);
  });

  it('subtracts a full refund from total and cash revenue', async () => {
    const { invoiceId } = await seedPaidOrder('cash');
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);

    const stats = await fetchStats();
    expect(stats.total_revenue).toBeCloseTo(0, 2);
    expect(stats.cash_revenue).toBeCloseTo(0, 2);
  });

  it('subtracts only the refunded portion of a partial refund', async () => {
    const { invoiceId, orderItemId } = await seedPaidOrder('cash');
    // Refund 1 of 2 units → ~5.80 returned, ~5.80 of revenue remains.
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash', items: [{ order_item_id: orderItemId, qty: 1 }] });
    expect(res.status).toBe(200);

    const stats = await fetchStats();
    expect(stats.total_revenue).toBeCloseTo(5.80, 2);
    expect(stats.cash_revenue).toBeCloseTo(5.80, 2);
  });

  it('excludes a voided (cancelled) order from revenue', async () => {
    // Unpaid open table → void cancels it; money was never collected.
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (1, 1, 1, 10.00, 1.60, 11.60, 'unpaid_table')`
    );
    const invoiceId = r.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 2, 5.000000, 16.00, 1.600000)`,
      [invoiceId]
    );
    await pool.query(`UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1`, [invoiceId]);

    await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });

    const stats = await fetchStats();
    expect(stats.total_revenue).toBeCloseTo(0, 2);
  });

  it('orders list exposes public invoice_number and searches by it', async () => {
    const [res] = await pool.query(
      `INSERT INTO orders (order_id, invoice_number, invoice_issued_at, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (15, 12001, NOW(), 1, 50, 0, 50, 'cash', 50)`
    );

    const list = await request(app)
      .get('/api/admin/orders?invoice=12001')
      .set('Cookie', adminCookie);

    expect(list.body.success).toBe(true);
    expect(list.body.orders).toHaveLength(1);
    expect(list.body.orders[0].invoice_id).toBe(res.insertId);
    expect(list.body.orders[0].invoice_number).toBe(12001);
    expect(list.body.orders[0].invoice_display_no).toBe('12001');

    const internalSearch = await request(app)
      .get(`/api/admin/orders?invoice=${res.insertId}`)
      .set('Cookie', adminCookie);

    expect(internalSearch.body.success).toBe(true);
    expect(internalSearch.body.orders).toHaveLength(0);
  });

  it('exposes order-level and line-level discount amounts separately', async () => {
    // Order-level only: subtotal 20.00, 25% order discount -> order_discount_amount = 5.00
    const [orderRes] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, discount_type, discount_value)
       VALUES (1, 1, 20.00, 0.00, 15.00, 'cash', 15.00, 'percent', 25.00)`
    );
    const invoiceId = orderRes.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 2, 10.000000, 0.00, 0.000000)`,
      [invoiceId]
    );

    // Line-level only: price 5.00 x2, fixed discount 1.00/unit -> line_discount_amount = 2.00
    const [order2Res] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (2, 1, 8.00, 0.00, 8.00, 'cash', 8.00)`
    );
    const invoice2Id = order2Res.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, discount_type, discount_value)
       VALUES (?, 1, 'Test Burger', 2, 5.000000, 0.00, 0.000000, 'fixed', 1.00)`,
      [invoice2Id]
    );

    // No discount at all.
    const [order3Res] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (3, 1, 10.00, 0.00, 10.00, 'cash', 10.00)`
    );
    const invoice3Id = order3Res.insertId;

    const res = await request(app).get('/api/admin/orders').set('Cookie', adminCookie);
    expect(res.status).toBe(200);

    const order1 = res.body.orders.find(o => o.invoice_id === invoiceId);
    expect(Number(order1.order_discount_amount)).toBeCloseTo(5.00, 2);
    expect(Number(order1.line_discount_amount)).toBeCloseTo(0, 2);

    const order2 = res.body.orders.find(o => o.invoice_id === invoice2Id);
    expect(Number(order2.order_discount_amount)).toBeCloseTo(0, 2);
    expect(Number(order2.line_discount_amount)).toBeCloseTo(2.00, 2);

    const order3 = res.body.orders.find(o => o.invoice_id === invoice3Id);
    expect(Number(order3.order_discount_amount)).toBeCloseTo(0, 2);
    expect(Number(order3.line_discount_amount)).toBeCloseTo(0, 2);
  });

  it('filters orders by shift_id', async () => {
    const [shiftA] = await pool.query(
      `INSERT INTO shifts (user_id, status, starting_cash) VALUES (1, 'closed', 0)`
    );
    const [shiftB] = await pool.query(
      `INSERT INTO shifts (user_id, status, starting_cash) VALUES (1, 'closed', 0)`
    );
    const [orderA] = await pool.query(
      `INSERT INTO orders (order_id, user_id, shift_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (1, 1, ?, 10.00, 0.00, 10.00, 'cash', 10.00)`,
      [shiftA.insertId]
    );
    const [orderB] = await pool.query(
      `INSERT INTO orders (order_id, user_id, shift_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (2, 1, ?, 20.00, 0.00, 20.00, 'cash', 20.00)`,
      [shiftB.insertId]
    );

    const res = await request(app)
      .get(`/api/admin/orders?shift_id=${shiftA.insertId}`)
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.orders.map(o => o.invoice_id)).toContain(orderA.insertId);
    expect(res.body.orders.map(o => o.invoice_id)).not.toContain(orderB.insertId);
    expect(res.body.stats.total_revenue).toBeCloseTo(10, 2);
  });

  it('filters orders by exact total amount', async () => {
    const [orderA] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (1, 1, 10.00, 0.00, 10.00, 'cash', 10.00)`
    );
    const [orderB] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (2, 1, 20.00, 0.00, 20.00, 'cash', 20.00)`
    );

    const res = await request(app)
      .get('/api/admin/orders?total=10.00')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const orderIds = res.body.orders.map(o => o.invoice_id);
    expect(orderIds).toContain(orderA.insertId);
    expect(orderIds).not.toContain(orderB.insertId);
  });

  it('matches total within a half-cent tolerance', async () => {
    const [orderA] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (1, 1, 10.00, 0.00, 10.00, 'cash', 10.00)`
    );
    const [orderB] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (2, 1, 10.01, 0.00, 10.01, 'cash', 10.01)`
    );

    const res = await request(app)
      .get('/api/admin/orders?total=10.004')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const orderIds = res.body.orders.map(o => o.invoice_id);
    expect(orderIds).toContain(orderA.insertId);
    expect(orderIds).not.toContain(orderB.insertId);
  });

  it('ignores a non-numeric total param (returns unfiltered set)', async () => {
    const [orderA] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (1, 1, 10.00, 0.00, 10.00, 'cash', 10.00)`
    );
    const [orderB] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (2, 1, 20.00, 0.00, 20.00, 'cash', 20.00)`
    );

    const res = await request(app)
      .get('/api/admin/orders?total=invalid_number')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const orderIds = res.body.orders.map(o => o.invoice_id);
    expect(orderIds).toContain(orderA.insertId);
    expect(orderIds).toContain(orderB.insertId);
  });

  it('does not double-count a void-kind refund row against revenue', async () => {
    // A live paid order (money collected) that also has a stray void-kind refund row.
    // Void-kind rows belong to cancelled orders; they must NOT net down a live sale.
    const { invoiceId } = await seedPaidOrder('cash');
    await pool.query(
      `INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, refund_method, user_id)
       VALUES ('void', ?, 'order', 10.00, 1.60, 11.60, 'cash', 1)`,
      [invoiceId]
    );

    const stats = await fetchStats();
    // Still full revenue: the void-kind row is ignored by the kind='refund' filter.
    expect(stats.total_revenue).toBeCloseTo(11.60, 2);
    expect(stats.cash_revenue).toBeCloseTo(11.60, 2);
  });

  it('filters orders returning only discounted orders with discounted=1', async () => {
    // Order-level only: subtotal 20.00, 25% order discount
    const [orderRes] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, discount_type, discount_value)
       VALUES (101, 1, 20.00, 0.00, 15.00, 'cash', 15.00, 'percent', 25.00)`
    );
    const invoiceId = orderRes.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 2, 10.000000, 0.00, 0.000000)`,
      [invoiceId]
    );

    // Line-level only: price 5.00 x2, fixed discount 1.00/unit
    const [order2Res] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (102, 1, 8.00, 0.00, 8.00, 'cash', 8.00)`
    );
    const invoice2Id = order2Res.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, discount_type, discount_value)
       VALUES (?, 1, 'Test Burger', 2, 5.000000, 0.00, 0.000000, 'fixed', 1.00)`,
      [invoice2Id]
    );

    // No discount at all.
    const [order3Res] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount)
       VALUES (103, 1, 10.00, 0.00, 10.00, 'cash', 10.00)`
    );
    const invoice3Id = order3Res.insertId;

    const res = await request(app)
      .get('/api/admin/orders?discounted=1')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const orderIds = res.body.orders.map(o => o.invoice_id);
    expect(orderIds).toContain(invoiceId);
    expect(orderIds).toContain(invoice2Id);
    expect(orderIds).not.toContain(invoice3Id);
  });

  it('filters refunds and JoFotara before pagination and summarizes saved returns once', async () => {
    const partialA = await seedOrder({ total: 10, refundStatus: 'partial' });
    await seedRefund(partialA, 2);
    const partialB = await seedOrder({ total: 20, refundStatus: 'partial' });
    await seedRefund(partialB, 5);
    await seedRefund(partialB, 5);

    const acceptedInvoice = await seedOrder({ total: 30, refundStatus: 'full' });
    const acceptedOriginal = await seedJofotaraDocument({ invoiceId: acceptedInvoice, status: 'accepted' });
    const acceptedReturn = await seedRefund(acceptedInvoice, 15);
    await seedJofotaraDocument({
      invoiceId: acceptedInvoice,
      refundId: acceptedReturn,
      originalDocumentId: acceptedOriginal,
      status: 'accepted'
    });
    await seedRefund(acceptedInvoice, 15);

    const pendingInvoice = await seedOrder();
    await seedJofotaraDocument({ invoiceId: pendingInvoice, status: 'pending' });
    const submittingInvoice = await seedOrder();
    await seedJofotaraDocument({ invoiceId: submittingInvoice, status: 'submitting' });
    const rejectedInvoice = await seedOrder({ refundStatus: 'full' });
    const rejectedOriginal = await seedJofotaraDocument({ invoiceId: rejectedInvoice, status: 'rejected' });
    const unknownReturn = await seedRefund(rejectedInvoice, 10);
    await seedJofotaraDocument({
      invoiceId: rejectedInvoice,
      refundId: unknownReturn,
      originalDocumentId: rejectedOriginal,
      status: 'unknown'
    });
    const unknownInvoice = await seedOrder();
    await seedJofotaraDocument({ invoiceId: unknownInvoice, status: 'unknown' });
    const unsubmittedInvoice = await seedOrder();

    const partial = await request(app)
      .get('/api/admin/orders?refund_status=partial&limit=1')
      .set('Cookie', adminCookie);
    expect(partial.status).toBe(200);
    expect(partial.body.orders.every(order => order.refund_status === 'partial')).toBe(true);
    expect(partial.body.pagination.total).toBe(2);
    expect(Number(partial.body.stats.total_revenue)).toBeCloseTo(18, 2);
    expect(partial.body.orders.filter(order => order.invoice_id === partialB)).toHaveLength(1);

    const accepted = await request(app)
      .get('/api/admin/orders?jofotara_status=accepted')
      .set('Cookie', adminCookie);
    expect(accepted.body.orders.map(order => order.invoice_id)).toEqual([acceptedInvoice]);

    const notSent = await request(app)
      .get('/api/admin/orders?jofotara_status=not_submitted')
      .set('Cookie', adminCookie);
    expect(notSent.body.orders.map(order => order.invoice_id)).toContain(unsubmittedInvoice);

    const attention = await request(app)
      .get('/api/admin/orders?jofotara_status=needs_attention')
      .set('Cookie', adminCookie);
    expect(attention.body.orders.map(order => order.invoice_id)).toEqual(
      expect.arrayContaining([pendingInvoice, submittingInvoice, rejectedInvoice, unknownInvoice])
    );
    expect(attention.body.orders.map(order => order.invoice_id)).not.toEqual(
      expect.arrayContaining([acceptedInvoice, unsubmittedInvoice])
    );

    const invalid = await request(app)
      .get('/api/admin/orders?jofotara_status=invalid_value')
      .set('Cookie', adminCookie);
    const invalidRefund = await request(app)
      .get('/api/admin/orders?refund_status=invalid_value')
      .set('Cookie', adminCookie);
    const all = await request(app).get('/api/admin/orders').set('Cookie', adminCookie);
    expect(invalid.body.pagination.total).toBe(all.body.pagination.total);
    expect(invalidRefund.body.pagination.total).toBe(all.body.pagination.total);

    const acceptedOrder = all.body.orders.find(order => order.invoice_id === acceptedInvoice);
    expect(acceptedOrder.jofotara_status).toBe('accepted');
    expect(acceptedOrder.jofotara_return_status).toBe('not_submitted');
    const unsubmittedOrder = all.body.orders.find(order => order.invoice_id === unsubmittedInvoice);
    expect(unsubmittedOrder.jofotara_status).toBe('not_submitted');
    const unknownOrder = all.body.orders.find(order => order.invoice_id === rejectedInvoice);
    expect(unknownOrder.jofotara_return_status).toBe('unknown');
    expect(all.body.orders.filter(order => order.invoice_id === partialB)).toHaveLength(1);
  });
});
