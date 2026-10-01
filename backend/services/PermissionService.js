const pool = require('../config/db');

const { PERMISSIONS, TEMPORARY_CHECKOUT_PERMISSIONS, isCurrentPermission, isAdminRole, isCallCenterRole, userHas, evaluateAction, getTableSectionIds } = require('../config/permissionPolicy.cjs');
const catalogDefinitions = new Map(require('../config/permissionCatalog.json').map(row => [row.perm_key, row]));

// Temporary Manager Access is only cached in the browser for checkout fields
// whose submitted PIN is re-verified by executeCheckout. Other overridable
// actions keep their own endpoint-specific authorization flow.
const CHECKOUT_MANAGER_OVERRIDE_PERMISSIONS = TEMPORARY_CHECKOUT_PERMISSIONS;

// Returns the implemented permission keys granted to a user. Admin/programmer get [] here
// (they bypass via isAdminRole / userHas), so never query grants for them.
async function loadUserPermissions(userId, role = null, executor = pool) {
  if (!userId || role === 'call_center') return [];
  const [rows] = await executor.query(
    `SELECT up.perm_key
       FROM user_permissions up
       JOIN permissions p ON p.perm_key = up.perm_key
      WHERE up.user_id = ? AND p.implemented = 1`,
    [userId]
  );
  return rows.map(r => r.perm_key).filter(isCurrentPermission);
}

// Route-facing predicates live with the canonical permission catalog so every
// caller applies the same admin bypass and permission key.
const canHoldOrders = (user) => userHas(user, PERMISSIONS.POS_HOLD_ORDERS);
const canSplitBill = user => evaluateAction(user, 'table.split').allowed;
const hasDiscountPermission = (user) => userHas(user, PERMISSIONS.POS_DISCOUNT);
const hasVoidPermission = (user) => userHas(user, PERMISSIONS.POS_VOID_ITEM);
const hasRefundPermission = (user) => userHas(user, PERMISSIONS.POS_REFUND);
const canCheckout = (user) => userHas(user, PERMISSIONS.POS_CHECKOUT);
const canPriceOverride = (user) => userHas(user, PERMISSIONS.POS_PRICE_OVERRIDE);
const canVoidPrinted = (user) => userHas(user, PERMISSIONS.POS_VOID_PRINTED_ITEM);
const canApplyServiceCharge = (user) => userHas(user, PERMISSIONS.POS_SERVICE_CHARGE);
const canTaxExempt = (user) => userHas(user, PERMISSIONS.POS_TAX_EXEMPT);
const canViewOrders = (user) => userHas(user, PERMISSIONS.ORDERS_VIEW);
// Only an explicitly granted operational user: admin and programmer logins stay single-session
// even though their role grants every other known action.
const canStaySignedInOnSeveralTerminals = (user) => !['admin', 'programmer'].includes(user?.role)
  && userHas(user, PERMISSIONS.AUTH_MULTI_TERMINAL);
const canOpenShift = (user) => userHas(user, PERMISSIONS.SHIFT_OPEN);
const canCloseShift = (user) => userHas(user, PERMISSIONS.SHIFT_CLOSE);
const canAccessTables = user => userHas(user, PERMISSIONS.TABLES_ACCESS);
const canEditLocked = user => evaluateAction(user, 'table.edit').allowed;
const canCreateTableOrder = user => evaluateAction(user, 'table.create').allowed;
const canCheckoutOrder = (user, context) => evaluateAction(user, 'checkout', context).allowed;
const canOverrideTables = (user) => userHas(user, PERMISSIONS.WAITER_OVERRIDE_TABLES);
const canCheckoutTable = user => isAdminRole(user) || (user?.role === 'waiter' && userHas(user, PERMISSIONS.WAITER_CHECKOUT));
const canTransferTable = user => evaluateAction(user, 'table.transfer').allowed;
const canMergeTables = user => evaluateAction(user, 'table.merge').allowed;

function assertTableSectionAccess(user, tables) {
  const ids = getTableSectionIds(user);
  if (ids === null) return;
  const allowed = new Set(ids);
  if (!tables.length || tables.some(table => !allowed.has(Number(table.section_id)))) {
    const error = new Error('Forbidden: This table is outside your assigned sections.');
    error.statusCode = 403;
    error.publicCode = 'TABLE_ACCESS_DENIED';
    throw error;
  }
}

// Canonical void wall for removing saved units from a live table order.
const assertCanVoidSavedUnits = (user, { isPrinted = true } = {}) => {
  if (isAdminRole(user)) return;
  const deny = (msg) => {
    const err = new Error(`Forbidden: ${msg}`);
    err.statusCode = 403;
    throw err;
  };
  const decision = evaluateAction(user, 'table.void', { printed: isPrinted });
  if (decision.allowed) return;
  if (!hasVoidPermission(user)) deny('You do not have permission to void a table order.');
  deny('You do not have permission to void printed items.');
};

// Object-level access check for printing an order's receipt/ticket.
const userCanAccessOrderForPrint = (user, order) => {
  if (!user || !order) return false;
  if (isAdminRole(user)) return true;
  if (isCallCenterRole(user)) return false;
  if (order.user_id === user.id || order.waiter_id === user.id) return true;
  return userHas(user, PERMISSIONS.POS_REPRINT_RECEIPT);
};

async function getCatalog() {
  const [rows] = await pool.query(
    `SELECT perm_key, label, label_ar, description, description_ar,
            category, sort_order, implemented, default_cashier, overridable
       FROM permissions ORDER BY sort_order ASC, perm_key ASC`
  );
  return rows.filter(row => isCurrentPermission(row.perm_key)).map(row => ({
    ...row, ...catalogDefinitions.get(row.perm_key),
    implemented: row.implemented, default_cashier: row.default_cashier, overridable: row.overridable,
  }));
}

async function getOverridableKeys(executor = pool, keys = TEMPORARY_CHECKOUT_PERMISSIONS) {
  if (!keys.length) return [];
  const [rows] = await executor.query(
    "SELECT perm_key FROM permissions WHERE overridable = 1 AND implemented = 1 AND perm_key IN (?)" +
    (executor === pool ? '' : ' LOCK IN SHARE MODE'), [keys]
  );
  return rows.map(r => r.perm_key).filter(isCurrentPermission);
}

module.exports = {
  evaluateAction,
  canCheckoutOrder,
  PERMISSIONS,
  isCurrentPermission,
  CHECKOUT_MANAGER_OVERRIDE_PERMISSIONS,
  isAdminRole,
  isCallCenterRole,
  loadUserPermissions,
  userHas,
  canHoldOrders,
  canSplitBill,
  hasDiscountPermission,
  hasVoidPermission,
  hasRefundPermission,
  canCheckout,
  canPriceOverride,
  canVoidPrinted,
  canApplyServiceCharge,
  canTaxExempt,
  canStaySignedInOnSeveralTerminals,
  canViewOrders,
  canOpenShift,
  canCloseShift,
  canAccessTables,
  canEditLocked,
  canCreateTableOrder,
  canOverrideTables,
  canCheckoutTable,
  canTransferTable,
  canMergeTables,
  getTableSectionIds,
  assertTableSectionAccess,
  assertCanVoidSavedUnits,
  userCanAccessOrderForPrint,
  getCatalog,
  getOverridableKeys
};
