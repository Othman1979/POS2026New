const { refreshAttention } = require('../../services/StockLedgerService');
const { availabilitySql } = require('../../services/StockProductAdapter');
const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const express = require('express');
const router = express.Router();
const {
    pool,
    sendSuccess,
    sendError,
    logAdminRouteError,
    invalidateCatalogCache,
    invalidateDashboardCache,
    triggerStaticMenuGeneration,
    parsePagination,
    emitInventoryChanged,
    emitStockChanged
} = require('./helpers');
const logger = require('../../config/logger');
const { healOpenOrdersForProduct } = require('../../services/OrderPricing');
const { normalizeModifierDefinition } = require('../../services/modifierDefs');
const { appendAuditEvent, isAuditDisabled } = require('../../services/auditEvents');
const { lockJofotaraPolicy, validateJofotaraCatalogRates } = require('../../services/JofotaraService');
const { normalizeJofotaraTaxCategory } = require('../../config/taxRegistration');
const stockActivation = require('../../services/StockActivationService');
const { announceStockChanged } = require('../../services/StockEventScope');
const stockRead = require('../../services/StockReadService');
const productBarcodes = require('../../services/productBarcodes');
const productPacks = require('../../services/ProductPacks');
const {
    grossToNet,
    collectCategorySubtree,
    resolveInheritedRootId
} = require('../../services/categoryPriceLists');

// Fire-and-forget audit writer — never blocks the mutation response.
function writeAudit(req, { event_type, entity_type, entity_id, old_value = null, new_value = null }) {
    appendAuditEvent(pool, {
        eventType: event_type,
        userId: req.user?.id || null,
        entityType: entity_type,
        entityId: entity_id,
        oldValue: old_value,
        newValue: new_value,
        ipAddress: req.ip || null
    }).catch(err => logger.error({ err }, `audit_events: failed to log ${event_type}`));
}

function afterCatalogMutation(req, { productIds, stockOnly = false } = {}) {
    invalidateCatalogCache();
    invalidateDashboardCache();
    triggerStaticMenuGeneration();
    if (stockOnly) emitStockChanged(req);
    else emitInventoryChanged(req, productIds);
}

function categoryError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function optionalCategoryId(value, fieldName = 'Parent category') {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw categoryError(400, `${fieldName} is invalid.`);
    return id;
}

function requestBoolean(body, key, fallback) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return fallback;
    const value = body[key];
    if (![true, false, 1, 0, '1', '0'].includes(value)) {
        throw categoryError(400, `${key} must be a boolean.`);
    }
    return value === true || value === 1 || value === '1';
}

async function inheritedRootForParent(conn, parentId) {
    if (parentId == null) return null;
    const [[parent]] = await conn.query(
        'SELECT id, parent_id, price_list_root_id, is_notes FROM categories WHERE id = ? FOR UPDATE',
        [parentId]
    );
    if (!parent) throw categoryError(400, 'Parent category was not found.');
    if (parent.price_list_root_id == null) return null;
    const [[root]] = await conn.query(
        'SELECT id, parent_id, price_list_root_id, is_notes FROM categories WHERE id = ? FOR UPDATE',
        [parent.price_list_root_id]
    );
    return resolveInheritedRootId(new Map([[Number(parent.id), parent], [Number(root?.id), root]]), parentId);
}

function normalizeBatchProduct(data, categoryId) {
    const taxRate = parseFloat(data.tax_rate) || 0;
    const grossPrice = parseFloat(data.price) || 0;
    return {
        category_id: categoryId,
        name: String(data.name).trim(),
        customer_info: data.customer_info?.trim() || null,
        price: grossToNet(grossPrice, taxRate),
        gross_price: grossPrice,
        cost_price: data.cost_price !== undefined && data.cost_price !== null && data.cost_price !== '' ? Number(data.cost_price) : 0,
        tax_rate: taxRate,
        jofotara_tax_category: normalizeProductTaxCategory(data.jofotara_tax_category, taxRate),
        barcode: data.barcode !== undefined && data.barcode !== null && String(data.barcode).trim() !== '' ? String(data.barcode).trim() : null,
        stock: data.stock !== undefined && data.stock !== null && data.stock !== '' ? Number(data.stock) : null,
        background_color: data.background_color || null
    };
}

function normalizeProductTaxCategory(value, taxRate) {
    try {
        return normalizeJofotaraTaxCategory(value, taxRate);
    } catch (error) {
        throw categoryError(400, error.message);
    }
}

// Validates a product create/update body. Returns an error string, or null if OK.
// Mirrors routes/admin/import.js so both entry points agree.
function validateProductInput(data, { requirePrice }) {
    for (const field of ['customer_info', 'previous_customer_info']) {
        if (data[field] !== undefined && data[field] !== null && (typeof data[field] !== 'string' || data[field].length > 1200)) {
            return 'Customer information must be text of at most 1200 characters.';
        }
    }
    const nameSent = data.name !== undefined && data.name !== null;
    if (requirePrice && !nameSent) return 'Product name is required.';
    if (nameSent && String(data.name).trim() === '') return 'Product name is required.';
    // Presence check FIRST — Number('') is 0, so an empty string would otherwise pass the ≥0 test.
    const priceSent = data.price !== undefined && data.price !== null && String(data.price).trim() !== '';
    if (requirePrice && !priceSent) return 'Price is required.';
    if (requirePrice || priceSent) {
        const price = Number(data.price);
        if (!Number.isFinite(price) || price < 0) return 'Price must be a number ≥ 0.';
    }
    if (data.tax_rate !== undefined && data.tax_rate !== null && data.tax_rate !== '') {
        const tax = Number(data.tax_rate);
        if (!Number.isFinite(tax) || tax < 0 || tax > 100) return 'Tax rate must be between 0 and 100.';
    }
    for (const field of ['stock', 'cost_price', 'min_stock_level']) {
        const v = data[field];
        if (v !== undefined && v !== null && v !== '' && !Number.isFinite(Number(v))) {
            return `${field} must be a number.`;
        }
    }
    return null;
}

