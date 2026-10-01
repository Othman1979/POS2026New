const request = require('supertest');
const mysql = require('mysql2');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim();

async function captureCheckoutCommands(operation, { beforeQuery = null } = {}) {
  const originalGetConnection = pool.getConnection;
  const leases = [];
  const restoreLease = (lease) => {
    if (lease.restored) return;
    lease.restored = true;
    Object.assign(lease.connection, lease.original);
  };

  pool.getConnection = async function capturedGetConnection(...args) {
    const connection = await originalGetConnection.apply(this, args);
    const lease = {
      connection,
      commands: [],
      restored: false,
      original: {
        query: connection.query,
        beginTransaction: connection.beginTransaction,
        commit: connection.commit,
        rollback: connection.rollback,
        release: connection.release
      }
    };
    leases.push(lease);
    connection.query = async function capturedQuery(sql, ...queryArgs) {
      const command = { type: 'query', sql: normalizeSql(sql), params: queryArgs };
      lease.commands.push(command);
      if (beforeQuery) await beforeQuery({ command, lease });
      return lease.original.query.call(this, sql, ...queryArgs);
    };
    for (const method of ['beginTransaction', 'commit', 'rollback']) {
      connection[method] = async function capturedTransactionCommand(...commandArgs) {
        lease.commands.push({ type: method });
        return lease.original[method].apply(this, commandArgs);
      };
    }
    connection.release = function capturedRelease(...releaseArgs) {
      restoreLease(lease);
      return lease.original.release.apply(this, releaseArgs);
    };
    return connection;
  };

  try {
    return { value: await operation(), leases };
  } finally {
    for (const lease of leases) restoreLease(lease);
    pool.getConnection = originalGetConnection;
  }
}

