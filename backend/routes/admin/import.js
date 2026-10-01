const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parseCatalogWorkbook } = require('../../services/catalogWorkbook');
let importInFlight = false;
const { 
    pool, 
    sendSuccess, 
    sendError, 
    logAdminRouteError,
    invalidateCatalogCache,
    invalidateDashboardCache,
    triggerStaticMenuGeneration,
    requireAdmin
} = require('./helpers');
const { lockJofotaraPolicy, validateJofotaraCatalogRates } = require('../../services/JofotaraService');
const { normalizeJofotaraTaxCategory } = require('../../config/taxRegistration');
const { grossToNet } = require('../../services/categoryPriceLists');
const { emitHeldOrdersChanged } = require('../../services/HeldOrderEvents');
const { appendAuditEvent } = require('../../services/auditEvents');
const productBarcodes = require('../../services/productBarcodes');

// Multer memory storage configuration (5MB limit)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
}).single('file');

// Helper function to extract value case-insensitively and trim keys/values
function getVal(row, possibleKeys, defaultVal = null) {
    if (!row || typeof row !== 'object') return defaultVal;
    for (const key of Object.keys(row)) {
        const cleanKey = key.trim().toLowerCase().replace(/[\s_]/g, '');
        for (const pk of possibleKeys) {
            const cleanPk = pk.trim().toLowerCase().replace(/[\s_]/g, '');
            if (cleanKey === cleanPk) {
                const val = row[key];
                return val !== undefined && val !== null ? val : defaultVal;
            }
        }
    }
    return defaultVal;
}

