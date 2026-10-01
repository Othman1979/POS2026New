'use strict';

const crypto = require('crypto');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { availabilitySql } = require('../../services/StockProductAdapter');
const { attachRegisterPrices } = require('../../services/categoryPriceLists');
const { OWNER_IDS_SQL } = require('../../services/productBarcodes');
const { fetchCartProducts } = require('../../services/InventoryService');
const { loadCheckoutSettings } = require('../../services/OrderPricing');
const { calculateExpectedTotals, calculateLineTotal } = require('../../services/PosCalculator');
const { canonicalizeHeldCart } = require('../../services/HeldOrderCanonicalizer');
const { normalizeCustomerPhone, redactCustomerPhone } = require('../../services/customerPhone');
const heldLifecycle = require('../../services/HeldOrderLifecycleService');
const { normalizeDraftInput, normalizeExternalRequestId, intakeError } = require('./contract');
const { requestHash, quoteHash, createQuoteToken, verifyQuoteToken } = require('./quoteToken');

const PRODUCT_SEARCH_LIMIT = 20;
const CATALOG_BROWSE_LIMIT = 20;
const CATALOG_SEARCH_TOKEN_LIMIT = 6;

function catalogEligibilitySql(includeUnavailable = false) {
    return `
        p.is_active=1 ${includeUnavailable ? '' : 'AND p.is_available=1'}
        AND COALESCE(c.is_active, 1)=1 AND COALESCE(c.is_notes, 0)=0
        AND (p.is_bundle=0 OR (
            EXISTS (
                SELECT 1 FROM product_bundle_items bundle_member
                 WHERE bundle_member.bundle_id=p.id
            )
            AND NOT EXISTS (
                SELECT 1 FROM product_bundle_items unavailable_member
                JOIN products unavailable_child ON unavailable_child.id=unavailable_member.product_id
                WHERE unavailable_member.bundle_id=p.id
                  AND (unavailable_child.is_active<>1 OR unavailable_child.is_available<>1)
            )
        ))
        AND NOT EXISTS (
            SELECT 1 FROM categories inactive_root
            WHERE inactive_root.id=c.price_list_root_id
              AND inactive_root.price_list_root_id=inactive_root.id
              AND inactive_root.is_active<>1
        )
    `;
}

function escapeLike(value) {
    return String(value).replace(/[=%_]/g, character => `=${character}`);
}

