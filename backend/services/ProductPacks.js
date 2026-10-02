'use strict';

// Packs of a product (product_packs): a carton of 12, a sack of 10 kg. The product keeps one stock balance in its
// base unit; a pack only says how many base units it holds. Every pack is offered when buying or counting the
// product. A pack with a sale price is also sold at the register: it gets its own sale product (its price and
// barcode, hidden from the POS grid) linked to the base product's stock item with qty_per_sale = factor, so
// scanning the pack sells it at its own price and moves `factor` base units of the same balance.

const { randomBytes } = require('node:crypto');
const productBarcodes = require('./productBarcodes');
const stockActivation = require('./StockActivationService');
const { grossToNet, netToGross } = require('./categoryPriceLists');
const { appendAuditEvent } = require('./auditEvents');

const MAX_PACKS = 10;
const MAX_LABEL = 40;
const MAX_SALE_PRICE = 9999999;
const FACTOR_PATTERN = /^\d{1,10}(\.\d{1,6})?$/;
const PRICE_PATTERN = /^\d{1,7}(\.\d{1,3})?$/;

const packError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const invalid = (message) => packError(400, message);

function productId(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value))) throw invalid('Invalid product.');
    return Number(value);
}

const trimFactor = (value) => String(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

function normalizeFactor(value, label) {
    const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
    if (!FACTOR_PATTERN.test(text) || Number(text) <= 0) throw invalid(`Enter how many base units the pack ${label} holds.`);
    if (Number(text) === 1) throw invalid(`The pack ${label} must hold more or less than one base unit.`);
    return trimFactor(text);
}

function normalizeSalePrice(value, label) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const text = String(value).trim();
    if (!PRICE_PATTERN.test(text) || Number(text) > MAX_SALE_PRICE) throw invalid(`The sale price of the pack ${label} is invalid.`);
    return Number(text);
}

// The packs of a request body, validated: [{ label, factor, sale_price, barcode }] in the order given.
function normalize(input) {
    if (!Array.isArray(input)) throw invalid('Packs must be a list.');
    if (input.length > MAX_PACKS) throw invalid(`A product can have at most ${MAX_PACKS} packs.`);
    const labels = new Set();
    const barcodes = new Set();
    return input.map((pack) => {
        if (!pack || typeof pack !== 'object' || Array.isArray(pack)) throw invalid('Each pack must be an object.');
        const label = typeof pack.label === 'string' ? pack.label.trim() : '';
        if (!label || [...label].length > MAX_LABEL) throw invalid(`Each pack needs a name of at most ${MAX_LABEL} characters.`);
        if (labels.has(label.toLowerCase())) throw invalid(`The pack ${label} is repeated.`);
        labels.add(label.toLowerCase());
        const factor = normalizeFactor(pack.factor, label);
        const salePrice = normalizeSalePrice(pack.sale_price, label);
        // The barcode belongs to the pack's sale entry, so a pack without a sale price has none.
        const barcode = salePrice === null ? null : productBarcodes.normalizeMainBarcode(pack.barcode || null) || null;
        if (barcode) {
            if (barcodes.has(barcode.toLowerCase())) throw invalid(`Barcode ${barcode} is repeated on this product.`);
            barcodes.add(barcode.toLowerCase());
        }
        return { label, factor, sale_price: salePrice, barcode };
    });
}

function present(row) {
    const sold = row.sale_product_id != null && Number(row.sale_linked) === 1;
    return {
        id: Number(row.id),
        label: row.label,
        factor: trimFactor(row.factor),
        sale_product_id: sold ? Number(row.sale_product_id) : null,
        sale_price: sold ? Number(netToGross(row.sale_price, row.sale_tax_rate).toFixed(3)) : null,
        barcode: sold ? row.sale_barcode || null : null,
    };
}

async function list(db, value) {
    const id = productId(value);
    const [rows] = await db.query(
        `SELECT pk.id, pk.label, CAST(pk.factor AS CHAR) AS factor, pk.sale_product_id,
                sp.price AS sale_price, sp.tax_rate AS sale_tax_rate, sp.barcode AS sale_barcode,
                EXISTS(SELECT 1 FROM product_stock_links sl WHERE sl.product_id = pk.sale_product_id) AS sale_linked
           FROM product_packs pk LEFT JOIN products sp ON sp.id = pk.sale_product_id
          WHERE pk.product_id = ? ORDER BY pk.sort_order, pk.id`, [id]);
    return rows.map(present);
}