// Creates a manually-entered category batch as one unit. The transaction keeps
// an invalid or duplicate row from leaving a half-created catalog behind.
router.post('/products/batch', async (req, res) => {
    const categoryId = Number.parseInt(req.body?.category_id, 10);
    const rows = req.body?.products;

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return sendError(res, 400, 'Select a category before saving.');
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        return sendError(res, 400, 'Add at least one product.');
    }
    if (rows.length > 500) {
        return sendError(res, 400, 'A batch can contain at most 500 products.');
    }

    const rowErrors = [];
    const names = new Map();
    const barcodes = new Map();
    const normalized = rows.map((row, index) => {
        const validationError = validateProductInput(row || {}, { requirePrice: true });
        if (validationError) rowErrors.push({ row: index, message: validationError });

        const product = validationError ? null : normalizeBatchProduct(row, categoryId);
        if (!product) return null;

        if (product.name.length > 100) {
            rowErrors.push({ row: index, field: 'name', message: 'Product name cannot exceed 100 characters.' });
        }
        if (product.barcode && product.barcode.length > 50) {
            rowErrors.push({ row: index, field: 'barcode', message: 'Barcode cannot exceed 50 characters.' });
        }
        if (product.cost_price < 0) {
            rowErrors.push({ row: index, field: 'cost_price', message: 'Cost cannot be negative.' });
        }
        if (row.stock !== undefined && row.stock !== null && row.stock !== '' && (!Number.isFinite(Number(row.stock)) || Number(row.stock) < 0)) {
            rowErrors.push({ row: index, field: 'stock', message: 'Opening stock must be zero or more.' });
        }

        const nameKey = product.name.toLocaleLowerCase();
        if (names.has(nameKey)) {
            rowErrors.push({ row: index, field: 'name', message: 'Product name is repeated in this category batch.' });
        } else {
            names.set(nameKey, index);
        }

        if (product.barcode) {
            const barcodeKey = product.barcode.toLocaleLowerCase();
            if (barcodes.has(barcodeKey)) {
                rowErrors.push({ row: index, field: 'barcode', message: 'Barcode is repeated in this batch.' });
            } else {
                barcodes.set(barcodeKey, index);
            }
        }

        if (product.background_color && !/^#[0-9a-f]{6}$/i.test(product.background_color)) {
            rowErrors.push({ row: index, field: 'background_color', message: 'Product color must be a 6-digit hex value.' });
        }
        return product;
    });

    if (rowErrors.length > 0) {
        const hasDuplicate = rowErrors.some(error => /repeated/i.test(error.message));
        return res.status(hasDuplicate ? 409 : 400).json({
            success: false,
            message: 'Fix the highlighted products before saving.',
            row_errors: rowErrors
        });
    }

        const conn = await getStockConnection(pool);
        const created = [];
        try {
            await conn.beginTransaction();
            const fiscalSettings = await lockJofotaraPolicy(conn);
            await validateJofotaraCatalogRates(conn, fiscalSettings, normalized.map(product => product.tax_rate));

        const [[category]] = await conn.query(
            'SELECT id FROM categories WHERE id = ? AND is_active = 1 AND is_notes = 0',
            [categoryId]
        );
        if (!category) {
            await conn.rollback();
            return sendError(res, 400, 'The selected category is unavailable.');
        }

        const [existingNames] = await conn.query(
            'SELECT name FROM products WHERE category_id = ?',
            [categoryId]
        );
        const existingNameKeys = new Set(existingNames.map(row => String(row.name).trim().toLocaleLowerCase()));
        const duplicateNameRows = normalized
            .map((product, index) => existingNameKeys.has(product.name.toLocaleLowerCase()) ? { row: index, field: 'name', message: 'A product with this name already exists in the selected category.' } : null)
            .filter(Boolean);

        let duplicateBarcodeRows = [];
        const submittedBarcodes = normalized.map(product => product.barcode).filter(Boolean);
        if (submittedBarcodes.length > 0) {
            // A code is taken whether another product holds it as its main or as an extra barcode, compared by the database.
            const taken = await productBarcodes.takenCodes(conn, submittedBarcodes);
            duplicateBarcodeRows = normalized
                .map((product, index) => product.barcode && taken.has(product.barcode) ? { row: index, field: 'barcode', message: 'This barcode is already used by another product.' } : null)
                .filter(Boolean);
        }

        const existingErrors = [...duplicateNameRows, ...duplicateBarcodeRows];
        if (existingErrors.length > 0) {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message: 'Some products already exist. Nothing was saved.',
                row_errors: existingErrors
            });
        }

        for (const product of normalized) {
            const [result] = await conn.query(
                `INSERT INTO products
                 (category_id, name, price, cost_price, tax_rate, jofotara_tax_category, barcode, modifiers, stock, min_stock_level, background_color, is_bundle, customer_info)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 0, ?)`,
                [
                    product.category_id,
                    product.name,
                    product.price,
                    product.cost_price,
                    product.tax_rate,
                    product.jofotara_tax_category,
                    product.barcode,
                    product.stock,
                    product.background_color,
                    product.customer_info
                ]
            );
            created.push({ id: result.insertId, ...product });
        }

        if (!(await isAuditDisabled(conn, req.user?.id))) {
            const auditValues = created.map(product => [
                'product_created',
                req.user?.id || null,
                'product',
                product.id,
                null,
                JSON.stringify({
                    name: product.name,
                    price: product.price,
                    gross_price: product.gross_price,
                    stock: product.stock,
                    batch: true
                }),
                req.ip || null
            ]);
            await conn.query(
                `INSERT INTO audit_events
                 (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                 VALUES ?`,
                [auditValues]
            );
        }

        await conn.commit();
    } catch (e) {
        await conn.rollback();
        if (e?.code === 'ER_DUP_ENTRY') {
            return sendError(res, 409, 'A product name or barcode changed while saving. Review the batch and try again.');
        }
        logAdminRouteError(req, e);
        return sendError(res, 500, e.message);
    } finally {
        conn.release();
    }

    afterCatalogMutation(req, { productIds: created.map(product => product.id) });
    return sendSuccess(res, {
        message: `${created.length} products added.`,
        created_count: created.length,
        ids: created.map(product => product.id)
    });
});