function parseCatalogInteger(rawValue, { name, defaultValue, minimum = 0, maximum = Number.MAX_SAFE_INTEGER }) {
    if (rawValue == null) return defaultValue;
    const value = String(rawValue).trim();
    if (!/^\d+$/.test(value)) throw intakeError(`${name} must be a whole number.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw intakeError(`${name} must be between ${minimum} and ${maximum}.`);
    }
    return parsed;
}

function holdRequestId(clientId, externalRequestId) {
    return `oi-${crypto.createHash('sha256').update(`${clientId}:${externalRequestId}`, 'utf8').digest('hex').slice(0, 61)}`;
}

function parseModifiers(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function publicModifierDefinitions(value) {
    return parseModifiers(value).slice(0, 50).map(group => ({
        id: typeof group?.id === 'string' ? group.id : null,
        name: String(group?.name || '').slice(0, 100),
        required: group?.required === true || group?.required === 1 || group?.required === '1' || group?.required === 'true',
        multi_select: group?.multi_select === true || group?.multi_select === 1 || group?.multi_select === '1' || group?.multi_select === 'true',
        options: Array.isArray(group?.options) ? group.options.slice(0, 100).map(option => ({
            id: typeof option?.id === 'string' ? option.id : null,
            name: String(option?.name || '').slice(0, 100),
            price: Number(option?.price) || 0,
        })) : [],
    })).filter(group => group.name && group.options.length);
}

async function loadActor(executor, config, { forUpdate = false } = {}) {
    const [[actor]] = await executor.query(`
        SELECT id, name, role, is_active
          FROM users
         WHERE id=?
         LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}
    `, [config.actorUserId]);
    if (!actor || actor.role !== 'call_center' || Number(actor.is_active) !== 1) {
        throw intakeError('The configured order-intake actor is unavailable.', 503, 'ORDER_INTAKE_ACTOR_UNAVAILABLE');
    }
    return { ...actor, permissions: [], allowed_sections: null, table_access_scope: 'none' };
}

async function assertOrderType(executor, orderTypeId) {
    const [[row]] = await executor.query(`
        SELECT ot.id, ot.name
          FROM order_types ot
          LEFT JOIN settings y ON y.setting_key='y_order_type_id'
         WHERE ot.id=? AND ot.is_active=1 AND COALESCE(ot.is_deferred_settlement, 0)=0
           AND (COALESCE(y.setting_value, '')='' OR ot.id<>CAST(y.setting_value AS UNSIGNED))
         LIMIT 1
    `, [orderTypeId]);
    if (!row) throw intakeError('This order type is not available for order intake.', 409, 'ORDER_INTAKE_ORDER_TYPE_UNAVAILABLE');
    return { id: Number(row.id), name: row.name };
}

function resolveRequestedModifiers(product, requested, itemIndex) {
    const definitions = publicModifierDefinitions(product.modifiers);
    const selected = [];
    const selectedByGroup = new Map();
    const pricedNotes = new Set();

    for (const entry of requested) {
        if (entry.noteProductId) {
            if (pricedNotes.has(entry.noteProductId)) throw intakeError(`Item ${itemIndex + 1} contains a duplicate priced note.`);
            pricedNotes.add(entry.noteProductId);
            selected.push({ noteProductId: entry.noteProductId });
            continue;
        }
        const group = (entry.gid && definitions.find(candidate => candidate.id === entry.gid))
            || definitions.find(candidate => candidate.name === entry.group);
        const option = group && ((entry.oid && group.options.find(candidate => candidate.id === entry.oid))
            || group.options.find(candidate => candidate.name === entry.option));
        if (!group || !option) {
            throw intakeError(`Item ${itemIndex + 1} contains an unavailable modifier.`, 409, 'ORDER_INTAKE_MODIFIER_UNAVAILABLE');
        }
        const key = `${group.id || group.name}:${option.id || option.name}`;
        if (selected.some(existing => existing._key === key)) throw intakeError(`Item ${itemIndex + 1} contains a duplicate modifier.`);
        const count = (selectedByGroup.get(group) || 0) + 1;
        if (!group.multi_select && count > 1) {
            throw intakeError(`Item ${itemIndex + 1} allows one option from ${group.name}.`, 409, 'ORDER_INTAKE_MODIFIER_CONFLICT');
        }
        selectedByGroup.set(group, count);
        selected.push({
            _key: key,
            ...(group.id ? { gid: group.id } : {}),
            ...(option.id ? { oid: option.id } : {}),
            group: group.name,
            option: option.name,
        });
    }

    for (const group of definitions) {
        if (group.required && !selectedByGroup.has(group)) {
            throw intakeError(`Item ${itemIndex + 1} requires a selection from ${group.name}.`, 409, 'ORDER_INTAKE_MODIFIER_REQUIRED');
        }
    }
    return selected.map(({ _key, ...entry }) => entry);
}

async function loadBundleMembers(executor, bundleIds) {
    if (!bundleIds.length) return new Map();
    const [rows] = await executor.query(`
        SELECT pbi.bundle_id, pbi.product_id, pbi.qty, p.name, p.category_id
          FROM product_bundle_items pbi
          JOIN products p ON p.id=pbi.product_id
         WHERE pbi.bundle_id IN (?)
         ORDER BY pbi.bundle_id, pbi.sort_order
    `, [bundleIds]);
    const result = new Map();
    for (const row of rows) {
        const id = Number(row.bundle_id);
        if (!result.has(id)) result.set(id, []);
        result.get(id).push(row);
    }
    return result;
}

async function buildCartLines(executor, draft, { stockEnabled }) {
    const preliminary = draft.items.map(item => ({
        product_id: item.product_id,
        selectedModifiers: item.modifiers,
    }));
    const productMap = await fetchCartProducts(executor, preliminary, { includeCheckoutContext: true });
    const bundleIds = draft.items
        .filter(item => Number(productMap.get(item.product_id)?.is_bundle) === 1)
        .map(item => item.product_id);
    const bundleMembers = await loadBundleMembers(executor, [...new Set(bundleIds)]);
    const quantities = new Map();

    const lines = draft.items.map((item, index) => {
        const product = productMap.get(item.product_id);
        if (!product || Number(product.product_is_active) !== 1 || Number(product.category_is_active ?? 1) !== 1
            || Number(product.category_is_notes) === 1 || Number(product.is_available) !== 1 || Number(product.can_sell) !== 1) {
            throw intakeError(`Item ${index + 1} is unavailable.`, 409, 'ORDER_INTAKE_PRODUCT_UNAVAILABLE');
        }
        quantities.set(item.product_id, (quantities.get(item.product_id) || 0) + item.quantity);
        const selectedModifiers = resolveRequestedModifiers(product, item.modifiers, index);
        const isBundle = Number(product.is_bundle) === 1;
        if (!isBundle && item.bundle_changes.length) {
            throw intakeError(`Item ${index + 1} is not a bundle.`, 400, 'ORDER_INTAKE_BUNDLE_INVALID');
        }
        let bundleItems;
        if (isBundle) {
            const members = bundleMembers.get(item.product_id) || [];
            if (!members.length) throw intakeError(`Item ${index + 1} has no available bundle definition.`, 409, 'ORDER_INTAKE_BUNDLE_UNAVAILABLE');
            const memberIds = new Set(members.map(member => Number(member.product_id)));
            const changes = new Map();
            for (const change of item.bundle_changes) {
                if (!memberIds.has(change.product_id)) throw intakeError(`Item ${index + 1} contains an invalid bundle change.`);
                if (changes.has(change.product_id)) throw intakeError(`Item ${index + 1} contains a duplicate bundle change.`);
                changes.set(change.product_id, change);
            }
            bundleItems = members.map(member => ({
                product_id: Number(member.product_id),
                name: member.name,
                category_id: member.category_id,
                qty: Number(member.qty),
                removed: changes.get(Number(member.product_id))?.removed === true,
                note: changes.get(Number(member.product_id))?.note || null,
            }));
        }
        return {
            id: item.product_id,
            product_id: item.product_id,
            qty: item.quantity,
            price: 0,
            tax_rate: 0,
            note: item.note,
            selectedModifiers: selectedModifiers.length ? selectedModifiers : null,
            ...(bundleItems ? { bundleItems } : {}),
        };
    });

    for (const [productId, quantity] of quantities) {
        const product = productMap.get(productId);
        if (stockEnabled && product?.stock != null && Number(product.stock) + 1e-9 < quantity) {
            throw intakeError(`${product.name} has insufficient stock.`, 409, 'ORDER_INTAKE_STOCK_UNAVAILABLE');
        }
    }
    return { lines, productMap, bundleMembers };
}

async function canonicalizeDraft(executor, draft, actor, config) {
    const orderType = await assertOrderType(executor, draft.order_type_id);
    const settings = await loadCheckoutSettings(executor);
    const prepared = await buildCartLines(executor, draft, { stockEnabled: settings.stockEnabled });
    const canonical = await canonicalizeHeldCart(executor, actor, { items: prepared.lines }, {
        accountingTaxInclusive: false,
        savedTaxRegistrationType: settings.taxRegistrationType,
        catalogProductMap: prepared.productMap,
        validatedMembersByBundleId: prepared.bundleMembers,
        registerPricesResolved: true,
    });
    const cart = {
        items: canonical.canonicalItems,
        customer_name: draft.customer.name,
        customer_phone: draft.customer.phone,
        customer_address: draft.customer.address,
        order_type_id: orderType.id,
        delivery_date: draft.delivery_at,
        order_note: draft.order_note,
        tax_inclusive_at_hold: 0,
        receipt_tax_inclusive_at_hold: settings.receiptTaxInclusiveDisplay ? 1 : 0,
        tax_registration_type_at_hold: canonical.taxRegistrationType,
        tax_exempt_at_hold: false,
        tax_context_version: 1,
    };
    const totals = calculateExpectedTotals(
        { order_discount_type: null, order_discount_value: 0 },
        canonical.canonicalItems,
        canonical.productMap,
        false,
        { taxRegistrationType: canonical.taxRegistrationType }
    );
    const requestDigest = requestHash(draft);
    const quoteDigest = quoteHash({ clientId: config.clientId, actorUserId: actor.id, cart, totals });
    return { draft, actor, orderType, cart, totals, requestDigest, quoteDigest, canonicalSubtotal: canonical.canonicalSubtotal };
}

function presentQuote(canonical, tokenResult) {
    return {
        quote_token: tokenResult.token,
        expires_at: new Date(tokenResult.claims.exp * 1000).toISOString(),
        currency: 'JOD',
        order_type: canonical.orderType,
        customer: canonical.draft.customer,
        order_note: canonical.draft.order_note || null,
        delivery_at: canonical.draft.delivery_at || null,
        items: canonical.cart.items.map(item => ({
            product_id: Number(item.product_id),
            name: item.name,
            quantity: Number(item.qty),
            unit_price: Number(item.price),
            line_total: Number(calculateLineTotal(item).toFixed(2)),
            note: item.note || null,
            modifiers: item.selectedModifiers || [],
            bundle_items: item.bundleItems || [],
        })),
        subtotal: Number(canonical.totals.subtotal),
        tax: Number(canonical.totals.tax),
        total: Number(canonical.totals.total),
    };
}

async function quoteOrder(rawDraft, context) {
    const draft = normalizeDraftInput(rawDraft);
    const actor = await loadActor(pool, context.config);
    const canonical = await canonicalizeDraft(pool, draft, actor, context.config);
    const tokenResult = createQuoteToken({
        config: context.config,
        actorUserId: actor.id,
        requestDigest: canonical.requestDigest,
        quoteDigest: canonical.quoteDigest,
    });
    return { canonical, response: presentQuote(canonical, tokenResult) };
}

function readStoredResult(row) {
    if (!row) return null;
    let result;
    try {
        result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json;
    } catch (_) {
        throw new Error('Stored order-intake result is invalid.');
    }
    if (!result || !Number.isSafeInteger(Number(result.id)) || Number(result.id) <= 0) {
        throw new Error('Stored order-intake result is invalid.');
    }
    return result;
}

function presentStoredRequest(row) {
    if (!row) return null;
    const result = readStoredResult(row);
    const active = Number(row.held_order_active) === 1;
    return {
        ...result,
        version: active ? Number(row.current_version) : Number(result.version),
        replay: true,
        active,
        kitchen_fired: active ? Number(row.current_kitchen_fired) === 1 : Boolean(result.kitchen_fired),
    };
}

function replayRequestResult(row, { requestDigest }) {
    if (!row) return null;
    if (row.request_hash !== requestDigest) {
        throw intakeError('This external request id was already used for another order.', 409, 'ORDER_INTAKE_IDEMPOTENCY_CONFLICT');
    }
    return presentStoredRequest(row);
}

async function findRequestResult(executor, { clientId, externalRequestId }) {
    const [[row]] = await executor.query(`
        SELECT intake.request_hash, intake.result_json,
               CASE WHEN held.id IS NULL THEN 0 ELSE 1 END AS held_order_active,
               held.version AS current_version, held.kitchen_fired AS current_kitchen_fired
          FROM order_intake_requests intake
          LEFT JOIN held_orders held ON held.id=intake.held_order_id
         WHERE intake.client_id=? AND intake.external_request_id=?
         LIMIT 1
    `, [clientId, externalRequestId]);
    return row || null;
}

async function submitHeldOrder(rawBody, context, io) {
    const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
    const unsupported = Object.keys(body).filter(key => !['draft', 'quote_token', 'confirmed'].includes(key));
    if (unsupported.length) throw intakeError(`Held-order submission contains unsupported fields: ${unsupported.join(', ')}.`);
    if (body.confirmed !== true) throw intakeError('Explicit customer confirmation is required.', 409, 'ORDER_INTAKE_CONFIRMATION_REQUIRED');
    const draft = normalizeDraftInput(body.draft);
    const requestDigest = requestHash(draft);
    const requestId = holdRequestId(context.clientId, draft.external_request_id);
    let conn;
    try {
        conn = await pool.getConnection();
        // Catalog authority must be serialized with concurrent catalog writes.
        // Plain reads therefore take shared InnoDB locks until this short hold
        // creation transaction commits, establishing one unambiguous catalog
        // version for quote verification and persistence.
        await conn.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        await conn.beginTransaction();
        // One configured actor owns this bounded queue. The exclusive actor row
        // lock serializes the capacity check and idempotency reservation without
        // adding a process-local mutex or a separate counter.
        const actor = await loadActor(conn, context.config, { forUpdate: true });
        const existingRequest = await findRequestResult(conn, {
            clientId: context.clientId,
            externalRequestId: draft.external_request_id,
        });
        const replay = replayRequestResult(existingRequest, { requestDigest });
        if (replay) {
            await conn.commit();
            return replay;
        }
        const claims = verifyQuoteToken(body.quote_token, {
            config: context.config,
            actorUserId: actor.id,
            requestDigest,
        });
        const canonical = await canonicalizeDraft(conn, draft, actor, context.config);
        if (canonical.quoteDigest !== claims.quote_hash) {
            const replacementToken = createQuoteToken({
                config: context.config,
                actorUserId: actor.id,
                requestDigest: canonical.requestDigest,
                quoteDigest: canonical.quoteDigest,
            });
            const error = intakeError('The order changed. Read the updated quote and confirm again.', 409, 'ORDER_INTAKE_REQUOTE_REQUIRED');
            error.publicData = { quote: presentQuote(canonical, replacementToken) };
            throw error;
        }
        const [[active]] = await conn.query(`
            SELECT COUNT(*) AS count
              FROM held_orders
             WHERE call_center_user_id=?
        `, [actor.id]);
        if (Number(active.count) >= context.config.activeHoldLimit) {
            throw intakeError(
                'The order-intake queue is full. Transfer the caller to a human.',
                429,
                'ORDER_INTAKE_ACTIVE_HOLD_LIMIT'
            );
        }
        canonical.cart._hold_request_fingerprint = canonical.quoteDigest;
        canonical.cart._order_intake = {
            client_id: context.clientId,
            external_request_id: draft.external_request_id,
            request_hash: canonical.requestDigest,
            quote_hash: canonical.quoteDigest,
            quote_totals: canonical.totals,
            confirmed_at: new Date().toISOString(),
            dispatch_policy: 'hold_only',
        };
        const [inserted] = await conn.query(`
            INSERT INTO held_orders
                (user_id, call_center_user_id, hold_request_id, reference_name, cart_data, subtotal, service_charge_snapshot_id)
            VALUES (?, ?, ?, '', ?, ?, NULL)
        `, [actor.id, actor.id, requestId, JSON.stringify(canonical.cart), canonical.canonicalSubtotal]);
        const referenceName = `Phone #${inserted.insertId}`;
        await conn.query('UPDATE held_orders SET reference_name=? WHERE id=?', [referenceName, inserted.insertId]);
        await heldLifecycle.appendHeldOrderAudit(conn, {
            actor,
            eventType: 'held_order_created',
            heldOrderId: inserted.insertId,
            newVersion: 1,
            operationId: requestId,
            call_center_user_id: Number(actor.id),
            intake_client_id: context.clientId,
            dispatch_policy: 'hold_only',
        });
        const result = {
            id: Number(inserted.insertId),
            reference_name: referenceName,
            version: 1,
            replay: false,
            active: true,
            kitchen_fired: false,
            totals: canonical.totals,
        };
        await conn.query(`
            INSERT INTO order_intake_requests
                (client_id, external_request_id, request_hash, held_order_id, result_json)
            VALUES (?, ?, ?, ?, ?)
        `, [
            context.clientId,
            draft.external_request_id,
            canonical.requestDigest,
            inserted.insertId,
            JSON.stringify(result),
        ]);
        await conn.commit();
        try {
            io?.to('staff').emit('held_orders_changed', {
                action: 'created',
                source: 'call_center',
                channel: 'order_intake',
                held_order_id: inserted.insertId,
            });
        } catch (notificationError) {
            logger.warn({ err: notificationError, heldOrderId: inserted.insertId }, 'Order-intake hold committed without a socket notification.');
        }
        return result;
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        if (error?.code === 'ER_DUP_ENTRY') {
            const existingRequest = await findRequestResult(pool, {
                clientId: context.clientId,
                externalRequestId: draft.external_request_id,
            });
            const replay = replayRequestResult(existingRequest, { requestDigest });
            if (replay) return replay;
        }
        throw error;
    } finally {
        if (conn) conn.release();
    }
}

