// backend/tests/integration/openTableNumbers.test.js
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

const request = require('supertest');
const { app } = require('../../../server');

function captureConnectionQueries() {
  const observed = [];
  const originalGetConnection = pool.getConnection;
  pool.getConnection = async function () {
    const conn = await originalGetConnection.call(this);
    const originalQuery = conn.query;
    const originalRelease = conn.release;
    conn.query = async function (sql, params) {
      observed.push(String(sql));
      return originalQuery.call(this, sql, params);
    };
    conn.release = function () {
      conn.query = originalQuery;
      conn.release = originalRelease;
      pool.getConnection = originalGetConnection;
      return originalRelease.call(this);
    };
    return conn;
  };
  return observed;
}

afterAll(async () => { await pool.end(); });

describe('Open table numbering — schema', () => {
  beforeEach(async () => {
    await seedDatabase();
    await pool.query("INSERT INTO shifts (id, user_id, status) VALUES (1, ?, 'open')", [SEED.cashierUser.id]);
  });

  it('allows order_id NULL, rejects duplicate (order_seq_scope, order_id), permits rollover', async () => {
    // order_id NULL must be accepted (open table)
    const [ins] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (NULL, ?, 1, 5, 0, 5, 'unpaid_table')`, [SEED.cashierUser.id]);
    expect(ins.insertId).toBeGreaterThan(0);

    // second NULL open-table on a different table — UNIQUE must tolerate multiple NULLs
    const [ins2] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (NULL, ?, 2, 5, 0, 5, 'unpaid_table')`, [SEED.cashierUser.id]);
    expect(ins2.insertId).toBeGreaterThan(0);

    // duplicate (order_seq_scope, order_id) must be rejected by the UNIQUE backstop
    await pool.query(
      `INSERT INTO orders (order_id, order_seq_scope, user_id, subtotal, tax, total, payment_method)
       VALUES (5, 'date:2026-06-30', ?, 5, 0, 5, 'cash')`, [SEED.cashierUser.id]);
    await expect(pool.query(
      `INSERT INTO orders (order_id, order_seq_scope, user_id, subtotal, tax, total, payment_method)
       VALUES (5, 'date:2026-06-30', ?, 5, 0, 5, 'cash')`, [SEED.cashierUser.id]
    )).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });

    // rollover case: same order_id but different scope date must NOT collide (Issue D fix).
    // This is the shift-spanning-business-date-rollover case that previously false-collided
    // on the mis-scoped (shift_id, order_id) UNIQUE.
    const [roll1] = await pool.query(
      `INSERT INTO orders (order_id, order_seq_scope, user_id, subtotal, tax, total, payment_method)
       VALUES (7, 'date:2026-06-30', ?, 5, 0, 5, 'cash')`, [SEED.cashierUser.id]);
    expect(roll1.insertId).toBeGreaterThan(0);
    const [roll2] = await pool.query(
      `INSERT INTO orders (order_id, order_seq_scope, user_id, subtotal, tax, total, payment_method)
       VALUES (7, 'date:2026-07-01', ?, 5, 0, 5, 'cash')`, [SEED.cashierUser.id]);
    expect(roll2.insertId).toBeGreaterThan(0);
  });
});

describe('Register checkout — order_id contiguity', () => {
  beforeEach(async () => {
    await seedDatabase();
  });

  it('two sequential register sales get contiguous order_ids', async () => {
    const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
    const cookie = login.headers['set-cookie'][0];
    await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 50 });
    const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1", [SEED.cashierUser.id]);

    const sale = () => request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
      cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }], shift_id: shift.id,
      subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2 });

    const r1 = await sale(); const r2 = await sale();
    const [[o1]] = await pool.query("SELECT order_id, order_seq_scope FROM orders WHERE invoice_id=?", [r1.body.invoice_id]);
    const [[o2]] = await pool.query("SELECT order_id, order_seq_scope FROM orders WHERE invoice_id=?", [r2.body.invoice_id]);
    expect(o2.order_id).toBe(o1.order_id + 1);

    // Every cashier uses the same business-day scope.
    const expectedScope = `date:${require('../../utils/businessDate').getBusinessDate()}`;
    expect(o1.order_seq_scope).toBe(expectedScope);
    expect(o2.order_seq_scope).toBe(expectedScope);
    expect(o1.order_seq_scope).not.toBeNull();
  });
});

