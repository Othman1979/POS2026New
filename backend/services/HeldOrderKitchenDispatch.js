const { formatOrderNumber } = require('../utils/orderNumber');
const crypto = require('crypto');
const { ensureHeldOrderNumber } = require('./HeldOrderNumber');
const { parseBackendTimestamp } = require('../utils/businessDate');
const { buildKitchenPrintPayloads, expandBundlesForKitchen, filterRoutableKitchenLines } = require('./kitchenPrintRouting');
const { enqueuePrintJobs } = require('./printDispatch');

const ACCEPTED_QUEUE_STATES = new Set(['pending', 'processing', 'sent', 'acknowledged']);
const KITCHEN_SNAPSHOT_VERSION = 1;

function dispatchError(message, statusCode = 409, publicCode = 'HELD_KITCHEN_OPERATION_CONFLICT') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.publicCode = publicCode;
    return error;
}

function stableHeldOrderTime(value) {
    const date = parseBackendTimestamp(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).sort().join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function cleanForSignature(value) {
    if (Array.isArray(value)) return value.map(cleanForSignature).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    if (!value || typeof value !== 'object') return value;
    const ignored = new Set([
        'qty', 'quantity', 'price', 'price_at_sale', 'total', 'subtotal', 'tax_rate',
        'tax_amount', 'modifier_tax_amount', 'modifier_surcharge', 'manual_price_override',
        'discountType', 'discountValue', 'discount_type', 'discount_value', 'cartId',
        'held_line_id', 'preparation_signature', 'created_at', '_isOther', '_bundleLabel',
        'jofotara_tax_category', 'tax_context_version', 'tax_inclusive_at_hold',
        'tax_registration_type_at_hold', 'bundle_snapshot_version', 'is_available', 'can_sell'
    ]);
    return Object.fromEntries(Object.keys(value)
        .filter(key => !ignored.has(key) && value[key] !== undefined)
        .sort()
        .map(key => [key, cleanForSignature(value[key])]));
}

function buildPreparationSignature(item = {}) {
    return sha256(stableJson(cleanForSignature(item)));
}

function lineNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function assignNestedLineIds(items, parentId) {
    if (!Array.isArray(items)) return items;
    return items.map((item, index) => {
        const existing = item && item.held_line_id ? String(item.held_line_id) : '';
        const signature = buildPreparationSignature(item);
        const heldLineId = existing || `${parentId}-child-${index + 1}`;
        return {
            ...item,
            held_line_id: heldLineId,
            preparation_signature: signature,
            ...(Array.isArray(item?.bundleItems) ? { bundleItems: assignNestedLineIds(item.bundleItems, heldLineId) } : {})
        };
    });
}

function assignStableHeldLineIds(items, {
    heldId,
    previousItems = [],
    protectedLineIds = new Set(),
    mode = 'initial'
} = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!Number.isSafeInteger(Number(heldId)) || Number(heldId) <= 0) {
        throw dispatchError('A held order ID is required for kitchen line identity.', 400, 'HELD_KITCHEN_ID_REQUIRED');
    }

    const previous = new Map((Array.isArray(previousItems) ? previousItems : [])
        .filter(item => item?.held_line_id)
        .map(item => [String(item.held_line_id), item]));
    const unusedBySignature = new Map();
    for (const item of previous.values()) {
        const signature = item.preparation_signature || buildPreparationSignature(item);
        const bucket = unusedBySignature.get(signature) || [];
        bucket.push(item);
        unusedBySignature.set(signature, bucket);
    }
    const used = new Set();
    let nextNumber = 1;
    for (const id of previous.keys()) {
        const match = String(id).match(new RegExp(`^held-${Number(heldId)}-line-(\\d+)$`));
        if (match) nextNumber = Math.max(nextNumber, Number(match[1]) + 1);
    }

    const assigned = list.map((rawItem, index) => {
        const item = { ...rawItem };
        const submittedId = item.held_line_id == null ? '' : String(item.held_line_id).trim();
        const submittedSignature = buildPreparationSignature(item);
        let heldLineId = submittedId;
        if (mode === 'initial') {
            heldLineId = `held-${Number(heldId)}-line-${index + 1}`;
        } else if (heldLineId) {
            const old = previous.get(heldLineId);
            if (!old || used.has(heldLineId)) {
                throw dispatchError('The held kitchen line identity is invalid.', 409, 'HELD_KITCHEN_LINE_ID_INVALID');
            }
            const oldSignature = old.preparation_signature || buildPreparationSignature(old);
            if (oldSignature !== submittedSignature && protectedLineIds.has(heldLineId)) {
                throw dispatchError('A kitchen-sent line was changed. Use the cancellation workflow.', 409, 'HELD_KITCHEN_SENT_LINE_CONFLICT');
            }
        } else {
            const bucket = (unusedBySignature.get(submittedSignature) || []).find(candidate => !used.has(String(candidate.held_line_id)));
            if (bucket) heldLineId = String(bucket.held_line_id);
            else {
                heldLineId = `held-${Number(heldId)}-line-${nextNumber}`;
                nextNumber += 1;
            }
        }
        used.add(heldLineId);
        const old = previous.get(heldLineId);
        const signature = mode === 'initial' || !old || !protectedLineIds.has(heldLineId)
            ? submittedSignature
            : (old.preparation_signature || submittedSignature);
        if (old && protectedLineIds.has(heldLineId) && signature !== submittedSignature) {
            throw dispatchError('A kitchen-sent line was changed. Use the cancellation workflow.', 409, 'HELD_KITCHEN_SENT_LINE_CONFLICT');
        }
        return {
            ...item,
            held_line_id: heldLineId,
            preparation_signature: signature,
            ...(Array.isArray(item.bundleItems) ? { bundleItems: assignNestedLineIds(item.bundleItems, heldLineId) } : {})
        };
    });

    return { items: assigned, usedLineIds: used };
}