// The base product's one stock item, enabling stock movements first when it has none.
async function baseStockItem(conn, base, actorId, ipAddress) {
    let [links] = await conn.query(
        'SELECT stock_item_id, CAST(qty_per_sale AS CHAR) AS qty_per_sale FROM product_stock_links WHERE product_id = ? FOR UPDATE', [base.id]);
    if (!links.length) {
        await stockActivation.activate(conn, base.id, {
            expected_stock_version: base.stock_version,
            request_key: `packs_${randomBytes(12).toString('hex')}`,
        }, actorId, ipAddress);
        [links] = await conn.query(
            'SELECT stock_item_id, CAST(qty_per_sale AS CHAR) AS qty_per_sale FROM product_stock_links WHERE product_id = ? FOR UPDATE', [base.id]);
    }
    if (links.length !== 1 || Number(links[0].qty_per_sale) !== 1) {
        throw packError(409, 'This product takes its stock from several items, so its packs cannot be sold.');
    }
    return String(links[0].stock_item_id);
}

async function retireSaleProduct(conn, saleProductId) {
    await conn.query('DELETE FROM product_stock_links WHERE product_id = ?', [saleProductId]);
    await conn.query('UPDATE products SET is_active = 0, barcode = NULL, stock = NULL, stock_version = stock_version + 1 WHERE id = ?', [saleProductId]);
}

async function linkSaleProduct(conn, saleProductId, stockItemId, factor) {
    const [links] = await conn.query(
        'SELECT CAST(stock_item_id AS CHAR) AS stock_item_id, CAST(qty_per_sale AS CHAR) AS qty_per_sale FROM product_stock_links WHERE product_id = ? FOR UPDATE',
        [saleProductId]);
    if (links.length === 1 && links[0].stock_item_id === stockItemId) {
        if (trimFactor(links[0].qty_per_sale) !== factor) {
            await conn.query('UPDATE product_stock_links SET qty_per_sale = ?, policy_version = policy_version + 1 WHERE product_id = ?',
                [factor, saleProductId]);
        }
        return;
    }
    if (links.length) await conn.query('DELETE FROM product_stock_links WHERE product_id = ?', [saleProductId]);
    await conn.query('INSERT INTO product_stock_links (product_id, stock_item_id, qty_per_sale, policy_version) VALUES (?, ?, ?, 1)',
        [saleProductId, stockItemId, factor]);
}

const saleName = (base, label) => [...`${base.name} - ${label}`].slice(0, 100).join('');

