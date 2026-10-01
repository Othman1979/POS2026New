const QRCode = require('qrcode');

const MAX_TEMPLATE_NODES = 300;
const MAX_DEPTH = 5;
const MAX_TEXT_BYTES = 500;
const MAX_EXPANDED_NODES = 2000;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_QR_BYTES = 4096;
const PAPER_WIDTH_PX = 576;
const MIN_ABSOLUTE_BAND_HEIGHT = 40;
const MAX_ABSOLUTE_BAND_HEIGHT = 1200;
const MAX_ABSOLUTE_HEIGHT_TOTAL = 2400;
const POSITION_GRID_PX = 4;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FIELD_FORMATS = new Set(['plain', 'brackets', 'modifier', 'list']);
const KITCHEN_TICKET_TYPES = new Set(['normal', 'void', 'subscription', 'subscription_void', 'follow_up', 'cancel']);
const STYLE_VALUES = {
    fontFamily: new Set(['sans', 'mono', 'arabic']),
    fontSize: new Set(['xs', 'sm', 'note', 'item', 'base', 'lg', 'total', 'xl', '2xl', 'display', '3xl']),
    fontWeight: new Set(['normal', 'bold', 'black']),
    fontStyle: new Set(['normal', 'italic']),
    align: new Set(['left', 'center', 'right']),
    direction: new Set(['auto', 'ltr', 'rtl']),
    width: new Set([11.5, 13.5, 14, 23.75, 25, 33, 43, 46, 50, 54, 57, 64.75, 67, 75, 86, 86.5, 100]),
    marginTop: new Set([0, 4, 8, 12, 16, 24]),
    marginBottom: new Set([0, 4, 6, 8, 12, 16, 24]),
    marginInlineStart: new Set([0, 64, 65, 75, 76]),
    offsetY: new Set([-8, -6, -4, -2, 0, 2, 4, 6, 8]),
    padding: new Set([0, 4, 8, 10, 12]),
    labelLayout: new Set(['apart', 'inline']),
    textTransform: new Set(['none', 'uppercase']),
    letterSpacing: new Set([0, 1, 2, 3]),
    lineHeight: new Set([1, 1.2]),
    treatment: new Set(['plain', 'outline', 'reverse']),
    opacity: new Set([0.55, 0.7, 0.8, 1])
};
const INLINE_STYLE_VALUES = {
    fontWeight: STYLE_VALUES.fontWeight,
    fontStyle: STYLE_VALUES.fontStyle,
    textTransform: STYLE_VALUES.textTransform,
    letterSpacing: STYLE_VALUES.letterSpacing
};
const OPERATIONS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy', 'falsy']);

const RECEIPT_GLOBAL = {
    'store.name': 'text', 'store.address': 'text', 'store.phone': 'text',
    'store.customHeaderText': 'text', 'store.customFooterText': 'text',
    'meta.invoiceDisplayNo': 'text', 'meta.ticketDisplayNo': 'text', 'meta.orderDisplayNo': 'text',
    'meta.date': 'text', 'meta.orderTakenAt': 'text', 'meta.printRequestedAt': 'text',
    'meta.cashier': 'text', 'meta.taxNumber': 'text', 'meta.orderTypeName': 'text', 'meta.tableNumber': 'text',
    'meta.hashNumber': 'text', 'meta.provisional': 'boolean', 'meta.heldOrderReceipt': 'boolean', 'meta.guestCheck': 'boolean', 'meta.note': 'text',
    'customer.name': 'text', 'customer.phone': 'text', 'customer.address': 'text', 'customer.deliveryDate': 'text',
    'payment.method': 'text', 'payment.cashAmount': 'money', 'payment.cardAmount': 'money',
    'payment.amountTendered': 'money', 'payment.changeDue': 'money',
    'billing.terms': 'text', 'billing.issuedOn': 'text', 'billing.dueOn': 'text',
    'billing.invoiceTotal': 'money', 'billing.collectedAmount': 'money', 'billing.outstandingAmount': 'money',
    'summary.subtotal': 'money', 'summary.orderDiscountAmount': 'money',
    'summary.orderDiscountLabel': 'text', 'summary.taxAmount': 'money', 'summary.taxLabel': 'text',
    'summary.roundingAdjustment': 'money', 'summary.total': 'money',
    taxMode: 'text', status: 'text', currency: 'text', decimals: 'number'
};
const RECEIPT_ROW = {
    key: 'text', kind: 'text', name: 'text', note: 'text', qty: 'number',
    unitPrice: 'money', extendedPrice: 'money', lineDiscountAmount: 'money',
    lineDiscountLabel: 'text', netAmount: 'money'
};
const KITCHEN_GLOBAL = {
    'meta.ticketType': 'text', 'meta.ticketTypeLabel': 'text',
    'meta.invoiceDisplayNo': 'text', 'meta.ticketDisplayNo': 'text', 'meta.orderDisplayNo': 'text',
    'meta.date': 'text', 'meta.orderTakenAt': 'text', 'meta.printRequestedAt': 'text',
    'meta.orderTypeName': 'text', 'meta.tableNumber': 'text', 'meta.hashNumber': 'text',
    'meta.followUpSequence': 'number',
    'meta.voidWarning': 'text',
    voidTicket: 'boolean', hasOtherItems: 'boolean', 'subscriptionRedemption.reference': 'text',
    'subscriptionRedemption.customerName': 'text', 'subscriptionRedemption.customerPhone': 'text',
    'subscriptionRedemption.isVoid': 'boolean', printerLabel: 'text'
};
const KITCHEN_ITEM = { name: 'text', qty: 'number', note: 'text', bundleLabel: 'text', isOther: 'boolean' };

function fail(code, message) {
    const error = new Error(message || code);
    error.code = code;
    throw error;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function rejectDangerousKeys(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) fail('TEMPLATE_DANGEROUS_KEY', 'Template contains a prototype-mutated array');
        for (const key of Object.keys(value)) {
            if (DANGEROUS_KEYS.has(key)) fail('TEMPLATE_DANGEROUS_KEY', `Template contains forbidden key ${key}`);
            if (!/^(?:0|[1-9]\d*)$/.test(key)) fail('TEMPLATE_SCHEMA_INVALID', `Template array has unknown property ${key}`);
            rejectDangerousKeys(value[key]);
        }
        return;
    }
    if (!isPlainObject(value)) fail('TEMPLATE_DANGEROUS_KEY', 'Template contains a non-plain object or prototype mutation');
    for (const key of Object.keys(value)) {
        if (DANGEROUS_KEYS.has(key)) fail('TEMPLATE_DANGEROUS_KEY', `Template contains forbidden key ${key}`);
        rejectDangerousKeys(value[key]);
    }
}

function object(value, allowed, location) {
    if (!isPlainObject(value)) fail('TEMPLATE_SCHEMA_INVALID', `${location} must be an object`);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) fail('TEMPLATE_SCHEMA_INVALID', `${location} has unknown property ${key}`);
    }
    return value;
}

