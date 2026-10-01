import {
  clearHeldOrderHandoff as clearHeldOrder,
  clearPosOrderSession,
  clearTablePrefill as clearPrefill,
  consumeStoredJson,
  readHeldOrderHandoff as readHeldOrder,
  getHeldOperationId as getOperationId,
  clearHeldOperationId as clearOperationId,
  hasActiveTableSession as hasActiveTable,
  hasPendingTableSession as hasPendingTable,
  isHeldKitchenFired as kitchenWasFired,
  POS_ORDER_KEYS,
  POS_ORDER_SESSION_KEYS,
  readActiveTable,
  setHeldKitchenFired as setKitchenFired,
  writeHeldOrderHandoff,
} from './stores/orderSession/orderSessionPersistence.js';

export const clearPosOrderSessionStorage = (storage = localStorage) => clearPosOrderSession(storage);
export const storeHeldOrderHandoff = (value, storage = localStorage) => writeHeldOrderHandoff(storage, value);
export const consumeHeldOrderHandoff = (storage = localStorage) => consumeStoredJson(storage, POS_ORDER_KEYS.restoreHeldOrder);
export const readHeldOrderHandoff = (storage = localStorage) => readHeldOrder(storage);
export const clearHeldOrderHandoff = (storage = localStorage) => clearHeldOrder(storage);
export const getHeldOperationId = (kind, heldOrderId, storage = localStorage) => getOperationId(kind, heldOrderId, storage);
export const clearHeldOperationId = (kind, heldOrderId, storage = localStorage) => clearOperationId(kind, heldOrderId, storage);
export const clearTablePrefill = (storage = localStorage) => clearPrefill(storage);
export const setHeldKitchenFired = (fired, storage = localStorage) => setKitchenFired(storage, fired);
export const isHeldKitchenFired = (storage = localStorage) => kitchenWasFired(storage);
export const readActiveTableSession = (storage = localStorage) => readActiveTable(storage);
export const hasActiveTableSession = (storage = localStorage) => hasActiveTable(storage);
export const hasPendingTableSession = (storage = localStorage, activeTable = null) => hasPendingTable(storage, activeTable);
export { POS_ORDER_SESSION_KEYS };
