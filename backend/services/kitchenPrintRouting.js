const { sanitizePrintString } = require('./printText');
const { assertOrderItemBundleIntegrity, assertNestedBundleIntegrity } = require('./bundleIntegrity');

function sanitizeItem(item) {
    const cleaned = { ...item };
    for (const key of ['name', 'product_name', 'note', '_bundleLabel']) {
        if (key in cleaned) cleaned[key] = sanitizePrintString(cleaned[key], key === 'note' ? 500 : 200);
    }
    return cleaned;
}

function expandBundlesForKitchen(items) {
    const list = Array.isArray(items) ? items : [];
    assertNestedBundleIntegrity(list);
    assertOrderItemBundleIntegrity(list);
    const byId = new Map(list.map(item => [item.id ?? item.cartId, item]));
    const out = [];
    for (const item of list) {
        if (Array.isArray(item.bundleItems)) {
            const parentQty = Number(item.qty ?? item.quantity);
            for (const child of item.bundleItems) {
                if (child.removed === true) continue;
                const quantity = Number(child.qty ?? child.quantity) * parentQty;
                out.push({ ...child, qty: quantity, quantity, _bundleLabel: item.name });
            }
        } else if (item.is_bundle === 1 || item.is_bundle === true) {
            continue;
        } else if (item.parent_item_id) {
            out.push({ ...item, _bundleLabel: byId.get(item.parent_item_id)?.name });
        } else {
            out.push(item);
        }
    }
    return out;
}

function kitchenCategoryId(item) {
    return item?.category_id ?? item?.item?.category_id;
}

async function resolveKitchenPrinterMap(executor, items) {
    const categoryIds = [...new Set((items || []).map(item => kitchenCategoryId(item)).filter(Boolean))];
    const categoryMapping = new Map();
    if (categoryIds.length) {
        const [rows] = await executor.query(`SELECT id, parent_id FROM categories WHERE id IN (${categoryIds.map(() => '?').join(',')})`, categoryIds);
        rows.forEach(row => categoryMapping.set(Number(row.id), row));
    }
    const searchIds = [...new Set([...categoryIds, ...[...categoryMapping.values()].map(row => row.parent_id).filter(Boolean)])];
    const categoryPrinters = new Map();
    if (searchIds.length) {
        const [rows] = await executor.query(
            `SELECT DISTINCT pc.category_id, p.* FROM printers p JOIN printer_categories pc ON p.id = pc.printer_id
              WHERE pc.category_id IN (${searchIds.map(() => '?').join(',')}) AND p.role = 'kitchen'`, searchIds);
        rows.forEach(row => {
            const list = categoryPrinters.get(Number(row.category_id)) || [];
            list.push(row);
            categoryPrinters.set(Number(row.category_id), list);
        });
    }
    return { categoryMapping, categoryPrinters };
}

// Explicit assignments own the route even when their station is disabled.
// Otherwise disabling a station could silently send preparation to another kitchen.
function printersForCategory(categoryId, categoryMapping, categoryPrinters) {
    const direct = categoryPrinters.get(Number(categoryId));
    const parentId = categoryMapping.get(Number(categoryId))?.parent_id;
    const selected = direct?.length ? direct : (categoryPrinters.get(Number(parentId)) || []);
    return new Map(selected.filter(printer => Number(printer.is_active) === 1).map(printer => [printer.id, printer]));
}

async function filterRoutableKitchenLines(executor, expandedLines) {
    const lines = Array.isArray(expandedLines) ? expandedLines : [];
    const { categoryMapping, categoryPrinters } = await resolveKitchenPrinterMap(executor, lines);
    const routable = [];
    const unrouted = [];
    const unavailable = [];
    for (const item of lines) {
        const categoryId = kitchenCategoryId(item);
        const printers = printersForCategory(categoryId, categoryMapping, categoryPrinters);
        if (printers.size) routable.push(item);
        else {
            unrouted.push(item);
            const parentId = categoryMapping.get(Number(categoryId))?.parent_id;
            if (categoryPrinters.get(Number(categoryId))?.length || categoryPrinters.get(Number(parentId))?.length) unavailable.push(item);
        }
    }
    return { routable, unrouted, unavailable };
}