function string(value, location, { empty = true, maxBytes } = {}) {
    if (typeof value !== 'string' || (!empty && value.length === 0)) fail('TEMPLATE_SCHEMA_INVALID', `${location} must be a string`);
    if (maxBytes && Array.from(value).length > maxBytes) fail('TEMPLATE_TEXT_INVALID', `${location} exceeds ${maxBytes} characters`);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail('TEMPLATE_TEXT_INVALID', `${location} contains forbidden control bytes`);
    return value;
}

function catalogFor(docType) {
    if (docType === 'receipt') return { global: RECEIPT_GLOBAL, relative: RECEIPT_ROW, source: 'rows' };
    if (docType === 'kitchen') return { global: KITCHEN_GLOBAL, relative: KITCHEN_ITEM, source: 'items' };
    fail('TEMPLATE_DOC_TYPE_INVALID', `Unsupported document type ${docType}`);
}

function catalogEntry(catalog, path, scope) {
    const entries = scope === 'relative' ? catalog.relative : catalog.global;
    if (!Object.prototype.hasOwnProperty.call(entries, path)) fail('TEMPLATE_FIELD_NOT_ALLOWED', `Field ${path} is not allowed in this template location`);
    return { path, type: entries[path] };
}

function validateBilingual(value, location) {
    object(value, ['en', 'ar', 'mode'], location);
    string(value.en, `${location}.en`, { maxBytes: MAX_TEXT_BYTES });
    string(value.ar, `${location}.ar`, { maxBytes: MAX_TEXT_BYTES });
    if (!['auto', 'both'].includes(value.mode)) fail('TEMPLATE_SCHEMA_INVALID', `${location}.mode is invalid`);
}

function validateStyle(value, location) {
    if (value === undefined) return;
    object(value, Object.keys(STYLE_VALUES), location);
    for (const [key, allowed] of Object.entries(STYLE_VALUES)) {
        if (value[key] !== undefined && !allowed.has(value[key])) fail('TEMPLATE_SCHEMA_INVALID', `${location}.${key} is invalid`);
    }
}

function validateInlineStyle(value, location) {
    if (value === undefined) return;
    object(value, Object.keys(INLINE_STYLE_VALUES), location);
    for (const [key, allowed] of Object.entries(INLINE_STYLE_VALUES)) {
        if (value[key] !== undefined && !allowed.has(value[key])) fail('TEMPLATE_SCHEMA_INVALID', `${location}.${key} is invalid`);
    }
}

function validateFieldVariants(value, node) {
    if (value === undefined) return;
    if (node.path !== 'meta.ticketTypeLabel') fail('TEMPLATE_SCHEMA_INVALID', 'node.variants is only allowed for the kitchen ticket heading');
    object(value, [...KITCHEN_TICKET_TYPES], 'node.variants');
    for (const [ticketType, heading] of Object.entries(value)) {
        validateBilingual(heading, `node.variants.${ticketType}`);
        if (!heading.en.trim() && !heading.ar.trim()) fail('TEMPLATE_SCHEMA_INVALID', `node.variants.${ticketType} cannot be blank`);
    }
}

function validateCondition(value, catalog, scope, location) {
    object(value, ['path', 'op', 'value'], location);
    string(value.path, `${location}.path`, { empty: false });
    const entry = catalogEntry(catalog, value.path, scope);
    if (!OPERATIONS.has(value.op)) fail('TEMPLATE_SCHEMA_INVALID', `${location}.op is invalid`);
    if (['truthy', 'falsy'].includes(value.op)) {
        if (value.value !== null) fail('TEMPLATE_SCHEMA_INVALID', `${location}.${value.op} requires null value`);
        return entry;
    }
    if (['number', 'money'].includes(entry.type)) {
        if (typeof value.value !== 'number' || !Number.isFinite(value.value)) fail('TEMPLATE_SCHEMA_INVALID', `${location}.value must be a finite number`);
    } else if (entry.type === 'boolean') {
        if (typeof value.value !== 'boolean') fail('TEMPLATE_SCHEMA_INVALID', `${location}.value must be boolean`);
    } else if (entry.type === 'text') {
        string(value.value, `${location}.value`, { maxBytes: MAX_TEXT_BYTES });
    } else {
        fail('TEMPLATE_SCHEMA_INVALID', `${location}.value has unsupported field type`);
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(value.op) && !['number', 'money'].includes(entry.type)) {
        fail('TEMPLATE_SCHEMA_INVALID', `${location}.op requires a numeric field`);
    }
    return entry;
}

function nodeScope(band) {
    return band.kind === 'repeat' ? 'relative' : 'global';
}

function validateAbsoluteBox(node, bounds, location) {
    for (const key of ['x', 'y', 'widthPx', 'heightPx']) {
        if (!Number.isSafeInteger(node[key]) || node[key] < 0 || node[key] % POSITION_GRID_PX !== 0) {
            fail('TEMPLATE_POSITION_INVALID', `${location}.${key} must be a non-negative ${POSITION_GRID_PX}px-grid integer`);
        }
    }
    if (node.widthPx < POSITION_GRID_PX || node.heightPx < POSITION_GRID_PX || node.x + node.widthPx > bounds.width || node.y + node.heightPx > bounds.height) {
        fail('TEMPLATE_POSITION_INVALID', `${location} is outside its positioned container`);
    }
}

