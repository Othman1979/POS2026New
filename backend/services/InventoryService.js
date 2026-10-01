const logger = require('../config/logger');
const { toFiniteNumber, sanitizeSelectedModifiers } = require('./PosCalculator');
const { journalProductDeltas, restoreProductSnapshots, loadLinks, availabilitySql } = require('./StockProductAdapter');
const stockQuantity = require('./stockQuantity');
const stockSnapshots = require('./StockSaleSnapshots');

const fetchCartProducts = async (conn, cartItems, {
    lock = false,
    includeNoteProducts = true,
    includeCheckoutContext = false
} = {}) => {
    if (lock && includeCheckoutContext) {
        throw new TypeError('Checkout context cannot be loaded through a locking product read.');
    }
    const baseProductIds = [...new Set(cartItems
        .map(item => Number(item.product_id))
        .filter(id => Number.isSafeInteger(id) && id > 0))];
    const noteProductIds = includeNoteProducts ? [...new Set(cartItems.flatMap(item =>
        (sanitizeSelectedModifiers(item.selectedModifiers) || [])
            .map(selection => Number(selection.noteProductId))
            .filter(id => Number.isSafeInteger(id) && id > 0)
    ))] : [];
    const productIds = [...new Set([...baseProductIds, ...noteProductIds])].sort((a, b) => a - b);
    if (productIds.length === 0) return new Map();

    const placeholders = productIds.map(() => '?').join(',');
    const checkoutColumns = includeCheckoutContext ? `,
               p.is_bundle,
               price_list_root.id AS price_list_root_id,
               price_list_root.name AS price_list_root_name,
               CASE
                 WHEN price_list_root.id IS NULL THEN p.price
                 ELSE COALESCE(price_override.price, p.price)
               END AS effective_price` : '';
    const checkoutJoins = includeCheckoutContext ? `
        LEFT JOIN categories price_list_root
          ON price_list_root.id = c.price_list_root_id
         AND c.is_notes = 0
         AND price_list_root.price_list_root_id = price_list_root.id
         AND price_list_root.parent_id IS NULL
         AND price_list_root.is_notes = 0
         AND price_list_root.is_active = 1
        LEFT JOIN product_price_overrides price_override
          ON price_override.price_list_root_id = price_list_root.id
         AND price_override.product_id = p.id` : '';
    const [rows] = await conn.query(`
        SELECT p.id, p.name, p.price, p.tax_rate, p.jofotara_tax_category, ${availabilitySql('p')} AS stock, p.stock_version, p.category_id, p.modifiers,
               p.is_active AS product_is_active,
               c.is_active AS category_is_active,
               c.is_notes AS category_is_notes,
               p.is_available,
               CASE
                 WHEN p.is_available = 1
                  AND (p.is_bundle = 0 OR NOT EXISTS (
                    SELECT 1
                    FROM product_bundle_items pbi
                    JOIN products child ON child.id = pbi.product_id
                    WHERE pbi.bundle_id = p.id
                      AND (child.is_active <> 1 OR child.is_available <> 1)
                  ))
                 THEN 1 ELSE 0
               END AS can_sell${checkoutColumns}
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        ${checkoutJoins}
        WHERE p.id IN (${placeholders})
        ${lock ? 'FOR UPDATE' : ''}
    `, productIds);

    const productMap = new Map(rows.map((row) => {
        let modifiers = null;
        if (row.modifiers) {
            try {
                modifiers = typeof row.modifiers === 'string' ? JSON.parse(row.modifiers) : row.modifiers;
            } catch (e) {
                logger.error({ err: e, productId: row.id }, 'Failed to parse product modifiers');
            }
        }
        const checkoutContext = includeCheckoutContext ? {
            price_list_root_id: row.price_list_root_id == null ? null : Number(row.price_list_root_id),
            effective_price: Number(row.effective_price)
        } : {};
        return [Number(row.id), { ...row, ...checkoutContext, modifiers }];
    }));

    if (baseProductIds.some(id => !productMap.has(id))) {
        throw new Error('One or more products in the cart no longer exist.');
    }

    return productMap;
};

