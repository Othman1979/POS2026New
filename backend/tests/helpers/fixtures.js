const { SEED } = require('../fixtures/seed');

async function seedReceiptPrinter(pool, overrides = {}) {
    const config = {
        name: 'Receipt Printer',
        role: 'receipt',
        type: 'windows',
        windows_name: 'Receipt-Printer',
        is_active: 1,
        ...overrides,
    };
    const [res] = await pool.query(`
        INSERT INTO printers (name, role, type, windows_name, is_active, assigned_ips)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [
        config.name,
        config.role,
        config.type,
        config.windows_name,
        config.is_active,
        config.assigned_ips || null,
    ]);
    return res.insertId;
}

async function insertShift(pool, overrides = {}) {
    const shift = {
        user_id: SEED.cashierUser.id,
        starting_cash: 20.00,
        expected_cash: 20.00,
        actual_cash: null,
        status: 'open',
        opened_at: '2026-07-01 07:00:00',
        closed_at: null,
        ...overrides,
    };
    const [res] = await pool.query(`
        INSERT INTO shifts (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
        shift.user_id,
        shift.starting_cash,
        shift.expected_cash,
        shift.actual_cash,
        shift.status,
        shift.opened_at,
        shift.closed_at,
    ]);
    return res.insertId;
}

async function insertPaidOrder(pool, overrides = {}) {
    const order = {
        order_id: null,
        user_id: SEED.cashierUser.id,
        shift_id: null,
        order_type_id: SEED.orderType.id,
        subtotal: 10.00,
        tax: 1.60,
        total: 11.60,
        payment_method: 'cash',
        cash_amount: 11.60,
        card_amount: 0.00,
        discount_type: null,
        discount_value: 0.00,
        created_at: '2026-07-01 08:00:00',
        invoice_issued_at: '2026-07-01 08:00:00',
        original_total: null,
        original_subtotal: null,
        original_tax: null,
        ...overrides,
    };
    const [res] = await pool.query(`
        INSERT INTO orders (
            order_id, user_id, shift_id, order_type_id, subtotal, tax, total,
            payment_method, cash_amount, card_amount, discount_type, discount_value,
            created_at, invoice_issued_at, original_total, original_subtotal, original_tax
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        order.order_id,
        order.user_id,
        order.shift_id,
        order.order_type_id,
        order.subtotal,
        order.tax,
        order.total,
        order.payment_method,
        order.cash_amount,
        order.card_amount,
        order.discount_type,
        order.discount_value,
        order.created_at,
        order.invoice_issued_at,
        order.original_total,
        order.original_subtotal,
        order.original_tax,
    ]);
    return res.insertId;
}

async function insertOrderItem(pool, overrides = {}) {
    const item = {
        invoice_id: null,
        product_id: SEED.product1.id,
        quantity: 2.000,
        price_at_sale: 5.000000,
        tax_rate: 16.00,
        tax_amount: 1.600000,
        discount_type: null,
        discount_value: 0.00,
        ...overrides,
    };
    if (!item.invoice_id) throw new Error('insertOrderItem requires invoice_id');
    const [res] = await pool.query(`
        INSERT INTO order_items (
            invoice_id, product_id, quantity, price_at_sale, tax_rate, tax_amount,
            discount_type, discount_value
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        item.invoice_id,
        item.product_id,
        item.quantity,
        item.price_at_sale,
        item.tax_rate,
        item.tax_amount,
        item.discount_type,
        item.discount_value,
    ]);
    return res.insertId;
}

async function insertOrderRefund(pool, overrides = {}) {
    const refund = {
        kind: 'refund',
        invoice_id: null,
        scope: 'order',
        subtotal_refunded: 0.00,
        tax_refunded: 0.00,
        amount_refunded: 0.00,
        refund_method: 'cash',
        user_id: SEED.adminUser.id,
        shift_id: null,
        created_at: '2026-07-01 09:00:00',
        ...overrides,
    };
    if (!refund.invoice_id) throw new Error('insertOrderRefund requires invoice_id');
    const [res] = await pool.query(`
        INSERT INTO refunds (
            kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded,
            refund_method, user_id, shift_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        refund.kind,
        refund.invoice_id,
        refund.scope,
        refund.subtotal_refunded,
        refund.tax_refunded,
        refund.amount_refunded,
        refund.refund_method,
        refund.user_id,
        refund.shift_id,
        refund.created_at,
    ]);
    return res.insertId;
}

async function insertVoidedOrder(pool, overrides = {}) {
    return insertPaidOrder(pool, {
        payment_method: 'voided',
        cash_amount: 0,
        card_amount: 0,
        original_total: overrides.original_total || overrides.total || 11.60,
        original_subtotal: overrides.original_subtotal || overrides.subtotal || 10.00,
        ...overrides,
    });
}

async function latestPrintPayload(pool) {
    const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
    if (!job) throw new Error('No print job found.');
    return JSON.parse(job.payload);
}

module.exports = {
    seedReceiptPrinter,
    insertShift,
    insertPaidOrder,
    insertOrderItem,
    insertOrderRefund,
    insertVoidedOrder,
    latestPrintPayload,
};