function validateNode(node, state, band, depth, ancestorHidden, ancestorVisibility = [], positionedBounds = null, insidePositionedNode = false, ancestorManualHidden = false) {
    if (depth > MAX_DEPTH) fail('TEMPLATE_DEPTH_LIMIT', `Template nesting exceeds ${MAX_DEPTH}`);
    state.nodeCount += 1;
    if (state.nodeCount > MAX_TEMPLATE_NODES) fail('TEMPLATE_NODE_LIMIT', `Template exceeds ${MAX_TEMPLATE_NODES} nodes`);
    object(node, ['id', 'type', 'text', 'path', 'label', 'format', 'variants', 'labelStyle', 'valueStyle', 'nodes', 'variant', 'size', 'style', 'visibleWhen', 'hidden', 'layout', 'height', 'x', 'y', 'widthPx', 'heightPx'], 'node');
    string(node.id, 'node.id', { empty: false, maxBytes: 200 });
    if (state.ids.has(node.id)) fail('TEMPLATE_SCHEMA_INVALID', `Duplicate node id ${node.id}`);
    state.ids.add(node.id);
    const ownVisibility = node.visibleWhen !== undefined && node.visibleWhen !== null ? node.visibleWhen : null;
    const visibility = ownVisibility ? [...ancestorVisibility, ownVisibility] : ancestorVisibility;
    if (node.hidden !== undefined && typeof node.hidden !== 'boolean') fail('TEMPLATE_SCHEMA_INVALID', 'node.hidden must be boolean');
    const manuallyHidden = ancestorManualHidden || node.hidden === true;
    const hidden = ancestorHidden || ownVisibility !== null || manuallyHidden;
    const scope = nodeScope(band);
    const hasPosition = ['x', 'y', 'widthPx', 'heightPx'].some(key => node[key] !== undefined);
    if (positionedBounds) validateAbsoluteBox(node, positionedBounds, 'node');
    else if (hasPosition) fail('TEMPLATE_POSITION_INVALID', 'Only direct children of a positioned section or row may have coordinates');
    if (node.visibleWhen !== undefined && node.visibleWhen !== null) validateCondition(node.visibleWhen, state.catalog, scope, 'node.visibleWhen');
    const common = new Set(['id', 'type', 'style', 'visibleWhen', 'hidden', 'x', 'y', 'widthPx', 'heightPx']);
    if (node.type === 'text') {
        assertOnlyNodeProperties(node, common, ['text']);
        validateBilingual(node.text, 'node.text');
        validateStyle(node.style, 'node.style');
        state.texts.push({ value: node.text, band, hidden, manuallyHidden, visibility });
    } else if (node.type === 'field') {
        assertOnlyNodeProperties(node, common, ['path', 'label', 'format', 'variants', 'labelStyle', 'valueStyle']);
        string(node.path, 'node.path', { empty: false });
        const entry = catalogEntry(state.catalog, node.path, scope);
        validateBilingual(node.label, 'node.label');
        if (node.format !== undefined && !FIELD_FORMATS.has(node.format)) fail('TEMPLATE_SCHEMA_INVALID', 'node.format is invalid');
        validateFieldVariants(node.variants, node);
        validateStyle(node.style, 'node.style');
        validateInlineStyle(node.labelStyle, 'node.labelStyle');
        validateInlineStyle(node.valueStyle, 'node.valueStyle');
        state.fields.push({ path: node.path, type: entry.type, band, hidden, manuallyHidden, visibility, node, scope });
    } else if (node.type === 'row') {
        assertOnlyNodeProperties(node, common, ['nodes', 'layout', 'height']);
        validateStyle(node.style, 'node.style');
        if (!Array.isArray(node.nodes)) fail('TEMPLATE_SCHEMA_INVALID', 'row.nodes must be an array');
        const layout = node.layout || 'flow';
        if (!['flow', 'absolute'].includes(layout)) fail('TEMPLATE_SCHEMA_INVALID', 'row.layout is invalid');
        if (layout === 'absolute') {
            if (positionedBounds || insidePositionedNode) fail('TEMPLATE_POSITION_INVALID', 'Positioned rows cannot be nested inside positioned content');
            if (!Number.isSafeInteger(node.height) || node.height < MIN_ABSOLUTE_BAND_HEIGHT || node.height > MAX_ABSOLUTE_BAND_HEIGHT || node.height % POSITION_GRID_PX !== 0) {
                fail('TEMPLATE_POSITION_INVALID', 'Positioned row height must be 40–1200px on the 4px grid');
            }
        } else if (node.height !== undefined && node.height !== null) {
            fail('TEMPLATE_POSITION_INVALID', 'Flow rows cannot define a height');
        }
        const childBounds = layout === 'absolute' ? { width: PAPER_WIDTH_PX - 20, height: node.height } : null;
        for (const child of node.nodes) validateNode(child, state, band, depth + 1, hidden, visibility, childBounds, insidePositionedNode || Boolean(positionedBounds) || layout === 'absolute', manuallyHidden);
    } else if (node.type === 'divider') {
        assertOnlyNodeProperties(node, common, ['variant']);
        if (!['dashed', 'solid'].includes(node.variant)) fail('TEMPLATE_SCHEMA_INVALID', 'divider.variant is invalid');
        validateStyle(node.style, 'node.style');
    } else if (node.type === 'spacer') {
        assertOnlyNodeProperties(node, new Set(['id', 'type', 'visibleWhen', 'hidden', 'x', 'y', 'widthPx', 'heightPx']), ['size']);
        if (![4, 8, 12, 16, 24].includes(node.size)) fail('TEMPLATE_SCHEMA_INVALID', 'spacer.size is invalid');
    } else if (node.type === 'jofotara_qr') {
        assertOnlyNodeProperties(node, common, ['size']);
        if (state.docType !== 'receipt') fail('TEMPLATE_SCHEMA_INVALID', 'JoFotara QR belongs only on receipts');
        if (visibility.length > 0 || manuallyHidden) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', 'JoFotara QR cannot be hidden by a template');
        if (![96, 128, 160, 384, 448, 512, 556].includes(node.size)) fail('TEMPLATE_SCHEMA_INVALID', 'jofotara_qr.size is invalid');
        validateStyle(node.style, 'node.style');
        state.qrNodes.push({ node, visibility });
    } else if (node.type === 'store_logo') {
        if (!state.profile?.allowStoreLogo) fail('TEMPLATE_FEATURE_NOT_ENABLED', 'Store logo is not enabled');
        if (band.kind !== 'once') fail('TEMPLATE_SCHEMA_INVALID', 'Store logo belongs only in a once band');
        assertOnlyNodeProperties(node, common, ['size']);
        if (![64, 96, 128].includes(node.size)) fail('TEMPLATE_SCHEMA_INVALID', 'store_logo.size is invalid');
        validateStyle(node.style, 'node.style');
    } else {
        fail('TEMPLATE_SCHEMA_INVALID', `Unknown node type ${node.type}`);
    }
}

function assertOnlyNodeProperties(node, common, specific) {
    const allowed = new Set([...common, ...specific]);
    for (const key of Object.keys(node)) {
        if (!allowed.has(key)) fail('TEMPLATE_SCHEMA_INVALID', `node has property ${key} that is not allowed for ${node.type}`);
    }
}

function canonicalKitchenFilter(filter, op) {
    return filter && filter.path === 'isOther' && filter.op === op && filter.value === true;
}

function countFields(state, criteria) {
    return state.fields.filter(field => Object.entries(criteria).every(([key, value]) => field[key] === value));
}

function requireCount(state, criteria, exact = false) {
    const matches = countFields(state, criteria);
    if ((exact && matches.length !== 1) || (!exact && matches.length === 0)) {
        fail('TEMPLATE_REQUIRED_STRUCTURE_MISSING', `Missing required binding ${criteria.path || ''}`);
    }
    return matches;
}

function isProvisionalCondition(condition, value) {
    return condition.path === 'meta.provisional' && condition.op === 'eq' && condition.value === value;
}

function hasOnlyBooleanBranch(entry, path, value) {
    return entry.visibility.length === 1 && entry.visibility[0].path === path &&
        entry.visibility[0].op === 'eq' && entry.visibility[0].value === value;
}

function hasOnlyProvisionalBranch(entry, value) {
    return hasOnlyBooleanBranch(entry, 'meta.provisional', value);
}

function hasCompatiblePaidBranch(entry) {
    const provisional = entry.visibility.filter(condition => condition.path === 'meta.provisional');
    return provisional.length > 0 && provisional.every(condition => isProvisionalCondition(condition, false));
}

function isPositivePaymentConditionForField(condition, fieldPath) {
    return ['payment.cashAmount', 'payment.cardAmount', 'payment.amountTendered', 'payment.changeDue'].includes(fieldPath) &&
        condition.path === fieldPath && condition.op === 'gt' && condition.value === 0;
}

function isPaymentModeCondition(condition) {
    return condition.path === 'payment.method' && ['eq', 'neq'].includes(condition.op) && condition.value === 'split';
}