// A source can restore an old composition, deduct a new product composition
// and consume recipes. Lock their complete union before the first stock post.
// Per-adapter sorting alone cannot prevent opposite-order source deadlocks.
async function prepareStockWrite(conn,{items=[],savedItems=[],recipeEnabled=false}={}) {
    const products=[...new Set([...items,...savedItems].map(row=>Number(row.product_id)).filter(id=>Number.isSafeInteger(id)&&id>0))].sort((a,b)=>a-b);
    if(!products.length)return null;
    const [productRows]=await conn.query('SELECT id,name,stock,CAST(stock_version AS CHAR) stock_version FROM products WHERE id IN (?) ORDER BY id FOR UPDATE',[products]);
    const recipes=require('./RecipeLedgerService');
    const recipeContext=recipeEnabled?await recipes.loadRecipeContext(conn,items):null;
    const ingredientIds=recipeContext?[...recipeContext.recipeLinesByProductId.values()].flat().map(row=>row.ingredient_id):[];
    const keys=savedItems.map(row=>row.recipe_line_key).filter(Boolean);
    const {ingredients}=await recipes.lockLineIngredients(conn,keys,ingredientIds);
    const links=await loadLinks(conn,products);
    const itemIds=new Set(links.map(row=>String(row.stock_item_id)));
    for(const row of savedItems){
        const original=stockSnapshots.read(row);
        if(original?.authority!=='product')continue;
        for(const part of original.version>=2?original.components:[original])itemIds.add(String(part.stock_item_id));
    }
    let physicalIngredients=0;
    if(ingredients.length){
        const [physical]=await conn.query('SELECT CAST(stock_item_id AS CHAR) stock_item_id FROM ingredients WHERE id IN (?) AND stock_item_id IS NOT NULL ORDER BY id FOR UPDATE',[ingredients.map(row=>row.id)]);
        physicalIngredients=physical.length;
        for(const row of physical)itemIds.add(row.stock_item_id);
    }
    if(itemIds.size&&(physicalIngredients||savedItems.length))await conn.query('SELECT id FROM stock_items WHERE id IN (?) ORDER BY id FOR UPDATE',[[...itemIds].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0)]);
    return {recipeContext,links,productRows,fresh:!savedItems.length};
}

