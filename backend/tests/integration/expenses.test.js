const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { invalidateUserSessions } = require('../../middleware/auth');

describe('Expenses API', () => {
    let adminCookie;
    let cashierCookie;
    let categoryId;

    async function login(userNumber) {
        const response = await request(app).post('/api/auth/login').send({ user_number: userNumber });
        return response.headers['set-cookie'][0];
    }

    async function grantExpenses() {
        await pool.query(
            "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.expenses')",
            [SEED.cashierUser.id]
        );
        invalidateUserSessions(SEED.cashierUser.id);
        cashierCookie = await login(SEED.cashierUser.user_number);
    }

    async function openShift(startingCash = 50) {
        const [result] = await pool.query(
            "INSERT INTO shifts (user_id, starting_cash, status) VALUES (?, ?, 'open')",
            [SEED.cashierUser.id, startingCash]
        );
        return result.insertId;
    }

    beforeEach(async () => {
        await seedDatabase();
        const [category] = await pool.query(
            "INSERT INTO expense_categories (name, is_active, sort_order, created_by) VALUES ('Supplies', 1, 10, ?)",
            [SEED.adminUser.id]
        );
        categoryId = category.insertId;
        adminCookie = await login(SEED.adminUser.user_number);
        cashierCookie = await login(SEED.cashierUser.user_number);
    });

    afterAll(async () => {
        await pool.end();
    });

    it('blocks a cashier without pos.expenses', async () => {
        await openShift();
        const response = await request(app)
            .post('/api/pos/expenses')
            .set('Cookie', cashierCookie)
            .send({ category_id: categoryId, amount: 10, note: 'Milk' });

        expect(response.statusCode).toBe(403);
    });

    it('records against the cashier own open shift and caps at live expected cash', async () => {
        await grantExpenses();
        const shiftId = await openShift(50);

        const created = await request(app)
            .post('/api/pos/expenses')
            .set('Cookie', cashierCookie)
            .send({ category_id: categoryId, amount: 10, note: 'Milk' });
        expect(created.statusCode).toBe(200);
        expect(created.body.expense.shift_id).toBe(shiftId);
        expect(created.body.expense.source).toBe('drawer');

        const tooLarge = await request(app)
            .post('/api/pos/expenses')
            .set('Cookie', cashierCookie)
            .send({ category_id: categoryId, amount: 40.01 });
        expect(tooLarge.statusCode).toBe(409);

        const [[stored]] = await pool.query('SELECT amount, note FROM expenses WHERE id=?', [created.body.expense.id]);
        expect(Number(stored.amount)).toBe(10);
        expect(stored.note).toBe('Milk');
    });

    it('queues drawer expense and cancellation slips without changing the saved outcome', async () => {
        await grantExpenses();
        await openShift(50);
        const [printer] = await pool.query(`
            INSERT INTO printers (name, role, type, windows_name, is_active)
            VALUES ('Receipt', 'receipt', 'windows', 'Test Receipt', 1)
        `);

        const created = await request(app)
            .post('/api/pos/expenses')
            .set('Cookie', cashierCookie)
            .send({ category_id: categoryId, amount: 10, receipt_printer_id: printer.insertId });
        expect(created.statusCode).toBe(200);
        expect(created.body.print_queued).toBe(true);

        const canceled = await request(app)
            .post(`/api/admin/expenses/${created.body.expense.id}/cancel`)
            .set('Cookie', adminCookie)
            .send({ receipt_printer_id: printer.insertId });
        expect(canceled.statusCode).toBe(200);
        expect(canceled.body.print_queued).toBe(true);

        const forbiddenReprint = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierCookie)
            .send({
                print_type: 'expense_cancel_slip',
                expense_id: created.body.expense.id,
                receipt_printer_id: printer.insertId,
            });
        expect(forbiddenReprint.statusCode).toBe(403);

        const reprint = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({
                print_type: 'expense_cancel_slip',
                expense_id: created.body.expense.id,
                receipt_printer_id: printer.insertId,
                language: 'ar',
            });
        expect(reprint.statusCode).toBe(200);
        expect(reprint.body.success).toBe(true);

        const [jobs] = await pool.query('SELECT print_type FROM print_queue ORDER BY id');
        expect(jobs.map(job => job.print_type)).toEqual([
            'expense_slip',
            'expense_cancel_slip',
            'expense_cancel_slip',
        ]);
    });

    it('replays a repeated request_id as the stored expense without a second row or slip', async () => {
        await grantExpenses();
        await openShift(50);
        const [printer] = await pool.query(`
            INSERT INTO printers (name, role, type, windows_name, is_active)
            VALUES ('Receipt', 'receipt', 'windows', 'Test Receipt', 1)
        `);
        const body = { category_id: categoryId, amount: 10, receipt_printer_id: printer.insertId, request_id: 'expense-retry-1' };
        const first = await request(app).post('/api/pos/expenses').set('Cookie', cashierCookie).send(body);
        const retry = await request(app).post('/api/pos/expenses').set('Cookie', cashierCookie).send(body);

        expect(first.statusCode).toBe(200);
        expect(retry.statusCode).toBe(200);
        expect(retry.body.expense.id).toBe(first.body.expense.id);
        expect(retry.body.replayed).toBe(true);
        const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM expenses');
        expect(Number(n)).toBe(1);
        const [[jobs]] = await pool.query("SELECT COUNT(*) n FROM print_queue WHERE print_type='expense_slip'");
        expect(Number(jobs.n)).toBe(1);
    });

    it('prints the expense slip with only the approved store info, never settings secrets', async () => {
        await grantExpenses();
        await openShift(50);
        await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('jofotara_secret_key', 'must-not-print') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)");
        const [printer] = await pool.query(`
            INSERT INTO printers (name, role, type, windows_name, is_active)
            VALUES ('Receipt', 'receipt', 'windows', 'Test Receipt', 1)
        `);
        const response = await request(app).post('/api/pos/expenses').set('Cookie', cashierCookie)
            .send({ category_id: categoryId, amount: 4, receipt_printer_id: printer.insertId });
        expect(response.statusCode).toBe(200);
        const [[job]] = await pool.query("SELECT payload FROM print_queue WHERE print_type='expense_slip' ORDER BY id DESC LIMIT 1");
        const payload = JSON.parse(job.payload);
        const { PRINT_STORE_INFO_KEYS } = require('../../services/printStoreInfo');
        expect(Object.keys(payload.data.storeInfo).every(key => PRINT_STORE_INFO_KEYS.includes(key))).toBe(true);
        expect(job.payload).not.toContain('must-not-print');
        expect(payload.data.storeInfo).not.toHaveProperty('jofotara_secret_key');
    });

    it('allows admin to record an outside-POS expense without a shift', async () => {
        const response = await request(app)
            .post('/api/admin/expenses')
            .set('Cookie', adminCookie)
            .send({ category_id: categoryId, amount: 7.5, source: 'outside', note: 'Bank payment' });

        expect(response.statusCode).toBe(200);
        expect(response.body.expense.source).toBe('outside');
        expect(response.body.expense.shift_id).toBeNull();
    });

    it.each([0, 5.25])('releases the cancellation connection before queuing a slip for %s', async amount => {
        if (process.env.POSAPP_REVIEW_CONNECTION_LIMIT) {
            expect(pool.pool.config.connectionLimit).toBe(Number(process.env.POSAPP_REVIEW_CONNECTION_LIMIT));
        }
        const [shift] = await pool.query(
            "INSERT INTO shifts (user_id,starting_cash,expected_cash,actual_cash,status,closed_at) VALUES (?,50,?,50,'closed',NOW())",
            [SEED.cashierUser.id, 50 - amount]
        );
        const [expense] = await pool.query(
            "INSERT INTO expenses (category_id,amount,source,shift_id,created_by,created_at) VALUES (?,?,'drawer',?,?,'2026-07-18 08:00:00')",
            [categoryId, amount, shift.insertId, SEED.cashierUser.id]
        );
        const [printer] = await pool.query(
            "INSERT INTO printers (name,role,type,windows_name,is_active) VALUES ('Receipt','receipt','windows','Test Receipt',1)"
        );
        const response = await request(app).post(`/api/admin/expenses/${expense.insertId}/cancel`)
            .set('Cookie', adminCookie).send({ receipt_printer_id: printer.insertId }).timeout(5000);
        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({ success: true, print_queued: true, expense: { status: 'canceled', amount } });
        const [[saved]] = await pool.query('SELECT expected_cash,actual_cash FROM shifts WHERE id=?', [shift.insertId]);
        expect(Number(saved.expected_cash)).toBe(50);
        expect(Number(saved.actual_cash)).toBe(50);
        const [jobs] = await pool.query('SELECT print_type FROM print_queue');
        expect(jobs).toEqual([{ print_type: 'expense_cancel_slip' }]);
    });

    it('records zero-valued expenses through the cashier and admin paths', async () => {
        await grantExpenses();
        const shiftId = await openShift(50);

        const cashierResponse = await request(app)
            .post('/api/pos/expenses')
            .set('Cookie', cashierCookie)
            .send({ category_id: categoryId, amount: 0, note: 'No-cost drawer record' });
        expect(cashierResponse.statusCode).toBe(200);
        expect(cashierResponse.body.expense.amount).toBe(0);
        expect(cashierResponse.body.expense.shift_id).toBe(shiftId);

        const adminResponse = await request(app)
            .post('/api/admin/expenses')
            .set('Cookie', adminCookie)
            .send({ category_id: categoryId, amount: 0, source: 'outside', note: 'No-cost outside record' });
        expect(adminResponse.statusCode).toBe(200);
        expect(adminResponse.body.expense.amount).toBe(0);
        expect(adminResponse.body.expense.shift_id).toBeNull();

        const [stored] = await pool.query(
            'SELECT amount FROM expenses WHERE id IN (?, ?) ORDER BY id',
            [cashierResponse.body.expense.id, adminResponse.body.expense.id]
        );
        expect(stored.map((expense) => Number(expense.amount))).toEqual([0, 0]);
    });

    it('rejects over-precision amounts instead of storing a rounded zero', async () => {
        await grantExpenses();
        await openShift(50);

        const cashierResponse = await request(app)
            .post('/api/pos/expenses')
            .set('Cookie', cashierCookie)
            .send({ category_id: categoryId, amount: 0.0000000001 });
        expect(cashierResponse.statusCode).toBe(400);

        const adminResponse = await request(app)
            .post('/api/admin/expenses')
            .set('Cookie', adminCookie)
            .send({ category_id: categoryId, amount: 0.001, source: 'outside' });
        expect(adminResponse.statusCode).toBe(400);
    });

    it('allows admin to cancel an active current-shift expense exactly once', async () => {
        const shiftId = await openShift(20);
        const created = await request(app)
            .post('/api/admin/expenses')
            .set('Cookie', adminCookie)
            .send({ category_id: categoryId, amount: 5, source: 'drawer', shift_id: shiftId });
        expect(created.statusCode).toBe(200);

        const canceled = await request(app)
            .post(`/api/admin/expenses/${created.body.expense.id}/cancel`)
            .set('Cookie', adminCookie)
            .send({});
        expect(canceled.statusCode).toBe(200);
        expect(canceled.body.expense.status).toBe('canceled');

        const again = await request(app)
            .post(`/api/admin/expenses/${created.body.expense.id}/cancel`)
            .set('Cookie', adminCookie)
            .send({});
        expect(again.statusCode).toBe(409);
    });

    it('cancels an outside expense from a previous business day and keeps its original entry', async () => {
        const created = await request(app)
            .post('/api/admin/expenses')
            .set('Cookie', adminCookie)
            .send({ category_id: categoryId, amount: 5, source: 'outside' });
        expect(created.statusCode).toBe(200);
        await pool.query(
            'UPDATE expenses SET created_at=DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 2 DAY) WHERE id=?',
            [created.body.expense.id]
        );

        const response = await request(app)
            .post(`/api/admin/expenses/${created.body.expense.id}/cancel`)
            .set('Cookie', adminCookie)
            .send({});

        expect(response.statusCode).toBe(200);
        expect(response.body.expense).toMatchObject({ status: 'canceled', amount: 5, canceled_by: SEED.adminUser.id, shift_id: null });
        expect(response.body.expense.created_at).not.toBe(response.body.expense.canceled_at);
    });

    async function expenseToCorrect({ closed = false, actualCash = 50 } = {}) {
        const shiftId = await openShift(50);
        const created = await request(app).post('/api/admin/expenses').set('Cookie', adminCookie)
            .send({ category_id: categoryId, amount: 5.25, source: 'drawer', shift_id: shiftId, note: 'Mistaken entry' });
        expect(created.statusCode).toBe(200);
        if (closed) {
            const close = await request(app).put('/api/auth/shifts?action=close').set('Cookie', cashierCookie)
                .send({ shift_id: shiftId, actual_cash: actualCash });
            expect(close.statusCode).toBe(200);
            expect(close.body.expected_cash).toBe(44.75);
        }
        await pool.query("UPDATE expenses SET created_at='2026-07-18 08:00:00' WHERE id=?", [created.body.expense.id]);
        return { shiftId, expenseId: created.body.expense.id };
    }

    it.each([44.75, 50])('corrects a historical closed drawer expense while preserving an actual count of %s', async actualCash => {
        const { shiftId, expenseId } = await expenseToCorrect({ closed: true, actualCash });
        const [[before]] = await pool.query('SELECT * FROM shifts WHERE id=?', [shiftId]);
        const [[original]] = await pool.query('SELECT * FROM expenses WHERE id=?', [expenseId]);
        const canceled = await request(app).post(`/api/admin/expenses/${expenseId}/cancel`).set('Cookie', adminCookie).send({});
        expect(canceled.statusCode).toBe(200);
        const [[after]] = await pool.query('SELECT * FROM shifts WHERE id=?', [shiftId]);
        expect(after).toEqual({ ...before, expected_cash: '50.00' });
        const [[saved]] = await pool.query('SELECT * FROM expenses WHERE id=?', [expenseId]);
        expect(saved).toMatchObject({ ...original, status: 'canceled', canceled_by: SEED.adminUser.id, canceled_at: expect.anything() });
        const shifts = await request(app).get('/api/admin/shifts').set('Cookie', adminCookie);
        expect(shifts.body.shifts.find(row => row.id === shiftId)).toMatchObject({ cash_expenses: 0, variance: actualCash - 50 });
        const report = await request(app).get('/api/admin/reports/expenses?start_date=2026-07-18&end_date=2026-07-18').set('Cookie', adminCookie);
        expect(report.statusCode).toBe(200);
        expect(report.body.summary).toEqual({ count: 0, total: 0, drawer: 0, outside: 0 });
        expect(report.body.entries).toEqual([expect.objectContaining({ id: expenseId, amount: 5.25, status: 'canceled' })]);
        const z = await request(app).get(`/api/admin/shift-reports/${shiftId}/print-payload?type=z_report`).set('Cookie', adminCookie);
        expect(z.statusCode).toBe(200);
        expect(z.body.print_payload).toMatchObject({ expected_cash: 50, actual_cash: actualCash, variance: actualCash - 50, cash_expenses: 0 });
    });

    it('applies only the expense delta to a corrected frozen expected count', async () => {
        const { shiftId, expenseId } = await expenseToCorrect({ closed: true });
        await pool.query('UPDATE shifts SET expected_cash=40 WHERE id=?', [shiftId]);
        const canceled = await request(app).post(`/api/admin/expenses/${expenseId}/cancel`).set('Cookie', adminCookie).send({});
        expect(canceled.statusCode).toBe(200);
        const [[shift]] = await pool.query('SELECT expected_cash,actual_cash FROM shifts WHERE id=?', [shiftId]);
        expect(Number(shift.expected_cash)).toBe(45.25);
        expect(Number(shift.actual_cash)).toBe(50);
    });

    it('cancels a previous-day expense on an open shift without freezing a new cash count', async () => {
        const { shiftId, expenseId } = await expenseToCorrect();
        const [[before]] = await pool.query('SELECT * FROM shifts WHERE id=?', [shiftId]);
        const canceled = await request(app).post(`/api/admin/expenses/${expenseId}/cancel`).set('Cookie', adminCookie).send({});
        expect(canceled.statusCode).toBe(200);
        const [[after]] = await pool.query('SELECT * FROM shifts WHERE id=?', [shiftId]);
        expect(after).toEqual(before);
        const z = await request(app).get(`/api/auth/shifts?action=zreport&shift_id=${shiftId}`).set('Cookie', cashierCookie);
        expect(z.body.data.expected_cash).toBe(50);
        expect(z.body.data.cash_expenses).toBe(0);
    });

    it('keeps cancellation restricted to admins and programmers', async () => {
        const { expenseId } = await expenseToCorrect();
        await grantExpenses();
        expect((await request(app).post(`/api/admin/expenses/${expenseId}/cancel`).send({})).statusCode).toBe(401);
        expect((await request(app).post(`/api/admin/expenses/${expenseId}/cancel`).set('Cookie', cashierCookie).send({})).statusCode).toBe(403);
        await pool.query("INSERT INTO users(name,user_number,role,is_active) VALUES ('Expense programmer','9087','programmer',1)");
        const programmer = await login('9087');
        const canceled = await request(app).post(`/api/admin/expenses/${expenseId}/cancel`).set('Cookie', programmer).send({});
        expect(canceled.statusCode).toBe(200);
        expect(canceled.body.expense.canceled_by_name).toBe('Expense programmer');
    });

    it('rolls back the cash correction if saving the cancellation fails', async () => {
        const { shiftId, expenseId } = await expenseToCorrect({ closed: true });
        await pool.query("CREATE TRIGGER fail_expense_cancel BEFORE UPDATE ON expenses FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Fixture cancellation failure'");
        try {
            const response = await request(app).post(`/api/admin/expenses/${expenseId}/cancel`).set('Cookie', adminCookie).send({});
            expect(response.statusCode).toBe(500);
            const [[shift]] = await pool.query('SELECT expected_cash FROM shifts WHERE id=?', [shiftId]);
            const [[expense]] = await pool.query('SELECT status,canceled_by FROM expenses WHERE id=?', [expenseId]);
            expect(Number(shift.expected_cash)).toBe(44.75);
            expect(expense).toEqual({ status: 'active', canceled_by: null });
        } finally { await pool.query('DROP TRIGGER fail_expense_cancel'); }
    });

    it('serializes duplicate closed-shift cancellations without restoring cash or printing twice', async () => {
        const { shiftId, expenseId } = await expenseToCorrect({ closed: true });
        const [printer] = await pool.query("INSERT INTO printers(name,role,type,windows_name,is_active) VALUES ('Cancellation','receipt','windows','Fixture printer',1)");
        const cancel = () => request(app).post(`/api/admin/expenses/${expenseId}/cancel`).set('Cookie', adminCookie).send({ receipt_printer_id: printer.insertId });
        const responses = await Promise.all([cancel(), cancel()]);
        expect(responses.map(row => row.statusCode).sort()).toEqual([200, 409]);
        const [[shift]] = await pool.query('SELECT expected_cash FROM shifts WHERE id=?', [shiftId]);
        expect(Number(shift.expected_cash)).toBe(50);
        const [[jobs]] = await pool.query("SELECT COUNT(*) n FROM print_queue WHERE print_type='expense_cancel_slip'");
        expect(Number(jobs.n)).toBe(1);
    });

    it.each(['close', 'cancel'])('reconciles a simultaneous close and cancellation when %s starts first', async first => {
        const { shiftId, expenseId } = await expenseToCorrect();
        const close = () => request(app).put('/api/auth/shifts?action=close').set('Cookie', cashierCookie).send({ shift_id: shiftId, actual_cash: 50 });
        const cancel = () => request(app).post(`/api/admin/expenses/${expenseId}/cancel`).set('Cookie', adminCookie).send({});
        const responses = await Promise.all(first === 'close' ? [close(), cancel()] : [cancel(), close()]);
        expect(responses.map(row => row.statusCode)).toEqual([200, 200]);
        const [[shift]] = await pool.query('SELECT status,expected_cash,actual_cash FROM shifts WHERE id=?', [shiftId]);
        expect(shift).toEqual({ status: 'closed', expected_cash: '50.00', actual_cash: '50.00' });
    });

    it('uses drawer expenses in live, admin, and frozen shift cash totals without changing sales', async () => {
        await grantExpenses();
        const shiftId = await openShift(50);
        await pool.query(`
            INSERT INTO orders
                (order_id, user_id, shift_id, subtotal, tax, total, payment_method, cash_amount)
            VALUES (1, ?, ?, 20, 0, 20, 'cash', 20)
        `, [SEED.cashierUser.id, shiftId]);
        await request(app)
            .post('/api/pos/expenses')
            .set('Cookie', cashierCookie)
            .send({ category_id: categoryId, amount: 10 });
        await request(app)
            .post('/api/admin/expenses')
            .set('Cookie', adminCookie)
            .send({ category_id: categoryId, amount: 8, source: 'outside' });

        const zReport = await request(app)
            .get(`/api/auth/shifts?action=zreport&shift_id=${shiftId}`)
            .set('Cookie', cashierCookie);
        expect(zReport.statusCode).toBe(200);
        expect(zReport.body.data.cash_sales).toBe(20);
        expect(zReport.body.data.cash_expenses).toBe(10);
        expect(zReport.body.data.expected_cash).toBe(60);

        const adminShifts = await request(app)
            .get('/api/admin/shifts')
            .set('Cookie', adminCookie);
        const listed = adminShifts.body.shifts.find(shift => shift.id === shiftId);
        expect(listed.cash_expenses).toBe(10);
        expect(listed.live_expected_cash).toBe(60);

        const closed = await request(app)
            .put('/api/auth/shifts?action=close')
            .set('Cookie', cashierCookie)
            .send({ shift_id: shiftId, actual_cash: 60 });
        expect(closed.statusCode).toBe(200);
        expect(closed.body.expected_cash).toBe(60);
        const [[storedShift]] = await pool.query('SELECT expected_cash FROM shifts WHERE id=?', [shiftId]);
        expect(Number(storedShift.expected_cash)).toBe(60);
    });

    it('manages categories without deleting used history', async () => {
        const created = await request(app)
            .post('/api/admin/expense-categories')
            .set('Cookie', adminCookie)
            .send({ name: 'Maintenance', sort_order: 20 });
        expect(created.statusCode).toBe(200);

        const updated = await request(app)
            .put(`/api/admin/expense-categories/${created.body.category.id}`)
            .set('Cookie', adminCookie)
            .send({ name: 'Repairs', sort_order: 15, is_active: false });
        expect(updated.statusCode).toBe(200);
        expect(updated.body.category.name).toBe('Repairs');
        expect(updated.body.category.is_active).toBe(0);
    });
});