function isPaidIdentityBranch(entry) {
    return hasCompatiblePaidBranch(entry) && entry.visibility.every(condition => isProvisionalCondition(condition, false));
}

function isPaidPaymentBranch(entry) {
    return hasCompatiblePaidBranch(entry) && entry.visibility.every(condition =>
        isProvisionalCondition(condition, false) || isPositivePaymentConditionForField(condition, entry.path) || isPaymentModeCondition(condition));
}

function isParentRowKindBranch(field) {
    return !field.manuallyHidden && field.visibility.length === 1 && field.visibility[0]?.path === 'kind' &&
        field.visibility[0]?.op === 'neq' && field.visibility[0]?.value === 'bundle_child';
}

function validateReceiptStructure(state) {
    const requireVisible = (path, exact = false) => {
        const matches = requireCount(state, { path, scope: 'global' }, exact);
        if (matches.some(field => field.hidden)) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', `Receipt required binding ${path} cannot be hidden`);
        return matches;
    };
    requireVisible('store.name', true);
    requireVisible('meta.date');
    const identities = state.fields.filter(field => field.scope === 'global' && ['meta.invoiceDisplayNo', 'meta.ticketDisplayNo', 'meta.orderDisplayNo'].includes(field.path));
    if (identities.length === 0) {
        fail('TEMPLATE_REQUIRED_STRUCTURE_MISSING', 'Receipt requires a public document identity');
    }
    if (identities.some(field => !isPaidIdentityBranch(field) && !(field.path === 'meta.orderDisplayNo' && hasOnlyBooleanBranch(field, 'meta.heldOrderReceipt', true)))) {
        fail('TEMPLATE_PROVISIONAL_BRANCH_INVALID', 'Receipt legal identity must be visible only for paid documents');
    }
    if (identities.every(field => field.manuallyHidden)) {
        fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', 'Receipt requires a visible public document identity');
    }
    const guestText = state.texts.filter(text => !text.manuallyHidden && text.value.en === 'GUEST CHECK' && (hasOnlyProvisionalBranch(text, true) || hasOnlyBooleanBranch(text, 'meta.guestCheck', true)));
    if (guestText.length !== 1) {
        fail('TEMPLATE_PROVISIONAL_BRANCH_INVALID', 'Receipt requires exactly one trusted guest-check branch');
    }
    const heldIdentities = identities.filter(field => field.visibility.some(condition => condition.path === 'meta.heldOrderReceipt'));
    if (heldIdentities.some(field => field.manuallyHidden) ||
        (heldIdentities.length > 0 && guestText[0].visibility[0].path !== 'meta.guestCheck')) {
        fail('TEMPLATE_PROVISIONAL_BRANCH_INVALID', 'Numbered held receipts require a visible order number and a separate guest-check branch');
    }
    const guestTable = state.fields.filter(field => field.scope === 'global' && field.path === 'meta.tableNumber');
    if (!guestTable.some(field => !field.manuallyHidden && (field.visibility.length === 0 || hasOnlyProvisionalBranch(field, true)))) {
        fail('TEMPLATE_PROVISIONAL_BRANCH_INVALID', 'Guest check requires safe table context');
    }
    const primary = state.bands.filter(band => band.kind === 'repeat' && band.source === 'rows');
    if (primary.length !== 1 || primary[0].filter !== null) fail('TEMPLATE_REQUIRED_STRUCTURE_INVALID', 'Receipt requires exactly one unfiltered primary rows band');
    if (primary[0].visibleWhen !== null) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', 'Receipt primary rows cannot be hidden');
    // Keep item notes in receipt definitions: they are customer-visible order data,
    // though the built-in node may hide itself when a particular row has no note.
    for (const path of ['name', 'qty', 'netAmount', 'note']) {
        const fields = countFields(state, { path, band: primary[0], scope: 'relative' });
        if (fields.length === 0) fail('TEMPLATE_REQUIRED_STRUCTURE_MISSING', `Receipt primary row requires ${path}`);
        if (path === 'note' && fields.every(field => field.manuallyHidden)) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', 'Receipt primary row note cannot be hidden');
        if (path !== 'note' && !fields.some(field => !field.hidden || isParentRowKindBranch(field))) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', `Receipt primary row ${path} cannot be hidden`);
    }
    for (const path of ['summary.subtotal', 'summary.total']) requireVisible(path);
    requireCount(state, { path: 'summary.taxAmount', scope: 'global' });
    requireCount(state, { path: 'summary.orderDiscountAmount', scope: 'global' });
    const paymentFields = state.fields.filter(field => field.scope === 'global' && field.path.startsWith('payment.'));
    for (const path of ['payment.method', 'payment.cashAmount', 'payment.cardAmount']) {
        const fields = requireCount(state, { path, scope: 'global' });
        if (fields.some(field => field.manuallyHidden)) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', `Receipt required binding ${path} cannot be hidden`);
    }
    if (paymentFields.some(field => !isPaidPaymentBranch(field))) {
        fail('TEMPLATE_PROVISIONAL_BRANCH_INVALID', 'Receipt payment must be visible only for paid documents');
    }
    if (state.qrNodes.length !== 1) fail('TEMPLATE_REQUIRED_STRUCTURE_MISSING', 'Receipt requires exactly one JoFotara QR node');
}

function validateKitchenStructure(state) {
    const requireVisible = (path, exact = false) => {
        const matches = requireCount(state, { path, scope: 'global' }, exact);
        if (matches.some(field => field.manuallyHidden)) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', `Kitchen required binding ${path} cannot be hidden`);
        return matches;
    };
    requireVisible('meta.ticketTypeLabel', true);
    requireVisible('meta.orderDisplayNo');
    requireVisible('meta.tableNumber');
    const primary = state.bands.filter(band => band.kind === 'repeat' && band.source === 'items' && canonicalKitchenFilter(band.filter, 'neq'));
    const anyItems = state.bands.filter(band => band.kind === 'repeat' && band.source === 'items');
    if (primary.length !== 1 || anyItems.filter(band => !canonicalKitchenFilter(band.filter, 'neq') && !canonicalKitchenFilter(band.filter, 'eq')).length > 0) {
        fail('TEMPLATE_REQUIRED_STRUCTURE_INVALID', 'Kitchen requires one canonical primary items partition');
    }
    if (primary[0].visibleWhen !== null) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', 'Kitchen primary items cannot be hidden');
    for (const path of ['qty', 'name', 'note']) {
        const fields = countFields(state, { path, band: primary[0], scope: 'relative' });
        if (fields.length === 0) fail('TEMPLATE_REQUIRED_STRUCTURE_MISSING', `Kitchen primary row requires ${path}`);
        if (path !== 'note' && fields.some(field => field.hidden)) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', `Kitchen primary row ${path} cannot be hidden`);
    }
    const secondaries = state.bands.filter(band => band.kind === 'repeat' && band.source === 'items' && canonicalKitchenFilter(band.filter, 'eq'));
    if (secondaries.length > 1) fail('TEMPLATE_REQUIRED_STRUCTURE_INVALID', 'Kitchen permits at most one secondary items partition');
}

