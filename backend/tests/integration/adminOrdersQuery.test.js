const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { insertPaidOrder, insertOrderRefund, insertShift } = require('../helpers/fixtures');
const { getBusinessDateRange } = require('../../utils/businessDate');

describe('Orders query work and business-time boundaries', () => {
  let cookie;
  beforeEach(async () => {
    await seedDatabase();
    cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
  });

  it('keeps date branches disjoint and applies filters before statistics and pagination', async () => {
    const range = getBusinessDateRange('2026-07-01', '2026-07-01');
    const paid = ['cash', 'card', 'split', 'receivable', 'platform'];
    const shift = await insertShift(pool);
    const cases = [];
    for (const method of [...paid, 'voided', 'unpaid_table']) {
      for (const [created, issued] of [
        [range.start, range.start], [range.end, range.end],
        ['2026-06-01 08:00:00', range.start],
        [range.start, '2026-06-01 08:00:00'], [range.start, null],
      ]) {
        const id = await insertPaidOrder(pool, { payment_method: method === 'receivable' ? 'cash' : method,
          created_at: created, invoice_issued_at: issued, subtotal: 10, tax: 0, total: 10,
          cash_amount: method === 'cash' ? 10 : method === 'split' ? 5 : 0,
          card_amount: method === 'card' ? 10 : method === 'split' ? 5 : 0,
          user_id: cases.length % 2 ? 1 : 2, shift_id: shift });
        if (method === 'receivable') {
          await pool.query(`UPDATE orders SET payment_method='receivable',payment_due_on='2026-09-01',
            receivable_reason='Fixture',buyer_name_at_sale='Fixture customer' WHERE invoice_id=?`, [id]);
        }
        await pool.query('UPDATE orders SET invoice_number=?,order_id=?,table_id=? WHERE invoice_id=?',
          [1000 + id, id, id % 2 ? 1 : null, id]);
        await insertOrderRefund(pool, { invoice_id: id, amount_refunded: 2,
          subtotal_refunded: 2, created_at: '2026-08-01 08:00:00' });
        await insertOrderRefund(pool, { invoice_id: id, kind: 'void', amount_refunded: 3 });
        const time = paid.includes(method) ? issued || created : created;
        cases.push({ id, method, user: cases.length % 2 ? 1 : 2, table: id % 2 === 1,
          included: time >= range.start && time < range.end });
      }
    }
    for (const filters of [{}, { payment_methods: 'cash,card' }, { cashier_id: 2 },
      { shift_id: shift, filter_type: 'tables', total: 10 }, { filter_type: 'register' }]) {
      const expected = cases.filter(o => o.included &&
        (!filters.payment_methods || filters.payment_methods.split(',').includes(o.method)) &&
        (!filters.cashier_id || filters.cashier_id === o.user) &&
        (!filters.filter_type || (filters.filter_type === 'tables') === o.table));
      const response = await request(app).get('/api/admin/orders').set('Cookie', cookie)
        .query({ start_date: '2026-07-01', end_date: '2026-07-01', ...filters, limit: 200 });
      expect(response.status).toBe(200);
      expect(response.body.orders.map(o => o.invoice_id)).toEqual(expected.map(o => o.id).reverse());
      expect(response.body.pagination.total).toBe(expected.length);
      expect(response.body.stats.total_revenue).toBe(expected.filter(o => o.method !== 'voided').length * 8);
      for (const method of ['cash', 'card', 'split', 'platform']) {
        expect(response.body.stats[`${method}_revenue`]).toBe(expected.filter(o => o.method === method).length * 8);
      }
    }
    const historical = await request(app).get('/api/admin/orders').set('Cookie', cookie).query({ invoice: 1002 });
    expect(historical.status).toBe(200);
    expect(historical.body.orders.map(o => o.invoice_id)).toEqual([2]);
    expect(historical.body.stats.cash_revenue).toBe(8);
    const page = await request(app).get('/api/admin/orders').set('Cookie', cookie)
      .query({ start_date: '2026-07-01', end_date: '2026-07-01', limit: 1, page: 2 });
    const included = cases.filter(o => o.included).reverse();
    expect(page.body.orders.map(o => o.invoice_id)).toEqual([included[1].id]);
    expect(page.body.pagination.total).toBe(included.length);
    const pastLastPage = await request(app).get('/api/admin/orders').set('Cookie', cookie)
      .query({ start_date: '2026-07-01', end_date: '2026-07-01', page: 999 });
    expect(pastLastPage.status).toBe(200);
    expect(pastLastPage.body.orders).toEqual([]);
    expect(pastLastPage.body.stats).toEqual(page.body.stats);
    const emptyDay = await request(app).get('/api/admin/orders').set('Cookie', cookie)
      .query({ start_date: '2020-01-01', end_date: '2020-01-01' });
    expect(emptyDay.status).toBe(200);
    expect(emptyDay.body.orders).toEqual([]);
    expect(emptyDay.body.pagination.total).toBe(0);
    expect(Object.values(emptyDay.body.stats).every(value => value === 0)).toBe(true);
  });

  it('bounds statistics reads to a selected day instead of historical orders and refunds', async () => {
    for (const [count, timestamp] of [[100, '2026-07-01 08:00:00'], [4000, '2025-01-01 08:00:00']]) {
      await pool.query(`INSERT INTO orders (user_id,subtotal,tax,total,payment_method,cash_amount,created_at,invoice_issued_at)
        VALUES ?`, [Array.from({ length: count }, () => [2, 10, 0, 10, 'cash', 10, timestamp, timestamp])]);
    }
    await pool.query(`INSERT INTO refunds (kind,invoice_id,scope,amount_refunded,user_id)
      SELECT 'refund',invoice_id,'order',2,1 FROM orders WHERE MOD(invoice_id,4)=0`);
    await pool.query('ANALYZE TABLE orders,refunds');
    const conn = await pool.getConnection();
    const query = pool.query.bind(pool);
    let rowsRead;
    const spy = vi.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
      if (!String(sql).includes('as total_revenue')) return query(sql, params);
      const before = Number((await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'"))[0][0].Value);
      const result = await conn.query(sql, params);
      rowsRead = Number((await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'"))[0][0].Value) - before;
      return result;
    });
    try {
      const response = await request(app).get('/api/admin/orders').set('Cookie', cookie)
        .query({ start_date: '2026-07-01', end_date: '2026-07-01' });
      expect(response.status).toBe(200);
      expect(response.body.pagination.total).toBe(100);
      expect(response.body.stats.cash_revenue).toBe(950);
      expect(rowsRead).toBeLessThan(2000);
    } finally { spy.mockRestore(); conn.release(); }
  });

  it('limits list discount and return work to the requested page', async () => {
    await pool.query(`INSERT INTO orders (user_id,subtotal,tax,total,payment_method,cash_amount,created_at,invoice_issued_at)
      VALUES ?`, [Array.from({ length: 4100 }, (_, i) => [2, 10, 0, 10, 'cash', 10,
      i < 100 ? '2026-07-01 08:00:00' : '2025-01-01 08:00:00',
      i < 100 ? '2026-07-01 08:00:00' : '2025-01-01 08:00:00'])]);
    await pool.query(`INSERT INTO order_items (invoice_id,product_id,quantity,price_at_sale,tax_rate,tax_amount)
      SELECT invoice_id,1,2,5,0,0 FROM orders`);
    await pool.query(`INSERT INTO refunds (kind,invoice_id,scope,amount_refunded,user_id)
      SELECT 'refund',invoice_id,'item',2.5,1 FROM orders WHERE MOD(invoice_id,4)=0`);
    await pool.query(`INSERT INTO refund_items
      (refund_id,order_item_id,product_id,quantity,unit_price,line_subtotal,line_tax,line_total)
      SELECT r.id,oi.id,1,.5,5,2.5,0,2.5 FROM refunds r JOIN order_items oi ON oi.invoice_id=r.invoice_id`);
    await pool.query('ANALYZE TABLE orders,order_items,refunds,refund_items');
    const conn = await pool.getConnection();
    const query = pool.query.bind(pool);
    let rowsRead;
    const spy = vi.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
      if (!String(sql).includes('AS jofotara_return_status')) return query(sql, params);
      const before = Number((await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'"))[0][0].Value);
      const result = await conn.query(sql, params);
      rowsRead = Number((await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'"))[0][0].Value) - before;
      return result;
    });
    try {
      const response = await request(app).get('/api/admin/orders').set('Cookie', cookie)
        .query({ start_date: '2026-07-01', end_date: '2026-07-01', limit: 10, page: 2 });
      expect(response.status).toBe(200);
      expect(response.body.orders.map(o => o.invoice_id)).toEqual([90,89,88,87,86,85,84,83,82,81]);
      expect(response.body.pagination.total).toBe(100);
      expect(response.body.stats.cash_revenue).toBe(937.5);
      expect(response.body.orders.find(o => o.invoice_id === 88).jofotara_return_status).toBe('not_submitted');
      expect(rowsRead).toBeLessThan(3000);
    } finally { spy.mockRestore(); conn.release(); }
  });
});
