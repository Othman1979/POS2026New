const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const cache = require('../../config/cache');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { invalidateUserSessions } = require('../../middleware/auth');
const { withBundleIntegrityChecksDisabled } = require('../helpers/bundleIntegrityFixtures');
const { refundPaidOrder, syncOrderRefundStatus } = require('../../services/RefundService');
const { restoreStockForCart } = require('../../services/InventoryService');

describe('POST /api/pos/refunds', () => {
  let adminCookie, cashierCookie, waiterCookie;

  beforeEach(async () => {
    await seedDatabase();
    adminCookie = (await request(app).post('/api/auth/login')
      .send({ user_number: '9001' })).headers['set-cookie'][0];
    cashierCookie = (await request(app).post('/api/auth/login')
      .send({ user_number: '9002' })).headers['set-cookie'][0];
    waiterCookie = (await request(app).post('/api/auth/login')
      .send({ user_number: '9003' })).headers['set-cookie'][0];
  });

  // Helper: create an unpaid open-table order on table 1 with 2x product 1.
  async function seedOpenTableOrder() {
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
    await pool.query(
      `UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1`,
      [invoiceId]
    );
    return invoiceId;
  }

  async function expectTableVoidedBy(invoiceId, userId) {
    const [refunds] = await pool.query('SELECT kind, user_id FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(refunds).toEqual([{ kind: 'void', user_id: userId }]);
    const [[order]] = await pool.query('SELECT payment_method, refund_status FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order).toEqual({ payment_method: 'voided', refund_status: 'full' });
    const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=1');
    expect(table).toEqual({ status: 'available', current_order_id: null });
  }

  async function seedOpenTableOrderWithCharge({
    qty = 2,
    lineDiscountType = null,
    lineDiscountValue = 0,
    orderDiscountType = null,
    orderDiscountValue = 0,
    taxInclusiveAtSale = 0
  } = {}) {
    const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
    const unitPrice = 5;
    let productSubtotal = unitPrice * qty;
    if (lineDiscountType === 'fixed') productSubtotal -= lineDiscountValue * qty;
    if (lineDiscountType === 'percent') productSubtotal -= productSubtotal * (lineDiscountValue / 100);
    productSubtotal = Math.max(0, productSubtotal);
    const fee = roundMoney(productSubtotal * 0.10);
    const subtotal = roundMoney(productSubtotal + fee);
    let discountedSubtotal = subtotal;
    if (orderDiscountType === 'fixed') discountedSubtotal -= orderDiscountValue;
    if (orderDiscountType === 'percent') discountedSubtotal -= discountedSubtotal * (orderDiscountValue / 100);
    discountedSubtotal = Math.max(0, discountedSubtotal);
    const discountRatio = subtotal > 0 ? discountedSubtotal / subtotal : 1;
    const productTax = taxInclusiveAtSale ? 0 : productSubtotal * discountRatio * 0.16;
    const feeTax = taxInclusiveAtSale ? 0 : fee * discountRatio * 0.16;
    const tax = roundMoney(productTax + feeTax);
    const total = roundMoney(discountedSubtotal + tax);

    const [orderResult] = await pool.query(
      `INSERT INTO orders
         (order_id, user_id, table_id, subtotal, tax, tax_inclusive_at_sale, total,
          payment_method, discount_type, discount_value)
       VALUES (1, 1, 1, ?, ?, ?, ?, 'unpaid_table', ?, ?)`,
      [subtotal, tax, taxInclusiveAtSale, total, orderDiscountType, orderDiscountValue]
    );
    const invoiceId = orderResult.insertId;
    const [productResult] = await pool.query(
      `INSERT INTO order_items
         (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, jofotara_tax_category, tax_amount,
          discount_type, discount_value, sort_order)
       VALUES (?, 1, 'Test Burger', ?, 5.000000, 16.00, 'S', ?, ?, ?, 0)`,
      [invoiceId, qty, productTax, lineDiscountType, lineDiscountValue]
    );
    const [feeResult] = await pool.query(
      `INSERT INTO order_items
         (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, jofotara_tax_category, tax_amount,
          discount_type, discount_value, note, sort_order)
       VALUES (?, NULL, '10% Service Charge', 1, ?, 16.00, 'S', ?, NULL, 0, 'Auto-Gratuity', 1)`,
      [invoiceId, fee, feeTax]
    );
    const snapshotId = '00000000-0000-4000-8000-000000000001';
    await pool.query(
      `INSERT INTO service_charge_snapshots
         (id, percentage, tax_rate, jofotara_tax_category, state, holder_type, holder_id, created_by, version)
       VALUES (?, 10, 16, 'S', 'open_order', 'order', ?, 1, 2)`,
      [snapshotId, String(invoiceId)]
    );
    await pool.query('UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?', [snapshotId, invoiceId]);
    await pool.query(
      "UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1",
      [invoiceId]
    );
    return {
      invoiceId,
      productItemId: productResult.insertId,
      feeItemId: feeResult.insertId,
      snapshotId
    };
  }

  async function corruptOpenOrder(invoiceId) {
    const [[parent]] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ?', [invoiceId]);
    await withBundleIntegrityChecksDisabled(pool, async conn => {
      await conn.query('UPDATE order_items SET quantity = 0 WHERE id = ?', [parent.id]);
      await conn.query(
        `INSERT INTO order_items
           (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, parent_item_id)
         VALUES (?, ?, 'Corrupt child', 1, 0, 0, 0, ?)`,
        [invoiceId, SEED.product1.id, parent.id]
      );
    });
  }

  async function snapshotRefundMutationState(invoiceId) {
    const [items] = await pool.query('SELECT * FROM order_items WHERE invoice_id = ? ORDER BY id', [invoiceId]);
    const [refunds] = await pool.query('SELECT * FROM refunds WHERE invoice_id = ? ORDER BY id', [invoiceId]);
    const [refundItems] = await pool.query('SELECT ri.* FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE r.invoice_id = ? ORDER BY ri.id', [invoiceId]);
    const [audits] = await pool.query('SELECT * FROM audit_events WHERE entity_id = ? ORDER BY id', [invoiceId]);
    const [orders] = await pool.query('SELECT * FROM orders WHERE invoice_id = ?', [invoiceId]);
    const [stock] = await pool.query('SELECT id, stock FROM products ORDER BY id');
    const [tables] = await pool.query('SELECT * FROM restaurant_tables WHERE id = 1');
    return { items, refunds, refundItems, audits, orders, stock, tables };
  }

  // Grant the seeded waiter (id 3) an exact permission set, then return a fresh cookie.
  async function grantWaiter(keys) {
    await pool.query('DELETE FROM user_permissions WHERE user_id = ?', [SEED.waiterUser.id]);
    if (keys.length) {
      await pool.query('INSERT INTO user_permissions (user_id, perm_key) VALUES ?', [keys.map(k => [SEED.waiterUser.id, k])]);
    }
    invalidateUserSessions(SEED.waiterUser.id);
    const relog = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
    return relog.headers['set-cookie'][0];
  }

  async function waitForAuditCount(eventType, entityId, expected, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    do {
      const [[row]] = await pool.query(
        "SELECT COUNT(*) AS c FROM audit_events WHERE event_type = ? AND entity_id = ?",
        [eventType, entityId]
      );
      count = Number(row.c);
      if (count === expected) return count;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return count;
  }

  function failNextConnectionQuery(predicate, message) {
    const originalGetConnection = pool.getConnection;
    pool.getConnection = async function () {
      const conn = await originalGetConnection.call(this);
      const originalQuery = conn.query;
      const originalRelease = conn.release;
      let failed = false;
      conn.query = async function (sql, params) {
        if (!failed && predicate(sql, params)) {
          failed = true;
          throw new Error(message);
        }
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
  }

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

  it('rejects an occupied-table void without pos.void_item (403)', async () => {
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cashierCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });
    expect(res.status).toBe(403);
    // DB untouched
    const [[refundCount]] = await pool.query('SELECT COUNT(*) c FROM refunds');
    expect(refundCount.c).toBe(0);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.payment_method).toBe('unpaid_table');
  });

  it('bundle corruption: void rejects full corrupt order rows before refund or table mutation', async () => {
    const invoiceId = await seedOpenTableOrder();
    await corruptOpenOrder(invoiceId);
    const before = await snapshotRefundMutationState(invoiceId);

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', reason: 'corrupt bundle guard' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('BUNDLE_ORDER_CORRUPT');
    expect(await snapshotRefundMutationState(invoiceId)).toEqual(before);
  });

  it('voids an open table order, frees the table, writes refund records (admin)', async () => {
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', reason: 'customer left' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('void');
    expect(Number(res.body.amount_refunded)).toBe(0);

    const [[refund]] = await pool.query('SELECT * FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(refund.kind).toBe('void');
    expect(Number(refund.amount_refunded)).toBe(0);
    expect(refund.reason).toBe('Table cleared');
    expect(refund.table_number).toBe('1');
    expect(refund.user_id).toBe(SEED.adminUser.id);
    expect(refund.created_at).toBeTruthy();

    const [items] = await pool.query('SELECT * FROM refund_items WHERE refund_id=?', [refund.id]);
    expect(items.length).toBe(1);
    expect(Number(items[0].quantity)).toBe(2);

    const [[order]] = await pool.query('SELECT payment_method, refund_status FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.payment_method).toBe('voided');
    expect(order.refund_status).toBe('full');

    const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=1');
    expect(table.status).toBe('available');
    expect(table.current_order_id).toBeNull();
  });

  it('reports success when a socket notification fails after the void commits', async () => {
    const invoiceId = await seedOpenTableOrder();
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const cacheSpy = vi.spyOn(cache, 'invalidateDashboardCache');
    try {
      global.__mockEmit__.mockImplementation(event => {
        if (event === 'shifts_changed') throw new Error('socket unavailable');
      });

      const res = await request(app).post('/api/pos/refunds')
        .set('Cookie', adminCookie)
        .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const [[order]] = await pool.query(
        'SELECT payment_method FROM orders WHERE invoice_id=?',
        [invoiceId]
      );
      expect(order.payment_method).toBe('voided');
      expect(cacheSpy).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId }),
        'Table void post-commit notification failed.'
      );
    } finally {
      global.__mockEmit__.mockReset();
      cacheSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('locks the table group before its order and items during an unpaid void', async () => {
    const invoiceId = await seedOpenTableOrder();
    const lockTrace = captureConnectionQueries();

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });

    expect(res.statusCode).toBe(200);
    const tableLock = lockTrace.findIndex(sql => /FROM\s+restaurant_tables[\s\S]+FOR UPDATE/i.test(sql));
    const orderLock = lockTrace.findIndex(sql => /FROM\s+orders[\s\S]+FOR UPDATE/i.test(sql));
    const itemLock = lockTrace.findIndex(sql => /FROM\s+order_items[\s\S]+FOR UPDATE/i.test(sql));
    expect(tableLock).toBeGreaterThanOrEqual(0);
    expect(orderLock).toBeGreaterThan(tableLock);
    expect(itemLock).toBeGreaterThan(orderLock);
  });

  it('partial void broadcasts the root and every joined child table', async () => {
    const invoiceId = await seedOpenTableOrder();
    const [[item]] = await pool.query(
      'SELECT id FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
      [invoiceId]
    );
    await pool.query(
      `UPDATE restaurant_tables
          SET status='occupied', current_order_id=?, parent_table_id=?
        WHERE id=?`,
      [invoiceId, SEED.table.id, SEED.table2.id]
    );
    global.__mockEmit__.mockClear();

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({
        invoice_id: invoiceId,
        expected_version: await currentTableRevision(invoiceId), intent: 'void',
        items: [{ order_item_id: item.id, qty: 1 }]
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.table_freed).toBe(false);
    const emittedTableIds = global.__mockEmit__.mock.calls
      .filter(([event]) => event === 'table_update')
      .map(([, payload]) => Number(payload.table.id));
    expect(emittedTableIds).toEqual(expect.arrayContaining([
      SEED.table.id,
      SEED.table2.id
    ]));
  });

  it('rolls back an unpaid-table void when the audit insert fails', async () => {
    const invoiceId = await seedOpenTableOrder();
    failNextConnectionQuery(
      (sql, params) => String(sql).includes('INSERT INTO audit_events') && Array.isArray(params) && params[0] === 'void_order',
      'simulated void_order audit failure'
    );

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', reason: 'audit fail' });

    expect(res.status).toBe(500);
    expect(await waitForAuditCount('void_order', invoiceId, 0)).toBe(0);

    const [[refundCount]] = await pool.query('SELECT COUNT(*) c FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(refundCount.c).toBe(0);
    const [[order]] = await pool.query('SELECT payment_method, refund_status FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.payment_method).toBe('unpaid_table');
    expect(order.refund_status).toBe('none');
    const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=1');
    expect(table.status).toBe('occupied');
    expect(table.current_order_id).toBe(invoiceId);
  });

  it('allows an occupied-table void with pos.void_item only', async () => {
    const cookie = await grantWaiter(['tables.access', 'pos.void_item']);
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });
    expect(res.status).toBe(200);
    await expectTableVoidedBy(invoiceId, SEED.waiterUser.id);
  });

  it('rejects intent=void from a pos.refund-only user lacking the void grants (403)', async () => {
    const cookie = await grantWaiter(['tables.access', 'pos.refund']); // no void perms
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });
    expect(res.status).toBe(403);
    // DB untouched — no refund row, order still open, table still occupied.
    const [[c]] = await pool.query('SELECT COUNT(*) c FROM refunds');
    expect(c.c).toBe(0);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
    expect(order.payment_method).toBe('unpaid_table');
    const [[table]] = await pool.query('SELECT status FROM restaurant_tables WHERE id = 1');
    expect(table.status).toBe('occupied');
  });

  it('allows a printed-table void with both void permissions and no refund/edit permission', async () => {
    const cookie = await grantWaiter(['tables.access', 'pos.void_item', 'pos.void_printed_item']);
    const invoiceId = await seedOpenTableOrder();
    await pool.query("UPDATE restaurant_tables SET status='printed' WHERE id=1");
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('void');
  });

  it('rejects a printed-table void without pos.void_printed_item', async () => {
    const cookie = await grantWaiter(['tables.access', 'pos.void_item']);
    const invoiceId = await seedOpenTableOrder();
    await pool.query("UPDATE restaurant_tables SET status='printed' WHERE id=1");
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });
    expect(res.status).toBe(403);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
    expect(order.payment_method).toBe('unpaid_table');
  });

  it('rejects a printed-table void without pos.void_item', async () => {
    const cookie = await grantWaiter(['tables.access', 'pos.void_printed_item']);
    const invoiceId = await seedOpenTableOrder();
    await pool.query("UPDATE restaurant_tables SET status='printed' WHERE id=1");

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });

    expect(res.status).toBe(403);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
    expect(order.payment_method).toBe('unpaid_table');
  });

  it('allows programmer to void without explicit grants', async () => {
    await pool.query("UPDATE users SET role='programmer' WHERE id=?", [SEED.cashierUser.id]);
    invalidateUserSessions(SEED.cashierUser.id);
    const programmerCookie = (await request(app).post('/api/auth/login')
      .send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
    const invoiceId = await seedOpenTableOrder();

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', programmerCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });

    expect(res.status).toBe(200);
    await expectTableVoidedBy(invoiceId, SEED.cashierUser.id);
  });

  it('rejects a void when table no longer points to the locked order', async () => {
    const invoiceId = await seedOpenTableOrder();
    await pool.query("UPDATE restaurant_tables SET status='available', current_order_id=NULL WHERE id=1");

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });

    expect(res.status).toBe(409);
    const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(count.count)).toBe(0);
  });

  it('stores the fixed item-removal reason even when last row frees the table', async () => {
    const invoiceId = await seedOpenTableOrder();
    const [[item]] = await pool.query('SELECT id FROM order_items WHERE invoice_id=?', [invoiceId]);

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({
        invoice_id: invoiceId,
        expected_version: await currentTableRevision(invoiceId), intent: 'void',
        reason: 'client supplied reason',
        items: [{ order_item_id: item.id, qty: 2 }]
      });

    expect(res.status).toBe(200);
    const [[refund]] = await pool.query('SELECT reason, table_number FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(refund).toMatchObject({ reason: 'Item removed from table', table_number: '1' });
  });

  it('routes a table-item void to its kitchen printer with only the voided item and its order time', async () => {
    const [printerResult] = await pool.query(
      `INSERT INTO printers (name, role, type, windows_name, is_active)
       VALUES ('Hot Kitchen', 'kitchen', 'windows', 'Hot-Kitchen', 1)`
    );
    await pool.query(
      'INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)',
      [printerResult.insertId, SEED.category.id]
    );

    const invoiceId = await seedOpenTableOrder();
    const [[voidedItem]] = await pool.query(
      'SELECT id FROM order_items WHERE invoice_id = ?',
      [invoiceId]
    );
    await pool.query(
      "UPDATE order_items SET created_at = '2026-07-14 17:15:00' WHERE id = ?",
      [voidedItem.id]
    );
    await pool.query(
      `INSERT INTO order_items
         (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, created_at)
       VALUES (?, 2, 'Keep This Drink', 1, 2.000000, 0, 0, '2026-07-14 17:20:00')`,
      [invoiceId]
    );

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({
        invoice_id: invoiceId,
        expected_version: await currentTableRevision(invoiceId), intent: 'void',
        items: [{ order_item_id: voidedItem.id, qty: 1 }]
      });

    expect(res.status).toBe(200);
    const [jobs] = await pool.query(
      "SELECT payload FROM print_queue WHERE print_type = 'kitchen' ORDER BY id"
    );
    expect(jobs).toHaveLength(1);
    const payload = JSON.parse(jobs[0].payload);
    expect(payload.printer_name).toBe('Hot-Kitchen');
    expect(payload.data).toMatchObject({
      void_ticket: true,
      table_number: '1'
    });
    expect(new Date(payload.data.order_taken_at).toISOString()).toBe('2026-07-14T17:15:00.000Z');
    expect(payload.data.items).toHaveLength(1);
    expect(payload.data.items[0]).toMatchObject({
      name: 'Test Burger',
      qty: 1
    });
    expect(payload.data.items[0]._isOther).not.toBe(true);
    expect(payload.data.items.some(item => item.name === 'Keep This Drink')).toBe(false);
  });

  it('does not queue a kitchen void ticket for a paid-order refund', async () => {
    const [printerResult] = await pool.query(
      `INSERT INTO printers (name, role, type, windows_name, is_active)
       VALUES ('Hot Kitchen', 'kitchen', 'windows', 'Hot-Kitchen', 1)`
    );
    await pool.query(
      'INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)',
      [printerResult.insertId, SEED.category.id]
    );
    const { invoiceId } = await seedPaidOrder();

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });

    expect(res.status).toBe(200);
    const [[queued]] = await pool.query(
      "SELECT COUNT(*) AS count FROM print_queue WHERE print_type = 'kitchen'"
    );
    expect(Number(queued.count)).toBe(0);
  });

  it('keeps a non-routable bundle parent so its voided child reaches the child kitchen printer', async () => {
    const [printerResult] = await pool.query(
      `INSERT INTO printers (name, role, type, windows_name, is_active)
       VALUES ('Bundle Kitchen', 'kitchen', 'windows', 'Bundle-Kitchen', 1)`
    );
    await pool.query(
      'INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)',
      [printerResult.insertId, SEED.category.id]
    );
    await pool.query(
      `INSERT INTO products (id, name, price, tax_rate, category_id, is_active, is_bundle)
       VALUES (11, 'Custom Meal', 5, 16, NULL, 1, 1)`
    );
    const invoiceId = await seedOpenTableOrder();
    const [[parent]] = await pool.query(
      'SELECT id FROM order_items WHERE invoice_id = ?',
      [invoiceId]
    );
    await pool.query(
      "UPDATE order_items SET product_id = 11, item_name = 'Custom Meal' WHERE id = ?",
      [parent.id]
    );
    await pool.query(
      `INSERT INTO order_items
         (invoice_id, parent_item_id, product_id, item_name, quantity, price_at_sale,
          tax_rate, tax_amount, created_at)
       VALUES (?, ?, 1, 'Test Burger', 2, 0, 0, 0, '2026-07-14 17:15:00')`,
      [invoiceId, parent.id]
    );

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({
        invoice_id: invoiceId,
        expected_version: await currentTableRevision(invoiceId), intent: 'void',
        items: [{ order_item_id: parent.id, qty: 1 }]
      });

    expect(res.status).toBe(200);
    const [jobs] = await pool.query(
      "SELECT payload FROM print_queue WHERE print_type = 'kitchen' ORDER BY id"
    );
    expect(jobs).toHaveLength(1);
    const payload = JSON.parse(jobs[0].payload);
    expect(payload.printer_name).toBe('Bundle-Kitchen');
    expect(payload.data.items).toHaveLength(1);
    expect(payload.data.items[0]).toMatchObject({
      name: 'Test Burger',
      qty: 1,
      _bundleLabel: 'Custom Meal'
    });
  });

  it('partial product void excludes and reprices the automatic service charge', async () => {
    const { invoiceId, productItemId, snapshotId } = await seedOpenTableOrderWithCharge();

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: productItemId, qty: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.table_freed).toBe(false);
    const [refundItems] = await pool.query(
      'SELECT ri.* FROM refund_items ri JOIN refunds r ON r.id=ri.refund_id WHERE r.invoice_id=?',
      [invoiceId]
    );
    expect(refundItems).toHaveLength(1);
    expect(refundItems[0]).toMatchObject({ item_name: 'Test Burger' });
    expect(refundItems[0].note).not.toBe('Auto-Gratuity');
    const [[fee]] = await pool.query(
      "SELECT price_at_sale, jofotara_tax_category, discount_type, discount_value FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
      [invoiceId]
    );
    expect(fee).toMatchObject({ price_at_sale: '0.500000', jofotara_tax_category: 'S', discount_type: null, discount_value: '0.00' });
    const [[order]] = await pool.query('SELECT subtotal, tax, total FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order).toMatchObject({ subtotal: '5.50', tax: '0.88', total: '6.38' });
    const [[snapshot]] = await pool.query('SELECT state, version FROM service_charge_snapshots WHERE id=?', [snapshotId]);
    expect(snapshot).toMatchObject({ state: 'open_order', version: 3 });
  });

  it('voids an exempt inclusive table item without re-dividing the stored net price', async () => {
    const { invoiceId, productItemId, feeItemId } = await seedOpenTableOrderWithCharge({
      qty: 2,
      taxInclusiveAtSale: 1
    });
    await pool.query(
      `UPDATE orders
          SET subtotal=9.48, tax=0, total=9.48, tax_exempt_at_sale=1
        WHERE invoice_id=?`,
      [invoiceId]
    );
    await pool.query(
      `UPDATE order_items
          SET price_at_sale=4.310344, price_before_tax_exemption=5.000000, tax_amount=0
        WHERE id=?`,
      [productItemId]
    );
    await pool.query('UPDATE order_items SET price_at_sale=0.86, tax_amount=0 WHERE id=?', [feeItemId]);

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: productItemId, qty: 1 }] });

    expect(res.status).toBe(200);
    const [[order]] = await pool.query('SELECT tax_exempt_at_sale, subtotal, tax, total FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order).toMatchObject({ tax_exempt_at_sale: 1, subtotal: '4.74', tax: '0.00', total: '4.74' });
    const [[fee]] = await pool.query("SELECT price_at_sale, tax_amount FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [invoiceId]);
    expect(fee).toMatchObject({ price_at_sale: '0.430000', tax_amount: '0.000000' });
  });

  it('whole table clear records products only and abandons the automatic charge snapshot', async () => {
    const { invoiceId, snapshotId } = await seedOpenTableOrderWithCharge();

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });

    expect(res.status).toBe(200);
    expect(res.body.table_freed).toBe(true);
    const [refundItems] = await pool.query(
      'SELECT ri.* FROM refund_items ri JOIN refunds r ON r.id=ri.refund_id WHERE r.invoice_id=?',
      [invoiceId]
    );
    expect(refundItems).toHaveLength(1);
    expect(refundItems[0].item_name).toBe('Test Burger');
    const [[snapshot]] = await pool.query('SELECT state, holder_type, holder_id FROM service_charge_snapshots WHERE id=?', [snapshotId]);
    expect(snapshot).toMatchObject({ state: 'abandoned', holder_type: 'none', holder_id: null });
  });

  it('voiding the final product frees the table even when an automatic charge row exists', async () => {
    const { invoiceId, productItemId, snapshotId } = await seedOpenTableOrderWithCharge({ qty: 1 });

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: productItemId, qty: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.table_freed).toBe(true);
    const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=1');
    expect(table).toMatchObject({ status: 'available', current_order_id: null });
    const [[snapshot]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [snapshotId]);
    expect(snapshot.state).toBe('abandoned');
    const [[feeRefundCount]] = await pool.query(
      "SELECT COUNT(*) AS count FROM refund_items ri JOIN refunds r ON r.id=ri.refund_id WHERE r.invoice_id=? AND ri.note='Auto-Gratuity'",
      [invoiceId]
    );
    expect(Number(feeRefundCount.count)).toBe(0);
  });

  it('rejects selecting the automatic charge as a void item', async () => {
    const { invoiceId, feeItemId } = await seedOpenTableOrderWithCharge();

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: feeItemId, qty: 1 }] });

    expect(res.status).toBe(400);
    const [[refundCount]] = await pool.query('SELECT COUNT(*) AS count FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(refundCount.count)).toBe(0);
  });

  it.each([
    ['line percent discount', { lineDiscountType: 'percent', lineDiscountValue: 20 }, { subtotal: '4.40', tax: '0.70', total: '5.10' }],
    ['fixed order discount', { orderDiscountType: 'fixed', orderDiscountValue: 2 }, { subtotal: '5.50', tax: '0.56', total: '4.06' }],
    ['percent order discount', { orderDiscountType: 'percent', orderDiscountValue: 10 }, { subtotal: '5.50', tax: '0.79', total: '5.74' }],
    ['frozen inclusive tax', { taxInclusiveAtSale: 1 }, { subtotal: '5.50', tax: '0.00', total: '5.50' }]
  ])('reconciles remaining totals after partial void with %s', async (_label, setup, expected) => {
    await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='tax_inclusive_pricing'");
    const { invoiceId, productItemId } = await seedOpenTableOrderWithCharge(setup);

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: productItemId, qty: 1 }] });

    expect(res.status).toBe(200);
    const [[order]] = await pool.query('SELECT subtotal, tax, total FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order).toMatchObject(expected);
  });

  it('still lets a pos.refund-only user refund a PAID order (void gate must not leak)', async () => {
    const cookie = await grantWaiter(['pos.refund']); // refund grant only
    const { invoiceId } = await seedPaidOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('refund');
  });

  it('rejects a request with no intent (400)', async () => {
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId });
    expect(res.status).toBe(400);
    const [[c]] = await pool.query('SELECT COUNT(*) c FROM refunds');
    expect(c.c).toBe(0);
  });

  it('rejects intent=void on a paid order (409)', async () => {
    const { invoiceId } = await seedPaidOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });
    expect(res.status).toBe(409);
    const [[c]] = await pool.query('SELECT COUNT(*) c FROM refunds');
    expect(c.c).toBe(0);
  });

  it('rejects intent=refund on an unpaid open table (409)', async () => {
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(409);
    const [[c]] = await pool.query('SELECT COUNT(*) c FROM refunds');
    expect(c.c).toBe(0);
  });

  it('rejects an empty items array (400) — never a silent whole-order void', async () => {
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [] });
    expect(res.status).toBe(400);
    const [[c]] = await pool.query('SELECT COUNT(*) c FROM refunds');
    expect(c.c).toBe(0);
    // Order must be untouched (not voided).
    const [[o]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
    expect(o.payment_method).toBe('unpaid_table');
  });

  it('rejects a malformed items value instead of treating it as a whole-table void', async () => {
    const invoiceId = await seedOpenTableOrder();

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: { order_item_id: 1, qty: 1 } });

    expect(res.status).toBe(400);
    const [[refundCount]] = await pool.query('SELECT COUNT(*) AS count FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(refundCount.count)).toBe(0);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.payment_method).toBe('unpaid_table');
  });

  it('rejects duplicate order_item_id selections without changing the live table', async () => {
    const invoiceId = await seedOpenTableOrder();
    const [[item]] = await pool.query('SELECT id, quantity FROM order_items WHERE invoice_id=?', [invoiceId]);

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({
        invoice_id: invoiceId,
        expected_version: await currentTableRevision(invoiceId), intent: 'void',
        items: [
          { order_item_id: item.id, qty: 1 },
          { order_item_id: item.id, qty: 1 }
        ]
      });

    expect(res.status).toBe(400);
    const [[refundCount]] = await pool.query('SELECT COUNT(*) AS count FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(refundCount.count)).toBe(0);
    const [[liveItem]] = await pool.query('SELECT quantity FROM order_items WHERE id=?', [item.id]);
    expect(Number(liveItem.quantity)).toBe(Number(item.quantity));
  });

  // ── Paid-order / partial / guard / restock / hardening tests ──

  async function seedPaidOrder() {
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, amount_tendered)
       VALUES (1, 1, 10.00, 1.60, 11.60, 'cash', 11.60, 11.60)`
    );
    const invoiceId = r.insertId;
    const [it] = await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 2, 5.000000, 16.00, 1.600000)`,
      [invoiceId]
    );
    return { invoiceId, orderItemId: it.insertId };
  }

  it('refunds an exempt paid order from its stored net price and zero stored tax', async () => {
    const [r] = await pool.query(
      `INSERT INTO orders
         (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, amount_tendered,
          tax_inclusive_at_sale, tax_exempt_at_sale)
       VALUES (1, 1, 17.00, 0.00, 17.00, 'cash', 17.00, 17.00, 1, 1)`
    );
    const invoiceId = r.insertId;
    await pool.query(
      `INSERT INTO order_items
         (invoice_id, product_id, item_name, quantity, price_at_sale, price_before_tax_exemption, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 1, 17.000000, 20.000000, 16.00, 0.000000)`,
      [invoiceId]
    );

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });

    expect(res.status).toBe(200);
    expect(Number(res.body.amount_refunded)).toBe(17);
    const [[refund]] = await pool.query('SELECT subtotal_refunded, tax_refunded, amount_refunded FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(refund).toMatchObject({ subtotal_refunded: '17.00', tax_refunded: '0.00', amount_refunded: '17.00' });
    const [[refundItem]] = await pool.query('SELECT unit_price, line_subtotal, line_tax, line_total FROM refund_items WHERE refund_id=(SELECT id FROM refunds WHERE invoice_id=?)', [invoiceId]);
    expect(refundItem).toMatchObject({ unit_price: '17.000000', line_subtotal: '17.00', line_tax: '0.00', line_total: '17.00' });
  });

  // A paid CATALOG-product line stores item_name = NULL (the product row owns the name).
  async function seedPaidCatalogOrderNullName() {
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, amount_tendered)
       VALUES (1, 1, 10.00, 1.60, 11.60, 'cash', 11.60, 11.60)`
    );
    const invoiceId = r.insertId;
    const [it] = await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, NULL, 2, 5.000000, 16.00, 1.600000)`,
      [invoiceId]
    );
    return { invoiceId, orderItemId: it.insertId };
  }

  it('(P2-6) refunding a catalog product snapshots the product name, never NULL', async () => {
    const { invoiceId } = await seedPaidCatalogOrderNullName();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);

    const [[refund]] = await pool.query('SELECT id FROM refunds WHERE invoice_id=?', [invoiceId]);
    const [[ri]] = await pool.query('SELECT item_name FROM refund_items WHERE refund_id=?', [refund.id]);
    expect(ri.item_name).not.toBeNull();
    expect(ri.item_name).toBe('Test Burger'); // COALESCE(oi.item_name, p.name)

    // The snapshot is durable: renaming the product AFTER the refund never rewrites history.
    await pool.query("UPDATE products SET name='Renamed Burger' WHERE id=1");
    const [[after]] = await pool.query('SELECT item_name FROM refund_items WHERE refund_id=?', [refund.id]);
    expect(after.item_name).toBe('Test Burger');
  });

  it('rolls back a paid refund when the audit insert fails', async () => {
    const { invoiceId } = await seedPaidOrder();
    failNextConnectionQuery(
      (sql, params) => String(sql).includes('INSERT INTO audit_events') && Array.isArray(params) && params[0] === 'refund',
      'simulated refund audit failure'
    );

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });

    expect(res.status).toBe(500);
    expect(await waitForAuditCount('refund', invoiceId, 0)).toBe(0);

    const [[refundCount]] = await pool.query('SELECT COUNT(*) c FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(refundCount.c).toBe(0);
    const [[order]] = await pool.query('SELECT payment_method, refund_status FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.payment_method).toBe('cash');
    expect(order.refund_status).toBe('none');
  });

  it('(P2-2) sequential partial voids record the full subtotal (no under-count on 2nd void)', async () => {
    // One line qty5 @ 10.00 → subtotal 50.00, tax 0, on table 1.
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (1, 1, 1, 50.00, 0.00, 50.00, 'unpaid_table')`
    );
    const invoiceId = r.insertId;
    const [it] = await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 5, 10.000000, 0, 0)`,
      [invoiceId]
    );
    await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1", [invoiceId]);
    const orderItemId = it.insertId;

    const v1 = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: orderItemId, qty: 4 }] });
    expect(v1.status).toBe(200);
    const v2 = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: orderItemId, qty: 1 }] });
    expect(v2.status).toBe(200);

    const [rows] = await pool.query(
      'SELECT subtotal_refunded FROM refunds WHERE invoice_id=? ORDER BY id', [invoiceId]
    );
    expect(rows.map(row => Number(row.subtotal_refunded))).toEqual([40, 10]);
  });

  it('(P3-3) a clamped refund header keeps refund_items in sync (Sum lines == subtotal_refunded)', async () => {
    // Stored rollup residue: a single 10.00 line, but orders.subtotal was saved a cent
    // low (9.99). The over-refund cap clamps the header subtotal to 9.99, so the line
    // rows must be rescaled from 10.00 to 9.99 or header and lines diverge.
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, amount_tendered)
       VALUES (1, 1, 9.99, 0.00, 9.99, 'cash', 9.99, 9.99)`
    );
    const invoiceId = r.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 1, 10.000000, 0, 0)`,
      [invoiceId]
    );
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);

    const [[refund]] = await pool.query('SELECT subtotal_refunded FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(refund.subtotal_refunded)).toBeCloseTo(9.99, 2); // header clamped
    const [[agg]] = await pool.query(
      `SELECT COALESCE(SUM(ri.line_subtotal),0) s
       FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
       WHERE r.invoice_id = ?`, [invoiceId]
    );
    // Before the fix: header 9.99 vs Sum(lines) 10.00. After: exactly equal.
    expect(Number(agg.s)).toBeCloseTo(Number(refund.subtotal_refunded), 2);
  });

  it('(P3-3) a clamped multi-line refund never writes a negative refund_items row', async () => {
    // A heavy order-level fixed discount makes every line net sub-cent: subtotal 1.00,
    // fixed discount 0.98 → discountedSubtotal 0.02 (discountRatio 0.02). Four 0.25 lines
    // each round 0.005 → 0.01 (preClamp 0.04), and the over-refund cap clamps the header
    // to 0.02. The clamp rescale must not make the last line absorb a NEGATIVE remainder.
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, discount_type, discount_value, cash_amount, amount_tendered)
       VALUES (1, 1, 1.00, 0.00, 0.02, 'cash', 'fixed', 0.98, 0.02, 0.02)`
    );
    const invoiceId = r.insertId;
    for (let i = 0; i < 4; i++) {
      await pool.query(
        `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
         VALUES (?, 1, 'Test Burger', 1, 0.250000, 0, 0)`,
        [invoiceId]
      );
    }

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);

    const [[refund]] = await pool.query('SELECT id, subtotal_refunded FROM refunds WHERE invoice_id=?', [invoiceId]);
    const [rows] = await pool.query('SELECT line_subtotal, line_total FROM refund_items WHERE refund_id=?', [refund.id]);
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(Number(row.line_subtotal)).toBeGreaterThanOrEqual(0); // no negative subtotal row
      expect(Number(row.line_total)).toBeGreaterThanOrEqual(0);    // no negative total row
    }
    // Reconciliation still holds: Σ line_subtotal == the clamped header.
    const sum = rows.reduce((a, x) => a + Number(x.line_subtotal), 0);
    expect(sum).toBeCloseTo(Number(refund.subtotal_refunded), 2);
    expect(Number(refund.subtotal_refunded)).toBeCloseTo(0.02, 2);
  });

  it('(P3-3) an amount-clamped refund keeps refund_items totals in sync', async () => {
    // Stored rollup residue: the line says 10.00 + 1.60 tax, but the order total
    // is only 10.50. The hard total cap must not leave refund_items summing to
    // 11.60 while refunds.amount_refunded is clamped to 10.50.
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, amount_tendered)
       VALUES (1, 1, 10.00, 1.60, 10.50, 'cash', 10.50, 10.50)`
    );
    const invoiceId = r.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 2, 5.000000, 16.00, 1.600000)`,
      [invoiceId]
    );

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);

    const [[refund]] = await pool.query(
      'SELECT id, subtotal_refunded, tax_refunded, amount_refunded FROM refunds WHERE invoice_id=?',
      [invoiceId]
    );
    const [[agg]] = await pool.query(
      `SELECT COALESCE(SUM(line_subtotal),0) subtotal,
              COALESCE(SUM(line_tax),0) tax,
              COALESCE(SUM(line_total),0) total,
              MIN(line_subtotal) min_subtotal,
              MIN(line_tax) min_tax,
              MIN(line_total) min_total
       FROM refund_items WHERE refund_id=?`,
      [refund.id]
    );

    expect(Number(refund.amount_refunded)).toBeCloseTo(10.50, 2);
    expect(Number(refund.subtotal_refunded)).toBeCloseTo(10.00, 2);
    expect(Number(refund.tax_refunded)).toBeCloseTo(0.50, 2);
    expect(Number(agg.subtotal)).toBeCloseTo(Number(refund.subtotal_refunded), 2);
    expect(Number(agg.tax)).toBeCloseTo(Number(refund.tax_refunded), 2);
    expect(Number(agg.total)).toBeCloseTo(Number(refund.amount_refunded), 2);
    expect(Number(agg.min_subtotal)).toBeGreaterThanOrEqual(0);
    expect(Number(agg.min_tax)).toBeGreaterThanOrEqual(0);
    expect(Number(agg.min_total)).toBeGreaterThanOrEqual(0);
  });

  it('preserves the stored subtotal and tax components of an allocated split child refund', async () => {
    const [parent] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method)
       VALUES (1, 1, 0.14, 0.01, 0.14, 'voided')`
    );
    const [child] = await pool.query(
      `INSERT INTO orders
         (order_id, user_id, subtotal, tax, total, payment_method,
          discount_type, discount_value, parent_invoice_id)
       VALUES (2, 1, 0.05, 0.01, 0.05, 'cash', 'percent', 10, ?)`,
      [parent.insertId]
    );
    await pool.query(
      `INSERT INTO order_items
         (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Allocated bite', 1, 0.05, 16, 0.01)`,
      [child.insertId]
    );

    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: child.insertId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);

    const [[refund]] = await pool.query(
      'SELECT id, subtotal_refunded, tax_refunded, amount_refunded FROM refunds WHERE invoice_id=?',
      [child.insertId]
    );
    const [[line]] = await pool.query(
      'SELECT line_subtotal, line_tax, line_total FROM refund_items WHERE refund_id=?',
      [refund.id]
    );
    expect(refund.subtotal_refunded).toBe('0.04');
    expect(refund.tax_refunded).toBe('0.01');
    expect(refund.amount_refunded).toBe('0.05');
    expect(line.line_subtotal).toBe('0.04');
    expect(line.line_tax).toBe('0.01');
    expect(line.line_total).toBe('0.05');
  });

  it('fully refunds allocated 2.38 and 2.37 siblings without losing the parent cent', async () => {
    const [parent] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method)
       VALUES (1, 1, 4.09, 0.66, 4.75, 'voided')`
    );
    const children = [];
    for (const [subtotal, total] of [[2.05, 2.38], [2.04, 2.37]]) {
      const [child] = await pool.query(
        `INSERT INTO orders
           (order_id, user_id, subtotal, tax, total, payment_method, parent_invoice_id)
         VALUES (?, 1, ?, 0.33, ?, 'cash', ?)`,
        [children.length + 2, subtotal, total, parent.insertId]
      );
      await pool.query(
        `INSERT INTO order_items
           (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
         VALUES (?, 1, 'Allocated half', 0.5, 4.092, 16, 0.33)`,
        [child.insertId]
      );
      children.push(child.insertId);
    }

    for (const invoiceId of children) {
      const res = await request(app).post('/api/pos/refunds')
        .set('Cookie', adminCookie)
        .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
      expect(res.status).toBe(200);
    }

    const [refunds] = await pool.query(
      `SELECT id, invoice_id, subtotal_refunded, tax_refunded, amount_refunded
         FROM refunds WHERE invoice_id IN (?) ORDER BY invoice_id`,
      [children]
    );
    expect(refunds.map((refund) => refund.subtotal_refunded)).toEqual(['2.05', '2.04']);
    expect(refunds.map((refund) => refund.tax_refunded)).toEqual(['0.33', '0.33']);
    expect(refunds.map((refund) => refund.amount_refunded)).toEqual(['2.38', '2.37']);
    expect(refunds.reduce((sum, refund) => sum + Math.round(Number(refund.amount_refunded) * 100), 0)).toBe(475);
    for (const refund of refunds) {
      const [[lineSum]] = await pool.query(
        'SELECT ROUND(SUM(line_total) * 100) AS cents FROM refund_items WHERE refund_id=?',
        [refund.id]
      );
      expect(Number(lineSum.cents)).toBe(Math.round(Number(refund.amount_refunded) * 100));
    }
  });

  async function seedOpenTableBundleOrder() {
    await pool.query("INSERT INTO products (id, name, price, is_bundle, tax_rate, stock) VALUES (50, 'Combo', 10.000000, 1, 0, NULL) ON DUPLICATE KEY UPDATE is_bundle=1");
    await pool.query("INSERT INTO product_bundle_items (bundle_id, product_id, qty, sort_order) VALUES (50, 1, 1, 0)");
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (1, 1, 1, 20.00, 0.00, 20.00, 'unpaid_table')`
    );
    const invoiceId = r.insertId;
    const [pr] = await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order)
       VALUES (?, 50, 'Combo', 2, 10.000000, 0, 0, 0)`,
      [invoiceId]
    );
    const parentId = pr.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order, parent_item_id)
       VALUES (?, 1, 'Test Burger', 2, 0, 0, 0, 1, ?)`,
      [invoiceId, parentId]
    );
    await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1", [invoiceId]);
    return { invoiceId, parentId };
  }

  it('refunds a paid order in full, keeps the sale row, marks refund_status=full', async () => {
    const { invoiceId } = await seedPaidOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('refund');
    expect(Number(res.body.amount_refunded)).toBeCloseTo(11.60, 2);

    const [[order]] = await pool.query('SELECT payment_method, refund_status FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.payment_method).toBe('cash');      // sale row preserved
    expect(order.refund_status).toBe('full');
    const [[refund]] = await pool.query('SELECT * FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(refund.refund_method).toBe('cash');
  });

  it('repairs a stale full cache before allowing a refund with no canonical ledger rows', async () => {
    const { invoiceId } = await seedPaidOrder();
    await pool.query("UPDATE orders SET refund_status='full' WHERE invoice_id=?", [invoiceId]);
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);
    const [[order]] = await pool.query('SELECT refund_status FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.refund_status).toBe('full');
  });

  it('derives partial and full status from canonical refund rows when the cache is stale', async () => {
    const partial = await seedPaidOrder();
    await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: partial.invoiceId, intent: 'refund', items: [{ order_item_id: partial.orderItemId, qty: 1 }], refund_method: 'cash' });
    await pool.query("UPDATE orders SET refund_status='none' WHERE invoice_id=?", [partial.invoiceId]);
    await expect(syncOrderRefundStatus(pool, partial.invoiceId)).resolves.toBe('partial');

    const full = await seedPaidOrder();
    await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: full.invoiceId, intent: 'refund', refund_method: 'cash' });
    await pool.query("UPDATE orders SET refund_status='none' WHERE invoice_id=?", [full.invoiceId]);
    await expect(syncOrderRefundStatus(pool, full.invoiceId)).resolves.toBe('full');
  });

  it('refunds a single item (partial) with correct math + refund_status=partial', async () => {
    const { invoiceId, orderItemId } = await seedPaidOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', items: [{ order_item_id: orderItemId, qty: 1 }], refund_method: 'cash' });
    expect(res.status).toBe(200);
    expect(Number(res.body.amount_refunded)).toBeCloseTo(5.80, 2); // half of 11.60
    const [[order]] = await pool.query('SELECT refund_status FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.refund_status).toBe('partial');
  });

  it('blocks a second refund that exceeds remaining quantity', async () => {
    const { invoiceId, orderItemId } = await seedPaidOrder();
    await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', items: [{ order_item_id: orderItemId, qty: 2 }], refund_method: 'cash' });
    const res2 = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', items: [{ order_item_id: orderItemId, qty: 1 }], refund_method: 'cash' });
    expect(res2.status).toBe(400);
    const [[cnt]] = await pool.query('SELECT COUNT(*) c FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(cnt.c).toBe(1); // second attempt wrote nothing
  });

  it('ignores client-sent money and uses DB values', async () => {
    const { invoiceId } = await seedPaidOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash', amount_refunded: 9999, subtotal_refunded: 9999 });
    expect(res.status).toBe(200);
    expect(Number(res.body.amount_refunded)).toBeCloseTo(11.60, 2);
  });

  it('restocks returned items when stock tracking is enabled', async () => {
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    await pool.query('UPDATE products SET stock=10 WHERE id=1');
    const { invoiceId } = await seedPaidOrder();
    await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    const [[p]] = await pool.query('SELECT stock FROM products WHERE id=1');
    expect(Number(p.stock)).toBe(12); // 10 + 2 returned
  });

  it('restores an exact six-decimal stock quantity', async () => {
    await pool.query('UPDATE products SET stock=9.782609 WHERE id=?', [SEED.product1.id]);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await restoreStockForCart(conn, [{ product_id: SEED.product1.id, qty: 0.217391 }]);
      await conn.commit();
    } finally {
      conn.release();
    }

    const [[product]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);
    expect(Number(product.stock)).toBe(10);
  });

  it('keeps a committed paid refund successful when catalog invalidation fails', async () => {
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    const { invoiceId } = await seedPaidOrder();
    const cacheSpy = vi.spyOn(cache, 'invalidateCatalogCache').mockImplementationOnce(() => {
      throw new Error('cache unavailable');
    });
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const res = await request(app).post('/api/pos/refunds')
        .set('Cookie', adminCookie)
        .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });

      expect(res.statusCode).toBe(200);
      expect(res.body.stock_product_ids).toBeUndefined();
      expect(res.body.stock_item_ids).toBeUndefined();
      expect(cacheSpy).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(global.__mockEmit__).toHaveBeenCalledWith('inventory_changed', { scope: 'stock', productIds: expect.arrayContaining([SEED.product1.id]) }));
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId }),
        'Paid refund catalog cache invalidation failed after commit.'
      );
    } finally {
      cacheSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  // ── Hardening tests ──

  it('(hardening) void of order with joined child table frees both parent and child', async () => {
    const invoiceId = await seedOpenTableOrder(); // order on table 1
    // join child table 2 to parent table 1
    await pool.query(
      "UPDATE restaurant_tables SET parent_table_id=1, status='occupied', current_order_id=? WHERE id=2",
      [invoiceId]
    );
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });
    expect(res.status).toBe(200);
    const [[t1]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=1');
    const [[t2]] = await pool.query('SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id=2');
    expect(t1.status).toBe('available');
    expect(t1.current_order_id).toBeNull();
    expect(t2.status).toBe('available');
    expect(t2.current_order_id).toBeNull();
    expect(t2.parent_table_id).toBeNull();
  });

  it('(hardening) voiding an already-voided order returns 400 and writes no second refund', async () => {
    const invoiceId = await seedOpenTableOrder();
    await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });
    const res2 = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' });
    expect(res2.status).toBe(400);
    const [[cnt]] = await pool.query('SELECT COUNT(*) c FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(cnt.c).toBe(1);
  });

  // ── C1: UI→endpoint contract is order_item_id (NOT product_id) ──

  it('(C1 contract) item-level refund keyed by order_item_id succeeds and writes refund_items', async () => {
    const { invoiceId, orderItemId } = await seedPaidOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', items: [{ order_item_id: orderItemId, qty: 2 }], refund_method: 'cash' });
    expect(res.status).toBe(200);
    const [[refund]] = await pool.query('SELECT * FROM refunds WHERE invoice_id=?', [invoiceId]);
    const [items] = await pool.query('SELECT * FROM refund_items WHERE refund_id=?', [refund.id]);
    expect(items.length).toBe(1);
    expect(Number(items[0].order_item_id)).toBe(orderItemId); // resolved by order_item_id
    expect(Number(items[0].quantity)).toBe(2);
  });

  it('(C1 contract) a body keyed by product_id (legacy bug) is rejected, not silently mis-refunded', async () => {
    const { invoiceId } = await seedPaidOrder();
    // product_id=1 exists as a product but is NOT an order_items.id → must 400, never resolve.
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', items: [{ product_id: 1, qty: 1 }], refund_method: 'cash' });
    expect(res.status).toBe(400);
    const [[cnt]] = await pool.query('SELECT COUNT(*) c FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(cnt.c).toBe(0);
  });

  // ── C2: discount-aware money + over-refund cap ──

  // Paid order: 5.00 × 2 with a 50% LINE discount → net subtotal 5.00, tax 0.80, total 5.80.
  // (Mirrors checkout: calculateLineTotal applies line discount, tax stored net.)
  async function seedDiscountedPaidOrder() {
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, amount_tendered)
       VALUES (1, 1, 5.00, 0.80, 5.80, 'cash', 5.80, 5.80)`
    );
    const invoiceId = r.insertId;
    const [it] = await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, discount_type, discount_value)
       VALUES (?, 1, 'Test Burger', 2, 5.000000, 16.00, 0.800000, 'percent', 50)`,
      [invoiceId]
    );
    return { invoiceId, orderItemId: it.insertId };
  }

  it('(C2) whole-order refund of a discounted order returns NET (what was paid), not gross', async () => {
    const { invoiceId } = await seedDiscountedPaidOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);
    // Gross (old bug) would be 10.00 + 0.80 = 10.80. Net actually paid = 5.80.
    expect(Number(res.body.amount_refunded)).toBeCloseTo(5.80, 2);
    const [[refund]] = await pool.query('SELECT * FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(refund.subtotal_refunded)).toBeCloseTo(5.00, 2);
    expect(Number(refund.tax_refunded)).toBeCloseTo(0.80, 2);
    // Never exceeds the order total.
    const [[order]] = await pool.query('SELECT total FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(Number(refund.amount_refunded)).toBeLessThanOrEqual(Number(order.total) + 1e-9);
  });

  it('(C2) order-level 50% discount also refunds NET (proration via discountRatio)', async () => {
    // 5.00 × 2 = 10 subtotal, order-level 50% → discountedSubtotal 5.00, tax stored net 0.80, total 5.80.
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, discount_type, discount_value, cash_amount, amount_tendered)
       VALUES (1, 1, 10.00, 0.80, 5.80, 'cash', 'percent', 50, 5.80, 5.80)`
    );
    const invoiceId = r.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 2, 5.000000, 16.00, 0.800000)`,
      [invoiceId]
    );
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);
    expect(Number(res.body.amount_refunded)).toBeCloseTo(5.80, 2);
    const [[refund]] = await pool.query('SELECT subtotal_refunded FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(refund.subtotal_refunded)).toBeCloseTo(5.00, 2);
  });

  it('partial void reduces the live order, keeps the table occupied', async () => {
    const invoiceId = await seedOpenTableOrder(); // 2x product 1 on table 1
    const [[oi]] = await pool.query('SELECT id FROM order_items WHERE invoice_id=?', [invoiceId]);
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: oi.id, qty: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('item');
    expect(res.body.refund_status).toBe('partial');
    expect(res.body.table_freed).toBe(false);

    const [[line]] = await pool.query('SELECT quantity FROM order_items WHERE id=?', [oi.id]);
    expect(Number(line.quantity)).toBe(1);
    const [[order]] = await pool.query('SELECT payment_method, refund_status, total FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.payment_method).toBe('unpaid_table');
    expect(order.refund_status).toBe('partial');
    expect(Number(order.total)).toBeCloseTo(5.80, 2);
    const [[tbl]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=1');
    expect(tbl.status).toBe('occupied');
    expect(Number(tbl.current_order_id)).toBe(invoiceId);
    const [[ri]] = await pool.query('SELECT quantity FROM refund_items WHERE order_item_id=?', [oi.id]);
    expect(Number(ri.quantity)).toBe(1);
  });

  it('partial void restocks the voided quantity', async () => {
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    await pool.query('UPDATE products SET stock=10 WHERE id=1');
    const invoiceId = await seedOpenTableOrder();
    const [[oi]] = await pool.query('SELECT id FROM order_items WHERE invoice_id=?', [invoiceId]);
    await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: oi.id, qty: 1 }] });
    const [[p]] = await pool.query('SELECT stock FROM products WHERE id=1');
    expect(Number(p.stock)).toBe(11);
  });

  it('voiding the last item empties the order and frees the table', async () => {
    const invoiceId = await seedOpenTableOrder();
    const [[oi]] = await pool.query('SELECT id FROM order_items WHERE invoice_id=?', [invoiceId]);
    const res = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: oi.id, qty: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('order');
    expect(res.body.refund_status).toBe('full');
    expect(res.body.table_freed).toBe(true);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.payment_method).toBe('voided');
    const [[tbl]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=1');
    expect(tbl.status).toBe('available');
    expect(tbl.current_order_id).toBeNull();
  });

  it('repeated partial void respects current remaining (no double-count)', async () => {
    const invoiceId = await seedOpenTableOrder();
    const [[oi]] = await pool.query('SELECT id FROM order_items WHERE invoice_id=?', [invoiceId]);
    await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: oi.id, qty: 1 }] });
    const tooMany = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: oi.id, qty: 2 }] });
    expect(tooMany.status).toBe(400);
    const ok = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: oi.id, qty: 1 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.table_freed).toBe(true);
  });

  it('partial void of a bundle parent (2 -> 1) rescales child rows', async () => {
    const { invoiceId, parentId } = await seedOpenTableBundleOrder();
    const res = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: parentId, qty: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.refund_status).toBe('partial');
    const [[parent]] = await pool.query('SELECT quantity FROM order_items WHERE id=?', [parentId]);
    expect(Number(parent.quantity)).toBe(1);
    const [children] = await pool.query('SELECT product_id, quantity FROM order_items WHERE parent_item_id=?', [parentId]);
    expect(children.length).toBe(1);
    expect(Number(children[0].quantity)).toBe(1);
  });

  it('partial void preserves saved bundle children after the catalog definition changes', async () => {
    const { invoiceId, parentId } = await seedOpenTableBundleOrder();
    const [[child]] = await pool.query(
      'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id = ? LIMIT 1',
      [invoiceId, parentId]
    );
    await pool.query("UPDATE order_items SET item_name='Historic Burger', note='No onions', quantity=4 WHERE id=?", [child.id]);
    await pool.query('DELETE FROM product_bundle_items WHERE bundle_id = ?', [50]);
    await pool.query(
      'INSERT INTO product_bundle_items (bundle_id, product_id, qty, sort_order) VALUES (50, ?, 1, 0)',
      [SEED.product2.id]
    );

    const res = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: parentId, qty: 1 }] });

    expect(res.statusCode).toBe(200);
    const [children] = await pool.query(
      'SELECT product_id, item_name, note, quantity FROM order_items WHERE parent_item_id = ? ORDER BY product_id',
      [parentId]
    );
    expect(children.map(child => ({ ...child, quantity: Number(child.quantity) }))).toEqual([
      expect.objectContaining({ product_id: SEED.product1.id, item_name: 'Historic Burger', note: 'No onions', quantity: 2 })
    ]);
    expect(children.some(item => Number(item.product_id) === SEED.product2.id)).toBe(false);
  });

  it('full void of a legacy numbered bundle keeps its order record', async () => {
    const { invoiceId, parentId } = await seedOpenTableBundleOrder();
    const res = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: parentId, qty: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.table_freed).toBe(true);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id=?', [invoiceId]);
    expect(order.payment_method).toBe('voided');
  });

  it('voiding an unpaid table does not assign or burn a public invoice number', async () => {
    const invoiceId = await seedOpenTableOrder();
    const [[before]] = await pool.query(
      "SELECT current_value FROM invoice_sequences WHERE sequence_name='global_invoice'"
    );
    const beforeValue = Number(before.current_value);

    const res = await request(app)
      .post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', reason: 'customer left' });

    expect(res.body.success).toBe(true);

    const [[order]] = await pool.query(
      'SELECT payment_method, invoice_number FROM orders WHERE invoice_id = ?',
      [invoiceId]
    );
    const [[after]] = await pool.query(
      "SELECT current_value FROM invoice_sequences WHERE sequence_name='global_invoice'"
    );
    expect(order.payment_method).toBe('voided');
    expect(order.invoice_number).toBeNull();
    expect(Number(after.current_value)).toBe(beforeValue);
  });

  it('forces a platform refund method even when the browser submits cash', async () => {
    const { invoiceId } = await seedPaidOrder();
    await pool.query("UPDATE orders SET payment_method='platform', cash_amount=0, card_amount=0, amount_tendered=0, change_due=0 WHERE invoice_id=?", [invoiceId]);

    const response = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });

    expect(response.statusCode).toBe(200);
    const [[refund]] = await pool.query('SELECT refund_method FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(refund.refund_method).toBe('platform');
  });

  it.each([
    ['missing', undefined],
    ['unsupported', 'crypto'],
    ['platform on a non-platform order', 'platform'],
  ])('rejects a %s refund method before changing financial records', async (_label, refundMethod) => {
    const { invoiceId } = await seedPaidOrder();
    const body = { invoice_id: invoiceId, intent: 'refund' };
    if (refundMethod !== undefined) body.refund_method = refundMethod;

    const response = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send(body);

    expect(response.statusCode).toBe(400);
    const [[row]] = await pool.query('SELECT COUNT(*) AS count FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(row.count)).toBe(0);
  });
});