function validateTemplate(template, profile) {
    rejectDangerousKeys(template);
    object(template, ['schemaVersion', 'docType', 'paper', 'bands'], 'template');
    if (template.schemaVersion !== 1) fail('TEMPLATE_SCHEMA_INVALID', 'Unsupported template schema version');
    if (!['receipt', 'kitchen'].includes(template.docType)) fail('TEMPLATE_DOC_TYPE_INVALID', 'Unsupported document type');
    object(template.paper, ['widthPx'], 'template.paper');
    if (template.paper.widthPx !== PAPER_WIDTH_PX) fail('TEMPLATE_SCHEMA_INVALID', 'Paper width must be 576px');
    if (!Array.isArray(template.bands) || template.bands.length === 0) fail('TEMPLATE_SCHEMA_INVALID', 'template.bands must be a non-empty array');
    const state = { docType: template.docType, catalog: catalogFor(template.docType), profile, nodeCount: 0, ids: new Set(), fields: [], texts: [], qrNodes: [], bands: [], absoluteHeight: 0 };
    const bandIds = new Set();
    for (const band of template.bands) {
        object(band, ['id', 'kind', 'layout', 'source', 'filter', 'visibleWhen', 'height', 'nodes'], 'band');
        string(band.id, 'band.id', { empty: false, maxBytes: 200 });
        if (bandIds.has(band.id)) fail('TEMPLATE_SCHEMA_INVALID', `Duplicate band id ${band.id}`);
        bandIds.add(band.id);
        if (!['once', 'repeat'].includes(band.kind)) fail('TEMPLATE_SCHEMA_INVALID', 'band.kind is invalid');
        if (!['flow', 'absolute'].includes(band.layout)) fail('TEMPLATE_SCHEMA_INVALID', 'band.layout is invalid');
        if (band.layout === 'absolute') {
            if (band.kind !== 'once') fail('TEMPLATE_POSITION_INVALID', 'Only once bands may use absolute layout');
            if (!Number.isSafeInteger(band.height) || band.height < MIN_ABSOLUTE_BAND_HEIGHT || band.height > MAX_ABSOLUTE_BAND_HEIGHT || band.height % POSITION_GRID_PX !== 0) {
                fail('TEMPLATE_POSITION_INVALID', 'Positioned band height must be 40–1200px on the 4px grid');
            }
            state.absoluteHeight += band.height;
            if (state.absoluteHeight > MAX_ABSOLUTE_HEIGHT_TOTAL) fail('TEMPLATE_POSITION_INVALID', 'Positioned bands exceed 2400px total height');
        } else if (band.height !== undefined && band.height !== null) {
            fail('TEMPLATE_POSITION_INVALID', 'Flow bands cannot define a height');
        }
        if (band.kind === 'once' && band.source !== null) fail('TEMPLATE_SCHEMA_INVALID', 'once band source must be null');
        if (band.kind === 'repeat' && band.source !== state.catalog.source) fail('TEMPLATE_SOURCE_INVALID', `Repeat source must be ${state.catalog.source}`);
        if (band.kind === 'once' && band.filter !== null) fail('TEMPLATE_SCHEMA_INVALID', 'once band filter must be null');
        if (band.kind === 'repeat' && band.filter !== null) validateCondition(band.filter, state.catalog, 'relative', 'band.filter');
        if (band.visibleWhen !== null) validateCondition(band.visibleWhen, state.catalog, nodeScope(band), 'band.visibleWhen');
        if (!Array.isArray(band.nodes)) fail('TEMPLATE_SCHEMA_INVALID', 'band.nodes must be an array');
        if (band.nodes.length === 0) fail('TEMPLATE_EMPTY_BAND', 'Bands must contain at least one node');
        state.bands.push(band);
        const positionedBounds = band.layout === 'absolute' ? { width: PAPER_WIDTH_PX, height: band.height } : null;
        for (const node of band.nodes) validateNode(node, state, band, 1, band.visibleWhen !== null, band.visibleWhen === null ? [] : [band.visibleWhen], positionedBounds);
    }
    if (template.docType === 'receipt') validateReceiptStructure(state);
    else validateKitchenStructure(state);
    return template;
}

function getOwnPath(value, path) {
    let current = value;
    for (const key of path.split('.')) {
        if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
        current = current[key];
    }
    return current;
}

function resolve(path, scope, model, item) {
    return scope === 'relative' ? getOwnPath(item, path) : getOwnPath(model, path);
}

function conditionMatches(condition, scope, model, item) {
    if (!condition) return true;
    const actual = resolve(condition.path, scope, model, item);
    switch (condition.op) {
    case 'eq': return actual === condition.value;
    case 'neq': return actual !== condition.value;
    case 'gt': return actual > condition.value;
    case 'gte': return actual >= condition.value;
    case 'lt': return actual < condition.value;
    case 'lte': return actual <= condition.value;
    case 'truthy': return Boolean(actual);
    case 'falsy': return !actual;
    default: return false;
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function bilingual(value) {
    const en = escapeHtml(value.en);
    const ar = escapeHtml(value.ar);
    if (value.mode === 'both' && ar) return en && ar ? `${en}<span dir="rtl"> ${ar}</span>` : (en || `<span dir="rtl">${ar}</span>`);
    return en || ar;
}

function bilingualSegments(value) {
    const en = String(value?.en || '');
    const ar = String(value?.ar || '');
    if (value?.mode === 'both' && ar) {
        return [
            ...(en ? [{ text: en, direction: 'ltr' }] : []),
            { text: `${en ? ' ' : ''}${ar}`, direction: 'rtl' }
        ];
    }
    const text = en || ar;
    return text ? [{ text, direction: en ? 'auto' : 'rtl' }] : [];
}

function nativeBox(node, positionedBounds) {
    if (!positionedBounds) return null;
    return { x: node.x, y: node.y, width: node.widthPx, height: node.heightPx };
}

function compiledNode(html = '', layout = null) {
    return { html, layout };
}

function styleAttribute(style = {}, extra = '') {
    const values = [];
    const font = { sans: 'Arial,Helvetica,sans-serif', mono: 'Consolas,monospace', arabic: 'Tahoma,Arial,sans-serif' };
    const size = { xs: 18, sm: 22, note: 24, item: 25, base: 26, lg: 30, total: 34, xl: 36, '2xl': 44, display: 48, '3xl': 52 };
    const weight = { normal: 400, bold: 600, black: 800 };
    if (style.fontFamily) values.push(`font-family:${font[style.fontFamily]}`);
    if (style.fontSize) values.push(`font-size:${size[style.fontSize]}px`);
    if (style.fontWeight) values.push(`font-weight:${weight[style.fontWeight]}`);
    if (style.fontStyle) values.push(`font-style:${style.fontStyle}`);
    if (style.align) values.push(`text-align:${style.align}`);
    if (style.direction && style.direction !== 'auto') values.push(`direction:${style.direction}`);
    if (style.width) values.push(`width:${style.width}%`);
    if (style.marginTop) values.push(`margin-top:${style.marginTop}px`);
    if (style.marginBottom) values.push(`margin-bottom:${style.marginBottom}px`);
    if (style.marginInlineStart) values.push(`margin-inline-start:${style.marginInlineStart}px`);
    if (style.offsetY) values.push(`transform:translateY(${style.offsetY}px)`);
    if (style.padding) values.push(`padding:${style.padding}px`);
    if (style.textTransform && style.textTransform !== 'none') values.push(`text-transform:${style.textTransform}`);
    if (style.letterSpacing) values.push(`letter-spacing:${style.letterSpacing}px`);
    if (style.lineHeight) values.push(`line-height:${style.lineHeight}`);
    if (style.treatment === 'outline') values.push('border:3px solid #000');
    if (style.treatment === 'reverse') values.push('background:#000;color:#fff');
    if (style.opacity !== undefined) values.push(`opacity:${style.opacity}`);
    if (extra) values.push(extra);
    return values.length ? ` style="${values.join(';')}"` : '';
}

function positionAttribute(node, positionedBounds) {
    if (!positionedBounds) return '';
    return `position:absolute;left:${node.x}px;top:${node.y}px;width:${node.widthPx}px;height:${node.heightPx}px;overflow:hidden`;
}

function nodeDataAttribute(node) {
    return ` data-node="${escapeHtml(node.id)}"`;
}

function formatMoney(value, model, path) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('TEMPLATE_MODEL_INVALID', `Money binding ${path} is not finite`);
    if (path === 'summary.taxAmount' && model.summary?.taxLabel) return String(model.summary.taxLabel);
    const decimals = Number.isSafeInteger(model.decimals) && model.decimals >= 0 && model.decimals <= 6 ? model.decimals : 2;
    const currency = typeof model.currency === 'string' && model.currency ? ` ${model.currency}` : '';
    return `${value.toFixed(decimals)}${currency}`;
}

function formatField(entry, value, model, format = 'plain') {
    let formatted;
    if (entry.type === 'money') formatted = formatMoney(value, model, entry.path);
    if (entry.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) fail('TEMPLATE_MODEL_INVALID', `Numeric binding ${entry.path} is not finite`);
        const numeric = Number.isInteger(value) ? String(value) : value.toFixed(2);
        formatted = entry.path === 'qty' ? `${numeric}x` : numeric;
    }
    if (entry.type === 'boolean') formatted = '';
    if (formatted === undefined) formatted = String(value ?? '');
    if (format === 'brackets') return formatted ? `[${formatted}]` : '';
    if (format === 'modifier') return formatted.split('\n').map(line => line.trim()).filter(Boolean).map(line => `*** ${line} ***`).join('\n');
    if (format === 'list') return formatted.split('\n').map(line => line.trim()).filter(Boolean).map(line => `- ${line}`).join('\n');
    return formatted;
}