router.get('/stock/items', async (req, res) => {
    try { return sendSuccess(res, await stockRead.list(pool, req.query)); }
    catch (error) {
        if (!error.statusCode) logAdminRouteError(req, error);
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Unable to load stock items.');
    }
});

router.get('/stock/products/:id/activation', async (req, res) => {
    try { return sendSuccess(res, await stockActivation.inspect(pool, req.params.id)); }
    catch (error) {
        if (!error.statusCode) logAdminRouteError(req, error);
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Unable to check stock activation.');
    }
});

router.post('/stock/products/:id/activate', async (req, res) => {
    try {
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
            const conn = await getStockConnection(pool);
            try {
                // One-transaction setting: do not change the pooled session's
                // default isolation for unrelated requests.
                await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
                await conn.beginTransaction();
                result = await stockActivation.activate(conn, req.params.id, req.body, req.user.id, req.ip);
                await conn.commit();
                break;
            } catch (error) {
                await conn.rollback();
                if (error.code === 'ER_LOCK_DEADLOCK' && attempt < 2) continue;
                if (error.code === 'ER_DUP_ENTRY') throw categoryError(409, 'Stock activation changed. Reload the product and review its stock record.');
                throw error;
            } finally { conn.release(); }
        }
        if (!result.replayed) afterCatalogMutation(req, { productIds: [req.params.id] });
        return sendSuccess(res, result);
    } catch (error) {
        if (!error.statusCode) logAdminRouteError(req, error);
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Unable to activate stock. Retry the same operation.');
    }
});

router.get('/stock/ingredients/:id/activation', async (req, res) => {
    try { return sendSuccess(res, await stockActivation.inspectIngredient(pool, req.params.id)); }
    catch (error) {
        if (!error.statusCode) logAdminRouteError(req, error);
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Unable to check stock activation.');
    }
});

router.post('/stock/ingredients/:id/activate', async (req, res) => {
    try {
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
            const conn = await getStockConnection(pool);
            try {
                await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
                await conn.beginTransaction();
                result = await stockActivation.activateIngredient(conn, req.params.id, req.body, req.user.id, req.ip);
                await conn.commit();
                break;
            } catch (error) {
                await conn.rollback();
                if (error.code === 'ER_LOCK_DEADLOCK' && attempt < 2) continue;
                if (error.code === 'ER_DUP_ENTRY') throw categoryError(409, 'Stock activation changed. Reload the ingredient and review its stock record.');
                throw error;
            } finally { conn.release(); }
        }
        if (!result.replayed) {
            req.io?.to('staff').emit('ingredients_changed', { ingredientIds: [result.ingredient_id] });
            // Activation changes the availability of products linked to the ingredient.
            invalidateCatalogCache();
            if (req.io) announceStockChanged(req.io, { ingredientIds: [result.ingredient_id], logContext: { route: req.originalUrl, method: req.method } });
        }
        return sendSuccess(res, result);
    } catch (error) {
        if (!error.statusCode) logAdminRouteError(req, error);
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Unable to activate stock. Retry the same operation.');
    }
});