async function lookupRequest(externalRequestId, context) {
    const normalizedId = normalizeExternalRequestId(externalRequestId);
    const row = await findRequestResult(pool, {
        clientId: context.clientId,
        externalRequestId: normalizedId,
    });
    return presentStoredRequest(row);
}

async function listOrderTypes(context) {
    await loadActor(pool, context.config);
    const [rows] = await pool.query(`
        SELECT ot.id, ot.name
          FROM order_types ot
          LEFT JOIN settings y ON y.setting_key='y_order_type_id'
         WHERE ot.is_active=1 AND COALESCE(ot.is_deferred_settlement, 0)=0
           AND (COALESCE(y.setting_value, '')='' OR ot.id<>CAST(y.setting_value AS UNSIGNED))
         ORDER BY ot.id
    `);
    return rows.map(row => ({ id: Number(row.id), name: row.name }));
}

async function searchCatalog(rawQuery, rawLimit, context) {
    await loadActor(pool, context.config);
    const query = String(rawQuery || '').trim();
    if (!query || query.length > 80) throw intakeError('Search text must contain 1-80 characters.');
    const limit = Math.min(Math.max(Number.parseInt(rawLimit, 10) || 10, 1), PRODUCT_SEARCH_LIMIT);
    const escaped = escapeLike(query);
    const contains = `%${escaped}%`;
    const starts = `${escaped}%`;
    const tokens = [...new Set(query.match(/[\p{L}\p{N}]+/gu) || [])]
        .slice(0, CATALOG_SEARCH_TOKEN_LIMIT)
        .map(token => `%${escapeLike(token)}%`);
    const tokenSql = tokens.length > 1
        ? ` OR (${tokens.map(() => "(p.name LIKE ? ESCAPE '=' OR c.name LIKE ? ESCAPE '=')").join(' AND ')})`
        : '';
    const tokenParams = tokens.length > 1 ? tokens.flatMap(token => [token, token]) : [];
    const [rows] = await pool.query(`
        SELECT p.id, p.barcode, p.name, p.price, p.tax_rate, p.category_id, p.modifiers, p.is_bundle, p.customer_info,
               ${availabilitySql('p')} AS stock, c.name AS category_name,
               1 AS can_sell
          FROM products p
          LEFT JOIN categories c ON c.id=p.category_id
         WHERE ${catalogEligibilitySql()}
           AND (p.name LIKE ? ESCAPE '=' OR p.id IN (${OWNER_IDS_SQL}) OR c.name LIKE ? ESCAPE '='${tokenSql})
         ORDER BY (p.id IN (${OWNER_IDS_SQL})) DESC, (p.name LIKE ? ESCAPE '=') DESC, p.name, p.id
         LIMIT ?
    `, [contains, query, query, contains, ...tokenParams, query, query, starts, limit]);
    const productMap = new Map(rows.map(row => [Number(row.id), row]));
    await attachRegisterPrices(pool, productMap);
    const bundles = await loadBundleMembers(pool, rows.filter(row => Number(row.is_bundle) === 1).map(row => Number(row.id)));
    const products = rows.filter(row => Number(row.can_sell) === 1).map(row => ({
        id: Number(row.id),
        barcode: row.barcode || null,
        name: row.name,
        category: row.category_name || null,
        customer_info: row.customer_info || null,
        unit_price: Number(row.effective_price ?? row.price),
        tax_rate: Number(row.tax_rate) || 0,
        stock: row.stock == null ? null : Number(row.stock),
        modifiers: publicModifierDefinitions(row.modifiers),
        bundle_items: (bundles.get(Number(row.id)) || []).map(member => ({
            product_id: Number(member.product_id),
            name: member.name,
            quantity: Number(member.qty),
        })),
    }));
    // Successful searches keep their existing query budget. Only a miss checks
    // whether the requested product is temporarily disabled by the cashier.
    let unavailableProducts = [];
    if (!products.length) {
        const [unavailable] = await pool.query(`SELECT p.id, p.name, c.name AS category
            FROM products p LEFT JOIN categories c ON c.id=p.category_id
            WHERE ${catalogEligibilitySql(true)} AND p.is_available=0
              AND (p.name LIKE ? ESCAPE '=' OR p.id IN (${OWNER_IDS_SQL})) ORDER BY p.id LIMIT 3`, [contains, query, query]);
        unavailableProducts = unavailable.map(row => ({ id: Number(row.id), name: row.name, category: row.category, available: false }));
    }
    return { products, unavailable_products: unavailableProducts };
}