describe('Open table numbering — save', () => {
  let waiterCookie;
  beforeEach(async () => {
    await seedDatabase();
    // waiter.edit_locked required by ensureCanUpdateTable() even for new-order creation
    await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'waiter.edit_locked')", [SEED.waiterUser.id]);
    const login = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
    waiterCookie = login.headers['set-cookie'][0];
  });

  it('settling an open table assigns a fresh order_id; legacy keeps its own', async () => {
    const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
    const cookie = login.headers['set-cookie'][0];
    await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 50 });
    const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1", [SEED.cashierUser.id]);

    // open table with NULL order_id
    const [open] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (NULL, ?, 1, 5, 0.8, 5.8, 'unpaid_table')`, [SEED.cashierUser.id]);
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, ?, 1, 5.0, 16.00, 0.8)`, [open.insertId, SEED.product1.id]);
    await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1", [open.insertId]);

    const settle = await request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
      edit_invoice_id: open.insertId, edit_order_id: null, table_id: 1, shift_id: shift.id,
      cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }],
      subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2 });
    expect(settle.statusCode).toBe(200);
    const [[settled]] = await pool.query("SELECT order_id, invoice_number FROM orders WHERE invoice_id=?", [open.insertId]);
    expect(settled.order_id).toBeGreaterThan(0);
    expect(settled.invoice_number).toBeGreaterThan(0);

    // legacy open table that already carries order_id = 99 keeps it
    const [legacy] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (99, ?, 2, 5, 0.8, 5.8, 'unpaid_table')`, [SEED.cashierUser.id]);
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, ?, 1, 5.0, 16.00, 0.8)`, [legacy.insertId, SEED.product1.id]);
    await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=2", [legacy.insertId]);
    const settle2 = await request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
      edit_invoice_id: legacy.insertId, edit_order_id: 99, table_id: 2, shift_id: shift.id,
      cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }],
      subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2 });
    expect(settle2.statusCode).toBe(200);
    const [[settledLegacy]] = await pool.query("SELECT order_id FROM orders WHERE invoice_id=?", [legacy.insertId]);
    expect(settledLegacy.order_id).toBe(99);
  });

  it('saving a table consumes no order_id (stays NULL) and advances no counter', async () => {
    const [before] = await pool.query("SELECT COALESCE(MAX(current_value),0) v FROM daily_sequences");
    const res = await request(app)
      .post('/api/pos/table_order')
      .set('Cookie', waiterCookie)
      .send({ table_id: SEED.table.id, cart: [{ id: SEED.product1.id, qty: 1, price: 5.00 }], subtotal: 5, tax: 0.8, total: 5.8 });
    expect(res.statusCode).toBe(200);

    const [rows] = await pool.query(
      "SELECT order_id FROM orders WHERE table_id = ? AND payment_method = 'unpaid_table'", [SEED.table.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).toBeNull();

    const [after] = await pool.query("SELECT COALESCE(MAX(current_value),0) v FROM daily_sequences");
    expect(Number(after[0].v)).toBe(Number(before[0].v)); // no counter burned
  });
});

