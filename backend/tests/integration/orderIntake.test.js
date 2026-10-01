import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
const crypto = require('crypto');
const http = require('http');

const API_KEY = 'test-order-intake-key-with-at-least-forty-eight-characters';
process.env.ORDER_INTAKE_ENABLED = 'true';
process.env.ORDER_INTAKE_CLIENT_ID = 'integration-test';
process.env.ORDER_INTAKE_API_KEY_SHA256 = crypto.createHash('sha256').update(API_KEY).digest('hex');
process.env.ORDER_INTAKE_QUOTE_SECRET = 'integration-quote-secret-with-at-least-thirty-two-characters';
process.env.ORDER_INTAKE_ACTOR_USER_ID = '70';
process.env.ORDER_INTAKE_RATE_LIMIT_MAX = '1000';
process.env.ORDER_INTAKE_CREATE_RATE_LIMIT_MAX = '1000';
process.env.ORDER_INTAKE_ACTIVE_HOLD_LIMIT = '200';

const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const orderIntakeService = require('../../modules/orderIntake/service');
const { seedDatabase, SEED } = require('../fixtures/seed');

let apiServer;
let apiBaseUrl;

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function close(server) {
    if (!server?.listening) return Promise.resolve();
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// Forwards the whole request but never relays the answer. upstreamFinished
// resolves with the server's complete response, so the client can abort only
// after the server has read the full body and committed.
async function createResponseWithholdingProxy() {
    let resolveUpstream;
    let rejectUpstream;
    const upstreamFinished = new Promise((resolve, reject) => {
        resolveUpstream = resolve;
        rejectUpstream = reject;
    });
    const proxy = http.createServer(incoming => {
        const target = new URL(incoming.url, apiBaseUrl);
        const upstream = http.request(target, {
            method: incoming.method,
            headers: incoming.headers,
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.once('error', rejectUpstream);
            response.once('end', () => resolveUpstream({
                statusCode: response.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        upstream.once('error', rejectUpstream);
        incoming.pipe(upstream);
    });
    await listen(proxy);
    const address = proxy.address();
    return { proxy, baseUrl: `http://127.0.0.1:${address.port}`, upstreamFinished };
}

function draft(id, overrides = {}) {
    return {
        external_request_id: id,
        order_type_id: 1,
        customer: { name: 'AI Customer', phone: '079-123-4567', address: 'Amman' },
        items: [{ product_id: SEED.product1.id, quantity: 1 }],
        ...overrides,
    };
}

async function quote(payload) {
    return request(app).post('/api/order-intake/v1/quotes').set('Authorization', `Bearer ${API_KEY}`).send(payload);
}

async function submit(payload, quoteToken, confirmed = true) {
    return request(app).post('/api/order-intake/v1/held-orders').set('Authorization', `Bearer ${API_KEY}`).send({
        draft: payload,
        quote_token: quoteToken,
        confirmed,
    });
}

describe('provider-neutral order-intake workflow', () => {
    beforeAll(async () => {
        await seedDatabase();
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active)
            VALUES (70, '9070', 'AI Order Intake', 'call_center', 1)
        `);
        await pool.query(`
            UPDATE products
               SET modifiers='[{"id":"g_size","name":"Size","required":true,"multi_select":false,"options":[{"id":"o_large","name":"Large","price":2}]}]'
             WHERE id=10
        `);
        apiServer = http.createServer(app);
        await listen(apiServer);
        const address = apiServer.address();
        apiBaseUrl = `http://127.0.0.1:${address.port}`;
    });

    beforeEach(async () => {
        await pool.query("DELETE FROM order_intake_requests WHERE client_id='integration-test'");
        await pool.query('DELETE FROM held_orders WHERE user_id=70');
        global.__mockEmit__?.mockClear?.();
    });

    afterAll(async () => {
        await close(apiServer);
        await pool.end();
    });

    it('fails closed without the dedicated bearer key', async () => {
        const missing = await request(app).get('/api/order-intake/v1/status');
        expect(missing.statusCode).toBe(401);
        expect(missing.body.code).toBe('ORDER_INTAKE_AUTH_REQUIRED');
        const browserCookie = await request(app).get('/api/order-intake/v1/status').set('Cookie', 'pos_token=fake');
        expect(browserCookie.statusCode).toBe(401);
        const invalid = await request(app).get('/api/order-intake/v1/status').set('Authorization', 'Bearer wrong-key');
        expect(invalid.statusCode).toBe(401);
    });

    it('reserves the configured machine actor from browser login', async () => {
        const denied = await request(app).post('/api/auth/login').send({ user_number: '9070' });
        expect(denied.statusCode).toBe(401);
        expect(denied.body).toMatchObject({ success: false, message: 'Invalid user number.' });
        expect((denied.headers['set-cookie'] || []).some(cookie => cookie.startsWith('pos_token='))).toBe(false);
    });

    it('does not expose internal failures or attached data in production', async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalEnforceHttps = process.env.ENFORCE_HTTPS;
        const failure = Object.assign(new Error('private database detail'), {
            statusCode: 500,
            publicData: { internal: 'must not escape' },
        });
        const spy = vi.spyOn(orderIntakeService, 'listOrderTypes').mockRejectedValueOnce(failure);
        process.env.NODE_ENV = 'production';
        process.env.ENFORCE_HTTPS = 'true';
        try {
            const response = await request(app)
                .get('/api/order-intake/v1/status')
                .set('Authorization', `Bearer ${API_KEY}`);
            expect(response.statusCode).toBe(500);
            expect(response.body.message).toBe('Operation failed. Please try again.');
            expect(JSON.stringify(response.body)).not.toContain('private database detail');
            expect(response.body).not.toHaveProperty('internal');
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
            if (originalEnforceHttps == null) delete process.env.ENFORCE_HTTPS;
            else process.env.ENFORCE_HTTPS = originalEnforceHttps;
            spy.mockRestore();
        }
    });

    it('exposes bounded order types, catalog discovery, natural search, and private customer lookup', async () => {
        const types = await request(app).get('/api/order-intake/v1/order-types').set('Authorization', `Bearer ${API_KEY}`);
        expect(types.statusCode).toBe(200);
        expect(types.body.order_types).toContainEqual({ id: 1, name: 'Dine In' });
        const status = await request(app).get('/api/order-intake/v1/status').set('Authorization', `Bearer ${API_KEY}`);
        expect(status.statusCode).toBe(200);
        expect(status.body.capabilities).toEqual(expect.arrayContaining(['catalog.browse', 'catalog.search']));

        const catalog = await request(app).get('/api/order-intake/v1/catalog/search?q=Test&limit=200').set('Authorization', `Bearer ${API_KEY}`);
        expect(catalog.statusCode).toBe(200);
        expect(catalog.body.products.length).toBeLessThanOrEqual(20);
        expect(catalog.body.products.find(product => product.id === SEED.product1.id)).toMatchObject({ name: 'Test Burger', unit_price: 5 });

        const [menuCategory] = await pool.query("INSERT INTO categories (name, is_active) VALUES ('Seasonal Menu', 1)");
        const [emptyCategory] = await pool.query("INSERT INTO categories (name, is_active) VALUES ('Empty Menu', 1)");
        const [notesCategory] = await pool.query("INSERT INTO categories (name, is_active, is_notes) VALUES ('Internal Notes', 1, 1)");
        const [inactiveCategory] = await pool.query("INSERT INTO categories (name, is_active) VALUES ('Hidden Menu', 0)");
        const [discoverableProduct] = await pool.query(`
            INSERT INTO products (name, price, tax_rate, category_id, is_active, is_available, is_bundle)
            VALUES ('Brightening Capsule Cream', 12, 0, ?, 1, 1, 0)
        `, [menuCategory.insertId]);
        const [secondDiscoverableProduct] = await pool.query(`
            INSERT INTO products (name, price, tax_rate, category_id, is_active, is_available, is_bundle)
            VALUES ('Seasonal Cleanser', 8, 0, ?, 1, 1, 0)
        `, [menuCategory.insertId]);
        const [notesProduct] = await pool.query(`
            INSERT INTO products (name, price, tax_rate, category_id, is_active, is_available, is_bundle)
            VALUES ('Do Not Read', 0, 0, ?, 1, 1, 0)
        `, [notesCategory.insertId]);
        const [inactiveProduct] = await pool.query(`
            INSERT INTO products (name, price, tax_rate, category_id, is_active, is_available, is_bundle)
            VALUES ('Hidden Product', 3, 0, ?, 1, 1, 0)
        `, [inactiveCategory.insertId]);
        try {
            const firstCategories = await request(app)
                .get('/api/order-intake/v1/catalog/browse?limit=1')
                .set('Authorization', `Bearer ${API_KEY}`);
            expect(firstCategories.statusCode).toBe(200);
            expect(firstCategories.body).toMatchObject({ view: 'categories' });
            expect(firstCategories.body.categories).toEqual([{ id: SEED.category.id, name: SEED.category.name }]);
            expect(firstCategories.body.next_cursor).toBe(SEED.category.id);

            const secondCategories = await request(app)
                .get(`/api/order-intake/v1/catalog/browse?limit=20&cursor=${firstCategories.body.next_cursor}`)
                .set('Authorization', `Bearer ${API_KEY}`);
            expect(secondCategories.statusCode).toBe(200);
            expect(secondCategories.body.categories).toContainEqual({ id: menuCategory.insertId, name: 'Seasonal Menu' });
            expect(secondCategories.body.categories).not.toContainEqual(expect.objectContaining({ id: emptyCategory.insertId }));
            expect(secondCategories.body.categories).not.toContainEqual(expect.objectContaining({ id: notesCategory.insertId }));
            expect(secondCategories.body.categories).not.toContainEqual(expect.objectContaining({ id: inactiveCategory.insertId }));

            const products = await request(app)
                .get(`/api/order-intake/v1/catalog/browse?category_id=${menuCategory.insertId}&limit=1`)
                .set('Authorization', `Bearer ${API_KEY}`);
            expect(products.statusCode).toBe(200);
            expect(products.body).toMatchObject({ view: 'products', next_cursor: discoverableProduct.insertId });
            expect(products.body.products).toEqual([{
                id: discoverableProduct.insertId,
                name: 'Brightening Capsule Cream',
                category: 'Seasonal Menu',
                unit_price: 12,
            }]);
            expect(products.body.products[0]).not.toHaveProperty('stock');
            expect(products.body.products[0]).not.toHaveProperty('modifiers');

            const nextProducts = await request(app)
                .get(`/api/order-intake/v1/catalog/browse?category_id=${menuCategory.insertId}&limit=1&cursor=${products.body.next_cursor}`)
                .set('Authorization', `Bearer ${API_KEY}`);
            expect(nextProducts.statusCode).toBe(200);
            expect(nextProducts.body).toMatchObject({ view: 'products', next_cursor: null });
            expect(nextProducts.body.products).toEqual([expect.objectContaining({
                id: secondDiscoverableProduct.insertId,
                name: 'Seasonal Cleanser',
            })]);

            const naturalSearch = await request(app)
                .get('/api/order-intake/v1/catalog/search?q=brightening%20cream')
                .set('Authorization', `Bearer ${API_KEY}`);
            expect(naturalSearch.statusCode).toBe(200);
            expect(naturalSearch.body.products).toContainEqual(expect.objectContaining({
                id: discoverableProduct.insertId,
                name: 'Brightening Capsule Cream',
            }));

            for (const query of ['category_id=abc', 'category_id=0', 'cursor=-1', 'cursor=1.5']) {
                const invalidBrowse = await request(app)
                    .get(`/api/order-intake/v1/catalog/browse?${query}`)
                    .set('Authorization', `Bearer ${API_KEY}`);
                expect(invalidBrowse.statusCode).toBe(400);
            }
        } finally {
            await pool.query('DELETE FROM products WHERE id IN (?, ?, ?, ?)', [
                discoverableProduct.insertId,
                secondDiscoverableProduct.insertId,
                notesProduct.insertId,
                inactiveProduct.insertId,
            ]);
            await pool.query('DELETE FROM categories WHERE id IN (?, ?, ?, ?)', [
                menuCategory.insertId,
                emptyCategory.insertId,
                notesCategory.insertId,
                inactiveCategory.insertId,
            ]);
        }

        const customer = await request(app).post('/api/order-intake/v1/customers/lookup').set('Authorization', `Bearer ${API_KEY}`).send({ phone: '0790000000' });
        expect(customer.statusCode).toBe(200);
        expect(customer.body.customer).toBeNull();

        const missingRequest = await request(app)
            .get('/api/order-intake/v1/requests/call-missing-0001')
            .set('Authorization', `Bearer ${API_KEY}`);
        expect(missingRequest.statusCode).toBe(200);
        expect(missingRequest.body.request).toBeNull();
        const invalidRequest = await request(app)
            .get('/api/order-intake/v1/requests/unsafe%20id')
            .set('Authorization', `Bearer ${API_KEY}`);
        expect(invalidRequest.statusCode).toBe(400);
    });

    it('omits empty bundles from catalog search and rejects them during quoting', async () => {
        const [inserted] = await pool.query(`
            INSERT INTO products (name, barcode, price, tax_rate, category_id, is_active, is_available, is_bundle)
            VALUES ('Empty Intake Bundle', 'EMPTY-INTAKE-BUNDLE', 9, 0, ?, 1, 1, 1)
        `, [SEED.category.id]);
        try {
            const catalog = await request(app)
                .get('/api/order-intake/v1/catalog/search?q=Empty%20Intake%20Bundle')
                .set('Authorization', `Bearer ${API_KEY}`);
            expect(catalog.statusCode).toBe(200);
            expect(catalog.body.products).not.toContainEqual(expect.objectContaining({ id: inserted.insertId }));

            const rejected = await quote(draft('call-empty-bundle', {
                items: [{ product_id: inserted.insertId, quantity: 1 }],
            }));
            expect(rejected.statusCode).toBe(409);
            expect(rejected.body.code).toBe('ORDER_INTAKE_BUNDLE_UNAVAILABLE');
        } finally {
            await pool.query('DELETE FROM products WHERE id=?', [inserted.insertId]);
        }
    });

    it('quotes from database authority and creates one hold-only order after confirmation', async () => {
        const payload = draft('call-create-0001');
        const quoted = await quote(payload);
        expect(quoted.statusCode).toBe(200);
        expect(quoted.body).toMatchObject({ success: true, currency: 'JOD', subtotal: 5, tax: 0.8, total: 5.8 });
        expect(Buffer.from(quoted.body.quote_token.split('.')[0], 'base64url').toString('utf8')).not.toContain('AI Customer');

        const unconfirmed = await submit(payload, quoted.body.quote_token, false);
        expect(unconfirmed.statusCode).toBe(409);
        expect(unconfirmed.body.code).toBe('ORDER_INTAKE_CONFIRMATION_REQUIRED');

        const [[beforePrint]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        const [[beforeOrders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const created = await submit(payload, quoted.body.quote_token);
        expect(created.statusCode).toBe(200);
        expect(created.body.held_order).toMatchObject({ replay: false, kitchen_fired: false });
        const [[held]] = await pool.query('SELECT user_id, call_center_user_id, kitchen_fired, order_id, cart_data FROM held_orders WHERE id=?', [created.body.held_order.id]);
        const stored = JSON.parse(held.cart_data);
        expect(held).toMatchObject({ user_id: 70, call_center_user_id: 70, kitchen_fired: 0, order_id: null });
        expect(stored._order_intake).toMatchObject({ client_id: 'integration-test', dispatch_policy: 'hold_only' });
        expect(stored.items[0]).toMatchObject({ product_id: SEED.product1.id, price: 5, tax_rate: 16 });
        const [[afterPrint]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        const [[afterOrders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        expect(Number(afterPrint.count)).toBe(Number(beforePrint.count));
        expect(Number(afterOrders.count)).toBe(Number(beforeOrders.count));
        expect(global.__mockEmit__.mock.calls).toContainEqual(['held_orders_changed', {
            action: 'created', source: 'call_center', channel: 'order_intake', held_order_id: created.body.held_order.id,
        }]);

        const replay = await submit(payload, quoted.body.quote_token);
        expect(replay.statusCode).toBe(200);
        expect(replay.body.held_order).toMatchObject({ id: created.body.held_order.id, replay: true });
    });

    it('supports required modifiers and server-hydrated bundles', async () => {
        const modifierPayload = draft('call-modifier-001', {
            items: [{ product_id: 10, quantity: 1, modifiers: [{ group_id: 'g_size', option_id: 'o_large' }] }],
        });
        const modifierQuote = await quote(modifierPayload);
        expect(modifierQuote.statusCode).toBe(200);
        expect(modifierQuote.body.items[0]).toMatchObject({ name: 'Modifier Product', unit_price: 7 });
        const missingRequired = await quote(draft('call-modifier-002', { items: [{ product_id: 10, quantity: 1 }] }));
        expect(missingRequired.statusCode).toBe(409);
        expect(missingRequired.body.code).toBe('ORDER_INTAKE_MODIFIER_REQUIRED');

        const bundleQuote = await quote(draft('call-bundle-0001', { items: [{ product_id: 4, quantity: 1 }] }));
        expect(bundleQuote.statusCode).toBe(200);
        expect(bundleQuote.body.items[0].bundle_items).toHaveLength(2);
        expect(bundleQuote.body.items[0].bundle_items.every(item => Number(item.category_id) === SEED.category.id)).toBe(true);
    });

    it('keeps quote query count bounded when a draft repeats the same bundle', async () => {
        const originalQuery = pool.query;
        const measuredQuote = async payload => {
            let count = 0;
            pool.query = function countedQuery(...args) {
                count += 1;
                return originalQuery.apply(this, args);
            };
            try {
                const response = await quote(payload);
                return { response, count };
            } finally {
                pool.query = originalQuery;
            }
        };
        const single = await measuredQuote(draft('call-bundle-query-1', {
            items: [{ product_id: 4, quantity: 1 }],
        }));
        const repeated = await measuredQuote(draft('call-bundle-query-40', {
            items: Array.from({ length: 40 }, () => ({ product_id: 4, quantity: 1 })),
        }));

        expect(single.response.statusCode).toBe(200);
        expect(repeated.response.statusCode).toBe(200);
        expect(repeated.response.body.items).toHaveLength(40);
        expect(repeated.count).toBe(single.count);
        console.info(`[order-intake-query-count] one bundle=${single.count}, forty repeated bundles=${repeated.count}`);
    });

    it('preserves separate item instructions and delivery notes in the quote and hold', async () => {
        const payload = draft('call-distinct-notes-01', {
            items: [{ product_id: 1, quantity: 1, note: 'بدون بصل' }, { product_id: 1, quantity: 1, note: 'الثومية على جنب' }],
            order_note: 'اتصل عند الوصول، الجرس لا يعمل',
        });
        const quoted = await quote(payload);
        expect(quoted.status).toBe(200);
        expect(quoted.body.items.map(item => item.note)).toEqual(['بدون بصل', 'الثومية على جنب']);
        expect(quoted.body.order_note).toBe(payload.order_note);
        expect(quoted.body.customer.address).toBe(payload.customer.address);
        const created = await submit(payload, quoted.body.quote_token);
        expect(created.status).toBe(200);
        const [[held]] = await pool.query('SELECT cart_data,kitchen_fired FROM held_orders WHERE id=?', [created.body.held_order.id]);
        const cart = JSON.parse(held.cart_data);
        expect(cart.items.map(item => item.note)).toEqual(['بدون بصل', 'الثومية على جنب']);
        expect(cart.order_note).toBe(payload.order_note);
        expect(Number(held.kitchen_fired)).toBe(0);
    });

    it('reports cashier-disabled products and rejects a disable after quoting without creating a hold', async () => {
        const payload = draft('call-disabled-after-quote');
        const quoted = await quote(payload);
        await pool.query('UPDATE products SET is_available=0 WHERE id=1');
        try {
            const search = await request(app).get('/api/order-intake/v1/catalog/search?q=Test%20Burger').set('Authorization', `Bearer ${API_KEY}`);
            expect(search.body.products).toEqual([]);
            expect(search.body.unavailable_products).toContainEqual(expect.objectContaining({ id: 1, available: false }));
            const rejected = await submit(payload, quoted.body.quote_token);
            expect(rejected.status).toBe(409);
            expect(rejected.body.code).toBe('ORDER_INTAKE_PRODUCT_UNAVAILABLE');
            const [[held]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=70');
            expect(Number(held.count)).toBe(0);
        } finally { await pool.query('UPDATE products SET is_available=1 WHERE id=1'); }
    });

    it('finds a product by an extra barcode, also when the cashier disabled it', async () => {
        await pool.query("INSERT INTO product_barcodes (product_id, barcode) VALUES (1, 'INTAKE-EXTRA-1')");
        const search = (text) => request(app).get(`/api/order-intake/v1/catalog/search?q=${text}`).set('Authorization', `Bearer ${API_KEY}`);
        try {
            const found = await search('INTAKE-EXTRA-1');
            expect(found.statusCode).toBe(200);
            expect(found.body.products).toEqual([expect.objectContaining({ id: 1, name: 'Test Burger' })]);
            expect((await search('INTAKE-EXTRA')).body.products).toEqual([]);
            await pool.query('UPDATE products SET is_available=0 WHERE id=1');
            const disabled = await search('INTAKE-EXTRA-1');
            expect(disabled.body.products).toEqual([]);
            expect(disabled.body.unavailable_products).toContainEqual(expect.objectContaining({ id: 1, available: false }));
        } finally {
            await pool.query('UPDATE products SET is_available=1 WHERE id=1');
            await pool.query("DELETE FROM product_barcodes WHERE barcode = 'INTAKE-EXTRA-1'");
        }
    });

    it('rejects injected money, unavailable products, and oversized bodies', async () => {
        const injected = await quote(draft('call-injected-01', { items: [{ product_id: 1, quantity: 1, price: 0.01 }] }));
        expect(injected.statusCode).toBe(400);
        expect(injected.body.message).toMatch(/unsupported fields: price/);

        await pool.query('UPDATE products SET is_available=0 WHERE id=?', [SEED.product1.id]);
        const unavailable = await quote(draft('call-unavailable-1'));
        await pool.query('UPDATE products SET is_available=1 WHERE id=?', [SEED.product1.id]);
        expect(unavailable.statusCode).toBe(409);
        expect(unavailable.body.code).toBe('ORDER_INTAKE_PRODUCT_UNAVAILABLE');

        const withinParserLimit = await request(app).post('/api/order-intake/v1/quotes').set('Authorization', `Bearer ${API_KEY}`).send({ padding: 'x'.repeat(64_000) });
        expect(withinParserLimit.statusCode).toBe(400);
        expect(withinParserLimit.body.message).toMatch(/unsupported fields/);
        const oversized = await request(app).post('/api/order-intake/v1/quotes').set('Authorization', `Bearer ${API_KEY}`).send({ padding: 'x'.repeat(2_100_000) });
        expect(oversized.statusCode).toBe(413);
    });

    it('enforces stock only while stock tracking is enabled', async () => {
        const [[previousProduct]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);
        const [[previousSetting]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled'");
        try {
            await pool.query('UPDATE products SET stock=0 WHERE id=?', [SEED.product1.id]);
            await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
            const allowed = await quote(draft('call-stock-disabled'));
            expect(allowed.statusCode).toBe(200);

            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
            const rejected = await quote(draft('call-stock-enabled'));
            expect(rejected.statusCode).toBe(409);
            expect(rejected.body.code).toBe('ORDER_INTAKE_STOCK_UNAVAILABLE');
        } finally {
            await pool.query('UPDATE products SET stock=? WHERE id=?', [previousProduct.stock, SEED.product1.id]);
            await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='stock_enabled'", [previousSetting.setting_value]);
        }
    });

    it('requires a new confirmation when catalog pricing changes after the quote', async () => {
        const payload = draft('call-requote-0001');
        const quoted = await quote(payload);
        await pool.query('UPDATE products SET price=price+1 WHERE id=?', [SEED.product1.id]);
        const changed = await submit(payload, quoted.body.quote_token);
        await pool.query('UPDATE products SET price=price-1 WHERE id=?', [SEED.product1.id]);
        expect(changed.statusCode).toBe(409);
        expect(changed.body).toMatchObject({ code: 'ORDER_INTAKE_REQUOTE_REQUIRED' });
        expect(changed.body.quote.total).toBe(6.96);
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=70');
        expect(Number(count.count)).toBe(0);
    });

    it('serializes catalog writes against hold creation instead of accepting a stale committed snapshot', async () => {
        const payload = draft('call-serialized-catalog-write');
        const quoted = await quote(payload);
        const originalGetConnection = pool.getConnection;
        let releaseCatalogRead;
        let signalCatalogRead;
        const catalogRead = new Promise(resolve => { signalCatalogRead = resolve; });
        const continueSubmission = new Promise(resolve => { releaseCatalogRead = resolve; });
        let intercepted = false;
        let writer;
        try {
            pool.getConnection = async function getInstrumentedConnection() {
                const connection = await originalGetConnection.call(pool);
                if (intercepted) return connection;
                intercepted = true;
                let signaled = false;
                return new Proxy(connection, {
                    get(target, property) {
                        if (property === 'query') {
                            return async (...args) => {
                                const result = await target.query(...args);
                                if (!signaled && /FROM products p/.test(String(args[0]))) {
                                    signaled = true;
                                    signalCatalogRead();
                                    await continueSubmission;
                                }
                                return result;
                            };
                        }
                        const value = target[property];
                        return typeof value === 'function' ? value.bind(target) : value;
                    },
                });
            };

            const submitting = Promise.resolve(submit(payload, quoted.body.quote_token));
            await Promise.race([
                catalogRead,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Hold submission did not reach the catalog read.')), 5000)),
            ]);
            writer = await originalGetConnection.call(pool);
            const update = writer.query('UPDATE products SET price=price+1 WHERE id=?', [SEED.product1.id]);
            const completedEarly = await Promise.race([
                update.then(() => true),
                new Promise(resolve => setTimeout(() => resolve(false), 100)),
            ]);
            expect(completedEarly).toBe(false);

            releaseCatalogRead();
            const created = await submitting;
            expect(created.statusCode).toBe(200);
            await update;
            const [[held]] = await pool.query('SELECT cart_data FROM held_orders WHERE id=?', [created.body.held_order.id]);
            expect(JSON.parse(held.cart_data).items[0].price).toBe(5);
            const [[current]] = await pool.query('SELECT price FROM products WHERE id=?', [SEED.product1.id]);
            expect(Number(current.price)).toBe(6);
        } finally {
            pool.getConnection = originalGetConnection;
            releaseCatalogRead?.();
            writer?.release();
            await pool.query('UPDATE products SET price=5 WHERE id=?', [SEED.product1.id]);
        }
    });

    it('allows more than the human 20-hold queue while preserving machine idempotency', async () => {
        const rows = Array.from({ length: 20 }, (_, index) => [70, 70, `existing-${index}`, `Existing ${index}`, '{"items":[]}', 0]);
        await pool.query(`
            INSERT INTO held_orders (user_id, call_center_user_id, hold_request_id, reference_name, cart_data, subtotal)
            VALUES ?
        `, [rows]);
        const payload = draft('call-over-human-cap');
        const quoted = await quote(payload);
        const created = await submit(payload, quoted.body.quote_token);
        expect(created.statusCode).toBe(200);
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=70');
        expect(Number(count.count)).toBe(21);
    });

    it('stops at the configured machine hold limit', async () => {
        const rows = Array.from({ length: 20 }, (_, index) => [70, 70, `capacity-${index}`, `Capacity ${index}`, '{"items":[]}', 0]);
        await pool.query(`
            INSERT INTO held_orders (user_id, call_center_user_id, hold_request_id, reference_name, cart_data, subtotal)
            VALUES ?
        `, [rows]);
        process.env.ORDER_INTAKE_ACTIVE_HOLD_LIMIT = '20';
        try {
            const payload = draft('call-at-capacity-01');
            const quoted = await quote(payload);
            const blocked = await submit(payload, quoted.body.quote_token);
            expect(blocked.statusCode).toBe(429);
            expect(blocked.body.code).toBe('ORDER_INTAKE_ACTIVE_HOLD_LIMIT');
        } finally {
            process.env.ORDER_INTAKE_ACTIVE_HOLD_LIMIT = '200';
        }
    });

    it('serializes the queue boundary so simultaneous creates cannot exceed the limit', async () => {
        const rows = Array.from({ length: 19 }, (_, index) => [70, 70, `boundary-${index}`, `Boundary ${index}`, '{"items":[]}', 0]);
        await pool.query(`
            INSERT INTO held_orders (user_id, call_center_user_id, hold_request_id, reference_name, cart_data, subtotal)
            VALUES ?
        `, [rows]);
        process.env.ORDER_INTAKE_ACTIVE_HOLD_LIMIT = '20';
        try {
            const payloads = [draft('call-boundary-0001'), draft('call-boundary-0002')];
            const quotes = await Promise.all(payloads.map(payload => quote(payload)));
            const responses = await Promise.all(payloads.map((payload, index) => submit(payload, quotes[index].body.quote_token)));
            expect(responses.map(response => response.statusCode).sort()).toEqual([200, 429]);
            const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE call_center_user_id=70');
            expect(Number(count.count)).toBe(20);
        } finally {
            process.env.ORDER_INTAKE_ACTIVE_HOLD_LIMIT = '200';
        }
    });

    it('creates one row under concurrent duplicate submissions and conflicts on changed reuse', async () => {
        const payload = draft('call-concurrent-01');
        const quoted = await quote(payload);
        const [left, right] = await Promise.all([
            submit(payload, quoted.body.quote_token),
            submit(payload, quoted.body.quote_token),
        ]);
        expect([left.statusCode, right.statusCode], JSON.stringify([left.body, right.body])).toEqual([200, 200]);
        expect(left.body.held_order.id).toBe(right.body.held_order.id);
        expect([left.body.held_order.replay, right.body.held_order.replay].sort()).toEqual([false, true]);

        const changed = draft('call-concurrent-01', { order_note: 'different request' });
        const changedQuote = await quote(changed);
        const conflict = await submit(changed, changedQuote.body.quote_token);
        expect(conflict.statusCode).toBe(409);
        expect(conflict.body.code).toBe('ORDER_INTAKE_IDEMPOTENCY_CONFLICT');
    });

    it('keeps the request id durable after the held order is consumed or canceled', async () => {
        const payload = draft('call-durable-replay');
        const quoted = await quote(payload);
        const created = await submit(payload, quoted.body.quote_token);
        const createdId = created.body.held_order.id;
        await pool.query("DELETE FROM audit_events WHERE entity_type='held_order' AND entity_id=?", [createdId]);
        await pool.query('DELETE FROM held_orders WHERE id=?', [createdId]);

        const originalQuoteSecret = process.env.ORDER_INTAKE_QUOTE_SECRET;
        process.env.ORDER_INTAKE_QUOTE_SECRET = 'rotated-quote-secret-with-at-least-thirty-two-characters';
        await pool.query('UPDATE users SET is_active=0 WHERE id=70');
        try {
            const lookup = await request(app)
                .get(`/api/order-intake/v1/requests/${payload.external_request_id}`)
                .set('Authorization', `Bearer ${API_KEY}`);
            expect(lookup.statusCode).toBe(200);
            expect(lookup.body.request).toMatchObject({ id: createdId, replay: true, active: false });
            await pool.query('UPDATE users SET is_active=1 WHERE id=70');
            const replay = await submit(payload, quoted.body.quote_token);
            expect(replay.statusCode).toBe(200);
            expect(replay.body.held_order).toMatchObject({ id: createdId, replay: true, active: false });
        } finally {
            process.env.ORDER_INTAKE_QUOTE_SECRET = originalQuoteSecret;
            await pool.query('UPDATE users SET is_active=1 WHERE id=70');
        }
        const [[holds]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=70');
        const [[requests]] = await pool.query("SELECT COUNT(*) AS count FROM order_intake_requests WHERE client_id='integration-test'");
        expect(Number(holds.count)).toBe(0);
        expect(Number(requests.count)).toBe(1);
    });

    it('returns a committed hold even when the advisory socket notification throws', async () => {
        const payload = draft('call-socket-failure');
        const quoted = await quote(payload);
        global.__mockEmit__.mockImplementation(event => {
            if (event === 'held_orders_changed') throw new Error('simulated socket failure');
        });
        try {
            const created = await submit(payload, quoted.body.quote_token);
            expect(created.statusCode).toBe(200);
            expect(created.body.held_order).toMatchObject({ replay: false, active: true });
            const [[held]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id=?', [created.body.held_order.id]);
            const [[record]] = await pool.query(
                'SELECT COUNT(*) AS count FROM order_intake_requests WHERE client_id=? AND external_request_id=?',
                ['integration-test', payload.external_request_id]
            );
            expect(Number(held.count)).toBe(1);
            expect(Number(record.count)).toBe(1);
        } finally {
            global.__mockEmit__.mockReset();
        }
    });

    it('writes nothing when the client connection drops before the create body is complete', async () => {
        const payload = draft('call-partial-body-0001');
        const quoted = await quote(payload);
        const body = JSON.stringify({ draft: payload, quote_token: quoted.body.quote_token, confirmed: true });
        await new Promise(resolve => {
            const target = new URL('/api/order-intake/v1/held-orders', apiBaseUrl);
            const transport = http.request(target, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${API_KEY}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            });
            transport.once('error', () => resolve());
            transport.once('close', () => resolve());
            transport.once('socket', socket => {
                const cutConnection = () => {
                    transport.write(body.slice(0, Math.floor(body.length / 2)));
                    setTimeout(() => transport.destroy(), 10).unref?.();
                };
                if (socket.connecting) socket.once('connect', cutConnection); else cutConnection();
            });
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        const [[held]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=70');
        const [[ledger]] = await pool.query("SELECT COUNT(*) AS count FROM order_intake_requests WHERE client_id='integration-test'");
        expect(Number(held.count)).toBe(0);
        expect(Number(ledger.count)).toBe(0);
    });

    it('replays one committed hold when the client times out before receiving the response', async () => {
        const payload = draft('call-response-timeout-0001');
        const quoted = await quote(payload);
        const createBody = { draft: payload, quote_token: quoted.body.quote_token, confirmed: true };
        const { proxy, baseUrl, upstreamFinished } = await createResponseWithholdingProxy();
        const client = new AbortController();
        let withheld;
        try {
            const sent = fetch(`${baseUrl}/api/order-intake/v1/held-orders`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(createBody),
                signal: client.signal,
            });
            sent.catch(() => {});
            // The client gives up only after the server has committed and answered.
            withheld = await upstreamFinished;
            client.abort();
            await expect(sent).rejects.toThrow();
        } finally {
            client.abort();
            await close(proxy);
        }
        expect(withheld.statusCode).toBe(200);

        const [[committed]] = await pool.query(`
            SELECT intake.held_order_id, COUNT(*) AS count
              FROM order_intake_requests intake
             WHERE intake.client_id='integration-test' AND intake.external_request_id=?
             GROUP BY intake.held_order_id
        `, [payload.external_request_id]);
        expect(Number(committed.count)).toBe(1);
        expect(JSON.parse(withheld.body).held_order).toMatchObject({ id: Number(committed.held_order_id), replay: false });
        const lookup = await request(app)
            .get(`/api/order-intake/v1/requests/${payload.external_request_id}`)
            .set('Authorization', `Bearer ${API_KEY}`);
        expect(lookup.statusCode).toBe(200);
        expect(lookup.body.request).toMatchObject({
            id: Number(committed.held_order_id),
            replay: true,
            active: true,
        });
        const replay = await submit(payload, quoted.body.quote_token);
        expect(replay.statusCode).toBe(200);
        expect(replay.body.held_order).toMatchObject({
            id: Number(committed.held_order_id),
            replay: true,
            active: true,
        });
        const [[held]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=70');
        const [[orders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const [[prints]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        expect(Number(held.count)).toBe(1);
        expect(Number(orders.count)).toBe(0);
        expect(Number(prints.count)).toBe(0);
    });

    it('rolls back the held row when the durable replay record cannot be inserted', async () => {
        const payload = draft('call-ledger-failure-0001');
        const quoted = await quote(payload);
        await pool.query(`
            CREATE TRIGGER test_order_intake_ledger_failure
            BEFORE INSERT ON order_intake_requests
            FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='forced replay ledger failure'
        `);
        let failed;
        try {
            failed = await submit(payload, quoted.body.quote_token);
        } finally {
            await pool.query('DROP TRIGGER IF EXISTS test_order_intake_ledger_failure');
        }
        expect(failed.statusCode).toBe(500);
        const [[heldAfterFailure]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=70');
        const [[ledgerAfterFailure]] = await pool.query("SELECT COUNT(*) AS count FROM order_intake_requests WHERE client_id='integration-test'");
        expect(Number(heldAfterFailure.count)).toBe(0);
        expect(Number(ledgerAfterFailure.count)).toBe(0);

        const recovered = await submit(payload, quoted.body.quote_token);
        expect(recovered.statusCode).toBe(200);
        expect(recovered.body.held_order).toMatchObject({ replay: false, active: true });
    });

    it('admits eight distinct simultaneous confirmed holds without duplicate or print side effects', async () => {
        const payloads = Array.from({ length: 8 }, (_, index) => draft(`call-load-${index.toString().padStart(4, '0')}`));
        const startedAt = Date.now();
        const quotes = await Promise.all(payloads.map(payload => quote(payload)));
        expect(quotes.every(response => response.statusCode === 200), JSON.stringify(quotes.map(response => response.body))).toBe(true);
        const [[printsBefore]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        const created = await Promise.all(payloads.map((payload, index) => submit(payload, quotes[index].body.quote_token)));
        const elapsedMs = Date.now() - startedAt;
        expect(created.every(response => response.statusCode === 200), JSON.stringify(created.map(response => response.body))).toBe(true);
        expect(new Set(created.map(response => response.body.held_order.id)).size).toBe(8);
        const [[holds]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=70');
        const [[printsAfter]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        expect(Number(holds.count)).toBe(8);
        expect(Number(printsAfter.count)).toBe(Number(printsBefore.count));
        console.info(`[order-intake-load] 8 quote+create workflows completed in ${elapsedMs}ms`);
    });

    it('fails closed when the configured actor is disabled', async () => {
        await pool.query('UPDATE users SET is_active=0 WHERE id=70');
        const response = await quote(draft('call-disabled-001'));
        await pool.query('UPDATE users SET is_active=1 WHERE id=70');
        expect(response.statusCode).toBe(503);
        expect(response.body.code).toBe('ORDER_INTAKE_ACTOR_UNAVAILABLE');
    });
});
