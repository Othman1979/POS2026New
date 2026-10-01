'use strict';

const { normalizeCustomerPhone } = require('../../services/customerPhone');
const { normalizeScheduledDateTime } = require('../../utils/businessDate');

const EXTERNAL_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_ITEMS = 40;
const MAX_QUANTITY = 1000;
const MAX_MODIFIERS_PER_ITEM = 20;
const MAX_BUNDLE_CHANGES_PER_ITEM = 20;

function intakeError(message, statusCode = 400, publicCode = 'ORDER_INTAKE_INVALID') {
    return Object.assign(new Error(message), { statusCode, publicCode });
}

function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw intakeError(`${label} must be an object.`);
    return value;
}

function onlyKeys(value, allowed, label) {
    const extra = Object.keys(value).filter(key => !allowed.has(key));
    if (extra.length) throw intakeError(`${label} contains unsupported fields: ${extra.join(', ')}.`);
}

function boundedText(value, label, max, { required = false } = {}) {
    if (value == null) {
        if (required) throw intakeError(`${label} is required.`);
        return '';
    }
    if (typeof value !== 'string') throw intakeError(`${label} must be text.`);
    const normalized = value.replace(/\r\n?/g, '\n').trim();
    if (required && !normalized) throw intakeError(`${label} is required.`);
    if (normalized.length > max) throw intakeError(`${label} is too long (max ${max} characters).`);
    return normalized;
}

function positiveId(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw intakeError(`${label} must be a positive integer.`);
    return parsed;
}

function normalizePhoneInput(value) {
    if (typeof value !== 'string') throw intakeError('Customer phone must be text.');
    if (value.length > 40) throw intakeError('Customer phone is too long (max 40 characters).');
    return normalizeCustomerPhone(boundedText(value, 'Customer phone', 40, { required: true }));
}

function normalizeModifier(raw, itemIndex, modifierIndex) {
    const value = object(raw, `Item ${itemIndex + 1} modifier ${modifierIndex + 1}`);
    onlyKeys(value, new Set(['group_id', 'option_id', 'group', 'option', 'note_product_id']), `Item ${itemIndex + 1} modifier ${modifierIndex + 1}`);
    if (value.note_product_id != null) {
        if (value.group_id != null || value.option_id != null || value.group != null || value.option != null) {
            throw intakeError(`Item ${itemIndex + 1} modifier ${modifierIndex + 1} mixes a priced note with a modifier option.`);
        }
        return { noteProductId: positiveId(value.note_product_id, 'Priced note product id') };
    }
    const groupId = value.group_id == null ? '' : String(value.group_id).trim();
    const optionId = value.option_id == null ? '' : String(value.option_id).trim();
    const group = boundedText(value.group, 'Modifier group', 80);
    const option = boundedText(value.option, 'Modifier option', 80);
    if ((groupId && !ID_RE.test(groupId)) || (optionId && !ID_RE.test(optionId))) {
        throw intakeError('Modifier ids are invalid.');
    }
    if ((!groupId || !optionId) && (!group || !option)) {
        throw intakeError(`Item ${itemIndex + 1} modifier ${modifierIndex + 1} needs a group and option id or name.`);
    }
    return {
        ...(groupId ? { gid: groupId } : {}),
        ...(optionId ? { oid: optionId } : {}),
        group: group || groupId,
        option: option || optionId,
    };
}

function normalizeBundleChange(raw, itemIndex, changeIndex) {
    const value = object(raw, `Item ${itemIndex + 1} bundle change ${changeIndex + 1}`);
    onlyKeys(value, new Set(['product_id', 'removed', 'note']), `Item ${itemIndex + 1} bundle change ${changeIndex + 1}`);
    if (value.removed != null && typeof value.removed !== 'boolean') throw intakeError('Bundle removed must be a boolean.');
    return {
        product_id: positiveId(value.product_id, 'Bundle product id'),
        removed: value.removed === true,
        note: boundedText(value.note, 'Bundle item note', 300) || null,
    };
}