const deductStockForCart = async (conn, cartItems, stockContext) => {
    for (const item of cartItems) {
        if (!item.product_id) continue;
        if (!Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0) {
            throw new Error(`Invalid quantity for product ${item.product_id}.`);
        }
    }
    const quantities = new Map();

    for (const item of cartItems) {
        if (!item.product_id) continue;
        const productId = Number(item.product_id);
        if (!Number.isSafeInteger(productId) || productId <= 0) throw new Error('Invalid stock product.');
        quantities.set(productId, (quantities.get(productId) || 0) + Number(item.qty));
    }
    if (!quantities.size) return new Map();
    const productIds = [...quantities.keys()].sort((a, b) => a - b);
    // Pricing/availability was resolved by the caller. Stock mutation needs only
    // these identities, not an exclusive lock on every product's category row.
    const plan=stockContext?.plan;
    const [products] = plan?.fresh?[plan.productRows.filter(row=>productIds.includes(Number(row.id)))]:await conn.query(`SELECT id,name,stock,CAST(stock_version AS CHAR) stock_version FROM products
        WHERE id IN (${productIds.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, productIds);
    if(plan)plan.fresh=false;
    const productMap = new Map(products.map(product => [Number(product.id), product]));
    if (productMap.size !== productIds.length) throw new Error('One or more products in the cart no longer exist.');
    // A locking product read does not make a nested EXISTS a current read.
    // Resolve links explicitly after the product lock, even under an old snapshot.
    const resolvedLinks=stockContext?.plan?stockContext.plan.links.filter(row=>productIds.includes(Number(row.product_id))):await loadLinks(conn,productIds);
    const linkedIds=[...new Set(resolvedLinks.map(row=>Number(row.product_id)))];
    if(linkedIds.length&&!stockContext)throw new Error('Linked stock requires a durable source context.');
    const linkedSet=new Set(linkedIds);

    const updateCases = [];
    const updateParams = [];
    const idsToUpdate = [];

    for (const [productId, qty] of quantities) {
        const product = productMap.get(productId);
        if (product && !linkedSet.has(productId) && product.stock !== null && product.stock !== undefined) {
            const currentStock = toFiniteNumber(product.stock, 0);
            if (currentStock + 1e-9 < qty) {
                throw new Error(`Insufficient stock for ${product.name}. Only ${currentStock} remaining.`);
            }
            updateCases.push('WHEN id = ? THEN stock - ?');
            updateParams.push(productId, qty);
            idsToUpdate.push(productId);
        }
    }

    if (idsToUpdate.length > 0) {
        const sql = `
            UPDATE products
            SET stock_version = stock_version + 1, stock = CASE
                ${updateCases.join('\n                ')}
                ELSE stock
            END
            WHERE id IN (${idsToUpdate.map(() => '?').join(',')}) AND stock IS NOT NULL
        `;
        await conn.query(sql, [...updateParams, ...idsToUpdate]);
    }
    const posted = stockContext ? await journalProductDeltas(conn, {
        ...stockContext, kind: 'issue',
        resolvedLinks,
        before: [...quantities.keys()].map(id => productMap.get(id)),
        deltas: new Map([...quantities].map(([id, value]) => [id, (-value).toFixed(6)]))
    }) : null;
    return new Map([...quantities.keys()].map(id => [id, posted?.productSnapshots.get(id) ??
        (productMap.get(id)?.stock == null ? { authority: 'none' } : { version: 1, authority: 'legacy_product' })]));
};

const restoreStockForCart = async (conn, cartItems, stockContext) => {
    let quantities = new Map();
    const effectiveItems=[];
    for (const item of cartItems || []) {
        if (!item?.product_id) continue;
        const snapshot = stockSnapshots.read(item);
        if (snapshot?.authority === 'none') continue;
        if (stockContext?.savedAuthorityOnly && !['product','legacy_product'].includes(snapshot?.authority)) continue;
        if(snapshot?.authority==='product'&&!stockContext)throw new Error('Linked stock requires a durable source context.');
        const quantity = Number(item.qty ?? item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        quantities.set(Number(item.product_id), (quantities.get(Number(item.product_id)) || 0) + quantity);
        effectiveItems.push(item);
    }
    if (!quantities.size) return false;
    let before;
    if (stockContext) {
        [before] = await conn.query('SELECT id,CAST(stock AS CHAR) AS stock,CAST(stock_version AS CHAR) AS stock_version FROM products WHERE id IN (?) ORDER BY id FOR UPDATE', [[...quantities.keys()].sort((a, b) => a - b)]);
        const restored=await restoreProductSnapshots(conn,{...stockContext,before,cartItems:effectiveItems});
        quantities=new Map([...restored.legacy].map(([id,units])=>[id,stockQuantity.format(units)]));
    }
    if(!quantities.size)return true;
    const cases = [];
    const params = [];
    const ids = [];
    for (const [productId, quantity] of quantities) {
        cases.push('WHEN id = ? THEN stock + ?');
        params.push(productId, quantity);
        ids.push(productId);
    }
    await conn.query(`UPDATE products SET stock_version = stock_version + 1, stock = CASE ${cases.join(' ')} ELSE stock END
                       WHERE id IN (${ids.map(() => '?').join(',')}) AND stock IS NOT NULL`, [...params, ...ids]);
    return true;
};

const restockOrderItems = async (conn, invoiceId, stockContext) => {
    const [oldItems] = await conn.query(
        'SELECT product_id, quantity,stock_authority,stock_snapshot FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL AND parent_item_id IS NULL',
        [invoiceId]
    );
    if (oldItems.length === 0) return false;
    // Callers that announce the stock change pass a Set to learn which products were restored.
    if (stockContext?.touchedProductIds) for (const row of oldItems) stockContext.touchedProductIds.add(Number(row.product_id));
    return restoreStockForCart(conn, oldItems, stockContext);
};

module.exports = { prepareStockWrite, fetchCartProducts, deductStockForCart, restockOrderItems, restoreStockForCart };