describe('Void before checkout — no order_id gap', () => {
  beforeEach(async () => {
    await seedDatabase();
  });

  it('voiding an unpaid table before checkout does not gap the daily sequence', async () => {
    const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
    const cookie = login.headers['set-cookie'][0];
    await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 50 });
    const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1", [SEED.cashierUser.id]);
    const sale = () => request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
      cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }], shift_id: shift.id,
      subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2 });

    const r1 = await sale();
    const [[o1]] = await pool.query("SELECT order_id FROM orders WHERE invoice_id=?", [r1.body.invoice_id]);

    // open a table then void it (delete the unpaid row) — simulates void-before-checkout
    const [open] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (NULL, ?, 1, 5, 0.8, 5.8, 'unpaid_table')`, [SEED.cashierUser.id]);
    await pool.query("DELETE FROM orders WHERE invoice_id=?", [open.insertId]);

    const r2 = await sale();
    const [[o2]] = await pool.query("SELECT order_id FROM orders WHERE invoice_id=?", [r2.body.invoice_id]);
    expect(o2.order_id).toBe(o1.order_id + 1); // contiguous — the table consumed nothing
  });
});

describe('Split children — distinct order_id and invoice_number', () => {
  let cashierCookie;
  let cashierShiftId;

  beforeEach(async () => {
    await seedDatabase();
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ user_number: SEED.cashierUser.user_number });
    cashierCookie = loginRes.headers['set-cookie'][0];
  });

  async function openShift() {
    const res = await request(app)
      .post('/api/auth/shifts?action=open')
      .set('Cookie', cashierCookie)
      .send({ user_id: SEED.cashierUser.id, starting_cash: 50 });
    expect(res.statusCode).toBe(200);
    const [[shift]] = await pool.query(
      "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
      [SEED.cashierUser.id]);
    cashierShiftId = shift.id;
  }

  it('split children get distinct order_ids and invoice_numbers', async () => {
    await openShift();

    // parent unpaid_table order — order_id 77 (arbitrary, distinct from other tests)
    const [parent] = await pool.query(
      `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method)
       VALUES (77, ?, ?, ?, ?, 10, 0, 10, 'unpaid_table')`,
      [SEED.cashierUser.id, SEED.cashierUser.id, SEED.table.id, cashierShiftId]);

    const splitPayload = (key) => ({
      is_split: true,
      parent_invoice_id: parent.insertId,
      parent_order_id: 77,
      cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 16 }],
      subtotal: 5,
      tax: 0.80,
      total: 5.80,
      payment_method: 'cash',
      amount_tendered: 5.80,
      change_due: 0,
      shift_id: cashierShiftId,
      idempotency_key: key,
    });

    const r1 = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(splitPayload('split-distinct-1'));
    const r2 = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(splitPayload('split-distinct-2'));

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const [rows] = await pool.query(
      'SELECT order_id, invoice_number FROM orders WHERE parent_invoice_id = ? ORDER BY invoice_id',
      [parent.insertId]);

    expect(rows).toHaveLength(2);

    const ids  = rows.map(r => r.order_id);
    const invs = rows.map(r => r.invoice_number);

    // none null
    expect(ids.every(v => v !== null && v > 0)).toBe(true);
    expect(invs.every(v => v !== null && v > 0)).toBe(true);

    // all distinct
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(invs).size).toBe(invs.length);
  });
});

describe('GET table_order — open table identity', () => {
  let waiterCookie;
  beforeEach(async () => {
    await seedDatabase();
    await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'waiter.edit_locked')", [SEED.waiterUser.id]);
    const login = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
    waiterCookie = login.headers['set-cookie'][0];
  });

  it('GET table_order for an open table returns table_display_no and null invoice_number', async () => {
    const post = await request(app)
      .post('/api/pos/table_order')
      .set('Cookie', waiterCookie)
      .send({ table_id: SEED.table.id, cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }], subtotal: 5, tax: 0.8, total: 5.8 });
    expect(post.statusCode).toBe(200);
    const invoiceId = post.body.invoice_id;
    expect(post.body.order_display_no).toBeNull();
    expect(post.body.ticket_display_no).toBeNull();
    expect(post.body.table_display_no).toBe(String(SEED.table.table_number));

    const res = await request(app)
      .get(`/api/pos/table_order?order_id=${invoiceId}`)
      .set('Cookie', waiterCookie);
    expect(res.statusCode).toBe(200);
    expect(res.body.table_display_no).toBe(String(SEED.table.table_number));
    expect(res.body.invoice_number).toBeNull();
  });

  it('order_notes exposes table_display_no for open tables', async () => {
    const post = await request(app)
      .post('/api/pos/table_order')
      .set('Cookie', waiterCookie)
      .send({ table_id: SEED.table.id, cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }], subtotal: 5, tax: 0.8, total: 5.8 });
    expect(post.statusCode).toBe(200);

    const adminLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
    const adminCookie = adminLogin.headers['set-cookie'][0];

    const res = await request(app)
      .get('/api/pos/order_notes')
      .set('Cookie', adminCookie);
    expect(res.statusCode).toBe(200);

    const openRow = res.body.orders.find(o => o.invoice_id === post.body.invoice_id);
    expect(openRow).toBeDefined();
    expect(openRow.table_display_no).toBe(String(SEED.table.table_number));
  });
});

describe('Open table numbering — concurrency', () => {
  let cookie, shiftId;
  beforeEach(async () => {
    await seedDatabase();
    const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
    cookie = login.headers['set-cookie'][0];
    await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 50 });
    const [[s]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1", [SEED.cashierUser.id]);
    shiftId = s.id;
  });

  const sale = () => request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
    cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }], shift_id: shiftId,
    subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2 });

  it('10 parallel same-shift register sales get 10 distinct order_ids, no deadlock', async () => {
    // 10 parallel same-shift sales — kept within the smallest supported test pool
    // budget (5 conn + 10 queue) so the race proof needs no .env.test tuning.
    // The distinctness + no-deadlock invariant holds for any N; 10 concurrent
    // writers on the single daily_sequences row is a genuine contention test.
    const results = await Promise.all(Array.from({ length: 10 }, () => sale()));
    for (const r of results) expect(r.statusCode).toBe(200); // no ER_LOCK_DEADLOCK surfaced
    const ids = results.map(r => r.body.order_id).filter(v => v != null);
    expect(new Set(ids).size).toBe(results.length); // all distinct
  }, 30000);

  it('parallel register sale + table settle yield distinct order_id and invoice_number', async () => {
    const [open] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (NULL, ?, 1, 5, 0.8, 5.8, 'unpaid_table')`, [SEED.cashierUser.id]);
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, ?, 1, 5.0, 16.00, 0.8)`, [open.insertId, SEED.product1.id]);
    await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1", [open.insertId]);
    const settle = request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
      edit_invoice_id: open.insertId, edit_order_id: null, table_id: 1, shift_id: shiftId,
      cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }],
      subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2 });
    const [rSale, rSettle] = await Promise.all([sale(), settle]);
    expect(rSale.statusCode).toBe(200);
    expect(rSettle.statusCode).toBe(200);
    const [paid] = await pool.query(
      "SELECT order_id, invoice_number FROM orders WHERE order_id IS NOT NULL AND invoice_number IS NOT NULL");
    const oids = paid.map(p => p.order_id);
    const invs = paid.map(p => p.invoice_number);
    expect(new Set(oids).size).toBe(oids.length);
    expect(new Set(invs).size).toBe(invs.length);
  });

  it('locks cashier shift before the saved table item range', async () => {
    const [open] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (NULL, ?, 1, 5, 0.8, 5.8, 'unpaid_table')`, [SEED.cashierUser.id]);
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, ?, 1, 5.0, 16.00, 0.8)`, [open.insertId, SEED.product1.id]);
    await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1", [open.insertId]);
    const lockTrace = captureConnectionQueries();

    const settled = await request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
      edit_invoice_id: open.insertId, edit_order_id: null, table_id: 1, shift_id: shiftId,
      cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }],
      subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2
    });
    expect(settled.statusCode).toBe(200);

    const shiftLock = lockTrace.findIndex(sql => /FROM\s+shifts[\s\S]+FOR UPDATE/i.test(sql));
    const groupLock = lockTrace.findIndex(sql => /FROM\s+restaurant_tables[\s\S]+ORDER BY id[\s\S]+FOR UPDATE/i.test(sql));
    const itemLock = lockTrace.findIndex(sql => /FROM\s+order_items[\s\S]+FOR UPDATE/i.test(sql));
    expect(shiftLock).toBeGreaterThanOrEqual(0);
    expect(groupLock).toBeGreaterThan(shiftLock);
    expect(itemLock).toBeGreaterThan(groupLock);
  });

  it('two parallel settles of the SAME table never double-number it', async () => {
    const [open] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (NULL, ?, 1, 5, 0.8, 5.8, 'unpaid_table')`, [SEED.cashierUser.id]);
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, ?, 1, 5.0, 16.00, 0.8)`, [open.insertId, SEED.product1.id]);
    await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1", [open.insertId]);
    const settle = () => request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
      edit_invoice_id: open.insertId, edit_order_id: null, table_id: 1, shift_id: shiftId,
      cart: [{ id: SEED.product1.id, qty: 1, price: 5.0 }],
      subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2 });
    const [a, b] = await Promise.all([settle(), settle().catch(e => e)]);
    // exactly one finalization; the row holds exactly one order_id + one invoice_number
    const [[row]] = await pool.query("SELECT order_id, invoice_number, payment_method FROM orders WHERE invoice_id=?", [open.insertId]);
    expect(row.payment_method).toBe('cash');
    expect(row.order_id).toBeGreaterThan(0);
    expect(row.invoice_number).toBeGreaterThan(0);
    const [extra] = await pool.query("SELECT COUNT(*) c FROM orders WHERE parent_invoice_id = ?", [open.insertId]);
    expect(Number(extra[0].c)).toBe(0); // no phantom second order minted
  });
});