async function browseCatalog(rawCategoryId, rawCursor, rawLimit, context) {
    await loadActor(pool, context.config);
    const categoryId = parseCatalogInteger(rawCategoryId, {
        name: 'category_id',
        defaultValue: null,
        minimum: 1,
    });
    const cursor = parseCatalogInteger(rawCursor, { name: 'cursor', defaultValue: 0 });
    const limit = parseCatalogInteger(rawLimit, {
        name: 'limit',
        defaultValue: 10,
        minimum: 1,
        maximum: CATALOG_BROWSE_LIMIT,
    });

    if (categoryId == null) {
        const [rows] = await pool.query(`
            SELECT c.id, c.name
              FROM categories c
             WHERE c.id>? AND c.is_active=1 AND c.is_notes=0
               AND EXISTS (
                    SELECT 1
                      FROM products p
                     WHERE p.category_id=c.id AND ${catalogEligibilitySql()}
               )
             ORDER BY c.id
             LIMIT ?
        `, [cursor, limit + 1]);
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit).map(row => ({ id: Number(row.id), name: row.name }));
        return {
            view: 'categories',
            categories: page,
            next_cursor: hasMore ? page[page.length - 1].id : null,
        };
    }

    const [rows] = await pool.query(`
        SELECT p.id, p.name, p.price, p.category_id, c.name AS category_name
          FROM products p
          JOIN categories c ON c.id=p.category_id
         WHERE p.category_id=? AND p.id>? AND ${catalogEligibilitySql()}
         ORDER BY p.id
         LIMIT ?
    `, [categoryId, cursor, limit + 1]);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const productMap = new Map(pageRows.map(row => [Number(row.id), row]));
    await attachRegisterPrices(pool, productMap);
    const products = pageRows.map(row => ({
        id: Number(row.id),
        name: row.name,
        category: row.category_name,
        unit_price: Number(row.effective_price ?? row.price),
    }));
    return {
        view: 'products',
        products,
        next_cursor: hasMore ? products[products.length - 1].id : null,
    };
}

async function lookupCustomer(phone, context) {
    await loadActor(pool, context.config);
    const normalized = normalizeCustomerPhone(phone);
    try {
        const [rows] = await pool.query(
            'SELECT id, name, address FROM customers WHERE phone_normalized=? ORDER BY id LIMIT 2',
            [normalized]
        );
        if (rows.length > 1) throw intakeError('More than one customer uses this phone number.', 409, 'ORDER_INTAKE_CUSTOMER_AMBIGUOUS');
        return rows[0] ? { id: Number(rows[0].id), name: rows[0].name, address: rows[0].address } : null;
    } catch (error) {
        logger.error({ err: error, phone: redactCustomerPhone(phone), intakeClientId: context.clientId }, 'Order-intake customer lookup failed.');
        throw error;
    }
}

module.exports = {
    holdRequestId,
    listOrderTypes,
    browseCatalog,
    searchCatalog,
    lookupCustomer,
    lookupRequest,
    quoteOrder,
    submitHeldOrder,
};