describe('checkout command baseline', () => {
  let cashierCookie;
  let shiftId;

  beforeEach(async () => {
    await seedDatabase();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ user_number: SEED.cashierUser.user_number });
    cashierCookie = login.headers['set-cookie'][0];
    const opened = await request(app)
      .post('/api/auth/shifts?action=open')
      .set('Cookie', cashierCookie)
      .send({ user_id: SEED.cashierUser.id, starting_cash: 0 });
    expect(opened.statusCode).toBe(200);
    const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.cashierUser.id]);
    shiftId = Number(shift.id);
  });

  afterAll(async () => {
    await pool.end();
  });

  const ordinaryCart = (count, extra = {}) => Array.from({ length: count }, () => ({
    id: SEED.product1.id,
    qty: 1,
    price: 5,
    ...extra
  }));

  const cashCheckout = (cart, idempotencyKey) => {
    const subtotal = Number((cart.length * 5).toFixed(2));
    const tax = Number((subtotal * 0.16).toFixed(2));
    const total = Number((subtotal + tax).toFixed(2));
    return {
      cart,
      shift_id: shiftId,
      subtotal,
      tax,
      total,
      payment_method: 'cash',
      amount_tendered: Math.ceil(total),
      change_due: Number((Math.ceil(total) - total).toFixed(2)),
      idempotency_key: idempotencyKey
    };
  };

  const mainLeaseFor = (captured) => captured.leases.find(lease =>
    lease.commands.some(command => command.type === 'beginTransaction')
  );

  const fiscalLeaseFor = (captured, mainLease) => captured.leases.find(lease => lease !== mainLease);

  const parentInsertCommands = (lease) => lease.commands.filter(command =>
    command.type === 'query' && command.sql.includes('INSERT INTO order_items')
  );

  // Working balances add three bounded warm-path statements; dirty scopes
  // from invoice and recipe writes are coalesced into one commit-time write.
  // Automatic kitchen admission adds at most two batched routing reads,
  // independent of cart size, and no second pool lease.
  it.each([
    { count: 1, recipe: false, budget: 25 }, { count: 10, recipe: false, budget: 25 },
    { count: 1, recipe: true, budget: 33 }, { count: 10, recipe: true, budget: 33 }
  ])('records $count recipe-enabled lines (recipe=$recipe) within $budget commands', async ({ count, recipe, budget }) => {
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
    if (recipe) {
      const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Budget ingredient','weight','g',0.0045)");
      await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,200)', [SEED.product1.id, ingredient.insertId]);
      await require('../../services/RecipeLedgerService').backfillWorkingBalances(pool);
    }
    const captured = await captureCheckoutCommands(() => request(app)
      .post('/api/pos/checkout').set('Cookie', cashierCookie)
      .send(cashCheckout(ordinaryCart(count), `recipe-budget-${count}-${recipe}`)));
    expect(captured.value.statusCode, JSON.stringify(captured.value.body)).toBe(200);
    expect(captured.leases.flatMap(lease => lease.commands).length).toBeLessThanOrEqual(budget);
    expect(captured.leases.flatMap(lease => lease.commands).filter(command =>
      command.type === 'query' && command.sql.includes('INSERT INTO stock_report_dirty')
    )).toHaveLength(1);
    const [[saved]] = await pool.query('SELECT COUNT(*) n FROM recipe_ledger_lines');
    expect(Number(saved.n)).toBe(count);
    const [[usage]] = await pool.query("SELECT COUNT(*) n,COALESCE(SUM(qty),0) qty FROM stock_movements WHERE movement_type='ingredient' AND kind='usage'");
    expect(Number(usage.n)).toBe(recipe ? count : 0);
    expect(Number(usage.qty)).toBe(recipe ? -200 * count : 0);
  });

  it('captures the current checkout command graph without leaking wrappers into the pool', async () => {
    const captured = await captureCheckoutCommands(() => request(app)
      .post('/api/pos/checkout')
      .set('Cookie', cashierCookie)
      .send({
        cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
        shift_id: shiftId,
        subtotal: 5,
        tax: 0.8,
        total: 5.8,
        payment_method: 'cash',
        amount_tendered: 10,
        change_due: 4.2,
        idempotency_key: 'checkout-performance-baseline'
      }));

    expect(captured.value.statusCode).toBe(200);
    const [[order]] = await pool.query(
      'SELECT invoice_id, total FROM orders WHERE idempotency_key=?',
      ['checkout-performance-baseline']
    );
    const [items] = await pool.query('SELECT id FROM order_items WHERE invoice_id=?', [order.invoice_id]);
    expect(Number(order.total)).toBe(5.8);
    expect(items).toHaveLength(1);

    const mainLease = mainLeaseFor(captured);
    expect(mainLease).toBeDefined();
    const mainSql = mainLease.commands.filter(command => command.type === 'query').map(command => command.sql);
    expect(mainSql.filter(sql => sql === 'SELECT LAST_INSERT_ID() AS order_id')).toHaveLength(0);
    expect(mainSql.filter(sql => sql === 'SELECT LAST_INSERT_ID() AS invoice_number')).toHaveLength(0);
    expect(mainSql.filter(sql => sql.includes('INSERT INTO stock_report_dirty'))).toHaveLength(1);
    // Includes the early user FK lock that prevents hold/counter lock inversion.
    expect(mainSql).toHaveLength(16);
    expect(mainSql.filter(sql => sql === 'SELECT id FROM users WHERE id=? LOCK IN SHARE MODE')).toHaveLength(1);
    expect(mainSql.filter(sql => sql.includes('FROM products p'))).toHaveLength(1);
    expect(mainSql.filter(sql => sql.includes('SELECT id, parent_id FROM categories'))).toHaveLength(1);
    expect(mainSql.filter(sql => sql.includes('FROM printers p JOIN printer_categories'))).toHaveLength(1);
    expect(mainSql.some(sql => sql.includes('FROM subscription_plans WHERE sale_product_id IN'))).toBe(false);
    expect(mainSql.some(sql => sql.includes('SELECT id, is_bundle FROM products WHERE id IN'))).toBe(false);
    expect(mainLease.commands.filter(command => command.type === 'beginTransaction')).toHaveLength(1);
    expect(mainLease.commands.filter(command => command.type === 'commit')).toHaveLength(1);

    const fiscalLease = fiscalLeaseFor(captured, mainLease);
    expect(fiscalLease).toBeDefined();
    expect(fiscalLease.commands.filter(command => command.type === 'query')).toHaveLength(1);
    expect(fiscalLease.commands.some(command => command.type === 'beginTransaction')).toBe(false);
    expect(fiscalLease.commands[0].sql).toContain('FROM orders o');
    expect(captured.leases.flatMap(lease => lease.commands)).toHaveLength(19);
  });

  it('persists ten independent parent lines through one batch without changing totals', async () => {
    const captured = await captureCheckoutCommands(() => request(app)
      .post('/api/pos/checkout')
      .set('Cookie', cashierCookie)
      .send(cashCheckout(ordinaryCart(10), 'checkout-performance-ten-lines')));

    expect(captured.value.statusCode).toBe(200);
    const mainLease = mainLeaseFor(captured);
    expect(parentInsertCommands(mainLease)).toHaveLength(1);
    expect(mainLease.commands.filter(command => command.type === 'query')).toHaveLength(16);
    expect(fiscalLeaseFor(captured, mainLease).commands.filter(command => command.type === 'query')).toHaveLength(1);
    expect(captured.leases.flatMap(lease => lease.commands)).toHaveLength(19);
    const [[order]] = await pool.query('SELECT invoice_id, subtotal, tax, total FROM orders WHERE idempotency_key=?', [
      'checkout-performance-ten-lines'
    ]);
    const [items] = await pool.query('SELECT sort_order FROM order_items WHERE invoice_id=? ORDER BY sort_order', [order.invoice_id]);
    expect(Number(order.subtotal)).toBe(50);
    expect(Number(order.tax)).toBe(8);
    expect(Number(order.total)).toBe(58);
    expect(items.map(item => Number(item.sort_order))).toEqual([...Array(10).keys()]);
  });

  it('reads audit bypass policy once for a ten-line discounted checkout', async () => {
    const cart = ordinaryCart(10, { discountType: 'percent', discountValue: 10 });
    const captured = await captureCheckoutCommands(() => request(app)
      .post('/api/pos/checkout')
      .set('Cookie', cashierCookie)
      .send({
        cart,
        shift_id: shiftId,
        subtotal: 45,
        tax: 7.2,
        total: 52.2,
        payment_method: 'cash',
        amount_tendered: 60,
        change_due: 7.8,
        manager_pin: SEED.adminUser.pin,
        idempotency_key: 'checkout-performance-discount-audit'
      }));

    expect(captured.value.statusCode, JSON.stringify(captured.value.body)).toBe(200);
    const mainLease = mainLeaseFor(captured);
    const mainSql = mainLease.commands.filter(command => command.type === 'query').map(command => command.sql);
    expect(mainSql.filter(sql => sql.includes('SELECT COALESCE(MAX(xyz), 0) AS disabled'))).toHaveLength(1);
    expect(mainSql.filter(sql => sql.includes('INSERT INTO audit_events'))).toHaveLength(1);
    const [[events]] = await pool.query(`SELECT COUNT(*) AS count FROM audit_events
      WHERE entity_type='order' AND entity_id=? AND event_type='line_discount_changed'`, [captured.value.body.invoice_id]);
    expect(Number(events.count)).toBe(10);
    const [savedEvents] = await pool.query(`SELECT user_id, manager_id, new_value FROM audit_events
      WHERE entity_type='order' AND entity_id=? AND event_type='line_discount_changed' ORDER BY id`, [captured.value.body.invoice_id]);
    expect(savedEvents.map(event => JSON.parse(event.new_value).line.line_index)).toEqual([...Array(10).keys()]);
    for (const event of savedEvents) {
      expect(Number(event.user_id)).toBe(SEED.cashierUser.id);
      expect(JSON.parse(event.new_value).discount).toEqual({ type: 'percent', value: 10, amount: 0.5 });
    }
  });

  it('admits a routed kitchen ticket with bounded transaction work', async () => {
    const [printer] = await pool.query(
      "INSERT INTO printers (name, role, type, windows_name, spooler_id, is_active) VALUES ('Budget Kitchen', 'kitchen', 'windows', 'Budget-Kitchen', 'primary', 1)"
    );
    await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)', [printer.insertId, SEED.category.id]);
    const captured = await captureCheckoutCommands(() => request(app)
      .post('/api/pos/checkout').set('Cookie', cashierCookie)
      .send(cashCheckout(ordinaryCart(10), 'checkout-performance-kitchen')));

    expect(captured.value.statusCode, JSON.stringify(captured.value.body)).toBe(200);
    expect(captured.value.body.kitchen_ticket_count).toBe(1);
    const mainLease = mainLeaseFor(captured);
    const mainSql = mainLease.commands.filter(command => command.type === 'query').map(command => command.sql);
    expect(mainSql).toHaveLength(19);
    expect(mainSql.filter(sql => sql.includes('INSERT INTO print_queue'))).toHaveLength(1);
    expect(mainSql.filter(sql => sql.includes('print_templates t'))).toHaveLength(1);
    expect(captured.leases.flatMap(lease => lease.commands)).toHaveLength(22);
  });

  it('rolls back every checkout mutation when the multi-row parent insert fails', async () => {
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    await pool.query('UPDATE products SET stock=20 WHERE id=?', [SEED.product1.id]);
    const [[before]] = await pool.query(`SELECT
      (SELECT COUNT(*) FROM orders) AS orders_count,
      (SELECT COUNT(*) FROM order_items) AS items_count,
      (SELECT COUNT(*) FROM audit_events) AS audits_count,
      (SELECT stock FROM products WHERE id=?) AS stock`, [SEED.product1.id]);
    let injected = false;

    const captured = await captureCheckoutCommands(() => request(app)
      .post('/api/pos/checkout')
      .set('Cookie', cashierCookie)
      .send(cashCheckout(ordinaryCart(10), 'checkout-performance-batch-failure')), {
      beforeQuery: ({ command }) => {
        const rows = command.params?.[0]?.[0];
        if (!injected && command.sql.includes('INSERT INTO order_items') && Array.isArray(rows) && rows.length === 10) {
          injected = true;
          throw new Error('Forced multi-row order item insert failure');
        }
      }
    });

    expect(injected).toBe(true);
    expect(captured.value.statusCode).toBe(500);
    const mainLease = mainLeaseFor(captured);
    expect(mainLease.commands.filter(command => command.type === 'rollback')).toHaveLength(1);
    expect(mainLease.commands.filter(command => command.type === 'commit')).toHaveLength(0);
    const [[after]] = await pool.query(`SELECT
      (SELECT COUNT(*) FROM orders) AS orders_count,
      (SELECT COUNT(*) FROM order_items) AS items_count,
      (SELECT COUNT(*) FROM audit_events) AS audits_count,
      (SELECT stock FROM products WHERE id=?) AS stock`, [SEED.product1.id]);
    expect(after).toEqual(before);
    const [[failedOrder]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE idempotency_key=?', [
      'checkout-performance-batch-failure'
    ]);
    expect(Number(failedOrder.count)).toBe(0);
  });

  it('keeps the stock lock separate from the checkout catalog context', async () => {
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    await pool.query('UPDATE products SET stock=20 WHERE id=?', [SEED.product1.id]);
    const captured = await captureCheckoutCommands(() => request(app)
      .post('/api/pos/checkout')
      .set('Cookie', cashierCookie)
      .send(cashCheckout(ordinaryCart(1), 'checkout-performance-stock')));

    expect(captured.value.statusCode).toBe(200);
    const mainLease = mainLeaseFor(captured);
    const mainSql = mainLease.commands.filter(command => command.type === 'query').map(command => command.sql);
    const stockLock = mainSql.find(sql => sql.includes('FOR UPDATE') && /FROM products\b/.test(sql));
    // One bounded identity lookup routes tracked products to their authority.
    // The isolated 3x1000 service comparison records its incremental cost.
    expect(mainSql.filter(sql => sql.includes('FROM product_stock_links WHERE') && sql.includes('FOR UPDATE'))).toHaveLength(1);
    expect(mainSql.filter(sql => sql.includes('INSERT INTO stock_report_dirty'))).toHaveLength(1);
    expect(mainSql).toHaveLength(19);
    expect(stockLock).toBeDefined();
    expect(stockLock).not.toMatch(/product_price_overrides|subscription_plans|price_list_root|categories/i);
    expect(fiscalLeaseFor(captured, mainLease).commands.filter(command => command.type === 'query')).toHaveLength(1);
    expect(captured.leases.flatMap(lease => lease.commands)).toHaveLength(22);
  });

  it('persists a six-decimal stock deduction for an amount-derived quantity', async () => {
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    await pool.query("UPDATE products SET price=23, tax_rate=0, jofotara_tax_category='O', stock=10 WHERE id=?", [SEED.product1.id]);

    const response = await request(app)
      .post('/api/pos/checkout')
      .set('Cookie', cashierCookie)
      .send({
        cart: [{ id: SEED.product1.id, qty: 0.217391, price: 23 }],
        shift_id: shiftId,
        subtotal: 5,
        tax: 0,
        total: 5,
        payment_method: 'cash',
        amount_tendered: 5,
        change_due: 0,
        idempotency_key: 'checkout-fractional-stock'
      });

    expect(response.statusCode).toBe(200);
    const [[product]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);
    expect(Number(product.stock)).toBe(9.782609);
  });

  it('checks out a photographed scale label as one normal fractional product line', async () => {
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    await pool.query("UPDATE products SET barcode='100000', price=11, tax_rate=0, jofotara_tax_category='O', stock=10 WHERE id=?", [SEED.product1.id]);

    const lookup = await request(app)
      .get('/api/pos/product_lookup?barcode=0100000040591&sales_context=register')
      .set('Cookie', cashierCookie);
    expect(lookup.body).toMatchObject({
      success: true,
      scale_total_cents: 4059,
      product: { id: SEED.product1.id, barcode: '100000', price: 11 }
    });

    const quantity = Number(((lookup.body.scale_total_cents / 100) / lookup.body.product.price).toFixed(6));
    const response = await request(app)
      .post('/api/pos/checkout')
      .set('Cookie', cashierCookie)
      .send({
        cart: [{ id: lookup.body.product.id, qty: quantity, price: lookup.body.product.price }],
        shift_id: shiftId,
        subtotal: 40.59,
        tax: 0,
        total: 40.59,
        payment_method: 'cash',
        amount_tendered: 40.59,
        change_due: 0,
        idempotency_key: 'checkout-scale-barcode'
      });

    expect(response.statusCode).toBe(200);
    const [[order]] = await pool.query(
      'SELECT invoice_id, subtotal, tax, total FROM orders WHERE idempotency_key=?',
      ['checkout-scale-barcode']
    );
    const [[item]] = await pool.query(
      'SELECT quantity, price_at_sale FROM order_items WHERE invoice_id=?',
      [order.invoice_id]
    );
    const [[product]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);

    expect(Number(order.subtotal)).toBe(40.59);
    expect(Number(order.tax)).toBe(0);
    expect(Number(order.total)).toBe(40.59);
    expect(Number(item.quantity)).toBe(3.69);
    expect(Number(item.price_at_sale)).toBe(11);
    expect(Number(product.stock)).toBe(6.31);
  });

  it('splits 51 independent parent lines at the fixed 50-row boundary', async () => {
    const captured = await captureCheckoutCommands(() => request(app)
      .post('/api/pos/checkout')
      .set('Cookie', cashierCookie)
      .send(cashCheckout(ordinaryCart(51), 'checkout-performance-fifty-one-lines')));

    expect(captured.value.statusCode).toBe(200);
    const mainLease = mainLeaseFor(captured);
    expect(parentInsertCommands(mainLease)).toHaveLength(2);
    const [[order]] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?', [
      'checkout-performance-fifty-one-lines'
    ]);
    const [items] = await pool.query('SELECT sort_order FROM order_items WHERE invoice_id=? ORDER BY sort_order', [order.invoice_id]);
    expect(items.map(item => Number(item.sort_order))).toEqual([...Array(51).keys()]);
  });

  it('keeps escaped-note and modifier batches below one MiB while crossing the byte boundary', async () => {
    const escaped = '\\\"\\\\'.repeat(2_000);
    const group = `Group-${escaped.slice(0, 120)}`;
    const option = `Option-${escaped.slice(0, 120)}`;
    await pool.query('UPDATE products SET modifiers=? WHERE id=?', [
      JSON.stringify([{ name: group, options: [{ name: option, price: 0 }] }]),
      SEED.product1.id
    ]);
    const selectedModifiers = Array.from({ length: 50 }, () => ({ group, option, price: 0 }));
    const captured = await captureCheckoutCommands(() => request(app)
      .post('/api/pos/checkout')
      .set('Cookie', cashierCookie)
      .send(cashCheckout(ordinaryCart(12, { note: escaped, selectedModifiers }), 'checkout-performance-byte-boundary')));

    expect(captured.value.statusCode).toBe(200);
    const parentCommands = parentInsertCommands(mainLeaseFor(captured));
    expect(parentCommands).toHaveLength(3);
    const [[packet]] = await pool.query('SELECT @@max_allowed_packet AS max_allowed_packet');
    expect(Number(packet.max_allowed_packet)).toBeGreaterThanOrEqual(1_048_576);
    for (const command of parentCommands) {
      expect(Buffer.byteLength(mysql.format(command.sql, command.params[0]), 'utf8')).toBeLessThan(1_048_576);
    }
  });
});
