// Relative imports only: the Playwright specs load this module in plain Node,
// where the Vite '@' alias does not resolve.
import { CHECKOUT_ATTEMPT_CACHE_KEY } from '../checkoutAttemptCache.js';
import { createRequestId } from '../../../shared/requestId.js';

export const POS_ORDER_KEYS = {
  activeTable: 'pos_active_table',
  tablePrefill: 'pos_table_prefill',
  cart: 'pos_cart',
  note: 'pos_order_note',
  discount: 'pos_order_discount',
  restoreHeldOrder: 'pos_restore_held_order',
  kitchenFired: 'pos_held_kitchen_fired',
  serviceChargeSnapshot: 'pos_service_charge_snapshot',
  taxExempt: 'pos_tax_exempt',
  context: 'pos_order_context',
  heldOperation: 'pos_held_pending_operation',
};

export const POS_ORDER_SESSION_KEYS = [
  POS_ORDER_KEYS.activeTable,
  POS_ORDER_KEYS.tablePrefill,
  POS_ORDER_KEYS.cart,
  POS_ORDER_KEYS.note,
  POS_ORDER_KEYS.discount,
  POS_ORDER_KEYS.restoreHeldOrder,
  POS_ORDER_KEYS.kitchenFired,
  POS_ORDER_KEYS.serviceChargeSnapshot,
  POS_ORDER_KEYS.taxExempt,
  POS_ORDER_KEYS.context,
  POS_ORDER_KEYS.heldOperation,
  CHECKOUT_ATTEMPT_CACHE_KEY,
];

const ORDER_CONTEXT_VERSION = 2;
const ORDER_CONTEXT_SCOPE_KINDS = new Set(['register', 'held', 'table']);
const TAX_REGISTRATION_TYPES = new Set(['sales_tax', 'income_tax']);
const CALL_CENTER_MODES = new Set(['new', 'editing']);

const positiveInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const normalizeHeldOrderContext = (value) => {
  if (!value || typeof value !== 'object') return null;
  const id = positiveInteger(value.id);
  const version = positiveInteger(value.version);
  const claimToken = text(value.claimToken);
  if (!id || !version || !/^[0-9a-f]{64}$/i.test(claimToken)) return null;
  return {
    id,
    version,
    claimToken,
    claimExpiresAt: value.claimExpiresAt == null ? null : text(value.claimExpiresAt),
    kitchenFired: value.kitchenFired === true || value.kitchenFired === 1 || value.kitchenFired === '1',
    baselineUnknown: value.baselineUnknown === true || value.baselineUnknown === 1 || value.baselineUnknown === '1',
    kitchenDispatchVersion: Math.max(0, Number(value.kitchenDispatchVersion) || 0),
  };
};

const text = (value) => value == null ? '' : String(value);

const optionalPositiveId = (value) => {
  if (value == null || value === '') return null;
  const normalized = positiveInteger(value);
  return normalized ? String(normalized) : undefined;
};

const normalizeCallCenterContext = (value) => {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || value.started !== true) return undefined;
  const userId = positiveInteger(value.userId);
  const mode = text(value.mode);
  if (!userId || !CALL_CENTER_MODES.has(mode)) return undefined;
  return { started: true, userId, mode };
};

const normalizeOrderContext = (value) => {
  if (!value || typeof value !== 'object' || value.version !== ORDER_CONTEXT_VERSION) return null;
  const scope = value.scope;
  if (!scope || !ORDER_CONTEXT_SCOPE_KINDS.has(scope.kind)) return null;

  let normalizedScope;
  if (scope.kind === 'table') {
    const id = optionalPositiveId(scope.id);
    const orderId = optionalPositiveId(scope.orderId);
    const splitCheckId = optionalPositiveId(scope.splitCheckId);
    const tableNumber = text(scope.tableNumber).trim();
    if (id === undefined || orderId === undefined || splitCheckId === undefined) return null;
    if (!id && !orderId && !splitCheckId && !tableNumber) return null;
    normalizedScope = { kind: 'table', id, orderId, splitCheckId, tableNumber };
  } else if (scope.kind === 'held') {
    const scopeId = text(scope.id);
    if (!scopeId) return null;
    normalizedScope = { kind: 'held', id: scopeId };
  } else {
    normalizedScope = { kind: 'register', id: null };
  }

  const callCenter = normalizeCallCenterContext(value.callCenter);
  if (callCenter === undefined) return null;
  // Retired subscription drafts must never be restored as ordinary orders.
  if (value.subscriptionPurchase != null) return null;
  if (callCenter && !['register', 'held'].includes(scope.kind)) return null;
  if (callCenter?.mode === 'editing' && scope.kind !== 'held') return null;
  if (callCenter?.mode === 'new' && scope.kind !== 'register') return null;
  const restoredHeldReference = text(value.restoredHeldReference);
  if (scope.kind === 'held' && (!restoredHeldReference || restoredHeldReference !== normalizedScope.id)) return null;
  const heldOrder = scope.kind === 'held' ? normalizeHeldOrderContext(value.heldOrder) : null;
  const holdRequestId = value.holdRequestId == null || value.holdRequestId === ''
    ? null
    : text(value.holdRequestId).trim();
  if (holdRequestId && !/^[a-z0-9-]{16,64}$/i.test(holdRequestId)) return null;

  const normalized = {
    version: ORDER_CONTEXT_VERSION,
    ...(value.checkoutDraftId ? { checkoutDraftId: text(value.checkoutDraftId) } : {}),
    scope: normalizedScope,
    selectedOrderType: positiveInteger(value.selectedOrderType),
    hashNumber: text(value.hashNumber),
    customerPhone: text(value.customerPhone),
    customerName: text(value.customerName),
    customerAddress: text(value.customerAddress),
    orderDate: text(value.orderDate),
    restoredHeldReference,
    taxRegistrationType: TAX_REGISTRATION_TYPES.has(value.taxRegistrationType)
      ? value.taxRegistrationType
      : null,
  };
  if (heldOrder) normalized.heldOrder = heldOrder;
  if (holdRequestId) normalized.holdRequestId = holdRequestId;
  if (callCenter) normalized.callCenter = callCenter;
  return normalized;
};