function warnPositionedOverlaps(nodes, containerId, state) {
    for (let left = 0; left < nodes.length; left += 1) for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left]; const b = nodes[right];
        if (a.x < b.x + b.widthPx && b.x < a.x + a.widthPx && a.y < b.y + b.heightPx && b.y < a.y + a.heightPx) {
            const warning = `Positioned nodes ${a.id} and ${b.id} overlap in ${containerId}.`;
            if (!state.warnings.includes(warning)) state.warnings.push(warning);
        }
    }
}

async function renderNode(node, band, model, item, state, positionedBounds = null, inFlowRow = false) {
    if (node.hidden === true) return compiledNode();
    if (state.numberedHold && (node.type === 'jofotara_qr' ||
        (node.type === 'field' && (['meta.invoiceDisplayNo', 'meta.ticketDisplayNo', 'meta.orderDisplayNo', 'meta.tableNumber'].includes(node.path) || node.path.startsWith('payment.'))))) return compiledNode();
    if (!conditionMatches(node.visibleWhen, nodeScope(band), model, item)) return compiledNode();
    state.expandedNodes += 1;
    if (state.expandedNodes > MAX_EXPANDED_NODES) fail('TEMPLATE_EXPANSION_LIMIT', `Template expands beyond ${MAX_EXPANDED_NODES} nodes`);
    const position = positionAttribute(node, positionedBounds);
    const nodeData = nodeDataAttribute(node);
    const box = nativeBox(node, positionedBounds);
    if (node.type === 'text') {
        // Every valid receipt already has one guest identity slot. Its held-order
        // meaning is application-owned, even in templates saved before numbering.
        const heldOrderText = state.numberedHold && node.text.en === 'GUEST CHECK';
        const value = heldOrderText ? `Order: ${escapeHtml(model.meta.orderDisplayNo)}` : bilingual(node.text);
        const segments = heldOrderText
            ? [{ text: `Order: ${String(model.meta.orderDisplayNo ?? '')}`, direction: 'auto' }]
            : bilingualSegments(node.text);
        return compiledNode(
            `<div class="pt-text"${nodeData}${styleAttribute(node.style, position)}>${value}</div>`,
            { id: node.id, type: 'text', value: segments, style: { ...node.style }, ...(box ? { box } : {}) }
        );
    }
    if (node.type === 'field') {
        if (model.taxMode === 'inclusive' && (
            node.path === 'summary.subtotal' ||
            node.path === 'summary.taxAmount' ||
            node.path === 'summary.taxLabel'
        )) return compiledNode();
        const entry = catalogEntry(state.catalog, node.path, nodeScope(band));
        const rawValue = resolve(node.path, nodeScope(band), model, item);
        if (entry.type === 'boolean' && rawValue === false) return compiledNode();
        if (entry.type === 'text' && (rawValue === null || rawValue === undefined || rawValue === '')) return compiledNode();
        if (node.path === 'meta.orderDisplayNo') state.orderIdentityRendered = true;
        const headingVariant = node.path === 'meta.ticketTypeLabel' ? node.variants?.[model.meta?.ticketType] : null;
        const formattedValue = headingVariant ? null : formatField(entry, rawValue, model, node.format);
        const value = headingVariant ? bilingual(headingVariant) : escapeHtml(formattedValue);
        const prefix = bilingual(node.label);
        const classes = ['pt-field'];
        if (!prefix) classes.push('pt-field-unlabelled');
        const kitchenRole = state.docType === 'kitchen' && inFlowRow && node.path === 'qty' ? 'quantity'
            : state.docType === 'kitchen' && inFlowRow && node.path === 'name' ? 'name' : null;
        if (kitchenRole === 'quantity') classes.push('pt-kitchen-qty');
        if (kitchenRole === 'name') classes.push('pt-kitchen-name');
        if (node.style?.labelLayout === 'inline') classes.push('pt-field-inline');
        if (node.style?.align === 'center') classes.push('pt-field-content-center');
        return compiledNode(
            `<div class="${classes.join(' ')}"${nodeData}${styleAttribute(node.style, position)}>${prefix ? `<span class="pt-label"${styleAttribute(node.labelStyle)}>${prefix}</span>` : ''}<span class="pt-value"${styleAttribute(node.valueStyle)}>${value}</span></div>`,
            {
                id: node.id,
                type: 'field',
                label: bilingualSegments(node.label),
                value: headingVariant ? bilingualSegments(headingVariant) : [{ text: formattedValue, direction: node.style?.direction || 'auto' }],
                style: { ...node.style },
                labelStyle: { ...node.labelStyle },
                valueStyle: { ...node.valueStyle },
                ...(kitchenRole ? { kitchenRole } : {}),
                ...(box ? { box } : {})
            }
        );
    }
    if (node.type === 'row') {
        const children = [];
        const childBounds = node.layout === 'absolute' ? { width: PAPER_WIDTH_PX - 20, height: node.height } : null;
        for (const child of node.nodes) children.push(await renderNode(child, band, model, item, state, childBounds, node.layout !== 'absolute'));
        const visibleChildren = children.filter(child => child.layout);
        if (node.layout === 'absolute') warnPositionedOverlaps(node.nodes.filter((_, index) => children[index]?.layout), node.id, state);
        const rowLayout = node.layout === 'absolute' ? `height:${node.height}px;position:relative;overflow:hidden` : '';
        return compiledNode(
            `<div class="pt-row${node.layout === 'absolute' ? ' pt-row-positioned' : ''}${node.layout !== 'absolute' && visibleChildren.length === 1 ? ' pt-row-single' : ''}"${nodeData}${styleAttribute(node.style, [position, rowLayout].filter(Boolean).join(';'))}>${children.map(child => child.html).join('')}</div>`,
            {
                id: node.id,
                type: 'row',
                layout: node.layout || 'flow',
                ...(node.layout === 'absolute' ? { height: node.height } : {}),
                style: { ...node.style },
                nodes: visibleChildren.map(child => child.layout),
                ...(box ? { box } : {})
            }
        );
    }
    if (node.type === 'divider') return compiledNode(
        `<div class="pt-divider pt-divider-${node.variant}"${nodeData}${styleAttribute(node.style, position)}></div>`,
        { id: node.id, type: 'divider', variant: node.variant, style: { ...node.style }, ...(box ? { box } : {}) }
    );
    if (node.type === 'spacer') return compiledNode(
        `<div class="pt-spacer"${nodeData}${styleAttribute({}, position || `height:${node.size}px`)}></div>`,
        { id: node.id, type: 'spacer', size: node.size, ...(box ? { box } : {}) }
    );
    if (node.type === 'jofotara_qr') {
        const jofotara = model.jofotara;
        if (!jofotara || jofotara.status !== 'accepted' || !jofotara.qrText) return compiledNode();
        if (Buffer.byteLength(jofotara.qrText, 'utf8') > MAX_QR_BYTES) fail('TEMPLATE_QR_TOO_LARGE', 'JoFotara QR exceeds 4096 bytes');
        const size = node.size <= 160 ? PAPER_WIDTH_PX - 20 : node.size;
        let uri;
        try {
            uri = await QRCode.toDataURL(jofotara.qrText, { errorCorrectionLevel: 'M', margin: 4, width: size, type: 'image/png' });
        } catch (error) {
            fail('TEMPLATE_QR_RENDER_FAILED', `JoFotara QR rendering failed: ${error.message}`);
        }
        if (!uri.startsWith('data:image/png;base64,')) fail('TEMPLATE_QR_RENDER_FAILED', 'JoFotara QR did not produce a PNG data URI');
        // Reserve a full-width footer: legacy absolute boxes and narrow rows must not clip the QR.
        state.jofotaraQrHtml = `<div class="pt-qr"${nodeData}><img alt="JoFotara QR" width="${size}" height="${size}" src="${uri}"></div>`;
        state.jofotaraQrLayout = { id: node.id, type: 'image', imageType: 'qr', size, dataUri: uri, style: { align: 'center', marginTop: 16 } };
        return compiledNode();
    }
    if (node.type === 'store_logo') {
        if (!state.storeLogoDataUri) {
            if (!state.logoWarning) { state.warnings.push('The Store Brand Icon is unavailable and was omitted.'); state.logoWarning = true; }
            return compiledNode();
        }
        const nativeLogoSupported = /^data:image\/(?:png|jpeg|webp);base64,/i.test(state.storeLogoDataUri);
        if (!nativeLogoSupported && !state.nativeLogoWarning) {
            state.warnings.push('The Store Brand Icon format is unavailable in native print output and was omitted there.');
            state.nativeLogoWarning = true;
        }
        return compiledNode(
            `<div class="pt-logo"${nodeData}${styleAttribute(node.style, position)}><img alt="Store logo" width="${node.size}" height="${node.size}" src="${state.storeLogoDataUri}"></div>`,
            nativeLogoSupported
                ? { id: node.id, type: 'image', imageType: 'logo', size: node.size, dataUri: state.storeLogoDataUri, style: { ...node.style }, ...(box ? { box } : {}) }
                : null
        );
    }
    fail('TEMPLATE_SCHEMA_INVALID', `Unknown node type ${node.type}`);
}