function canonicalLineSort(a, b) {
    return String(a.held_line_id || '').localeCompare(String(b.held_line_id || ''), 'en', { numeric: true });
}

function computePositiveKitchenDelta({ baseline = [], current = [] } = {}) {
    const baselineMap = new Map();
    for (const line of baseline) {
        if (!line?.held_line_id || baselineMap.has(String(line.held_line_id))) {
            throw dispatchError('The saved kitchen baseline is invalid.', 409, 'HELD_KITCHEN_SNAPSHOT_INVALID');
        }
        baselineMap.set(String(line.held_line_id), line);
    }
    const seen = new Set();
    const delta = [];
    for (const line of [...(Array.isArray(current) ? current : [])].sort(canonicalLineSort)) {
        const id = String(line?.held_line_id || '');
        if (!id || seen.has(id)) throw dispatchError('The submitted kitchen line identity is invalid.', 409, 'HELD_KITCHEN_LINE_ID_INVALID');
        seen.add(id);
        const old = baselineMap.get(id);
        if (!old) {
            const qty = lineNumber(line.qty ?? line.quantity);
            if (qty > 0) delta.push({ ...clone(line), qty });
            continue;
        }
        const oldSignature = old.preparation_signature || buildPreparationSignature(old.item || old);
        const currentSignature = line.preparation_signature || buildPreparationSignature(line);
        if (oldSignature !== currentSignature) {
            throw dispatchError('A kitchen-sent line was changed. Use the cancellation workflow.', 409, 'HELD_KITCHEN_SENT_LINE_CONFLICT');
        }
        const previousQty = lineNumber(old.qty);
        const nextQty = lineNumber(line.qty ?? line.quantity);
        if (nextQty < previousQty) {
            throw dispatchError('A kitchen-sent line was reduced. Use the cancellation workflow.', 409, 'HELD_KITCHEN_SENT_LINE_CONFLICT');
        }
        if (nextQty > previousQty) delta.push({ ...clone(line), qty: nextQty - previousQty, delta_qty: nextQty - previousQty });
    }
    for (const old of baselineMap.values()) {
        if (!seen.has(String(old.held_line_id))) {
            throw dispatchError('A kitchen-sent line was removed. Use the cancellation workflow.', 409, 'HELD_KITCHEN_SENT_LINE_CONFLICT');
        }
    }
    return delta.sort(canonicalLineSort);
}