async function buildKitchenPrintPayloads(executor, rawData) {
    const stableOrderId = rawData.internal_invoice_id || rawData.invoice_id || rawData.order_id;
    const printBatchId = rawData.print_batch_id || (stableOrderId ? `order-${stableOrderId}` : null);
    if (!printBatchId) {
        const error = new Error('Kitchen print job is missing an order or print batch ID.');
        error.statusCode = 400;
        throw error;
    }
    const data = { ...rawData, items: expandBundlesForKitchen(rawData.items || []).map(sanitizeItem) };
    const lineKeys = new Map(data.items.map((item, index) => {
        const id = item.cartId ?? item.id;
        return [item, id == null ? `line:${index}` : `id:${id}`];
    }));
    const { categoryMapping, categoryPrinters } = await resolveKitchenPrinterMap(executor, data.items);
    const tickets = new Map();
    const unroutedItems = [];
    for (const item of data.items) {
        const printers = printersForCategory(kitchenCategoryId(item), categoryMapping, categoryPrinters);
        if (!printers.size) { unroutedItems.push(item); continue; }
        for (const printer of printers.values()) {
            const ticket = tickets.get(printer.id) || { printer, items: [], itemKeys: new Set() };
            const itemKey = lineKeys.get(item);
            if (!ticket.itemKeys.has(itemKey)) {
                ticket.itemKeys.add(itemKey);
                ticket.items.push(item);
            }
            tickets.set(printer.id, ticket);
        }
    }
    const payloads = [...tickets.values()].map(ticket => {
        const primaryIds = ticket.itemKeys;
        const otherItems = data.void_ticket === true || data.follow_up === true || data.cancel_ticket === true ? [] : data.items
            .filter(item => !primaryIds.has(lineKeys.get(item)))
            .map(item => ({ ...item, qty: item.qty ?? item.quantity, _isOther: true }));
        const orderTakenAt = data.void_ticket === true
            ? (ticket.items[0]?.created_at || data.order_taken_at || data.date || '')
            : (data.order_taken_at || data.date || '');
        return {
            printer_id: ticket.printer.id,
            printer_name: sanitizePrintString(ticket.printer.windows_name, 200),
            printer_type: ticket.printer.type,
            network_ip: ticket.printer.network_ip,
            network_port: ticket.printer.network_port,
            status_capability: ticket.printer.status_capability || 'write_only',
            print_type: 'kitchen',
            data: {
                print_batch_id: printBatchId, internal_invoice_id: data.internal_invoice_id, invoice_id: data.invoice_id,
                ...(data.held_order === true ? { held_order: true } : {}),
                invoice_number: data.invoice_number ?? null, invoice_display_no: data.invoice_display_no ?? null,
                order_display_no: data.order_display_no, ticket_display_no: data.ticket_display_no, order_id: data.order_id,
                order_taken_at: orderTakenAt, date: orderTakenAt, void_ticket: data.void_ticket === true,
                follow_up: data.follow_up === true,
                cancel_ticket: data.cancel_ticket === true,
                follow_up_sequence: data.follow_up === true && Number.isInteger(Number(data.follow_up_sequence))
                    ? Number(data.follow_up_sequence) : null,
                hash_number: data.hash_number == null ? null : sanitizePrintString(data.hash_number, 100),
                order_type_name: sanitizePrintString(data.order_type_name, 200),
                table_number: sanitizePrintString(data.table_number, 100),
                items: [...ticket.items.map(item => sanitizeItem({ ...item, qty: item.qty ?? item.quantity })), ...otherItems.map(sanitizeItem)],
                printer_label: sanitizePrintString(ticket.printer.name, 200),
                subscription_redemption: data.subscription_redemption ? {
                    reference: sanitizePrintString(data.subscription_redemption.reference, 100),
                    customer_name: sanitizePrintString(data.subscription_redemption.customer_name, 200),
                    customer_phone: sanitizePrintString(data.subscription_redemption.customer_phone, 100),
                    is_void: data.subscription_redemption.is_void === true
                } : null
            }
        };
    });
    return { payloads, unroutedItems };
}

module.exports = { buildKitchenPrintPayloads, expandBundlesForKitchen, filterRoutableKitchenLines, resolveKitchenPrinterMap };