export const matchesTableOrderContext = (context, table) => {
  if (context?.scope?.kind !== 'table' || !table) return false;
  const scope = context.scope;
  const tableId = optionalPositiveId(table.id);
  const orderId = optionalPositiveId(table.current_order_id);
  const splitCheckId = optionalPositiveId(table.split_check_id);
  if (tableId === undefined || orderId === undefined || splitCheckId === undefined) return false;
  if (scope.id !== tableId) return false;
  if (scope.orderId !== orderId) return false;
  if (scope.splitCheckId !== splitCheckId) return false;
  if (!scope.id && scope.tableNumber !== text(table.table_number).trim()) return false;
  return true;
};

const getItem = (storage, key) => {
  try { return storage.getItem(key); } catch (_) { return null; }
};
const setItem = (storage, key, value) => {
  try { storage.setItem(key, value); } catch (_) {}
};
const removeItem = (storage, key) => {
  try { storage.removeItem(key); } catch (_) {}
};

const readJson = (storage, key, fallback = null) => {
  try {
    const value = getItem(storage, key);
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    removeItem(storage, key);
    return fallback;
  }
};

export const readOrderSnapshot = (storage = localStorage) => {
  const savedCart = readJson(storage, POS_ORDER_KEYS.cart, []);
  const cart = Array.isArray(savedCart) ? savedCart : [];
  if (savedCart !== undefined && savedCart !== null && !Array.isArray(savedCart)) {
    removeItem(storage, POS_ORDER_KEYS.cart);
  }

  const rawContext = readJson(storage, POS_ORDER_KEYS.context, null);
  const context = normalizeOrderContext(rawContext);
  if (rawContext !== null && context === null) removeItem(storage, POS_ORDER_KEYS.context);

  return {
  cart,
  note: getItem(storage, POS_ORDER_KEYS.note) || '',
  discount: readJson(storage, POS_ORDER_KEYS.discount),
  serviceChargeSnapshot: readJson(storage, POS_ORDER_KEYS.serviceChargeSnapshot),
  taxExempt: readJson(storage, POS_ORDER_KEYS.taxExempt, false) === true,
  context,
  };
};

export const readCallCenterOrderSnapshot = (userId, storage = localStorage) => {
  const snapshot = readOrderSnapshot(storage);
  const context = snapshot.context;
  if (!context?.callCenter || context.callCenter.userId !== positiveInteger(userId)) {
    clearPosOrderSession(storage);
    return null;
  }
  return snapshot;
};

