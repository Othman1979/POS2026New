import { fetchReadJsonResponse, fetchJsonResponseWithTimeout } from '@/shared/http.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

// Every mutation gets a deadline; callers treat a timeout as an uncertain outcome
// and retry with the same operation id (or reconcile) instead of calling it a failure.
const timedJsonRequest = (url, method, body, timeoutMs = 15000) => fetchJsonResponseWithTimeout(url, {
  method, headers: jsonHeaders, body: JSON.stringify(body),
}, timeoutMs);

export const abandonServiceChargeSnapshot = (snapshot) => timedJsonRequest(
  `api/pos/service_charge_snapshots/${snapshot.id}`,
  'DELETE',
  {
    version: snapshot.version,
    ...(snapshot.claimToken ? { claim_token: snapshot.claimToken } : {}),
  },
);

export const createServiceChargeSnapshot = (payload) => timedJsonRequest('api/pos/service_charge_snapshots', 'POST', payload);
export const getTableDraft = (tableId) => fetchReadJsonResponse(`api/pos/table-draft/${tableId}`);
// expectedHash deletes only the draft that was imported (409 DRAFT_CHANGED otherwise).
export const dismissTableDraft = (tableId, expectedHash = null) => fetchJsonResponseWithTimeout(`api/pos/table-draft/${tableId}`, {
  method: 'DELETE',
  ...(expectedHash ? { headers: jsonHeaders, body: JSON.stringify({ expected_hash: expectedHash }) } : {}),
});
// Exact products by id (QR import); never merged into the visible catalog scope.
export const getProductsByIds = (ids, salesContext) => fetchReadJsonResponse(`api/pos/products?${new URLSearchParams({
  sales_context: salesContext, product_ids: ids.join(','),
})}`);
export const getTableOrder = (orderId, options = {}) => fetchReadJsonResponse(`api/pos/table_order?order_id=${orderId}`, options);
export const previewTableItemTransfer = (payload, options = {}) => fetchJsonResponseWithTimeout('api/pos/tables/transfer/preview', {
  ...options, method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload),
});
export const getTables = (userId) => fetchReadJsonResponse(`api/pos/get_tables?user_id=${userId}`);
export const saveTableOrder = (payload) => timedJsonRequest('api/pos/table_order', 'POST', payload);
export const markTablePrinted = ({ tableId, invoiceId }) => timedJsonRequest('api/pos/table_order', 'POST', {
  action: 'mark_printed',
  table_id: tableId,
  expected_invoice_id: invoiceId,
});
export const holdOrder = (payload) => timedJsonRequest('api/pos/held_orders', 'POST', payload);
export const getHeldOrders = () => fetchReadJsonResponse('api/pos/held_orders');
export const getHeldOrdersSummary = () => fetchReadJsonResponse('api/pos/held_orders/summary');
export const claimHeldOrder = ({ id, claimToken, expectedVersion, customerPhone = null }) => timedJsonRequest(
  `api/pos/held_orders/${encodeURIComponent(id)}/claim`,
  'POST',
  {
    claim_token: claimToken,
    expected_version: expectedVersion,
    ...(customerPhone ? { phone: customerPhone } : {}),
  },
);
export const updateHeldOrder = (id, payload) => timedJsonRequest(
  `api/pos/held_orders/${encodeURIComponent(id)}`,
  'PATCH',
  payload,
);
export const followUpHeldOrder = (id, payload) => timedJsonRequest(
  `api/pos/held_orders/${encodeURIComponent(id)}/follow-up`,
  'POST',
  payload,
);
export const confirmHeldKitchenBaseline = (id, payload) => timedJsonRequest(
  `api/pos/held_orders/${encodeURIComponent(id)}/baseline-confirm`,
  'POST',
  payload,
);
export const releaseHeldOrder = (id, payload) => timedJsonRequest(
  `api/pos/held_orders/${encodeURIComponent(id)}/release`,
  'POST',
  payload,
);
export const cancelHeldOrder = (id, payload) => timedJsonRequest(
  `api/pos/held_orders/${encodeURIComponent(id)}`,
  'DELETE',
  payload,
);
export const splitTable = (payload) => timedJsonRequest('api/pos/table_splits/split', 'POST', payload);
export const updateTableSplits = (payload) => timedJsonRequest('api/pos/table_splits', 'PUT', payload);
export const transferTable = (payload) => fetchJsonResponseWithTimeout('api/pos/tables/transfer', {
  method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload),
});
export const getTableAction = (operationId) => fetchReadJsonResponse(`api/pos/tables/transfer/${encodeURIComponent(operationId)}`);
export const joinTables = (payload) => timedJsonRequest('api/pos/tables/join', 'POST', payload);
export const disjoinTables = (payload) => timedJsonRequest('api/pos/tables/disjoin', 'POST', payload);
export const getTableSplits = (parentInvoiceId = null) => fetchReadJsonResponse(
  'api/pos/table_splits' + (parentInvoiceId === null ? '' : `?parent_invoice_id=${encodeURIComponent(parentInvoiceId)}`)
);
export const cancelTableSplit = (splitId) => fetchJsonResponseWithTimeout(
  `api/pos/table_splits?id=${encodeURIComponent(splitId)}`,
  { method: 'DELETE' }
);
export const getOrderDetails = (invoiceId) => fetchReadJsonResponse(`api/admin/order_details?id=${invoiceId}`);
export const getOrderTypes = () => fetchReadJsonResponse('api/pos/order_types');
export const getCustomerByPhone = (phone, { privateBody = false } = {}) => privateBody
  ? timedJsonRequest('api/pos/customer_lookup', 'POST', { phone })
  : fetchReadJsonResponse(`api/pos/customer_lookup?phone=${encodeURIComponent(phone)}`);
export const findPhoneHeldOrders = (phone) => timedJsonRequest('api/pos/held_orders/phone-matches', 'POST', { phone });
// A timeout or unreadable body lands in the store's "could not confirm" path;
// expected_version prevents a double apply if the user retries after reopening.
export const voidTableItems = (payload) => fetchJsonResponseWithTimeout('/api/pos/refunds', {
  method: 'POST',
  headers: jsonHeaders,
  credentials: 'same-origin',
  body: JSON.stringify(payload),
});
// A deadline is an uncertain outcome. The store retains the original payload
// and key for explicit recovery; this transport never retries a payment.
export const checkoutOrder = (payload) => fetchJsonResponseWithTimeout('api/pos/checkout', {
  method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload),
}, 30000);
// The server waits up to 30 s for the provider; stay above that so a slow but
// healthy acceptance is not reported as needing attention.
export const finalizeJofotaraCheckout = (payload) => timedJsonRequest('api/pos/checkout/jofotara', 'POST', payload, 45000);
export const getJofotaraCheckoutStatus = (payload) => timedJsonRequest('api/pos/checkout/jofotara/status', 'POST', payload);
// Not idempotent: a timeout is reported as unconfirmed and never retried automatically.
export const logDrawerPop = (payload) => timedJsonRequest('api/pos/log_drawer_pop', 'POST', payload);