// Full replace of a product's packs. The caller owns a READ COMMITTED transaction (stock activation needs it).
// Returns { packs, product_ids } where product_ids are every product whose catalog entry changed.
async function replace(conn, value, input, actorId, ipAddress) {
    const id = productId(value);
    const packs = normalize(input);
    await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' FOR UPDATE");
    const [[base]] = await conn.query(
        `SELECT id, name, category_id, tax_rate, jofotara_tax_category, is_active, is_bundle,
                CAST(stock_version AS CHAR) AS stock_version
           FROM products WHERE id = ? FOR UPDATE`, [id]);
    if (!base) throw packError(404, 'Product not found.');
    if (Number(base.is_bundle) === 1) throw invalid('A bundle cannot have packs.');
    const [[ownPack]] = await conn.query('SELECT product_id FROM product_packs WHERE sale_product_id = ?', [id]);
    if (ownPack) throw invalid('This product is the sale entry of a pack; edit the packs of its base product instead.');
    const [existing] = await conn.query(
        `SELECT pk.id, pk.label, CAST(pk.factor AS CHAR) AS factor, pk.sale_product_id
           FROM product_packs pk WHERE pk.product_id = ? ORDER BY pk.sort_order, pk.id FOR UPDATE`, [id]);
    const previousByLabel = new Map(existing.map((row) => [row.label.toLowerCase(), row]));
    const keepSale = new Set();
    const labels = new Set(packs.map((pack) => pack.label.toLowerCase()));
    for (const pack of packs) {
        const previous = previousByLabel.get(pack.label.toLowerCase());
        if (pack.sale_price !== null && previous?.sale_product_id != null) keepSale.add(Number(previous.sale_product_id));
    }
    const changed = new Set();
    for (const row of existing) {
        const saleId = row.sale_product_id == null ? null : Number(row.sale_product_id);
        if (saleId === null) continue;
        // Past sales of the pack are reported through this row, so a pack that has sold stays defined.
        if (!labels.has(row.label.toLowerCase())) {
            const [[sold]] = await conn.query('SELECT 1 AS sold FROM order_items WHERE product_id = ? LIMIT 1', [saleId]);
            if (sold) throw invalid(`The pack ${row.label} has sales; clear its sale price to stop selling it instead of removing it.`);
        }
        if (!keepSale.has(saleId)) {
            await retireSaleProduct(conn, saleId);
            changed.add(saleId);
        }
    }

    const selling = packs.some((pack) => pack.sale_price !== null);
    const stockItemId = selling ? await baseStockItem(conn, base, actorId, ipAddress) : null;
    const taxRate = Number(base.tax_rate) || 0;
    await conn.query('DELETE FROM product_packs WHERE product_id = ?', [id]);
    const saved = [];
    for (const [index, pack] of packs.entries()) {
        const previous = previousByLabel.get(pack.label.toLowerCase());
        let saleId = previous?.sale_product_id == null ? null : Number(previous.sale_product_id);
        if (pack.sale_price !== null) {
            if (pack.barcode) await productBarcodes.assertFree(conn, saleId || 0, [pack.barcode]);
            const values = [base.category_id, saleName(base, pack.label), grossToNet(pack.sale_price, taxRate), taxRate,
                base.jofotara_tax_category, pack.barcode, Number(base.is_active) === 1 ? 1 : 0];
            if (saleId !== null) {
                await conn.query(
                    `UPDATE products SET category_id = ?, name = ?, price = ?, tax_rate = ?, jofotara_tax_category = ?, barcode = ?,
                            is_active = ?, is_bundle = 0, stock = NULL WHERE id = ?`, [...values, saleId]);
            } else {
                const [created] = await conn.query(
                    `INSERT INTO products (category_id, name, price, cost_price, tax_rate, jofotara_tax_category, barcode, is_active, stock)
                     VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL)`,
                    [values[0], values[1], values[2], values[3], values[4], values[5], values[6]]);
                saleId = Number(created.insertId);
            }
            await linkSaleProduct(conn, saleId, stockItemId, pack.factor);
            changed.add(saleId);
        }
        await conn.query(
            'INSERT INTO product_packs (product_id, label, factor, sort_order, sale_product_id) VALUES (?, ?, ?, ?, ?)',
            [id, pack.label, pack.factor, index, saleId]);
        saved.push({ label: pack.label, factor: pack.factor, sale_price: pack.sale_price, barcode: pack.barcode, sale_product_id: saleId });
    }
    await appendAuditEvent(conn, {
        eventType: 'product_packs_changed', userId: actorId, entityType: 'product', entityId: id,
        oldValue: { packs: existing.map((row) => ({ label: row.label, factor: trimFactor(row.factor), sale_product_id: row.sale_product_id })) },
        newValue: { packs: saved }, ipAddress,
    });
    changed.add(id);
    return { packs: await list(conn, id), product_ids: [...changed] };
}

// Keep the sale products of a product's packs active only while the product is.
async function syncSaleProductsActive(conn, baseProductId, isActive) {
    await conn.query(
        `UPDATE products p JOIN product_packs pk ON pk.sale_product_id = p.id
            SET p.is_active = ?
          WHERE pk.product_id = ? AND EXISTS (SELECT 1 FROM product_stock_links sl WHERE sl.product_id = p.id)`,
        [isActive ? 1 : 0, baseProductId]);
}

module.exports = { MAX_PACKS, normalize, list, replace, syncSaleProductsActive };