export const writeCart = (storage, cart) => setItem(storage, POS_ORDER_KEYS.cart, JSON.stringify(cart));
export const clearCartStorage = (storage = localStorage) => removeItem(storage, POS_ORDER_KEYS.cart);
export const writeOrderNote = (storage, note) => setItem(storage, POS_ORDER_KEYS.note, note);
export const writeOrderDiscount = (storage, discount) => setItem(storage, POS_ORDER_KEYS.discount, JSON.stringify(discount));
export const clearOrderDiscount = (storage = localStorage) => removeItem(storage, POS_ORDER_KEYS.discount);
export const writeServiceChargeSnapshot = (storage, snapshot) => {
  if (snapshot) setItem(storage, POS_ORDER_KEYS.serviceChargeSnapshot, JSON.stringify(snapshot));
  else removeItem(storage, POS_ORDER_KEYS.serviceChargeSnapshot);
};
export const writeTaxExempt = (storage, value) => {
  if (value === true) setItem(storage, POS_ORDER_KEYS.taxExempt, 'true');
  else removeItem(storage, POS_ORDER_KEYS.taxExempt);
};
export const writeOrderContext = (storage, context) => {
  const normalized = normalizeOrderContext(context);
  if (normalized) setItem(storage, POS_ORDER_KEYS.context, JSON.stringify(normalized));
  else removeItem(storage, POS_ORDER_KEYS.context);
};
export const readActiveTable = (storage = localStorage) => readJson(storage, POS_ORDER_KEYS.activeTable);
export const writeActiveTable = (storage, table) => {
  if (table) setItem(storage, POS_ORDER_KEYS.activeTable, JSON.stringify(table));
  else removeItem(storage, POS_ORDER_KEYS.activeTable);
};
export const consumeStoredJson = (storage, key) => {
  const value = readJson(storage, key);
  removeItem(storage, key);
  return value;
};
export const writeHeldOrderHandoff = (storage, value) => setItem(
  storage,
  POS_ORDER_KEYS.restoreHeldOrder,
  typeof value === 'string' ? value : JSON.stringify(value)
);
export const readHeldOrderHandoff = (storage = localStorage) => readJson(storage, POS_ORDER_KEYS.restoreHeldOrder);
export const clearHeldOrderHandoff = (storage = localStorage) => removeItem(storage, POS_ORDER_KEYS.restoreHeldOrder);
const heldOperationKey = (kind, heldOrderId) => `${text(kind).trim()}:${positiveInteger(heldOrderId)}`;
const readHeldOperations = (storage) => {
  const stored = readJson(storage, POS_ORDER_KEYS.heldOperation, {});
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  // Read the one-operation format written by the first lifecycle release so an
  // in-flight retry survives an application update.
  if (stored.operationId && stored.kind && stored.heldOrderId) {
    return { [heldOperationKey(stored.kind, stored.heldOrderId)]: String(stored.operationId) };
  }
  return stored;
};
export const getHeldOperationId = (kind, heldOrderId, storage = localStorage) => {
  const normalizedKind = text(kind).trim();
  const normalizedId = positiveInteger(heldOrderId);
  const key = heldOperationKey(normalizedKind, normalizedId);
  const operations = readHeldOperations(storage);
  if (operations[key]) return String(operations[key]);
  const operationId = createHeldOperationId();
  operations[key] = operationId;
  setItem(storage, POS_ORDER_KEYS.heldOperation, JSON.stringify(operations));
  return operationId;
};

export const createHeldOperationId = createRequestId;
export const createHeldClaimToken = () => {
  const bytes = new Uint8Array(32);
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
};
export const clearHeldOperationId = (kind, heldOrderId, storage = localStorage) => {
  const key = heldOperationKey(kind, heldOrderId);
  const operations = readHeldOperations(storage);
  if (!operations[key]) return;
  delete operations[key];
  if (Object.keys(operations).length === 0) removeItem(storage, POS_ORDER_KEYS.heldOperation);
  else setItem(storage, POS_ORDER_KEYS.heldOperation, JSON.stringify(operations));
};
export const clearTablePrefill = (storage = localStorage) => removeItem(storage, POS_ORDER_KEYS.tablePrefill);
export const setHeldKitchenFired = (storage, fired) => {
  if (fired) setItem(storage, POS_ORDER_KEYS.kitchenFired, '1');
  else removeItem(storage, POS_ORDER_KEYS.kitchenFired);
};
export const isHeldKitchenFired = (storage = localStorage) => getItem(storage, POS_ORDER_KEYS.kitchenFired) === '1';
export const hasActiveTableSession = (storage = localStorage) => Boolean(getItem(storage, POS_ORDER_KEYS.activeTable));
export const hasPendingTableSession = (storage = localStorage, activeTable = null) => Boolean(
  getItem(storage, POS_ORDER_KEYS.tablePrefill) || getItem(storage, POS_ORDER_KEYS.activeTable) || activeTable
);
export const clearOrderData = (storage = localStorage) => {
  [POS_ORDER_KEYS.cart, POS_ORDER_KEYS.note, POS_ORDER_KEYS.discount, POS_ORDER_KEYS.kitchenFired, POS_ORDER_KEYS.serviceChargeSnapshot, POS_ORDER_KEYS.taxExempt, POS_ORDER_KEYS.context].forEach((key) => removeItem(storage, key));
};
export const clearPosOrderSession = (storage = localStorage) => {
  POS_ORDER_SESSION_KEYS.forEach((key) => removeItem(storage, key));
};
