// backend/tests/unit/print.unit.test.js
const pool = require('../../config/db');
const printModule = require('../../routes/print');
const templateManager = require('../../services/printTemplateManager');
const { getBuiltinTemplate } = require('../../services/printTemplateDefaults');

function mockBuiltinTemplateResolution() {
    vi.spyOn(templateManager, 'resolveActiveTemplate').mockImplementation(async (_executor, docType, options = {}) => ({
        kind: 'builtin',
        definition: getBuiltinTemplate(docType, { storeInfo: options.storeInfo }),
        templateRevisionId: `builtin:${docType}-v1`
    }));
}

describe('printKitchenOrder unit tests', () => {
    let mockIo;
    let mockEmit;
    let mockTo;
    let querySpy;

    beforeEach(() => {
        vi.clearAllMocks();
        mockBuiltinTemplateResolution();

        mockEmit = vi.fn();
        mockTo = vi.fn().mockReturnValue({ emit: mockEmit });
        mockIo = {
            sockets: {
                adapter: {
                    rooms: new Map()
                }
            },
            to: mockTo,
            emit: mockEmit
        };
        // Add a mock spooler connection so the print jobs are processed and status updated
        mockIo.sockets.adapter.rooms.set('spoolers', new Set(['spooler-1']));

        // Spy on database pool query calls directly
        querySpy = vi.spyOn(pool, 'query');
    });

    it('should correctly build kitchen print payloads with quantity mapped to qty', async () => {
        // Mock DB queries:
        // 1. categories parent lookup
        // 2. printers lookup
        // 3. INSERT INTO print_queue
        // 4. UPDATE print_queue status
        querySpy.mockImplementation(async (sql, params) => {
            if (sql.includes('FROM categories')) {
                return [[{ id: 1, parent_id: null }]];
            }
            if (sql.includes('FROM printers')) {
                return [[{
                    category_id: 1,
                    id: 10,
                    name: 'Kitchen Station',
                    role: 'kitchen',
                    type: 'windows',
                    windows_name: 'POS-Printer',
                    is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) {
                return [{ insertId: 101 }];
            }
            if (sql.includes('UPDATE print_queue')) {
                return [{}];
            }
            return [[]];
        });

        const printData = {
            order_id: 123,
            invoice_id: 123,
            table_number: 'T5',
            order_type_name: 'Dine In',
            date: '2026-06-06',
            items: [
                { id: 9, product_id: 9, name: 'Burger', quantity: 2.0, category_id: 1 }
            ]
        };

        const count = await printModule.printKitchenOrder(mockIo, printData);
        expect(count).toBe(1);

        // Verify that the payload inserted into database (query 3) contains correct fields
        const insertCall = querySpy.mock.calls.find(call => call[0].includes('INSERT INTO print_queue'));
        expect(insertCall).toBeDefined();

        const payloadString = insertCall[1][0];
        const payload = JSON.parse(payloadString);

        expect(payload.printer_name).toBe('POS-Printer');
        expect(payload.printer_id).toBe(10);
        expect(payload.print_type).toBe('kitchen');
        expect(payload.data.table_number).toBe('T5');

        // Assert qty matches quantity (crucial fix for preventing undefined quantity bug)
        expect(payload.data.items[0].qty).toBe(2.0);
        expect(payload.data.items[0].name).toBe('Burger');
    });

    it('kitchen payload carries ticket order_id (not internal invoice_id), invoice_display_no is null', async () => {
        // This test calls the REAL printKitchenOrder. It would FAIL if the production
        // bridge payload were changed to `order_id: data.invoice_id` instead of `data.order_id`.
        querySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM categories')) return [[{ id: 1, parent_id: null }]];
            if (sql.includes('FROM printers')) {
                return [[{
                    category_id: 1, id: 10, name: 'Kitchen', role: 'kitchen',
                    type: 'windows', windows_name: 'POS-Printer', is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 101 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        // Simulates what the route handler derives via buildOrderIdentity before calling
        // printKitchenOrder: internal invoice_id=123, but daily display order_id='17'.
        const printData = {
            internal_invoice_id: 123,
            invoice_id: 123,
            invoice_display_no: null,   // kitchen never exposes a paid invoice number
            order_id: '17',             // derived: ticket_display_no || order_display_no
            order_display_no: '17',
            ticket_display_no: '17',
            table_number: 'T3',
            order_type_name: 'Dine In',
            date: '2026-06-29',
            items: [{ id: 9, product_id: 9, name: 'Burger', quantity: 2, category_id: 1 }]
        };

        const count = await printModule.printKitchenOrder(mockIo, printData);
        expect(count).toBe(1);

        const insertCall = querySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        expect(insertCall).toBeDefined();
        const data = JSON.parse(insertCall[1][0]).data;

        // Contract: kitchen ticket never carries a public invoice number
        expect(data.invoice_display_no).toBeNull();
        // Contract: order_id is the display/ticket string, NOT the internal invoice_id integer
        expect(data.order_id).toBe('17');
        expect(data.order_id).not.toBe(123);
        expect(data.order_id).not.toBe('123');
    });

    it('should propagate parent category matches when child category has no direct printer', async () => {
        // Child category 2 has parent_id 1
        // Only category 1 has a printer assigned
        querySpy.mockImplementation(async (sql, params) => {
            if (sql.includes('FROM categories')) {
                return [[{ id: 2, parent_id: 1 }, { id: 1, parent_id: null }]];
            }
            if (sql.includes('FROM printers')) {
                // Return printer mapped only to parent category 1
                return [[{
                    category_id: 1,
                    id: 20,
                    name: 'Parent Station',
                    role: 'kitchen',
                    type: 'windows',
                    windows_name: 'Parent-Printer',
                    is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) {
                return [{ insertId: 102 }];
            }
            if (sql.includes('UPDATE print_queue')) {
                return [{}];
            }
            return [[]];
        });

        const printData = {
            order_id: 124,
            invoice_id: 124,
            table_number: 'T10',
            items: [
                { id: 5, product_id: 5, name: 'Spicy Fries', quantity: 1, category_id: 2 } // item belongs to child category 2
            ]
        };

        const count = await printModule.printKitchenOrder(mockIo, printData);
        expect(count).toBe(1);

        const insertCall = querySpy.mock.calls.find(call => call[0].includes('INSERT INTO print_queue'));
        const payload = JSON.parse(insertCall[1][0]);
        expect(payload.printer_name).toBe('Parent-Printer');
        expect(payload.data.items[0].qty).toBe(1);
    });
});

describe('receipt identity via POST /print route', () => {
    // Uses supertest against a minimal Express app wired with the real print router.
    // pool.query is spied and mocked per-test. Auth is bypassed via preWarmToken, which
    // mutates the same in-memory tokenCache that requireAuth reads — no vi.mock needed.
    // This exercises the real route handler in print.js — would FAIL if the ...identity
    // spread or the `date: order.invoice_issued_at` assignment were reverted.
    const request = require('supertest');
    let app;
    let receiptMockIo;
    let receiptQuerySpy;

    const TEST_TOKEN = 'receipt-identity-test-token';

    beforeAll(() => {
        // Pre-warm auth so requireAuth resolves from cache without any DB query.
        const { preWarmToken } = require('../../middleware/auth');
        preWarmToken(TEST_TOKEN, {
            id: 1,
            role: 'cashier',
            name: 'Test Cashier',
            // These cases reprint past paid receipts to inspect the payload.
            permissions: ['tables.access', 'pos.reprint_receipt'],
            table_access_scope: 'all'
        });

        const express = require('express');
        app = express();
        app.use(express.json());
        // Inject mock io — closure reads receiptMockIo at request time (set by beforeEach).
        app.use((req, res, next) => { req.io = receiptMockIo; next(); });
        app.use('/print', printModule);
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockBuiltinTemplateResolution();
        const mockEmit = vi.fn();
        receiptMockIo = {
            sockets: { adapter: { rooms: new Map([['spoolers', new Set(['s1'])]]) } },
            to: vi.fn().mockReturnValue({ emit: mockEmit }),
            emit: mockEmit
        };
        receiptQuerySpy = vi.spyOn(pool, 'query');
    });

    it('loads paid order from DB and injects public invoice identity into print payload', async () => {
        const request = require('supertest');

        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) {
                return [[{ setting_key: 'store_name', setting_value: 'TestStore' }]];
            }
            if (sql.includes("role = 'receipt'")) {
                return [[{
                    id: 1, role: 'receipt', type: 'windows',
                    windows_name: 'TestPrinter', assigned_ips: null, is_active: 1
                }]];
            }
            if (sql.includes('FROM orders o')) {
                // Paid order: internal invoice_id=123, daily display order_id=17, public invoice_number=7001
                return [[{
                    invoice_id: 123,
                    user_id: 1,
                    order_id: 17,
                    invoice_number: 7001,
                    invoice_issued_at: '2026-06-29T10:00:00.000Z',
                    created_at: '2026-06-29T09:00:00.000Z',
                    cashier_name: 'Ali',
                    payment_method: 'cash',
                    subtotal: 100, tax: 0, total: 100,
                    discount_type: null, discount_value: 0,
                    amount_tendered: 100, change_due: 0,
                    hash_number: 'abc123',
                    table_number: '', order_type_name: 'Dine In',
                    customer_name: '', customer_phone: '', customer_address: ''
                }]];
            }
            if (sql.includes('FROM order_items')) return [[]];
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 200 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({ print_type: 'receipt', invoice_id: 123 });

        expect(res.body.success).toBe(true);

        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        expect(insertCall).toBeDefined();
        const payload = JSON.parse(insertCall[1][0]);
        const data = payload.data;

        // public invoice number exposed as display string (via buildOrderIdentity spread)
        expect(data.invoice_display_no).toBe('7001');
        // internal IDs preserved for idempotency and audit
        expect(data.internal_invoice_id).toBe(123);
        expect(data.invoice_id).toBe(123);
        // receipt header uses order-taken time, not invoice/print time
        expect(data.date).toBe('2026-06-29T09:00:00.000Z');
        expect(data.order_taken_at).toBe('2026-06-29T09:00:00.000Z');
    });

    it('requires a terminal printer choice when more than one receipt printer is active', async () => {
        const request = require('supertest');
        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) return [[]];
            if (sql.includes("role = 'receipt'")) {
                return [[
                    { id: 1, role: 'receipt', type: 'windows', windows_name: 'Front', is_active: 1 },
                    { id: 2, role: 'receipt', type: 'windows', windows_name: 'Patio', is_active: 1 }
                ]];
            }
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({ print_type: 'receipt', invoice_id: 123 });

        expect(res.statusCode).toBe(409);
        expect(res.body.message).toBe('Select a receipt printer for this terminal.');
        expect(receiptQuerySpy.mock.calls.some(call => call[0].includes('FROM orders o'))).toBe(false);
    });

    it('rejects provisional receipt payloads that do not point at a real order', async () => {
        const request = require('supertest');

        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) {
                return [[{ setting_key: 'store_name', setting_value: 'TestStore' }]];
            }
            if (sql.includes("role = 'receipt'")) {
                return [[{
                    id: 1, role: 'receipt', type: 'windows',
                    windows_name: 'TestPrinter', assigned_ips: null, is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 201 }];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({
                print_type: 'receipt',
                invoice_id: 'TEMP-FAKE',
                cashier: 'Injected',
                total: 999,
                items: [{ name: 'Forged item', qty: 1, price: 999 }]
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(receiptQuerySpy.mock.calls.some(c => c[0].includes('INSERT INTO print_queue'))).toBe(false);
    });

    it('accepts a table guest check, marks it provisional, and strips invoice/order identity', async () => {
        const request = require('supertest');
        const { preWarmToken } = require('../../middleware/auth');
        const GUEST_TOKEN = 'guest-check-allowed-token';
        preWarmToken(GUEST_TOKEN, { id: 2, role: 'cashier', name: 'Cashier Two', permissions: ['pos.checkout'] });

        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) {
                return [[{ setting_key: 'store_name', setting_value: 'TestStore' }]];
            }
            if (sql.includes("role = 'receipt'")) {
                return [[{
                    id: 1, role: 'receipt', type: 'windows',
                    windows_name: 'TestPrinter', assigned_ips: null, is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 301 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${GUEST_TOKEN}`)
            .send({
                print_type: 'receipt',
                payment_method: 'Unpaid',
                invoice_id: 'GUEST CHECK',
                order_id: 'SHOULD-NOT-PRINT',
                order_display_no: 'SHOULD-NOT-PRINT',
                ticket_display_no: 'SHOULD-NOT-PRINT',
                table_number: '5',
                date: '2026-06-30T09:00:00.000Z',
                total: 12,
                items: [{ name: 'Tea', qty: 1, price: 12 }]
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        expect(insertCall).toBeDefined();
        const payload = JSON.parse(insertCall[1][0]);
        expect(payload.data.provisional).toBe(true);
        expect(payload.data.invoice_display_no).toBeNull();
        expect(payload.data.order_id).toBeNull();
        expect(payload.data.order_display_no).toBeNull();
        expect(payload.data.ticket_display_no).toBeNull();
        expect(payload.data.table_display_no).toBe('5');
        expect(payload.data.order_taken_at).toBe('2026-06-30T09:00:00.000Z');
        // A guest check has no persisted order — the route must not attempt to load one.
        expect(receiptQuerySpy.mock.calls.some(c => c[0].includes('FROM orders o'))).toBe(false);
    });

    it('rejects a guest check from a user without checkout permission', async () => {
        const request = require('supertest');
        // TEST_TOKEN can read tables but has no checkout permission.
        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) {
                return [[{ setting_key: 'store_name', setting_value: 'TestStore' }]];
            }
            if (sql.includes("role = 'receipt'")) {
                return [[{
                    id: 1, role: 'receipt', type: 'windows',
                    windows_name: 'TestPrinter', assigned_ips: null, is_active: 1
                }]];
            }
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({
                print_type: 'receipt',
                payment_method: 'Unpaid',
                invoice_id: 'GUEST CHECK',
                total: 12,
                items: []
            });

        expect(res.statusCode).toBe(403);
        expect(receiptQuerySpy.mock.calls.some(c => c[0].includes('INSERT INTO print_queue'))).toBe(false);
    });

    it('sanitizes user-visible receipt strings before enqueueing the spooler payload', async () => {
        const request = require('supertest');
        const hasControl = (value) => /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(String(value));

        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) {
                return [[{ setting_key: 'store_name', setting_value: 'TestStore\x1B' }]];
            }
            if (sql.includes("role = 'receipt'")) {
                return [[{
                    id: 1, role: 'receipt', type: 'windows',
                    windows_name: 'TestPrinter', assigned_ips: null, is_active: 1
                }]];
            }
            if (sql.includes('FROM orders o')) {
                return [[{
                    invoice_id: 124,
                    user_id: 1,
                    order_id: 18,
                    invoice_number: 7002,
                    invoice_issued_at: '2026-06-29T10:00:00.000Z',
                    created_at: '2026-06-29T09:00:00.000Z',
                    cashier_name: 'Ali\x1B[2J',
                    payment_method: 'cash',
                    subtotal: 100, tax: 0, total: 100,
                    discount_type: null, discount_value: 0,
                    amount_tendered: 100, change_due: 0,
                    hash_number: 'abc\x1D123',
                    table_number: 'T\n5',
                    order_type_name: 'Dine\rIn',
                    customer_name: 'Customer\x00Name',
                    customer_phone: '079\n000',
                    customer_address: 'Street\x1B[31m'
                }]];
            }
            if (sql.includes('FROM order_items')) {
                return [[{
                    quantity: 1,
                    name: 'Burger\x1B[2J',
                    price_at_sale: 5,
                    parent_item_id: null,
                    discount_type: null,
                    discount_value: 0,
                    note: 'No\nonion\x1D'
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 202 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({ print_type: 'receipt', invoice_id: 124 });

        expect(res.body.success).toBe(true);
        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        const payload = JSON.parse(insertCall[1][0]);
        const data = payload.data;

        expect(hasControl(data.cashier)).toBe(false);
        expect(hasControl(data.order_type_name)).toBe(false);
        expect(hasControl(data.table_number)).toBe(false);
        expect(hasControl(data.customer_name)).toBe(false);
        expect(hasControl(data.customer_phone)).toBe(false);
        expect(hasControl(data.customer_address)).toBe(false);
        expect(hasControl(data.hash_number)).toBe(false);
        expect(hasControl(data.items[0].name)).toBe(false);
        expect(hasControl(data.items[0].note)).toBe(false);
    });

    it('rejects removed legacy daily report print types', async () => {
        const request = require('supertest');
        const { preWarmToken } = require('../../middleware/auth');
        const REPORT_TOKEN = 'report-print-admin-token';
        const hasControl = (value) => /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(String(value));
        preWarmToken(REPORT_TOKEN, { id: 3, role: 'admin', name: 'Report Admin', permissions: [] });

        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) {
                return [[{ setting_key: 'store_name', setting_value: 'TestStore' }]];
            }
            if (sql.includes("role = 'receipt'")) {
                return [[{
                    id: 1, role: 'receipt', type: 'windows',
                    windows_name: 'TestPrinter', assigned_ips: null, is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 203 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${REPORT_TOKEN}`)
            .send({
                print_type: 'report_products',
                date: '2026-07-01',
                products: [{ item_name: 'Burger\x1B[2J', category_name: 'Food\x00', qty_sold: 1, gross_revenue: 5 }],
                categories: [{ category_name: 'Food\nCategory', qty_sold: 1, gross_revenue: 5 }]
            });

        expect(res.body.success).toBe(false);
        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        expect(insertCall).toBeUndefined();
    });

    it('sanitizes user-visible new daily report rows before enqueueing the spooler payload', async () => {
        const request = require('supertest');
        const { preWarmToken } = require('../../middleware/auth');
        const REPORT_TOKEN = 'report-print-admin-token';
        const hasControl = (value) => /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(String(value));
        preWarmToken(REPORT_TOKEN, { id: 3, role: 'admin', name: 'Report Admin', permissions: [] });

        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) {
                return [[{ setting_key: 'store_name', setting_value: 'TestStore' }]];
            }
            if (sql.includes("role = 'receipt'")) {
                return [[{
                    id: 1, role: 'receipt', type: 'windows',
                    windows_name: 'TestPrinter', assigned_ips: null, is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 204 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${REPORT_TOKEN}`)
            .send({
                print_type: 'daily_sales_report',
                report_id: 'report:123\x1B',
                period: {
                    start_date: '2026-07-14',
                    end_date: '2026-07-14',
                    business_day_start_hour: 6,
                    window_label: 'client-controlled\x01'
                },
                language: 'ar',
                products: [{ item_name: 'Burger\x1B[2J', category_path: 'Food\x00', sold_qty: 10, returned_qty: 1, net_sales: 9 }],
                categories: [{ name: 'Food\nCategory', subcategories: [{ name: 'Subcat\x00' }] }]
            });

        expect(res.body.success).toBe(true);
        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        expect(insertCall).toBeDefined();
        const data = JSON.parse(insertCall[1][0]).data;

        expect(data.report_id).toBe('daily_sales_report:2026-07-14:2026-07-14');
        expect(data.period.start_date).toBe('2026-07-14');
        expect(data.period.window_label).toBe('2026-07-14 06:00 → 2026-07-15 05:59');
        expect(data.language).toBe('ar');
        expect(data.direction).toBe('rtl');
        expect(hasControl(data.products[0].item_name)).toBe(false);
        expect(hasControl(data.products[0].category_path)).toBe(false);
        expect(data.products[0].net_sales).toBe(9);
        expect(hasControl(data.categories[0].name)).toBe(false);
        expect(hasControl(data.categories[0].subcategories[0].name)).toBe(false);
    });

    it('open-table kitchen ticket: order_id is null (not internal invoice_id), table_number drives display', async () => {
        // Route-level test: fires POST /print/print for an open table kitchen print.
        // MUST FAIL before print.js:388 fix (sees '555') and PASS after (sees null).
        const request = require('supertest');

        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) {
                return [[{ setting_key: 'store_name', setting_value: 'TestStore' }]];
            }
            if (sql.includes('FROM orders o')) {
                // Open table: order_id=null, invoice_number=null — only invoice_id is internal PK
                return [[{
                    invoice_id: 555, order_id: null, invoice_number: null,
                    table_id: 9, payment_method: 'unpaid_table',
                    created_at: '2026-06-30T09:00:00.000Z',
                    order_type_name: 'Table',
                    hash_number: 'h1', waiter_id: 1,
                    subtotal: 5, tax: 0, total: 5
                }]];
            }
            if (sql.includes('FROM order_items')) {
                return [[{
                    invoice_id: 555, product_id: 1, item_name: 'Burger',
                    quantity: 1, name: 'Burger', category_id: 1, is_bundle: 0
                }]];
            }
            if (sql.includes('FROM restaurant_tables')) {
                return [[{ table_number: '9' }]];
            }
            if (sql.includes('FROM categories')) {
                return [[{ id: 1, parent_id: null }]];
            }
            if (sql.includes("role = 'kitchen'")) {
                // Printer row shape as read by printKitchenOrder (SELECT DISTINCT pc.category_id, p.*)
                return [[{
                    category_id: 1, id: 10, name: 'Kitchen Station',
                    role: 'kitchen', type: 'windows',
                    windows_name: 'Kitchen-Printer',
                    network_ip: null, network_port: null,
                    is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 300 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({ print_type: 'kitchen', invoice_id: 555 });

        expect(res.body.success).toBe(true);

        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        expect(insertCall).toBeDefined();
        const payload = JSON.parse(insertCall[1][0]);
        const data = payload.data;

        // No internal PK leak onto kitchen ticket (was String(invoice_id)='555' before fix)
        expect(data.order_id).toBeNull();
        expect(data.order_id).not.toBe(555);
        expect(data.order_id).not.toBe('555');
        // Table number drives open-table display
        expect(data.table_number).toBe('9');
        expect(data.order_taken_at).toBe('2026-06-30T09:00:00.000Z');
        expect(data.date).toBe('2026-06-30T09:00:00.000Z');
    });

    it('paid register kitchen ticket keeps invoice and daily order identity with order-taken time', async () => {
        const request = require('supertest');

        receiptQuerySpy.mockImplementation(async (sql) => {
            if (sql.includes('FROM settings')) {
                return [[{ setting_key: 'store_name', setting_value: 'TestStore' }]];
            }
            if (sql.includes('FROM orders o')) {
                return [[{
                    invoice_id: 777,
                    user_id: 1,
                    order_id: 17,
                    invoice_number: 7001,
                    table_id: null,
                    payment_method: 'cash',
                    created_at: '2026-06-30T08:15:00.000Z',
                    order_type_name: 'Takeaway',
                    hash_number: 'h2',
                    waiter_id: null,
                    subtotal: 5,
                    tax: 0,
                    total: 5
                }]];
            }
            if (sql.includes('FROM order_items')) {
                return [[{
                    invoice_id: 777,
                    product_id: 1,
                    item_name: 'Burger',
                    quantity: 1,
                    name: 'Burger',
                    category_id: 1,
                    is_bundle: 0
                }]];
            }
            if (sql.includes('FROM restaurant_tables')) return [[]];
            if (sql.includes('FROM categories')) return [[{ id: 1, parent_id: null }]];
            if (sql.includes("role = 'kitchen'")) {
                return [[{
                    category_id: 1,
                    id: 10,
                    name: 'Kitchen Station',
                    role: 'kitchen',
                    type: 'windows',
                    windows_name: 'Kitchen-Printer',
                    network_ip: null,
                    network_port: null,
                    is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 302 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({ print_type: 'kitchen', invoice_id: 777 });

        expect(res.body.success).toBe(true);

        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        const data = JSON.parse(insertCall[1][0]).data;

        expect(data.invoice_display_no).toBe('7001');
        expect(data.order_display_no).toBe('17');
        expect(data.order_id).toBe('17');
        expect(data.table_number).toBe('');
        expect(data.order_taken_at).toBe('2026-06-30T08:15:00.000Z');
    });

    it('kitchen print route keeps repeated DB order item rows distinct before routing', async () => {
        receiptQuerySpy.mockImplementation(async (sql, params) => {
            if (sql.includes('FROM settings')) return [[{ key_name: 'store_name', value: 'Test Store' }]];
            if (sql.includes('FROM orders o')) {
                return [[{
                    invoice_id: 888,
                    user_id: 1,
                    order_id: 22,
                    invoice_number: 5,
                    invoice_issued_at: '2026-07-05 12:00:00',
                    created_at: '2026-07-05 11:59:00',
                    payment_method: 'cash',
                    table_id: null,
                    waiter_id: null,
                    order_type_name: 'Dine In'
                }]];
            }
            if (sql.includes('FROM order_items')) {
                return [[
                    { id: 501, invoice_id: 888, product_id: 1, item_name: null, name: 'Burger', quantity: 1, category_id: 999, is_bundle: 0 },
                    { id: 502, invoice_id: 888, product_id: 1, item_name: null, name: 'Burger', quantity: 1, category_id: 999, is_bundle: 0 }
                ]];
            }
            if (sql.includes('FROM restaurant_tables')) return [[]];
            if (sql.includes('SELECT id, name, category_id, is_bundle FROM products')) {
                return [[{ id: 1, name: 'Test Burger', category_id: 1, is_bundle: 0 }]];
            }
            if (sql.includes('FROM categories')) return [[{ id: 1, parent_id: null }]];
            if (sql.includes("role = 'kitchen'")) {
                return [[{
                    category_id: 1,
                    id: 10,
                    name: 'Kitchen',
                    role: 'kitchen',
                    type: 'windows',
                    windows_name: 'Kitchen-1',
                    is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 990 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({ print_type: 'kitchen', invoice_id: 888 });

        expect(res.statusCode).toBe(200);
        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        const payload = JSON.parse(insertCall[1][0]);
        const primaryItems = payload.data.items.filter(item => !item._isOther);
        expect(primaryItems).toHaveLength(2);
        expect(primaryItems.map(item => item.cartId)).toEqual(['order-888-1-1', 'order-888-2-1']);
        expect(primaryItems.map(item => item.category_id)).toEqual([1, 1]);
    });

    it('kitchen print route preserves DB bundle parent links so child items keep bundle labels', async () => {
        receiptQuerySpy.mockImplementation(async (sql, params) => {
            if (sql.includes('FROM settings')) return [[{ key_name: 'store_name', value: 'Test Store' }]];
            if (sql.includes('FROM orders o')) {
                return [[{
                    invoice_id: 889,
                    user_id: 1,
                    order_id: 23,
                    invoice_number: 6,
                    invoice_issued_at: '2026-07-05 12:05:00',
                    created_at: '2026-07-05 12:04:00',
                    payment_method: 'cash',
                    table_id: null,
                    waiter_id: null,
                    order_type_name: 'Dine In'
                }]];
            }
            if (sql.includes('FROM order_items')) {
                return [[
                    { id: 700, invoice_id: 889, product_id: 4, item_name: null, name: 'Family Package', quantity: 1, category_id: 999, is_bundle: 0 },
                    { id: 701, invoice_id: 889, parent_item_id: 700, product_id: 1, item_name: null, name: 'Burger', quantity: 2, category_id: 999, is_bundle: 0 }
                ]];
            }
            if (sql.includes('FROM restaurant_tables')) return [[]];
            if (sql.includes('SELECT id, name, category_id, is_bundle FROM products')) {
                return [[
                    { id: 4, name: 'Family Package', category_id: 1, is_bundle: 0 },
                    { id: 1, name: 'Test Burger', category_id: 1, is_bundle: 0 }
                ]];
            }
            if (sql.includes('FROM categories')) return [[{ id: 1, parent_id: null }]];
            if (sql.includes("role = 'kitchen'")) {
                return [[{
                    category_id: 1,
                    id: 10,
                    name: 'Kitchen',
                    role: 'kitchen',
                    type: 'windows',
                    windows_name: 'Kitchen-1',
                    is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 991 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({ print_type: 'kitchen', invoice_id: 889 });

        expect(res.statusCode).toBe(200);
        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        const payload = JSON.parse(insertCall[1][0]);
        const primaryItems = payload.data.items.filter(item => !item._isOther);
        expect(primaryItems).toHaveLength(1);
        expect(primaryItems[0].product_id).toBe(1);
        expect(primaryItems[0]._bundleLabel).toBe('Family Package');
        expect(primaryItems[0].parent_item_id).toBe(700);
    });

    it('kitchen DB reprint keeps a no-child historic row routable after catalog marks it as a bundle', async () => {
        receiptQuerySpy.mockImplementation(async (sql, params) => {
            if (sql.includes('FROM settings')) return [[{ key_name: 'store_name', value: 'Test Store' }]];
            if (sql.includes('FROM orders o')) {
                return [[{
                    invoice_id: 890,
                    user_id: 1,
                    order_id: 24,
                    invoice_number: 7,
                    invoice_issued_at: '2026-07-05 12:05:00',
                    created_at: '2026-07-05 12:04:00',
                    payment_method: 'cash',
                    table_id: null,
                    waiter_id: null,
                    order_type_name: 'Dine In'
                }]];
            }
            if (sql.includes('FROM order_items')) {
                return [[
                    { id: 710, invoice_id: 890, product_id: 4, item_name: null, name: 'Historic Package', quantity: 1, category_id: 999, is_bundle: 1 }
                ]];
            }
            if (sql.includes('FROM restaurant_tables')) return [[]];
            if (sql.includes('SELECT id, name, category_id, is_bundle FROM products')) {
                return [[{ id: 4, name: 'Family Package', category_id: 1, is_bundle: 1 }]];
            }
            if (sql.includes('FROM categories')) return [[{ id: 1, parent_id: null }]];
            if (sql.includes("role = 'kitchen'")) {
                return [[{
                    category_id: 1,
                    id: 10,
                    name: 'Kitchen',
                    role: 'kitchen',
                    type: 'windows',
                    windows_name: 'Kitchen-1',
                    is_active: 1
                }]];
            }
            if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 992 }];
            if (sql.includes('UPDATE print_queue')) return [{}];
            return [[]];
        });

        const res = await request(app)
            .post('/print/print')
            .set('Cookie', `pos_token=${TEST_TOKEN}`)
            .send({ print_type: 'kitchen', invoice_id: 890 });

        expect(res.statusCode).toBe(200);
        const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
        const payload = JSON.parse(insertCall[1][0]);
        const primaryItems = payload.data.items.filter(item => !item._isOther);
        expect(primaryItems).toHaveLength(1);
        expect(primaryItems[0]).toMatchObject({ id: 710, product_id: 4, name: 'Historic Package' });
    });
});
