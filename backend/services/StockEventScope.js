const pool = require('../config/db');
const logger = require('../config/logger');

// A stock event names the products whose displayed stock may have changed so
// tills reload only when one is on screen or in the cart. Above the cap, or when
// the lookup fails, the event carries no ids and tills keep the full refresh.
const MAX_STOCK_EVENT_PRODUCT_IDS = 200;
// The lookup runs after the response; a stalled pool must not hold the emit.
const STOCK_EVENT_LOOKUP_TIMEOUT_MS = 1500;
// One lookup at a time process-wide: a burst of sales (or a stalled database)
// can never queue more than one optional read ahead of user-facing work.
let lookupInFlight = false;

const positiveIds = (values) => [...new Set((values || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];

// Products sold or restored, plus every product linked to a stock item that a
// sold product or a consumed recipe ingredient moved. One indexed read
// (product_stock_links.stock_item_id foreign key, ingredients unique key).
async function resolveStockAffectedProductIds(db, { productIds = [], ingredientIds = [], stockItemIds = [], timeoutMs = STOCK_EVENT_LOOKUP_TIMEOUT_MS } = {}) {
    const products = positiveIds(productIds);
    const ingredients = positiveIds(ingredientIds);
    const items = positiveIds(stockItemIds);
    // A stock item id that cannot be named exactly makes the set unknown.
    if (items.length !== new Set([...stockItemIds].map(String)).size) return null;
    if (!products.length && !ingredients.length && !items.length) return null;
    // Every list is bounded before it reaches the IN clauses.
    if (products.length > MAX_STOCK_EVENT_PRODUCT_IDS || ingredients.length > MAX_STOCK_EVENT_PRODUCT_IDS || items.length > MAX_STOCK_EVENT_PRODUCT_IDS) return null;
    // Restores post to the stock items saved on the sale, which may no longer be
    // the product's current links, so those items are named directly.
    // LIMIT keeps a widely shared stock item bounded; a set over the cap falls back.
    // SET STATEMENT gives the read a server-side deadline: the server ends it and
    // the connection returns to the pool, so an abandoned lookup cannot hold one.
    const [rows] = await db.query(
        `SET STATEMENT max_statement_time=${Math.max(timeoutMs, 1) / 1000} FOR
         SELECT DISTINCT sl.product_id
           FROM (SELECT stock_item_id FROM product_stock_links WHERE product_id IN (?)
                 UNION
                 SELECT stock_item_id FROM ingredients WHERE id IN (?) AND stock_item_id IS NOT NULL
                 UNION
                 SELECT stock_item_id FROM product_stock_links WHERE stock_item_id IN (?)) touched
           JOIN product_stock_links sl ON sl.stock_item_id = touched.stock_item_id
          LIMIT ${MAX_STOCK_EVENT_PRODUCT_IDS + 1}`,
        [products.length ? products : [0], ingredients.length ? ingredients : [0], items.length ? items : [0]]
    );
    const affected = new Set(products);
    for (const row of rows) affected.add(Number(row.product_id));
    if (affected.size > MAX_STOCK_EVENT_PRODUCT_IDS) return null;
    return [...affected].sort((a, b) => a - b);
}

// Emits after commit and never throws on a lookup failure. Without ids the
// payload is the legacy one, so tills keep the full refresh. While another
// lookup is running the event goes out unscoped at once instead of queueing.
async function emitStockChangedEvent(io, { productIds, ingredientIds, stockItemIds, db = pool, timeoutMs = STOCK_EVENT_LOOKUP_TIMEOUT_MS } = {}) {
    let ids = null;
    if (!lookupInFlight) {
        let timer;
        lookupInFlight = true;
        // The gate opens when the read really ends (server deadline), not when we stop waiting.
        const lookup = resolveStockAffectedProductIds(db, { productIds, ingredientIds, stockItemIds, timeoutMs });
        lookup.then(() => { lookupInFlight = false; }, () => { lookupInFlight = false; });
        try {
            ids = await Promise.race([
                lookup,
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Stock event scope lookup timed out.')), timeoutMs); })
            ]);
        } catch (error) {
            logger.error({ err: error }, 'Stock event scope lookup failed; sending an unscoped stock event.');
        } finally {
            clearTimeout(timer);
        }
    }
    // A resolved set with no products means nothing on any till changed; an empty
    // list would read as unscoped and reload every till.
    if (ids && ids.length === 0) return;
    io.to('staff').emit('inventory_changed', ids ? { scope: 'stock', productIds: ids } : { scope: 'stock' });
}

// Notification only: a committed mutation never waits for the lookup (pool
// acquire) and a failure here can never fail or crash its response.
function announceStockChanged(io, { logContext = {}, ...args } = {}) {
    void emitStockChangedEvent(io, args).catch(error => logger.error({ err: error, ...logContext }, 'Stock event emit failed.'));
}

// After a committed stock document (purchase invoice, stock count): drop the catalog caches the product and
// ingredient routes drop, and tell tills and ingredient screens what changed. `scope` is posting.eventScope().
function announceStockDocument(req, scope) {
    if (!scope) return;
    const { invalidateCatalogCache, invalidateDashboardCache } = require('../config/cache');
    const { triggerStaticMenuGeneration } = require('../config/menuCache');
    invalidateCatalogCache();
    if (scope.hasProducts) {
        invalidateDashboardCache();
        triggerStaticMenuGeneration();
    }
    if (!req.io) return;
    if (scope.hasIngredients) req.io.to('staff').emit('ingredients_changed', { ingredientIds: scope.ingredientIds });
    announceStockChanged(req.io, {
        productIds: scope.productIds, ingredientIds: scope.ingredientIds, stockItemIds: scope.stockItemIds,
        logContext: { route: req.originalUrl, method: req.method },
    });
}

module.exports = { STOCK_EVENT_LOOKUP_TIMEOUT_MS, MAX_STOCK_EVENT_PRODUCT_IDS, resolveStockAffectedProductIds, emitStockChangedEvent, announceStockChanged, announceStockDocument };