function artifactCss(template) {
    const base = 'html,body{margin:0;padding:0}.compiled-document{width:576px;box-sizing:border-box;background:#fff;color:#000;padding:5px 10px 60px;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;line-height:1.2}.compiled-document *{box-sizing:border-box}.pt-row{display:flex;align-items:flex-start}.pt-row-positioned{display:block}.pt-row-single .pt-field,.pt-row-single .pt-text{width:100%!important}.pt-field,.pt-text{white-space:pre-wrap}.pt-field{display:flex;justify-content:space-between;font-size:25px;margin-bottom:6px}.pt-field-unlabelled{display:block}.pt-field-inline{justify-content:flex-start;gap:6px}.pt-field-inline .pt-label{margin-right:0}.pt-field-content-center{justify-content:center}.pt-row .pt-field{margin-bottom:0}.pt-label{margin-right:6px}.pt-divider{width:100%;margin:10px 0}.pt-divider-dashed{border-bottom:2px dashed #000}.pt-divider-solid{border-bottom:3px solid #000}.pt-qr{text-align:center;break-inside:avoid;margin-top:16px}.pt-qr img{display:inline-block;max-width:100%;height:auto;image-rendering:pixelated}';
    const receiptLayout = template.docType === 'receipt' ? '.compiled-document[data-doc-type="receipt"] .pt-field,.compiled-document[data-doc-type="receipt"] .pt-text{overflow-wrap:anywhere}.compiled-document[data-doc-type="receipt"] .pt-row .pt-field{min-width:0}' : '';
    const kitchenLayout = template.docType === 'kitchen' ? '.pt-kitchen-qty{width:auto!important;min-width:75px;flex:0 0 auto;padding-inline-end:12px;white-space:nowrap}.pt-kitchen-name{width:auto!important;flex:1 1 auto;min-width:0}' : '';
    const usesPositioning = template.bands.some(band => band.layout === 'absolute');
    const usesLogo = template.bands.some(band => (band.nodes || []).some(node => node.type === 'store_logo'));
    return base + receiptLayout + kitchenLayout + (usesPositioning ? '.pt-band-positioned{position:relative;overflow:hidden}' : '') + (usesLogo ? '.pt-logo{text-align:center}.pt-logo img{display:inline-block;object-fit:contain}' : '');
}