function snapshotLine(line, printerIds = []) {
    if (!line?.held_line_id || !line?.preparation_signature) {
        throw dispatchError('The kitchen baseline is missing a stable line signature.', 409, 'HELD_KITCHEN_SNAPSHOT_INVALID');
    }
    return {
        held_line_id: String(line.held_line_id),
        preparation_signature: String(line.preparation_signature),
        qty: lineNumber(line.qty ?? line.quantity),
        item: {
            product_id: line.product_id ?? null,
            id: line.id ?? null,
            name: line.name ?? line.product_name ?? '',
            note: line.note || '',
            category_id: line.category_id ?? null,
            is_bundle: line.is_bundle || 0,
            _bundleLabel: line._bundleLabel || '',
            ...(Array.isArray(line.bundleItems) ? { bundleItems: clone(line.bundleItems) } : {})
        },
        printer_ids: [...new Set((printerIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)
    };
}

function buildKitchenSnapshot({ heldId, createdAt, sequence, batchId, lines = [], routes = [], previous = null, kind = 'initial' } = {}) {
    const sentLines = lines.map(line => snapshotLine(line, line.printer_ids || line.printerIds || routes
        .filter(route => route.held_line_id === line.held_line_id).map(route => route.printer_id)));
    const batch = {
        sequence: Number(sequence),
        kind,
        batch_id: String(batchId),
        created_at: stableHeldOrderTime(createdAt),
        lines: sentLines,
        routes: routes.map(route => ({
            printer_id: Number(route.printer_id),
            held_line_id: route.held_line_id ? String(route.held_line_id) : null
        })).filter(route => Number.isSafeInteger(route.printer_id) && route.printer_id > 0)
    };
    const previousBatches = Array.isArray(previous?.batches) ? previous.batches : [];
    const previousLines = Array.isArray(previous?.lines) ? previous.lines : [];
    const lineMap = new Map(previousLines.map(line => [String(line.held_line_id), clone(line)]));
    for (const line of sentLines) {
        const old = lineMap.get(line.held_line_id);
        if (!old) lineMap.set(line.held_line_id, line);
        else {
            old.qty = Math.round((Number(old.qty) + Number(line.qty)) * 1e6) / 1e6;
            old.printer_ids = [...new Set([...(old.printer_ids || []), ...(line.printer_ids || [])])].sort((a, b) => a - b);
        }
    }
    return {
        schema_version: KITCHEN_SNAPSHOT_VERSION,
        held_id: Number(heldId),
        created_at: stableHeldOrderTime(createdAt),
        baseline_unknown: false,
        sequence: Number(sequence),
        next_sequence: Number(sequence) + 1,
        lines: [...lineMap.values()].sort(canonicalLineSort),
        batches: [...previousBatches, batch]
    };
}

// For display: a snapshot that cannot be trusted means the baseline is unknown
// (the held board shows it for manual review instead of failing the whole list).
function kitchenBaselineKnown(value) {
    try { return Boolean(parseKitchenSnapshot(value)); } catch (_) { return false; }
}

function parseKitchenSnapshot(value) {
    if (!value) return null;
    let parsed;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch (_) {
        throw dispatchError('The kitchen baseline needs manual review.', 409, 'HELD_KITCHEN_SNAPSHOT_INVALID');
    }
    if (!parsed || parsed.schema_version !== KITCHEN_SNAPSHOT_VERSION || parsed.baseline_unknown === true ||
        !Array.isArray(parsed.lines) || !Array.isArray(parsed.batches) || !Number.isInteger(Number(parsed.sequence)) ||
        !Number.isInteger(Number(parsed.next_sequence)) || Number(parsed.next_sequence) !== Number(parsed.sequence) + 1) {
        throw dispatchError('The kitchen baseline needs manual review.', 409, 'HELD_KITCHEN_SNAPSHOT_INVALID');
    }
    for (const line of parsed.lines) {
        if (!Array.isArray(line.printer_ids) || line.printer_ids.length === 0) {
            throw dispatchError('The kitchen baseline needs manual review.', 409, 'HELD_KITCHEN_SNAPSHOT_INVALID');
        }
        snapshotLine({ ...line.item, ...line }, line.printer_ids);
    }
    for (const batch of parsed.batches) {
        if (!batch?.batch_id || !Array.isArray(batch.lines) || !Number.isInteger(Number(batch.sequence))) throw dispatchError('The kitchen baseline needs manual review.', 409, 'HELD_KITCHEN_SNAPSHOT_INVALID');
    }
    return parsed;
}

function buildCancellationBatchId(heldId, operationId, snapshot) {
    const sentSnapshotHash = sha256(stableJson(snapshot?.batches || snapshot?.lines || []));
    const cancellationHash = sha256(stableJson({ operation_id: String(operationId), sent_snapshot_hash: sentSnapshotHash }));
    return `held-${Number(heldId)}-cancel-${cancellationHash}`;
}

function buildRoundBatchId(heldId, sequence, createdAt, lines) {
    return `held-${Number(heldId)}-${Number(sequence)}-${sha256(stableJson({ created_at: stableHeldOrderTime(createdAt), lines }))}`;
}

function readItemsFromHeldRow(row) {
    let parsed;
    try { parsed = JSON.parse(row?.cart_data || '{}'); } catch (_) {
        throw dispatchError('The held order cart needs manual review.', 409, 'HELD_KITCHEN_CART_INVALID');
    }
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(items)) throw dispatchError('The held order cart needs manual review.', 409, 'HELD_KITCHEN_CART_INVALID');
    return { parsed: Array.isArray(parsed) ? { items } : parsed, items };
}

function primaryLinesByPrinter(payloads) {
    const routeByLine = new Map();
    for (const payload of payloads) {
        for (const item of payload.data?.items || []) {
            if (item?._isOther === true) continue;
            const id = String(item.held_line_id || item.cartId || item.id || '');
            if (!id) continue;
            const route = routeByLine.get(id) || [];
            route.push(Number(payload.printer_id));
            routeByLine.set(id, route);
        }
    }
    return routeByLine;
}

async function queueHeldKitchenRound({ db, heldOrder, items, operationId, sequence = 1, kind = 'initial', previousSnapshot = null }) {
    if (!db || typeof db.query !== 'function') throw new Error('Held kitchen round requires a transaction connection.');
    if (!Array.isArray(items) || items.length === 0) throw dispatchError('There are no preparation items to send.', 422, 'HELD_KITCHEN_ITEMS_EMPTY');
    const { routable, unavailable } = await filterRoutableKitchenLines(db, expandBundlesForKitchen(items));
    if (unavailable?.length) throw dispatchError('A configured kitchen station is disabled. Enable it before sending this order.', 409, 'HELD_KITCHEN_ROUTE_MISSING');
    if (routable.length === 0) throw dispatchError('There are no preparation items to send.', 422, 'HELD_KITCHEN_ITEMS_EMPTY');
    await ensureHeldOrderNumber(db, heldOrder);
    const batchId = kind === 'cancel'
        ? buildCancellationBatchId(heldOrder.id, operationId, previousSnapshot)
        : buildRoundBatchId(heldOrder.id, sequence, heldOrder.created_at, routable.map(item => ({ id: item.held_line_id, qty: item.qty, signature: item.preparation_signature })));
    const rawData = {
        held_order: true,
        print_batch_id: batchId,
        internal_invoice_id: null,
        invoice_id: null,
        order_display_no: formatOrderNumber(heldOrder) || String(heldOrder.id),
        ticket_display_no: null,
        order_id: heldOrder.order_id ?? heldOrder.id,
        order_taken_at: stableHeldOrderTime(heldOrder.created_at),
        date: stableHeldOrderTime(heldOrder.created_at),
        order_type_name: heldOrder.order_type_name || '',
        table_number: '',
        items: routable,
        follow_up: kind === 'follow_up',
        cancel_ticket: kind === 'cancel',
        follow_up_sequence: kind === 'follow_up' ? Number(sequence) : null
    };
    const { payloads } = await buildKitchenPrintPayloads(db, rawData);
    if (payloads.length === 0) throw dispatchError('There are no preparation items to send.', 422, 'HELD_KITCHEN_ITEMS_EMPTY');
    const queued = await enqueuePrintJobs(db, payloads, { returnStatus: true });
    const rejected = queued.find(job => !ACCEPTED_QUEUE_STATES.has(String(job.status || 'pending')));
    if (rejected) throw dispatchError('A previous kitchen job requires manual review before this order can continue.', 409, 'HELD_KITCHEN_QUEUE_NOT_ACCEPTED');
    const routeByLine = primaryLinesByPrinter(payloads);
    const expanded = expandBundlesForKitchen(routable);
    const lines = expanded.map(item => ({ ...item, printer_ids: routeByLine.get(String(item.held_line_id || item.cartId || item.id)) || [] }));
    if (lines.some(line => !line.printer_ids.length)) throw dispatchError('A kitchen line has no durable printer route.', 409, 'HELD_KITCHEN_ROUTE_EVIDENCE_MISSING');
    const snapshot = kind === 'cancel' ? previousSnapshot : buildKitchenSnapshot({
        heldId: heldOrder.id,
        createdAt: heldOrder.created_at,
        sequence,
        batchId,
        lines,
        routes: [...routeByLine.entries()].flatMap(([held_line_id, printerIds]) => printerIds.map(printer_id => ({ held_line_id, printer_id }))),
        previous: previousSnapshot,
        kind
    });
    return { batchId, payloads, queued, count: payloads.length, snapshot, lines };
}

async function buildHeldKitchenBaseline({ db, heldOrder, items, operationId }) {
    if (!db || typeof db.query !== 'function') throw new Error('Held kitchen baseline requires a transaction connection.');
    if (!Array.isArray(items) || items.length === 0) throw dispatchError('There are no preparation items to confirm.', 422, 'HELD_KITCHEN_ITEMS_EMPTY');
    const { routable } = await filterRoutableKitchenLines(db, expandBundlesForKitchen(items));
    if (routable.length === 0) throw dispatchError('There are no preparation items to confirm.', 422, 'HELD_KITCHEN_ITEMS_EMPTY');
    const batchId = `held-${Number(heldOrder.id)}-baseline-confirm-${String(operationId)}`;
    const { payloads } = await buildKitchenPrintPayloads(db, {
        print_batch_id: batchId,
        internal_invoice_id: null,
        invoice_id: null,
        order_display_no: formatOrderNumber(heldOrder) || String(heldOrder.id),
        ticket_display_no: null,
        order_id: heldOrder.order_id ?? heldOrder.id,
        order_taken_at: stableHeldOrderTime(heldOrder.created_at),
        date: stableHeldOrderTime(heldOrder.created_at),
        order_type_name: heldOrder.order_type_name || '',
        table_number: '',
        items: routable,
        follow_up: false,
        cancel_ticket: false
    });
    if (payloads.length === 0) throw dispatchError('There are no preparation items to confirm.', 422, 'HELD_KITCHEN_ITEMS_EMPTY');
    const routeByLine = primaryLinesByPrinter(payloads);
    const expanded = expandBundlesForKitchen(routable);
    const lines = expanded.map(item => ({ ...item, printer_ids: routeByLine.get(String(item.held_line_id || item.cartId || item.id)) || [] }));
    if (lines.some(line => !line.printer_ids.length)) throw dispatchError('A kitchen line has no durable printer route.', 409, 'HELD_KITCHEN_ROUTE_EVIDENCE_MISSING');
    return {
        batchId,
        payloads,
        count: 0,
        snapshot: buildKitchenSnapshot({
            heldId: heldOrder.id,
            createdAt: heldOrder.created_at,
            sequence: 0,
            batchId,
            lines,
            routes: [...routeByLine.entries()].flatMap(([held_line_id, printerIds]) => printerIds.map(printer_id => ({ held_line_id, printer_id }))),
            previous: null,
            kind: 'baseline_confirmation'
        })
    };
}

async function queueHeldKitchenCancellation({ db, heldOrder, operationId, snapshot, partial = false }) {
    if (!db || typeof db.query !== 'function') throw new Error('Held kitchen cancellation requires a transaction connection.');
    const parsedSnapshot = parseKitchenSnapshot(snapshot);
    if (!parsedSnapshot || !Array.isArray(parsedSnapshot.lines)) {
        throw dispatchError('The fired held order has no valid kitchen baseline.', 409, 'HELD_KITCHEN_SNAPSHOT_INVALID');
    }
    if (parsedSnapshot.lines.length === 0) return {batchId:buildCancellationBatchId(heldOrder.id,operationId,parsedSnapshot),payloads:[],queued:[],count:0};
    const printerIds = [...new Set(parsedSnapshot.lines.flatMap(line => line.printer_ids || []).map(Number))]
        .filter(id => Number.isSafeInteger(id) && id > 0);
    if (printerIds.length === 0) {
        throw dispatchError('The original kitchen printer route is unavailable. Review this cancellation manually.', 409, 'HELD_KITCHEN_ROUTE_MISSING');
    }

    const [printers] = await db.query(
        `SELECT id, name, windows_name, type, network_ip, network_port, status_capability
           FROM printers
          WHERE role='kitchen' AND is_active=1 AND id IN (${printerIds.map(() => '?').join(',')})`,
        printerIds
    );
    const printerById = new Map((printers || []).map(printer => [Number(printer.id), printer]));
    if (printerIds.some(id => !printerById.has(id))) {
        throw dispatchError('The original kitchen printer route is unavailable. Review this cancellation manually.', 409, 'HELD_KITCHEN_ROUTE_MISSING');
    }

    const batchId = buildCancellationBatchId(heldOrder.id, operationId, parsedSnapshot);
    const payloads = printerIds.map(printerId => {
        const printer = printerById.get(printerId);
        const items = parsedSnapshot.lines
            .filter(line => (line.printer_ids || []).map(Number).includes(printerId))
            .map(line => ({
                ...clone(line.item),
                held_line_id: line.held_line_id,
                preparation_signature: line.preparation_signature,
                qty: line.qty,
                quantity: line.qty
            }));
        if (items.length === 0) return null;
        const orderTakenAt = stableHeldOrderTime(heldOrder.created_at);
        return {
            printer_id: printer.id,
            printer_name: printer.windows_name || printer.name,
            printer_type: printer.type,
            network_ip: printer.network_ip,
            network_port: printer.network_port,
            status_capability: printer.status_capability || 'write_only',
            print_type: 'kitchen',
            data: {
                held_order: true,
                print_batch_id: batchId,
                internal_invoice_id: null,
                invoice_id: null,
                order_display_no: formatOrderNumber(heldOrder) || String(heldOrder.id),
                ticket_display_no: null,
                order_id: heldOrder.order_id ?? heldOrder.id,
                order_taken_at: orderTakenAt,
                date: orderTakenAt,
                order_type_name: heldOrder.order_type_name || '',
                table_number: '',
                items,
                follow_up: false,
                cancel_ticket: !partial,
                void_ticket: partial,
                follow_up_sequence: null
            }
        };
    }).filter(Boolean);

    if (payloads.length === 0) {
        throw dispatchError('The original kitchen printer route is unavailable. Review this cancellation manually.', 409, 'HELD_KITCHEN_ROUTE_MISSING');
    }
    const queued = await enqueuePrintJobs(db, payloads, { returnStatus: true });
    const rejected = queued.find(job => !ACCEPTED_QUEUE_STATES.has(String(job.status || 'pending')));
    if (rejected) throw dispatchError('A previous kitchen cancellation job requires manual review before this order can continue.', 409, 'HELD_KITCHEN_QUEUE_NOT_ACCEPTED');
    return { batchId, payloads, queued, count: payloads.length };
}

// A re-held order is compared with what the kitchen actually received, not the
// previous edit. Cancel changed preparation on its original stations, then send
// only replacement/new work. Both rounds and the new baseline commit together.
async function queueHeldKitchenChanges({ db, heldOrder, items, operationId, snapshot }) {
    const expanded = expandBundlesForKitchen(items);
    const { routable, unavailable } = await filterRoutableKitchenLines(db, expanded);
    const oldById = new Map(snapshot.lines.map(line => [String(line.held_line_id), line]));
    if (unavailable?.some(line => {
        const old = oldById.get(String(line.held_line_id));
        return !old || old.preparation_signature !== line.preparation_signature || Number(old.qty) !== Number(line.qty);
    })) throw dispatchError('A configured kitchen station is disabled. Enable it before sending this order.', 409, 'HELD_KITCHEN_ROUTE_MISSING');
    const quantity = value => Math.round(Number(value) * 1e6) / 1e6;
    const currentById = new Map(expanded.map(line => [String(line.held_line_id), line]));
    const routableIds = new Set(routable.map(line => String(line.held_line_id)));
    const removed = [], added = [], retained = [];
    for (const old of snapshot.lines) {
        const current = currentById.get(String(old.held_line_id));
        const same = current && current.preparation_signature === old.preparation_signature;
        const keptQty = same ? Math.min(Number(old.qty), Number(current.qty)) : 0;
        if (keptQty > 0) retained.push({ ...clone(old), qty: keptQty });
        const removedQty = quantity(Number(old.qty) - keptQty);
        if (removedQty > 0) removed.push({ ...clone(old), qty: removedQty });
    }
    for (const current of expanded) {
        const old = oldById.get(String(current.held_line_id));
        if (!old && !routableIds.has(String(current.held_line_id))) continue;
        const keptQty = old?.preparation_signature === current.preparation_signature ? Number(old.qty) : 0;
        const qty = quantity(Number(current.qty) - keptQty);
        if (qty > 0) {
            if (!routableIds.has(String(current.held_line_id))) {
                throw dispatchError('The kitchen station for this change is unavailable.', 409, 'HELD_KITCHEN_ROUTE_MISSING');
            }
            added.push({ ...current, qty, quantity: qty });
        }
    }
    if (!removed.length && !added.length) return null;
    await ensureHeldOrderNumber(db, heldOrder);
    let next = { ...clone(snapshot), lines: retained };
    const queued = [], payloads = [];
    let batchId;
    if (removed.length) {
        const cancellation = await queueHeldKitchenCancellation({
            db, heldOrder, operationId, partial: true, snapshot: { ...snapshot, lines: removed }
        });
        queued.push(...cancellation.queued); payloads.push(...cancellation.payloads);
        batchId = cancellation.batchId;
        const sequence = Number(next.next_sequence);
        next = { ...next, sequence, next_sequence: sequence + 1,
            batches: [...next.batches, { sequence, kind: 'item_cancel', batch_id: batchId,
                created_at: stableHeldOrderTime(heldOrder.created_at), lines: removed, routes: [] }] };
    }
    if (added.length) {
        const addition = await queueHeldKitchenRound({ db, heldOrder, items: added, operationId,
            sequence: next.next_sequence, kind: 'follow_up', previousSnapshot: next });
        for (const line of addition.lines) {
            const earlier = retained.find(old => old.held_line_id === line.held_line_id);
            if (earlier && stableJson(earlier.printer_ids) !== stableJson(line.printer_ids)) {
                throw dispatchError('The original kitchen route changed. Review this item before increasing its quantity.', 409, 'HELD_KITCHEN_ROUTE_CHANGED');
            }
        }
        queued.push(...addition.queued); payloads.push(...addition.payloads);
        batchId = addition.batchId;
        next = addition.snapshot;
    }
    return { queued, payloads, count: payloads.length, batchId, snapshot: next };
}

// Compatibility mode is intentionally limited to the unit seam used by older
// integrations. Production held routes use queueHeldKitchenRound with the
// caller's transaction connection and never pass printKitchenOrder.
async function dispatchHeldOrderKitchen({ db, io, heldOrder, items, printKitchenOrder, operationId = null }) {
    if (Number(heldOrder?.kitchen_fired) === 1) throw dispatchError('This held order is already fired.', 409, 'HELD_KITCHEN_ALREADY_FIRED');
    if (typeof printKitchenOrder === 'function') {
        const count = await printKitchenOrder(io, {
            print_batch_id: `held-${heldOrder.id}`,
            order_id: heldOrder.order_id ?? heldOrder.id,
            invoice_id: '',
            date: stableHeldOrderTime(heldOrder.created_at),
            order_type_name: heldOrder.order_type_name,
            table_number: '',
            items
        });
        if (Number(count) < 1) throw dispatchError('No active kitchen printer route is available.', 422, 'HELD_KITCHEN_UNROUTED_ITEMS');
        const [result] = await db.query('UPDATE held_orders SET kitchen_fired = 1 WHERE id = ? AND kitchen_fired = 0', [heldOrder.id]);
        if (Number(result?.affectedRows) !== 1) throw dispatchError('Held order changed. Refresh and try again.', 409, 'HELD_VERSION_CONFLICT');
        return count;
    }
    const round = await queueHeldKitchenRound({ db, heldOrder, items, operationId, sequence: 1, kind: 'initial' });
    return round;
}

module.exports = {
    queueHeldKitchenChanges,
    ACCEPTED_QUEUE_STATES,
    KITCHEN_SNAPSHOT_VERSION,
    dispatchError,
    stableHeldOrderTime,
    stableJson,
    buildPreparationSignature,
    assignStableHeldLineIds,
    computePositiveKitchenDelta,
    buildKitchenSnapshot,
    parseKitchenSnapshot,
    kitchenBaselineKnown,
    buildCancellationBatchId,
    buildRoundBatchId,
    readItemsFromHeldRow,
    queueHeldKitchenRound,
    buildHeldKitchenBaseline,
    queueHeldKitchenCancellation,
    dispatchHeldOrderKitchen
};