function normalizeItem(raw, index) {
    const value = object(raw, `Item ${index + 1}`);
    onlyKeys(value, new Set(['product_id', 'quantity', 'note', 'modifiers', 'bundle_changes']), `Item ${index + 1}`);
    const quantity = Number(value.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
        throw intakeError(`Item ${index + 1} quantity must be greater than 0 and at most ${MAX_QUANTITY}.`);
    }
    if (Math.abs(quantity * 1_000_000 - Math.round(quantity * 1_000_000)) > 1e-6) {
        throw intakeError(`Item ${index + 1} quantity supports at most six decimal places.`);
    }
    const modifiers = value.modifiers == null ? [] : value.modifiers;
    const bundleChanges = value.bundle_changes == null ? [] : value.bundle_changes;
    if (!Array.isArray(modifiers) || modifiers.length > MAX_MODIFIERS_PER_ITEM) {
        throw intakeError(`Item ${index + 1} supports at most ${MAX_MODIFIERS_PER_ITEM} modifiers.`);
    }
    if (!Array.isArray(bundleChanges) || bundleChanges.length > MAX_BUNDLE_CHANGES_PER_ITEM) {
        throw intakeError(`Item ${index + 1} supports at most ${MAX_BUNDLE_CHANGES_PER_ITEM} bundle changes.`);
    }
    return {
        product_id: positiveId(value.product_id, `Item ${index + 1} product id`),
        quantity,
        note: boundedText(value.note, `Item ${index + 1} note`, 300) || null,
        modifiers: modifiers.map((entry, modifierIndex) => normalizeModifier(entry, index, modifierIndex)),
        bundle_changes: bundleChanges.map((entry, changeIndex) => normalizeBundleChange(entry, index, changeIndex)),
    };
}

function normalizeDraftInput(raw) {
    const value = object(raw, 'Order draft');
    onlyKeys(value, new Set(['external_request_id', 'order_type_id', 'customer', 'items', 'order_note', 'delivery_at']), 'Order draft');
    const externalRequestId = normalizeExternalRequestId(value.external_request_id);
    const customer = object(value.customer, 'Customer');
    onlyKeys(customer, new Set(['name', 'phone', 'address']), 'Customer');
    const items = value.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
        throw intakeError(`An order must contain 1-${MAX_ITEMS} items.`);
    }
    return {
        external_request_id: externalRequestId,
        order_type_id: positiveId(value.order_type_id, 'Order type id'),
        customer: {
            name: boundedText(customer.name, 'Customer name', 100, { required: true }),
            phone: normalizePhoneInput(customer.phone),
            address: boundedText(customer.address, 'Customer address', 300, { required: true }),
        },
        items: items.map(normalizeItem),
        order_note: boundedText(value.order_note, 'Order note', 500) || null,
        delivery_at: value.delivery_at == null || value.delivery_at === ''
            ? null
            : normalizeScheduledDateTime(value.delivery_at, 'ORDER_INTAKE_DELIVERY_DATE_INVALID'),
    };
}

function normalizeExternalRequestId(value) {
    const externalRequestId = String(value || '').trim();
    if (!EXTERNAL_ID_RE.test(externalRequestId)) {
        throw intakeError('external_request_id must be 8-128 safe identifier characters.', 400, 'ORDER_INTAKE_REQUEST_ID_INVALID');
    }
    return externalRequestId;
}

function normalizeCustomerLookup(raw) {
    const value = object(raw, 'Customer lookup');
    onlyKeys(value, new Set(['phone']), 'Customer lookup');
    return normalizePhoneInput(value.phone);
}

module.exports = {
    MAX_ITEMS,
    MAX_QUANTITY,
    MAX_MODIFIERS_PER_ITEM,
    MAX_BUNDLE_CHANGES_PER_ITEM,
    intakeError,
    normalizeDraftInput,
    normalizeCustomerLookup,
    normalizeExternalRequestId,
};