// ALL /api/admin/products
router.all('/products', async (req, res) => {
    try {
        if (req.method === 'GET') {
            const hasPagedRequest = req.query.page !== undefined ||
                                    req.query.limit !== undefined ||
                                    req.query.search !== undefined ||
                                    req.query.category_ids !== undefined ||
                                    req.query.status !== undefined ||
                                    req.query.stock_status !== undefined ||
                                    req.query.sort !== undefined;
            if (hasPagedRequest) {
                const { page, limit, offset } = parsePagination(req.query);
                const search = String(req.query.search || '').trim();
                const categoryIdsStr = String(req.query.category_ids || '').trim();
                const status = String(req.query.status || '').trim();
                const stockStatus = String(req.query.stock_status || '').trim();
                const sort = String(req.query.sort || '').trim();

                const where = [];
                const params = [];

                if (search) {
                    where.push("(p.name LIKE ? OR p.barcode LIKE ? OR p.sku LIKE ? OR c.name LIKE ? OR p.id IN (SELECT product_id FROM product_barcodes WHERE barcode LIKE ?))");
                    const q = `%${search}%`;
                    params.push(q, q, q, q, q);
                }

                if (categoryIdsStr) {
                    const ids = categoryIdsStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
                    if (ids.length > 0) {
                        const placeholders = ids.map(() => '?').join(',');
                        where.push(`p.category_id IN (${placeholders})`);
                        params.push(...ids);
                    }
                }

                if (status === 'active') {
                    where.push("p.is_active = 1");
                } else if (status === 'inactive') {
                    where.push("p.is_active = 0");
                }

                const [threshRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'low_stock_threshold'");
                const threshold = threshRows.length > 0 ? parseInt(threshRows[0].setting_value, 10) : 3;

                if (stockStatus === 'low') {
                    where.push(`${availabilitySql('p')} <= ?`);
                    params.push(threshold);
                } else if (stockStatus === 'out') {
                    where.push(`${availabilitySql('p')} <= 0`);
                } else if (stockStatus === 'in') {
                    where.push(`(${availabilitySql('p')} IS NULL OR ${availabilitySql('p')} > ?)`);
                    params.push(threshold);
                }

                const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

                const sortMap = {
                    newest: 'p.is_active DESC, p.id DESC',
                    name: 'p.name ASC',
                    price_desc: 'p.price DESC',
                    stock_asc: `${availabilitySql('p')} IS NULL, ${availabilitySql('p')} ASC`
                };
                const orderBy = sortMap[sort] || sortMap.newest;

                const [countRows] = await pool.query(`
                    SELECT COUNT(*) AS total
                    FROM products p
                    LEFT JOIN categories c ON p.category_id = c.id
                    ${whereSql}
                `, params);

                const [products] = await pool.query(`
                    SELECT p.*, ${availabilitySql('p')} AS stock, c.name as category_name,
                    (SELECT CAST(MIN(stock_item_id) AS CHAR) FROM product_stock_links WHERE product_id=p.id) AS stock_item_id,
                    (SELECT pk.product_id FROM product_packs pk WHERE pk.sale_product_id=p.id) AS pack_of_product_id
                    FROM products p
                    LEFT JOIN categories c ON p.category_id = c.id

                    ${whereSql}
                    ORDER BY ${orderBy}
                    LIMIT ? OFFSET ?
                `, [...params, limit, offset]);
                await productBarcodes.attachExtras(pool, products);

                const [[activeStats]] = await pool.query("SELECT COUNT(*) AS active_products FROM products p WHERE p.is_active = 1");
                const [[lowStockStats]] = await pool.query(`SELECT COUNT(*) AS low_stock FROM products p WHERE p.is_active = 1 AND ${availabilitySql('p')} <= ?`, [threshold]);
                const total = Number(countRows[0]?.total || 0);

                return sendSuccess(res, {
                    products,
                    pagination: {
                        total,
                        page,
                        limit,
                        total_pages: Math.max(1, Math.ceil(total / limit))
                    },
                    stats: {
                        active_products: Number(activeStats?.active_products || 0),
                        low_stock: Number(lowStockStats?.low_stock || 0)
                    }
                });
            }

            const [products] = await pool.query(`
                SELECT p.*, ${availabilitySql('p')} AS stock, c.name as category_name,
                    (SELECT CAST(MIN(stock_item_id) AS CHAR) FROM product_stock_links WHERE product_id=p.id) AS stock_item_id,
                    (SELECT pk.product_id FROM product_packs pk WHERE pk.sale_product_id=p.id) AS pack_of_product_id
                FROM products p
                LEFT JOIN categories c ON p.category_id = c.id

                ORDER BY p.is_active DESC, p.id DESC
                LIMIT 500
            `);
            await productBarcodes.attachExtras(pool, products);
            return sendSuccess(res, { products });
        }
        else if (req.method === 'POST') {
            const data = req.body;
            const validationError = validateProductInput(data, { requirePrice: true });
            if (validationError) return sendError(res, 400, validationError);
            const barcode = productBarcodes.normalizeMainBarcode(data.barcode) ?? null;
            const extraBarcodes = productBarcodes.normalizeExtraBarcodes(data.extra_barcodes) ?? [];
            productBarcodes.assertDistinct(barcode, extraBarcodes);
            let modifiers = null;
            if (data.modifiers !== undefined) {
                try {
                    const canonical = normalizeModifierDefinition(data.modifiers);
                    modifiers = canonical ? JSON.stringify(canonical) : null;
                } catch (e) {
                    return sendError(res, 400, e.message);
                }
            }
            const stock = (data.stock !== undefined && data.stock !== null && data.stock !== '') ? Number(data.stock) : null;
            const cost_price = (data.cost_price !== undefined && data.cost_price !== null && data.cost_price !== '') ? Number(data.cost_price) : 0;
            const min_stock_level = (data.min_stock_level !== undefined && data.min_stock_level !== null && data.min_stock_level !== '') ? Number(data.min_stock_level) : null;
            const category_id = data.category_id || null;
            const background_color = data.background_color || null;
            const taxRate = parseFloat(data.tax_rate) || 0;
            const taxCategory = normalizeProductTaxCategory(data.jofotara_tax_category, taxRate);
            const grossPrice = parseFloat(data.price) || 0;
            const is_bundle = data.is_bundle ? 1 : 0;
            const price_override_locked = requestBoolean(data, 'price_override_locked', false) ? 1 : 0;
            // Admin enters tax-inclusive price; strip tax so POS can add it back correctly
            const priceToStore = grossToNet(grossPrice, taxRate);
            const conn = await getStockConnection(pool);
            let result;
            try {
                await conn.beginTransaction();
                const fiscalSettings = await lockJofotaraPolicy(conn);
                await validateJofotaraCatalogRates(conn, fiscalSettings, [taxRate]);
                await productBarcodes.assertFree(conn, 0, [barcode, ...extraBarcodes].filter(Boolean));
                [result] = await conn.query(
                    "INSERT INTO products (category_id, name, price, cost_price, tax_rate, jofotara_tax_category, barcode, modifiers, stock, min_stock_level, background_color, is_bundle, price_override_locked, customer_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [category_id, data.name, priceToStore, cost_price, taxRate, taxCategory, barcode, modifiers, stock, min_stock_level, background_color, is_bundle, price_override_locked, data.customer_info?.trim() || null]
                );
                if (extraBarcodes.length) await productBarcodes.replaceExtras(conn, result.insertId, extraBarcodes);
                await conn.commit();
            } catch (error) {
                await conn.rollback();
                throw productBarcodes.asBarcodeConflict(error);
            } finally {
                conn.release();
            }
            writeAudit(req, { event_type: 'product_created', entity_type: 'product', entity_id: result.insertId, new_value: { name: data.name, price: priceToStore, gross_price: grossPrice, stock, price_override_locked } });
            afterCatalogMutation(req, { productIds: [result.insertId] });
            return sendSuccess(res, { message: "Product added.", id: result.insertId });
        }
        else if (req.method === 'PUT') {
            const data = req.body;
            if (!data.id) return sendError(res, 400, 'Product id is required.');
            const validationError = validateProductInput(data, { requirePrice: false });
            if (validationError) return sendError(res, 400, validationError);

            // Fetch current row FIRST — needed for audits and to preserve fields the client omits.
            const [[currentProduct]] = await pool.query(
                "SELECT name, price, stock, is_active, tax_rate, jofotara_tax_category, price_override_locked FROM products WHERE id = ?", [data.id]
            );
            if (!currentProduct) return sendError(res, 404, 'Product not found.');

            // PARTIAL UPDATE: build the SET clause from ONLY the keys the request actually sent.
            // Fixes (1) the compounding tax strip (quick actions omit price, so it is never
            // re-stripped) and (2) stale full-row PUTs clobbering unrelated fields on concurrent edits.
            const has = (key) => Object.prototype.hasOwnProperty.call(data, key);
            const sets = [];
            const vals = [];
            const put = (col, value) => { sets.push(`${col} = ?`); vals.push(value); };
            if (has('customer_info')) {
                if (typeof data.previous_customer_info !== 'string') return sendError(res, 400, 'Reload the product before changing its customer information.');
                put('customer_info', data.customer_info?.trim() || null);
            }

            if (has('name'))             put('name', data.name);
            if (has('category_id'))      put('category_id', data.category_id || null);
            // The main barcode is stored in products.barcode; extra_barcodes (omitted = unchanged, [] = none) in product_barcodes.
            const mainBarcode = has('barcode') ? productBarcodes.normalizeMainBarcode(data.barcode) : undefined;
            const extraBarcodes = productBarcodes.normalizeExtraBarcodes(data.extra_barcodes);
            if (has('barcode'))          put('barcode', mainBarcode);
            if (has('background_color')) put('background_color', data.background_color || null);
            if (has('is_active'))        put('is_active', data.is_active ? 1 : 0);
            if (has('is_bundle'))        put('is_bundle', data.is_bundle ? 1 : 0);
            const priceOverrideLockedPut = requestBoolean(
                data,
                'price_override_locked',
                Number(currentProduct.price_override_locked) === 1
            ) ? 1 : 0;
            if (has('price_override_locked')) put('price_override_locked', priceOverrideLockedPut);
            if (has('cost_price'))       put('cost_price', (data.cost_price === '' || data.cost_price === null) ? 0 : Number(data.cost_price));
            if (has('min_stock_level'))  put('min_stock_level', (data.min_stock_level === '' || data.min_stock_level === null) ? null : Number(data.min_stock_level));
            if (has('modifiers')) {
                try {
                    const canonical = normalizeModifierDefinition(data.modifiers);
                    put('modifiers', canonical ? JSON.stringify(canonical) : null);
                } catch (e) {
                    return sendError(res, 400, e.message);
                }
            }

            const newStock = has('stock')
                ? ((data.stock === '' || data.stock === null || data.stock === undefined) ? null : Number(data.stock))
                : currentProduct.stock;
            if (has('stock')) {
                if (!/^\d{1,20}$/.test(String(data.expected_stock_version ?? ''))) {
                    return sendError(res, 409, 'Reload the product before changing its stock.');
                }
                put('stock', newStock);
                sets.push('stock_version = stock_version + 1');
            }

            // Price/tax: admin form sends GROSS; strip to NET. Only transform+write when a price
            // was actually sent — omitted price/tax are preserved (never re-stripped).
            const priceProvided = has('price') && data.price !== null && data.price !== '';
            // tax_rate: a PRESENT key (even '') is an explicit set from the modal, and '' means 0.
            // Quick actions omit the key entirely, so they still preserve the stored rate.
            const taxProvided   = has('tax_rate') && data.tax_rate !== null;
            const taxRatePut    = taxProvided ? (data.tax_rate === '' ? 0 : (parseFloat(data.tax_rate) || 0)) : (Number(currentProduct.tax_rate) || 0);
            const categoryProvided = has('jofotara_tax_category');
            const taxCategoryPut = categoryProvided
                ? normalizeProductTaxCategory(data.jofotara_tax_category, taxRatePut)
                : (taxProvided && Math.abs(Number(currentProduct.tax_rate || 0) - taxRatePut) > 0.001
                    ? normalizeProductTaxCategory(undefined, taxRatePut)
                    : currentProduct.jofotara_tax_category);
            const grossPricePut = priceProvided ? (parseFloat(data.price) || 0) : 0;
            const oldPrice      = Number(currentProduct.price || 0);
            const newPrice      = priceProvided ? grossToNet(grossPricePut, taxRatePut) : oldPrice;
            if (priceProvided) put('price', newPrice);
            if (taxProvided)   put('tax_rate', taxRatePut);
            if (categoryProvided || taxProvided) put('jofotara_tax_category', taxCategoryPut);

            if (sets.length === 0 && extraBarcodes === undefined) return sendSuccess(res, { message: "Nothing to update." });
            vals.push(data.id);
            const conn = await getStockConnection(pool);
            try {
                await conn.beginTransaction();
                const fiscalSettings = await lockJofotaraPolicy(conn);
                const effectiveActive = has('is_active') ? (data.is_active ? 1 : 0) : Number(currentProduct.is_active ?? 1);
                if (effectiveActive) await validateJofotaraCatalogRates(conn, fiscalSettings, [taxRatePut]);
                if (has('customer_info')) {
                    const [[currentInfo]] = await conn.query('SELECT customer_info FROM products WHERE id=? FOR UPDATE', [data.id]);
                    if (!currentInfo) throw categoryError(404, 'Product not found.');
                    const before = currentInfo.customer_info || '';
                    const after = data.customer_info?.trim() || '';
                    if (before !== data.previous_customer_info && before !== after) throw categoryError(409, 'Another employee updated this item. Reload before saving.');
                    if (before !== after) await appendAuditEvent(conn, {
                        eventType: 'product_customer_info_changed', userId: req.user.id, entityType: 'product', entityId: data.id,
                        oldValue: { customer_info: before }, newValue: { customer_info: after }, ipAddress: req.ip || null
                    });
                }
                if (has('barcode') || extraBarcodes !== undefined) {
                    // Lock the product, then keep every barcode of it unique: against its own set and against other products.
                    const [[lockedProduct]] = await conn.query('SELECT barcode FROM products WHERE id = ? FOR UPDATE', [data.id]);
                    if (!lockedProduct) throw categoryError(404, 'Product not found.');
                    const finalMain = has('barcode') ? mainBarcode : lockedProduct.barcode;
                    const finalExtras = extraBarcodes
                        ?? (await productBarcodes.loadExtras(conn, [Number(data.id)])).get(Number(data.id))
                        ?? [];
                    productBarcodes.assertDistinct(finalMain, finalExtras);
                    await productBarcodes.assertFree(conn, data.id, [has('barcode') ? mainBarcode : null, ...(extraBarcodes ?? [])].filter(Boolean));
                }
                let stockBefore;
                if (has('stock') || (has('is_bundle') && Number(data.is_bundle) === 1)) {
                    [[stockBefore]] = await conn.query('SELECT stock,stock_version FROM products WHERE id=? FOR UPDATE', [data.id]);
                    const [[stockLink]] = await conn.query('SELECT stock_item_id FROM product_stock_links WHERE product_id=? FOR UPDATE', [data.id]);
                    if (stockLink) throw categoryError(409, has('stock') ? 'This product uses the stock ledger. Record its quantity through inventory operations.' : 'A stock-tracked product cannot be converted to a bundle.');
                }
                if (sets.length) {
                    const [updated] = await conn.query(`UPDATE products SET ${sets.join(', ')} WHERE id = ?${has('stock') ? ' AND stock_version = ?' : ''}`,
                        has('stock') ? [...vals, data.expected_stock_version] : vals);
                    if (has('stock') && !updated.affectedRows) throw categoryError(409, 'Stock changed. Reload and review before saving.');
                }
                if (has('barcode') || has('name') || has('is_active')) {
                    const [identities]=await conn.query('SELECT id FROM stock_items WHERE legacy_product_id=? ORDER BY id FOR UPDATE',[data.id]);
                    // Keep catalog-owned physical identities in sync. Explicitly
                    // shared identities retain their physical name and status.
                    await conn.query(`UPDATE stock_items s JOIN products p ON p.id=s.legacy_product_id
                        SET s.name=p.name,s.barcode=p.barcode,s.is_active=p.is_active
                        WHERE p.id=? AND (SELECT COUNT(*) FROM product_stock_links l WHERE l.stock_item_id=s.id
                            AND NOT EXISTS (SELECT 1 FROM product_packs sp WHERE sp.sale_product_id=l.product_id))<=1`,[data.id]);
                    await refreshAttention(conn,identities.map(row=>row.id));
                }
                if (has('is_active')) await productPacks.syncSaleProductsActive(conn, data.id, data.is_active);
                if (extraBarcodes !== undefined) await productBarcodes.replaceExtras(conn, data.id, extraBarcodes);
                if (has('stock')) await appendAuditEvent(conn, {
                    eventType: 'stock_adjusted', userId: req.user?.id || null, entityType: 'product', entityId: data.id,
                    oldValue: stockBefore, newValue: { stock: newStock, kind: 'catalog_count' }, ipAddress: req.ip || null
                });
                await conn.commit();
            } catch (error) {
                await conn.rollback();
                throw productBarcodes.asBarcodeConflict(error);
            } finally {
                conn.release();
            }

            // price_history + audit ONLY when the pre-tax price really changed.
            const priceReallyChanged = priceProvided && Math.abs(oldPrice - newPrice) > 0.001;
            if (priceReallyChanged) {
                await pool.query(
                    "INSERT INTO price_history (product_id, old_price, new_price, changed_by) VALUES (?, ?, ?, ?)",
                    [data.id, oldPrice, newPrice, req.user?.id || null]
                );
                writeAudit(req, {
                    event_type: 'price_changed', entity_type: 'product', entity_id: data.id,
                    old_value: { price: oldPrice },
                    new_value: { price: newPrice, gross_price: grossPricePut, name: currentProduct.name }
                });
            }

            // Field-scoped audits — guarded by key presence so minimal payloads log only what changed.
            if (has('is_active') && Number(currentProduct.is_active ?? 1) !== (data.is_active ? 1 : 0)) {
                writeAudit(req, { event_type: 'product_status_changed', entity_type: 'product', entity_id: data.id, old_value: { is_active: Number(currentProduct.is_active ?? 1), name: currentProduct.name }, new_value: { is_active: data.is_active ? 1 : 0 } });
            }
            if (has('name') && currentProduct.name !== data.name && !priceReallyChanged) {
                writeAudit(req, { event_type: 'product_updated', entity_type: 'product', entity_id: data.id, old_value: { name: currentProduct.name }, new_value: { name: data.name } });
            }

            // Tax/price changed → re-derive every OPEN table order using this product (fire-and-forget).
            const taxChangedHeal   = taxProvided && Math.abs(Number(currentProduct.tax_rate || 0) - taxRatePut) > 0.001;
            const categoryChangedHeal = String(currentProduct.jofotara_tax_category) !== String(taxCategoryPut);
            if (taxChangedHeal || categoryChangedHeal || priceReallyChanged) {
                healOpenOrdersForProduct(data.id, req.io)
                    .catch((err) => logger.error({ err, productId: data.id }, 'product PUT: open-order heal failed'));
            }
            afterCatalogMutation(req, { productIds: [data.id] });
            return sendSuccess(res, { message: "Product updated." });
        }
        else if (req.method === 'DELETE') {
            if (!req.body.id) return sendError(res, 400, 'Product id is required.');
            const [[usage]] = await pool.query(
                "SELECT COUNT(*) AS n FROM product_bundle_items WHERE product_id = ?", [req.body.id]
            );
            if (Number(usage?.n || 0) > 0) {
                return sendError(res, 409, 'This product is used in a bundle — remove it from the bundle first.');
            }
            const [[prod]] = await pool.query("SELECT name FROM products WHERE id = ?", [req.body.id]);
            const conn=await getStockConnection(pool);
            try {
                await conn.beginTransaction();
                await conn.query('UPDATE products SET is_active=0 WHERE id=?',[req.body.id]);
                await productPacks.syncSaleProductsActive(conn, req.body.id, false);
                const [identities]=await conn.query('SELECT id FROM stock_items WHERE legacy_product_id=? ORDER BY id FOR UPDATE',[req.body.id]);
                await conn.query(`UPDATE stock_items s SET s.is_active=0 WHERE s.legacy_product_id=?
                    AND (SELECT COUNT(*) FROM product_stock_links l WHERE l.stock_item_id=s.id
                            AND NOT EXISTS (SELECT 1 FROM product_packs sp WHERE sp.sale_product_id=l.product_id))<=1`,[req.body.id]);
                await refreshAttention(conn,identities.map(row=>row.id));
                await conn.commit();
            } catch(error){await conn.rollback();throw error;}finally{conn.release();}
            writeAudit(req, { event_type: 'product_deleted', entity_type: 'product', entity_id: req.body.id, old_value: { name: prod?.name || null } });
            afterCatalogMutation(req, { productIds: [req.body.id] });
            return sendSuccess(res, { message: "Product deleted." });
        }
        else {
            return sendError(res, 405, "Method not allowed.");
        }
    } catch (e) {
        if (e.statusCode) return sendError(res, e.statusCode, e.message, e.publicCode);
        logAdminRouteError(req, e);
        sendError(res, 500, e.message);
    }
});

// ALL /api/admin/categories
router.all('/categories', async (req, res) => {
    try {
        if (req.method === 'GET') {
            const [categories] = await pool.query(`
                SELECT c1.*, c2.name AS parent_name,
                       valid_root.name AS price_list_root_name,
                       CASE
                         WHEN c1.id = c1.price_list_root_id
                          AND c1.parent_id IS NULL
                          AND c1.is_notes = 0
                         THEN 1 ELSE 0
                       END AS is_price_list_root
                FROM categories c1
                LEFT JOIN categories c2 ON c1.parent_id = c2.id
                LEFT JOIN categories valid_root
                  ON valid_root.id = c1.price_list_root_id
                 AND valid_root.id = valid_root.price_list_root_id
                 AND valid_root.parent_id IS NULL
                 AND valid_root.is_notes = 0
                ORDER BY c1.is_active DESC, c1.parent_id ASC, c1.id DESC
            `);
            return sendSuccess(res, { categories });
        } else if (req.method === 'POST') {
            const name = String(req.body?.name || '').trim();
            if (!name) return sendError(res, 400, 'Category name is required.');
            if (Object.prototype.hasOwnProperty.call(req.body, 'price_list_root_id')) {
                return sendError(res, 400, 'price_list_root_id is managed by the server.');
            }
            const parentId = optionalCategoryId(req.body.parent_id);
            const isNotes = requestBoolean(req.body, 'is_notes', false) ? 1 : 0;
            const hideInPos = requestBoolean(req.body, 'hide_in_pos', false) ? 1 : 0;
            const isRoot = requestBoolean(req.body, 'is_price_list_root', false);
            if (isRoot && parentId != null) return sendError(res, 400, 'A price-list root must be top-level.');
            if (isRoot && isNotes) return sendError(res, 400, 'A notes category cannot be a price-list root.');

            const conn = await getStockConnection(pool);
            let categoryId;
            try {
                await conn.beginTransaction();
                const inheritedRootId = isRoot ? null : await inheritedRootForParent(conn, parentId);
                const [result] = await conn.query(
                    'INSERT INTO categories (name, parent_id, is_notes, hide_in_pos, price_list_root_id) VALUES (?, ?, ?, ?, ?)',
                    [name, parentId, isNotes, hideInPos, inheritedRootId]
                );
                categoryId = Number(result.insertId);
                if (isRoot) {
                    await conn.query('UPDATE categories SET price_list_root_id = id WHERE id = ?', [categoryId]);
                }
                await appendAuditEvent(conn, {
                    eventType: 'category_created',
                    userId: req.user?.id || null,
                    entityType: 'category',
                    entityId: categoryId,
                    newValue: { name, parent_id: parentId, hide_in_pos: hideInPos, is_price_list_root: isRoot ? 1 : 0 },
                    ipAddress: req.ip || null
                });
                await conn.commit();
            } catch (error) {
                await conn.rollback();
                throw error;
            } finally {
                conn.release();
            }
            afterCatalogMutation(req);
            return sendSuccess(res, { message: "Category added.", id: categoryId });
        } else if (req.method === 'PUT') {
            const categoryId = optionalCategoryId(req.body.id, 'Category');
            if (categoryId == null) return sendError(res, 400, 'Category id is required.');
            const name = String(req.body?.name || '').trim();
            if (!name) return sendError(res, 400, 'Category name is required.');
            if (Object.prototype.hasOwnProperty.call(req.body, 'price_list_root_id')) {
                return sendError(res, 400, 'price_list_root_id is managed by the server.');
            }
            const parentId = optionalCategoryId(req.body.parent_id);

            const conn = await getStockConnection(pool);
            try {
                await conn.beginTransaction();
                // ponytail: the catalog is intentionally loaded once; use a recursive CTE only if category scale makes this measurable.
                const [categories] = await conn.query(
                    'SELECT id, parent_id, name, is_active, is_notes, hide_in_pos, price_list_root_id FROM categories ORDER BY id FOR UPDATE'
                );
                const categoriesById = new Map(categories.map(row => [Number(row.id), row]));
                const current = categoriesById.get(categoryId);
                if (!current) throw categoryError(404, 'Category not found.');
                if (parentId != null && !categoriesById.has(parentId)) throw categoryError(400, 'Parent category was not found.');

                let cursor = parentId;
                const seen = new Set();
                while (cursor != null) {
                    if (cursor === categoryId || seen.has(cursor)) throw categoryError(409, 'Category parent would create a cycle.');
                    seen.add(cursor);
                    cursor = categoriesById.get(cursor)?.parent_id == null ? null : Number(categoriesById.get(cursor).parent_id);
                }

                const isNotes = requestBoolean(req.body, 'is_notes', Number(current.is_notes) === 1) ? 1 : 0;
                const isActive = requestBoolean(req.body, 'is_active', Number(current.is_active) === 1) ? 1 : 0;
                const hideInPos = requestBoolean(req.body, 'hide_in_pos', Number(current.hide_in_pos) === 1) ? 1 : 0;
                const wasRoot = Number(current.price_list_root_id) === categoryId;
                const rootIntent = requestBoolean(req.body, 'is_price_list_root', wasRoot);
                if (rootIntent && parentId != null) throw categoryError(400, 'A price-list root must be top-level.');
                if (rootIntent && isNotes) throw categoryError(400, 'A notes category cannot be a price-list root.');

                const inheritedRootId = rootIntent ? categoryId : resolveInheritedRootId(categoriesById, parentId);
                const subtree = collectCategorySubtree(categories, categoryId);
                const subtreeIds = subtree.map(row => Number(row.id));
                const placeholders = subtreeIds.map(() => '?').join(',');
                await conn.query(
                    `UPDATE categories
                        SET name = CASE WHEN id = ? THEN ? ELSE name END,
                            parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END,
                            is_active = CASE WHEN id = ? THEN ? ELSE is_active END,
                            is_notes = CASE WHEN id = ? THEN ? ELSE is_notes END,
                            hide_in_pos = CASE WHEN id = ? THEN ? ELSE hide_in_pos END,
                            price_list_root_id = ?
                      WHERE id IN (${placeholders})`,
                    [categoryId, name, categoryId, parentId, categoryId, isActive, categoryId, isNotes, categoryId, hideInPos, inheritedRootId, ...subtreeIds]
                );
                await appendAuditEvent(conn, {
                    eventType: 'category_updated',
                    userId: req.user?.id || null,
                    entityType: 'category',
                    entityId: categoryId,
                    oldValue: { name: current.name, parent_id: current.parent_id, hide_in_pos: current.hide_in_pos, price_list_root_id: current.price_list_root_id },
                    newValue: { name, parent_id: parentId, hide_in_pos: hideInPos, price_list_root_id: inheritedRootId, subtree_ids: subtreeIds },
                    ipAddress: req.ip || null
                });
                await conn.commit();
            } catch (error) {
                await conn.rollback();
                throw error;
            } finally {
                conn.release();
            }
            afterCatalogMutation(req);
            return sendSuccess(res, { message: "Category updated." });
        } else if (req.method === 'DELETE') {
            const categoryId = optionalCategoryId(req.body.id, 'Category');
            if (categoryId == null) return sendError(res, 400, 'Category id is required.');
            const conn = await getStockConnection(pool);
            try {
                await conn.beginTransaction();
                const [categories] = await conn.query(
                    'SELECT id, parent_id, name, is_active, is_notes, price_list_root_id FROM categories ORDER BY id FOR UPDATE'
                );
                const categoriesById = new Map(categories.map(row => [Number(row.id), row]));
                const current = categoriesById.get(categoryId);
                if (!current) throw categoryError(404, 'Category not found.');
                const subtree = collectCategorySubtree(categories, categoryId);
                const isRoot = Number(current.price_list_root_id) === categoryId;
                const directChildren = categories.filter(row => Number(row.parent_id) === categoryId).map(row => Number(row.id));

                if (isRoot) {
                    const descendantIds = subtree.slice(1).map(row => Number(row.id));
                    if (descendantIds.length > 0) {
                        await conn.query(
                            `UPDATE categories SET price_list_root_id = NULL WHERE id IN (${descendantIds.map(() => '?').join(',')})`,
                            descendantIds
                        );
                    }
                    if (directChildren.length > 0) {
                        await conn.query(
                            `UPDATE categories SET parent_id = NULL WHERE id IN (${directChildren.map(() => '?').join(',')})`,
                            directChildren
                        );
                    }
                } else if (directChildren.length > 0) {
                    const destinationRootId = resolveInheritedRootId(categoriesById, current.parent_id);
                    await conn.query(
                        `UPDATE categories SET parent_id = ?, price_list_root_id = ? WHERE id IN (${directChildren.map(() => '?').join(',')})`,
                        [current.parent_id, destinationRootId, ...directChildren]
                    );
                }

                await conn.query('UPDATE products SET category_id = NULL WHERE category_id = ?', [categoryId]);
                await conn.query('UPDATE categories SET is_active = 0 WHERE id = ?', [categoryId]);
                await appendAuditEvent(conn, {
                    eventType: 'category_deleted',
                    userId: req.user?.id || null,
                    entityType: 'category',
                    entityId: categoryId,
                    oldValue: {
                        id: categoryId,
                        name: current.name,
                        detached_tree: isRoot,
                        detached_category_ids: isRoot ? subtree.slice(1).map(row => Number(row.id)) : []
                    },
                    ipAddress: req.ip || null
                });
                await conn.commit();
            } catch (txErr) {
                await conn.rollback();
                throw txErr;
            } finally {
                conn.release();
            }
            afterCatalogMutation(req);
            return sendSuccess(res, { message: "Category deleted." });
        }
        else {
            return sendError(res, 405, "Method not allowed.");
        }
    } catch (e) {
        if (!e.statusCode || e.statusCode >= 500) logAdminRouteError(req, e);
        sendError(res, e.statusCode || 500, e.message);
    }
});

module.exports = router;