function badImport(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizeImportedTaxRate(value, legacyFormat) {
    const numeric = Number(String(value).trim().replace(/%$/, ''));
    if (!Number.isFinite(numeric)) return NaN;
    if (legacyFormat && Math.abs(numeric - 0.8) < 1e-9) return 8;
    return numeric > 0 && numeric < 1 ? numeric * 100 : numeric;
}

async function replaceCatalog(conn) {
    // Serialize destructive catalog replacement with product authority activation.
    await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' FOR UPDATE");
    const [[stockLink]] = await conn.query('SELECT product_id FROM product_stock_links LIMIT 1 FOR UPDATE');
    if (stockLink) throw badImport('Catalog replacement is blocked while products have stock ledger history.', 409);
    const [[recipeLine]] = await conn.query('SELECT 1 FROM product_recipe_lines LIMIT 1 FOR UPDATE');
    if (recipeLine) {
        throw badImport('Catalog replacement is blocked while product recipes exist. Clear recipes first.', 409);
    }

    const [[document]] = await conn.query('SELECT 1 FROM stock_document_lines WHERE product_id IS NOT NULL LIMIT 1 FOR UPDATE');
    if (document) {
        throw badImport('Catalog replacement is blocked while purchase invoices or stock counts reference products.', 409);
    }

    const [[history]] = await conn.query('SELECT invoice_id FROM order_items WHERE product_id IS NOT NULL LIMIT 1');
    const [[returns]] = await conn.query('SELECT id FROM refund_items WHERE product_id IS NOT NULL LIMIT 1');
    if (history || returns) throw badImport('Catalog replacement would detach historical sales and returns. Import in append mode and deactivate old products instead.', 409);

    const [[counts]] = await conn.query(`
        SELECT
          (SELECT COUNT(*) FROM products) AS products_removed,
          (SELECT COUNT(*) FROM categories) AS categories_removed
    `);

    // These rows configure or cache the current catalog and cannot point at replacement IDs.
    await conn.query('DELETE FROM held_orders');
    await conn.query('DELETE FROM qr_table_drafts');
    await conn.query('DELETE FROM product_bundle_items');
    await conn.query('DELETE FROM price_history');
    await conn.query('DELETE FROM printer_categories');
    await conn.query('DELETE FROM products');
    await conn.query('DELETE FROM categories');

    return {
        products_removed: Number(counts.products_removed) || 0,
        categories_removed: Number(counts.categories_removed) || 0
    };
}

// POST /api/admin/import/catalog
router.post('/catalog', requireAdmin, (req, res) => {
    if (importInFlight) return sendError(res, 409, 'Another catalog import is running. Please wait for it to finish.');
    importInFlight = true;
    upload(req, res, err => {
        handleImport(req, res, err).catch(error => {
            logAdminRouteError(req, error);
            if (!res.headersSent) sendError(res, 500, 'Unable to import catalog.');
        }).finally(() => { importInFlight = false; });
    });
});
async function handleImport(req, res, err) {
        if (err instanceof multer.MulterError) {
            return sendError(res, 400, `Upload error: ${err.message}`);
        } else if (err) {
            return sendError(res, 400, `Upload error: ${err.message}`);
        }

        if (!req.file) {
            return sendError(res, 400, 'No file uploaded.');
        }

        const isXlsx = req.file.originalname.toLowerCase().endsWith('.xlsx');
        if (!isXlsx) {
            return sendError(res, 400, 'Only .xlsx spreadsheet files are allowed.');
        }

        let conn;
        try {
            const { catRows, prodRows, legacyFormat } = await parseCatalogWorkbook(req.file.buffer, req.body?.mapping);
            req.file.buffer = null;
            if (req.aborted || res.destroyed) return;
            conn = await getStockConnection(pool);
            await conn.beginTransaction();
            const fiscalSettings = await lockJofotaraPolicy(conn);

            const importMode = req.body?.mode || 'append';
            if (!['append', 'replace'].includes(importMode)) throw badImport('Import mode is invalid.');
            if (importMode === 'replace' && req.body?.confirm_replace !== '1') {
                throw badImport('Catalog replacement requires explicit confirmation.');
            }
            const removed = importMode === 'replace'
                ? await replaceCatalog(conn)
                : { products_removed: 0, categories_removed: 0 };
            const importedTaxRates = [];

            const errors = [];

            // 1. Process Categories
            let categories_imported = 0;
            let categories_skipped = 0;

            const [existingCats] = await conn.query(
                'SELECT id, name, parent_id, price_list_root_id, is_notes FROM categories ORDER BY id FOR UPDATE'
            );
            const categoryNameToIds = new Map();
            const validCategoryIds = new Set(existingCats.map(category => Number(category.id)));
            const importedCategoryIds = [];
            const categoryParentById = new Map(existingCats.map(category => [Number(category.id), category.parent_id == null ? null : Number(category.parent_id)]));
            const addCategoryName = (name, id) => {
                const key = String(name).toLowerCase().trim();
                if (!categoryNameToIds.has(key)) categoryNameToIds.set(key, new Set());
                categoryNameToIds.get(key).add(Number(id));
            };
            const uniqueCategoryId = (name) => {
                const ids = categoryNameToIds.get(String(name).toLowerCase().trim());
                return ids?.size === 1 ? [...ids][0] : null;
            };
            for (const cat of existingCats) {
                addCategoryName(cat.name, cat.id);
            }

            const pendingParentUpdates = [];

            for (const row of catRows) {
                const nameVal = getVal(row, ['name', 'categoryname', 'category_name']);
                if (!nameVal) {
                    // Skip completely empty rows
                    const keys = Object.keys(row);
                    if (keys.length === 0 || keys.every(k => row[k] === undefined || row[k] === null || String(row[k]).trim() === '')) {
                        continue;
                    }
                    errors.push('Categories Sheet: Category Name is required.');
                    continue;
                }

                const name = String(nameVal).trim();
                if (!name) {
                    errors.push('Categories Sheet: Category Name cannot be empty.');
                    continue;
                }

                const key = name.toLowerCase();

                if (categoryNameToIds.has(key)) {
                    categories_skipped++;
                    continue;
                }

                const parentVal = getVal(row, ['parentcategory', 'parent_category', 'parent']);
                const parentName = parentVal ? String(parentVal).trim() : '';

                let isNotesVal = getVal(row, ['isnotes', 'is_notes', 'notes']);
                let is_notes = 0;
                if (isNotesVal !== null && isNotesVal !== undefined) {
                    const s = String(isNotesVal).trim().toLowerCase();
                    if (s === '1' || s === 'true' || s === 'yes' || s === 'y') {
                        is_notes = 1;
                    }
                }

                const [result] = await conn.query(
                    "INSERT INTO categories (name, parent_id, is_notes) VALUES (?, ?, ?)",
                    [name, null, is_notes]
                );

                const newId = result.insertId;
                addCategoryName(name, newId);
                validCategoryIds.add(Number(newId));
                importedCategoryIds.push(Number(newId));
                categoryParentById.set(Number(newId), null);
                categories_imported++;

                if (parentName) {
                    pendingParentUpdates.push({ id: newId, parentName });
                }
            }

            // Categories Pass 2: Resolve parent categories
            const resolvedParentUpdates = [];
            for (const update of pendingParentUpdates) {
                const parentKey = update.parentName.toLowerCase();
                const parentId = uniqueCategoryId(parentKey);
                if (parentId) {
                    categoryParentById.set(Number(update.id), Number(parentId));
                    resolvedParentUpdates.push({ ...update, parentId: Number(parentId) });
                } else {
                    errors.push(`Categories Sheet: Parent category "${update.parentName}" is missing or ambiguous.`);
                }
            }

            const hasParentCycle = (categoryId) => {
                const visited = new Set();
                let cursor = Number(categoryId);
                while (cursor != null) {
                    if (visited.has(cursor)) return true;
                    visited.add(cursor);
                    cursor = categoryParentById.get(cursor) ?? null;
                }
                return false;
            };
            for (const update of resolvedParentUpdates) {
                if (hasParentCycle(update.id)) {
                    errors.push(`Categories Sheet: Parent category "${update.parentName}" would create a cycle.`);
                    continue;
                }
                await conn.query('UPDATE categories SET parent_id = ? WHERE id = ?', [update.parentId, update.id]);
            }

            // Imported descendants must inherit the same price-list root as categories
            // created through the regular admin route. Resolve after every parent link is
            // in place so spreadsheet row order cannot change the result.
            if (importedCategoryIds.length) {
                const [categoryRows] = await conn.query(
                    'SELECT id, parent_id, price_list_root_id, is_notes FROM categories'
                );
                const categoriesById = new Map(categoryRows.map(category => [Number(category.id), category]));
                const inheritedRootFor = (categoryId) => {
                    let current = categoriesById.get(Number(categoryId));
                    const visited = new Set([Number(categoryId)]);

                    while (current?.parent_id != null) {
                        const parentId = Number(current.parent_id);
                        if (visited.has(parentId)) return null;
                        visited.add(parentId);

                        const parent = categoriesById.get(parentId);
                        if (!parent) return null;
                        if (
                            parent.parent_id == null
                            && Number(parent.is_notes) === 0
                            && Number(parent.price_list_root_id) === parentId
                        ) {
                            return parentId;
                        }
                        current = parent;
                    }
                    return null;
                };

                const cases = [];
                const params = [];
                for (const categoryId of importedCategoryIds) {
                    cases.push('WHEN ? THEN ?');
                    params.push(categoryId, inheritedRootFor(categoryId));
                }
                await conn.query(
                    `UPDATE categories
                     SET price_list_root_id = CASE id ${cases.join(' ')} END
                     WHERE id IN (${importedCategoryIds.map(() => '?').join(', ')})`,
                    [...params, ...importedCategoryIds]
                );
            }

            // 2. Process Products
            let products_imported = 0;
            let products_skipped = 0;

            const [existingProds] = await conn.query('SELECT name FROM products');
            const existingNames = new Set(existingProds.map(p => p.name.toLowerCase().trim()));
            // The workbook's barcodes that a product already holds (main or extra), decided by the database.
            const takenBarcodes = await productBarcodes.takenCodes(conn, prodRows.map(row => {
                const value = getVal(row, ['barcode', 'code']);
                return value ? String(value).trim() : null;
            }));

            const newNames = new Set();
            const newBarcodes = new Set();

            let rowIdx = 1; // 1-based index (row 1 is header)
            for (const row of prodRows) {
                rowIdx++;
                const sourceRow = row.__legacyRow || rowIdx;

                const nameVal = getVal(row, ['name', 'productname', 'product_name']);
                if (!nameVal) {
                    const keys = Object.keys(row);
                    if (keys.length === 0 || keys.every(k => row[k] === undefined || row[k] === null || String(row[k]).trim() === '')) {
                        continue;
                    }
                    errors.push(`Products Sheet - Row ${sourceRow}: Product Name is required.`);
                    continue;
                }

                const name = String(nameVal).trim();
                if (!name) {
                    errors.push(`Products Sheet - Row ${sourceRow}: Product Name cannot be empty.`);
                    continue;
                }

                const key = name.toLowerCase();

                // Skip if duplicate in DB or in this upload
                if (existingNames.has(key) || newNames.has(key)) {
                    products_skipped++;
                    continue;
                }

                const barcodeVal = getVal(row, ['barcode', 'code']);
                const barcode = barcodeVal ? String(barcodeVal).trim() : null;
                if (barcode) {
                    const bcKey = barcode.toLowerCase();
                    if (takenBarcodes.has(barcode) || newBarcodes.has(bcKey)) {
                        products_skipped++;
                        continue;
                    }
                }

                const explicitCategoryId = getVal(row, ['categoryid', 'category_id']);
                const catVal = getVal(row, ['category', 'categoryname', 'category_name']);
                const catName = catVal ? String(catVal).trim() : '';
                let categoryId = null;
                if (explicitCategoryId !== null && explicitCategoryId !== undefined && String(explicitCategoryId).trim() !== '') {
                    const id = Number(explicitCategoryId);
                    if (!Number.isInteger(id) || id <= 0 || !validCategoryIds.has(id)) {
                        errors.push(`Products Sheet - Row ${sourceRow}: Category ID "${explicitCategoryId}" is invalid.`);
                        continue;
                    }
                    categoryId = id;
                } else if (catName) {
                    const ids = categoryNameToIds.get(catName.toLowerCase());
                    if (ids?.size === 1) {
                        categoryId = [...ids][0];
                    } else if (ids?.size > 1) {
                        errors.push(`Products Sheet - Row ${sourceRow}: Category "${catName}" is ambiguous. Use category_id.`);
                        continue;
                    } else {
                        errors.push(`Products Sheet - Row ${sourceRow}: Category "${catName}" not found. Add it to the Categories sheet first.`);
                        continue;
                    }
                }
                if (legacyFormat && !catName) {
                    errors.push(`Products Sheet - Row ${sourceRow}: Category is required for a legacy import.`);
                    continue;
                }

                const priceVal = getVal(row, ['price', 'unitprice', 'unit_price', 'rate']);
                if (priceVal === null || priceVal === undefined || String(priceVal).trim() === '') {
                    errors.push(`Products Sheet - Row ${sourceRow}: Price is required.`);
                    continue;
                }
                const price = Number(priceVal);
                if (isNaN(price) || price < 0) {
                    errors.push(`Products Sheet - Row ${sourceRow}: Price must be a valid non-negative number.`);
                    continue;
                }

                const taxRateVal = getVal(row, ['taxrate', 'tax_rate', 'tax']);
                let tax_rate = 0.00;
                if (taxRateVal !== null && taxRateVal !== undefined && String(taxRateVal).trim() !== '') {
                    tax_rate = normalizeImportedTaxRate(taxRateVal, legacyFormat);
                    if (isNaN(tax_rate) || tax_rate < 0 || tax_rate > 100) {
                        errors.push(`Products Sheet - Row ${sourceRow}: Tax Rate must be a valid number between 0 and 100 (e.g., 16 for 16%).`);
                        continue;
                    }
                }
                importedTaxRates.push(tax_rate);
                let jofotaraTaxCategory;
                try {
                    jofotaraTaxCategory = normalizeJofotaraTaxCategory(
                        getVal(row, ['jofotarataxcategory', 'jofotara_tax_category', 'taxcategory']),
                        tax_rate
                    );
                } catch (error) {
                    errors.push(`Products Sheet - Row ${sourceRow}: ${error.message}`);
                    continue;
                }

                const stockVal = getVal(row, ['stock', 'qty', 'quantity']);
                let stock = null;
                if (stockVal !== null && stockVal !== undefined && String(stockVal).trim() !== '') {
                    stock = Number(stockVal);
                    if (isNaN(stock)) {
                        errors.push(`Products Sheet - Row ${sourceRow}: Stock must be a valid number.`);
                        continue;
                    }
                }

                const colorVal = getVal(row, ['backgroundcolor', 'background_color', 'color']);
                const background_color = colorVal ? String(colorVal).trim() : null;

                await conn.query(
                    "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, barcode, stock, background_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [categoryId, name, grossToNet(price, tax_rate), tax_rate, jofotaraTaxCategory, barcode, stock, background_color]
                );

                products_imported++;
                newNames.add(key);
                if (barcode) {
                    newBarcodes.add(barcode.toLowerCase());
                }
            }

            if (errors.length > 0) {
                await conn.rollback();
                return res.status(200).json({
                    success: false,
                    summary: {
                        categories_imported: 0,
                        categories_skipped: 0,
                        products_imported: 0,
                        products_skipped: 0
                    },
                    errors
                });
            }

            await validateJofotaraCatalogRates(conn, fiscalSettings, importedTaxRates);

            if (importMode === 'replace') {
                await appendAuditEvent(conn, {
                    eventType: 'catalog_replaced',
                    userId: req.user?.id || null,
                    entityType: 'catalog',
                    oldValue: removed,
                    newValue: { products_imported, categories_imported },
                    ipAddress: req.ip || null
                });
            }

            await conn.commit();
            conn.release();
            conn = null;

            // Invalidate caches & notify clients
            invalidateCatalogCache();
            invalidateDashboardCache();
            triggerStaticMenuGeneration();
            if (req.io) req.io.to('staff').emit('inventory_changed');
            if (importMode === 'replace') emitHeldOrdersChanged(req.io, 'cleared');

            return sendSuccess(res, {
                success: true,
                summary: {
                    categories_imported,
                    categories_skipped,
                    products_imported,
                    products_skipped,
                    ...removed
                },
                errors: []
            });

        } catch (e) {
            if (conn) await conn.rollback();
            if (e.statusCode) return sendError(res, e.statusCode, e.message, e.publicCode);
            logAdminRouteError(req, e);
            return sendError(res, 500, e.message);
        } finally {
            if (conn) conn.release();
        }
}

module.exports = router;
