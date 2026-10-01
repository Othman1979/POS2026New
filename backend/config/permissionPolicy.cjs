// Shared by Node and the browser. No database, session cache, or side effects.
const catalog = require('./permissionCatalog.json');
const knownKeys = new Set(catalog.filter(row => row.implemented).map(row => row.perm_key));
const definitions = new Map(catalog.map(row => [row.perm_key, row]));
const PERMISSIONS = Object.freeze(Object.fromEntries(catalog.map(row => [row.perm_key.replaceAll('.', '_').toUpperCase(), row.perm_key])));
// Supported approval surfaces are code-owned; a database flag cannot create one.
const CHECKOUT_APPROVAL_ACTIONS = Object.freeze([PERMISSIONS.POS_DISCOUNT, PERMISSIONS.POS_PRICE_OVERRIDE]);
const TEMPORARY_CHECKOUT_PERMISSIONS = Object.freeze([PERMISSIONS.POS_DISCOUNT, PERMISSIONS.POS_PRICE_OVERRIDE]);
const TABLE_APPROVAL_ACTIONS = Object.freeze(['table.join', 'table.disjoin']);
const isAdminRole = user => !!user && ['admin', 'programmer'].includes(user.role);
const isCallCenterRole = user => user?.role === 'call_center';
const isCurrentPermission = key => knownKeys.has(key);
const canAssignPermission = (role, key) => isCurrentPermission(key) && definitions.get(key)?.roles?.includes(role) === true;

function userHas(user, key) {
    if (!user || !isCurrentPermission(key) || isCallCenterRole(user)) return false;
    if (isAdminRole(user)) return true;
    if (!canAssignPermission(user.role, key)) return false;
    if (key === PERMISSIONS.TABLES_ACCESS && user.role === 'waiter') return true;
    return Array.isArray(user.permissions) && user.permissions.includes(key);
}

function getTableSectionIds(user) {
    if (!user || isCallCenterRole(user)) return [];
    if (isAdminRole(user)) return null;
    if (user.table_access_scope === 'all') return null;
    if (user.table_access_scope !== 'selected') return [];
    return [...new Set(String(user.allowed_sections ?? '').split(',').map(value => value.trim())
        .filter(value => /^\d+$/.test(value)).map(Number)
        .filter(id => Number.isSafeInteger(id) && id > 0))];
}

function presetPermissions(preset, rows = catalog) {
    const role = preset === 'waiter' ? 'waiter' : 'cashier';
    if (!['cashier', 'cashier_tables', 'waiter'].includes(preset)) return [];
    return rows.filter(row => row.implemented && canAssignPermission(role, row.perm_key)
        && (preset === 'waiter' ? definitions.get(row.perm_key)?.default_waiter
            : row.default_cashier || (preset === 'cashier_tables' && ['tables.access', 'tables.save'].includes(row.perm_key))))
        .map(row => row.perm_key);
}

// These compose grants only. Callers still enforce persisted state, section and
// ownership scope, transaction locks, and financial invariants before a write.
const actionRules = Object.freeze({
    'table.create': user => [PERMISSIONS.TABLES_ACCESS, user.role === 'cashier' ? PERMISSIONS.TABLES_SAVE : PERMISSIONS.WAITER_EDIT_LOCKED],
    'table.edit': () => [PERMISSIONS.WAITER_EDIT_LOCKED],
    'table.void': (_user, context) => context.saved === false ? [] : [PERMISSIONS.POS_VOID_ITEM, ...(context.printed ? [PERMISSIONS.POS_VOID_PRINTED_ITEM] : [])],
    'table.transfer': () => [PERMISSIONS.WAITER_TRANSFER_TABLE],
    'table.transfer_items': () => [PERMISSIONS.WAITER_TRANSFER_TABLE, PERMISSIONS.WAITER_EDIT_LOCKED],
    'table.join': () => [PERMISSIONS.WAITER_MERGE_TABLES],
    'table.disjoin': () => [PERMISSIONS.WAITER_MERGE_TABLES],
    'table.merge': () => [PERMISSIONS.WAITER_MERGE_TABLES],
    'table.split': () => [PERMISSIONS.POS_SPLIT_CHECKS],
    checkout: (user, context) => userHas(user, PERMISSIONS.POS_CHECKOUT)
        ? [PERMISSIONS.POS_CHECKOUT]
        : [context.tablePayment && user.role === 'waiter' ? PERMISSIONS.WAITER_CHECKOUT : PERMISSIONS.POS_CHECKOUT],
});

function evaluateAction(user, action, context = {}) {
    context = context ?? {};
    if (!Object.hasOwn(actionRules, action) && !isCurrentPermission(action)) {
        return { allowed: false, code: 'UNKNOWN_ACTION', missingPermissions: [] };
    }
    if (!user || isCallCenterRole(user)) {
        return { allowed: false, code: 'ROLE_RESTRICTED', missingPermissions: [] };
    }
    const required = Object.hasOwn(actionRules, action) ? actionRules[action](user, context) : [action];
    const missingPermissions = required.filter(key => !userHas(user, key));
    return { allowed: missingPermissions.length === 0, code: missingPermissions.length ? 'PERMISSION_REQUIRED' : null, missingPermissions };
}

module.exports = { catalog, PERMISSIONS, CHECKOUT_APPROVAL_ACTIONS, TEMPORARY_CHECKOUT_PERMISSIONS, TABLE_APPROVAL_ACTIONS, isAdminRole, isCallCenterRole, isCurrentPermission, canAssignPermission, userHas, evaluateAction, getTableSectionIds, presetPermissions };