async function compileTemplate(template, model, context = {}) {
    const checked = validateTemplate(template, context.profile || { allowStoreLogo: false });
    const numberedHold = checked.docType === 'receipt' && model.meta?.heldOrderReceipt === true;
    if (numberedHold) model = { ...model, meta: { ...model.meta, guestCheck: true } };
    const templateRevisionId = resolveTemplateRevisionId(context, checked.docType);
    const state = { docType: checked.docType, numberedHold, catalog: catalogFor(checked.docType), expandedNodes: 0, sections: 0, warnings: [], storeLogoDataUri: context.storeLogoDataUri || null };
    const output = [];
    const nativeBands = [];
    let kitchenPrimaryIndexes = null;
    for (const band of checked.bands) {
        const scope = nodeScope(band);
        if (band.kind === 'once') {
            if (!conditionMatches(band.visibleWhen, scope, model, null)) continue;
            reserveSections(state, 1);
            const parts = [];
            const positionedBounds = band.layout === 'absolute' ? { width: PAPER_WIDTH_PX, height: band.height } : null;
            for (const node of band.nodes) parts.push(await renderNode(node, band, model, null, state, positionedBounds));
            if (band.layout === 'absolute') {
                warnPositionedOverlaps(band.nodes.filter((_, index) => parts[index]?.layout), band.id, state);
                output.push(`<section class="pt-band pt-band-positioned" data-band="${escapeHtml(band.id)}" style="height:${band.height}px">${parts.map(part => part.html).join('')}</section>`);
            } else output.push(`<section class="pt-band" data-band="${escapeHtml(band.id)}">${parts.map(part => part.html).join('')}</section>`);
            nativeBands.push({
                id: band.id,
                layout: band.layout || 'flow',
                ...(band.layout === 'absolute' ? { height: band.height } : {}),
                nodes: parts.map(part => part.layout).filter(Boolean)
            });
            continue;
        }
        const source = Array.isArray(model?.[band.source]) ? model[band.source] : [];
        let selectedCount = 0;
        for (const item of source) {
            if (conditionMatches(band.filter, 'relative', model, item) && conditionMatches(band.visibleWhen, 'relative', model, item)) selectedCount += 1;
        }
        reserveSections(state, selectedCount);
        const indexes = [];
        for (let index = 0; index < source.length; index += 1) {
            const item = source[index];
            if (!conditionMatches(band.filter, 'relative', model, item) || !conditionMatches(band.visibleWhen, 'relative', model, item)) continue;
            indexes.push(index);
            const parts = [];
            for (const node of band.nodes) parts.push(await renderNode(node, band, model, item, state));
            output.push(`<section class="pt-band" data-band="${escapeHtml(band.id)}">${parts.map(part => part.html).join('')}</section>`);
            nativeBands.push({ id: band.id, layout: 'flow', nodes: parts.map(part => part.layout).filter(Boolean) });
        }
        if (checked.docType === 'kitchen' && canonicalKitchenFilter(band.filter, 'neq')) kitchenPrimaryIndexes = indexes;
    }
    if (checked.docType === 'kitchen') {
        // Older kitchen layouts can omit identity on item-void/follow-up branches.
        // Add the mandatory order line without replacing any restaurant content.
        if (model.meta?.numberedHold && !state.orderIdentityRendered) {
            output.unshift(`<section class="pt-band"><div class="pt-text" style="font-size:36px;font-weight:800;text-align:center">Order: ${escapeHtml(model.meta.orderDisplayNo)}</div></section>`);
            nativeBands.unshift({
                id: 'required-order-identity', layout: 'flow', nodes: [{
                    id: 'required-order-identity', type: 'text',
                    value: [{ text: `Order: ${String(model.meta.orderDisplayNo ?? '')}`, direction: 'auto' }],
                    style: { fontSize: 'xl', fontWeight: 'black', align: 'center' }
                }]
            });
        }
        const expected = (Array.isArray(model?.items) ? model.items : []).map((item, index) => ({ item, index })).filter(({ item }) => item?.isOther !== true).map(({ index }) => index);
        if (!kitchenPrimaryIndexes || kitchenPrimaryIndexes.length !== expected.length || kitchenPrimaryIndexes.some((index, position) => index !== expected[position])) {
            fail('TEMPLATE_PRIMARY_COVERAGE_INVALID', 'Kitchen primary items were not compiled exactly once');
        }
    }
    if (state.jofotaraQrHtml) {
        output.push(state.jofotaraQrHtml);
        nativeBands.push({ id: 'jofotara-qr', layout: 'flow', nodes: [state.jofotaraQrLayout] });
    }
    const css = artifactCss(checked);
    const html = `<main class="compiled-document" data-doc-type="${checked.docType}" style="width:576px">${output.join('')}</main>`;
    const nativeLayout = { version: 1, docType: checked.docType, widthPx: PAPER_WIDTH_PX, bands: nativeBands };
    if (Buffer.byteLength(html, 'utf8') + Buffer.byteLength(css, 'utf8') > MAX_ARTIFACT_BYTES) fail('TEMPLATE_ARTIFACT_LIMIT', 'Compiled artifact exceeds 256KB');
    if (Buffer.byteLength(JSON.stringify(nativeLayout), 'utf8') > MAX_ARTIFACT_BYTES) fail('TEMPLATE_ARTIFACT_LIMIT', 'Native compiled layout exceeds 256KB');
    return { artifact: { version: 1, kind: 'compiled_document_v1', docType: checked.docType, widthPx: PAPER_WIDTH_PX, templateRevisionId, compilerVersion: 1, html, css, nativeLayout }, warnings: state.warnings };
}

function reserveSections(state, count) {
    if (!Number.isSafeInteger(count) || count < 0 || state.sections + count > MAX_EXPANDED_NODES) {
        fail('TEMPLATE_EXPANSION_LIMIT', `Template expands beyond ${MAX_EXPANDED_NODES} sections`);
    }
    state.sections += count;
}

function resolveTemplateRevisionId(context, docType) {
    const mode = context?.mode;
    const revision = context?.templateRevisionId;
    if (!['runtime', 'preview', 'test'].includes(mode)) fail('TEMPLATE_CONTEXT_INVALID', 'Compilation mode is invalid');
    if (mode === 'preview') {
        if (revision === 'preview:unpublished') return revision;
        fail('TEMPLATE_CONTEXT_INVALID', 'Preview artifacts must use unpublished provenance');
    }
    if (revision === `builtin:${docType}-v1`) return revision;
    if (Number.isSafeInteger(revision) && revision > 0) return `revision:${revision}`;
    fail('TEMPLATE_CONTEXT_INVALID', 'Template revision provenance is invalid for this document and mode');
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

function getTemplateCatalog(docType) {
    const catalog = catalogFor(docType);
    const fields = Object.entries(catalog.global).map(([path, type]) => ({ path, type, scope: 'document' }));
    const relativeFields = Object.entries(catalog.relative).map(([path, type]) => ({ path, type, scope: catalog.source }));
    return deepFreeze({ docType, sources: [catalog.source], fields: [...fields, ...relativeFields], conditionOperations: [...OPERATIONS], styleTokens: Object.fromEntries(Object.entries(STYLE_VALUES).map(([key, values]) => [key, [...values]])) });
}

module.exports = { validateTemplate, compileTemplate, getTemplateCatalog };
