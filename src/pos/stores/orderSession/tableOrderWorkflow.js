import { printHeldCustomerReceipt } from '@/utils/heldReceiptPrint.js';
import { computed, ref, toRaw } from 'vue';
import permissionPolicy from '@posapp/permission-policy';
import { t } from '@/shared/i18n.js';
import { isUnansweredRequest } from '@/shared/http.js';
import { roundMoney, serviceChargeFee } from '@/utils/posTotals.js';
import {
  buildSplitPreview,
  buildSplitRequest,
  moveSplitItem as moveSplitLine,
  splitItemFractionally as splitUnassignedItem,
  validateSplitMoneyCents,
} from './splitChecks.js';
import {
  clearCartStorage,
  clearTablePrefill,
  matchesTableOrderContext,
  POS_ORDER_KEYS,
  writeActiveTable,
  writeServiceChargeSnapshot,
  getHeldOperationId,
  clearHeldOperationId,
  createHeldOperationId,
} from './orderSessionPersistence.js';
import { tableRowEndsSession } from '@/pos/tableWorkspacePolicy.js';
import { createTableSessionBoundary, normalizeActiveTable } from './tableSession.js';

const UNCONFIRMED_TABLE_SAVE = 'Could not confirm the table save. Reopen the table to review it before saving again.';

export function createTableOrderWorkflow({
  api,
  ui,
  readOrderDraft,
  readPersistedOrderSnapshot,
  restorePersistedDraftSnapshot,
  reconcileDraftOrderType,
  clearOrderDraft,
  captureOrderSession,
  isCheckoutInFlight = () => false,
  isCurrentOrderSession,
  refreshServiceCharge,
  getActor,
  shouldAutoApplyServiceCharge,
  onHeldMutationConflict,
  reclaimHeldOrder,
  can,
}) {
  const {
    cart,
    calculationCart = cart,
    getItemTotalGross,
    selectedCartIndex,
    orderNote,
    orderDiscount,
    editingInvoiceId,
    editingOrderId,
    originalSavedItems,
    selectedOrderType,
    customerPhone,
    customerName,
    customerAddress,
    orderDate,
    hashNumber,
    serviceChargeSnapshot,
    activeOrderTaxInclusive,
    activeOrderReceiptTaxInclusive,
    receiptTaxInclusiveDisplay,
    activeOrderTaxRegistrationType,
    isTaxExempt = ref(false),
    autoServiceChargeRemoved,
    taxInclusivePricing,
    cartSubtotal,
    cartTax,
    cartTotal,
    totals,
  } = readOrderDraft();
  let serviceChargeSnapshotRequest = null;
  let tableSaveRequestSeq = 0;
  // Table-session state refs
  const activeTable = ref(null);
  const activeQrDraft = ref(null);
  
  // NOTE: never tear down a table session by hand (`activeTable.value = null` +
  // removeItem('pos_active_table')). Always go through leaveTableSession() /
  // clearActiveTableSession() so the session token is bumped (drops in-flight
  // table loads) and the QR draft is cleared — otherwise stale data bleeds in.
  // Table-session boundary primitives. A monotonic token identifies the current
  // table session; every table-scoped async callback captures it and refuses to
  // write if a newer session (enter/leave/switch) has since bumped it. The same
  // boundaries clear table-scoped residue (the QR customer draft) so it can't
  // bleed into the next session. Internal — never exposed to components.
  const tableBoundary = createTableSessionBoundary({ activeTable, activeQrDraft, storage: localStorage });
  const tableSessionSeq = tableBoundary.tableSessionSeq;
  const captureTableSession = tableBoundary.capture;
  const isCurrentTableSession = tableBoundary.isCurrent;
  const clearTableScopedResidue = tableBoundary.clearTableScopedResidue;
  const invalidateTableSession = tableBoundary.invalidate;
  const leaveTableSession = () => {
    tableBoundary.leave();
    serviceChargeSnapshotRequest = null;
  };
  const restoredHeldReference = ref('');
  const restoredHeldOrder = ref(null);
  const pendingHoldRequestId = ref(null);

  // Reference/config refs
  const tableSettings = ref({ tables_enabled: false, table_mode: 'fixed' });
  const tableSections = ref([]);
  const restaurantTables = ref([]);
  const tableWorkspaceLoaded = ref(false);
  // Set when the latest floor read failed, so heartbeat recovery can retry it.
  const tableWorkspaceLoadFailed = ref(false);
  const isTableWorkspaceLoading = ref(false);
  let tableWorkspaceRequest = null;
  let queuedTableWorkspaceRequest = null;
  let queuedTableWorkspaceOptions = null;
  const tableSplitsList = ref([]);
  const pendingTableAction = ref(null);
  let tableActionRequest = null;
  let tableSplitsRequest = null;
  let queuedTableSplitsRequest = null;
  let tableSplitsScope = null;
  let tableSplitsRequestScope = null;
  // In-memory only: a restored or changed draft must be saved/reopened first.
  const tableDraftContent = () => JSON.stringify([cart?.value, orderNote?.value, orderDiscount?.value,
    selectedOrderType?.value, customerPhone?.value, customerName?.value, customerAddress?.value,
    orderDate?.value, hashNumber?.value, serviceChargeSnapshot?.value, autoServiceChargeRemoved?.value,
    activeOrderTaxInclusive?.value, activeOrderReceiptTaxInclusive?.value, activeOrderTaxRegistrationType?.value, isTaxExempt.value]);
  let savedTableDraft = null;
  let protectedTransferDraft = null;
  const isAffectedDraft = payload => activeTable.value?.current_order_id && payload.expected_tables.some(row =>
    Number(row.current_order_id) === Number(activeTable.value.current_order_id));
  const assertSavedTransferDraft = payload => {
    if (isAffectedDraft(payload) && (!savedTableDraft || savedTableDraft !== tableDraftContent())) {
      throw new Error(t('Save or reopen the table before moving items. Your unsaved changes are still in the cart.'));
    }
  };
  const heldOrders = ref([]);
  
  // Table getters
  const tablesEnabled = computed(() => {
    return tableSettings.value.tables_enabled === true || tableSettings.value.tables_enabled === '1';
  });
  
  const tableMode = computed(() => {
    return tableSettings.value.table_mode || 'fixed';
  });
  
  const isDynamicTableMode = computed(() => {
    return tableMode.value === 'dynamic';
  });
  
  const isFixedTableMode = computed(() => {
    return !isDynamicTableMode.value;
  });
  
  const isInsideTableOrder = computed(() => {
    return !!activeTable.value;
  });
  
  const selectedTable = computed(() => {
      return restaurantTables.value.find(table => String(table.id) === String(ui.selectedTableId)) || null;
  });
  
  
  const canHoldOrder = computed(() => {
    if (!getActor().user) return false;
    return can('pos.hold_orders');
  });
  
  const canUpdateTable = computed(() => {
    const user = getActor().user;
    if (!user || !can('tables.access')) return false;
    return permissionPolicy.evaluateAction(user, activeTable.value?.current_order_id ? 'table.edit' : 'table.create').allowed;
  });
  
  const canTransferTable = computed(() => {
    return permissionPolicy.evaluateAction(getActor().user, 'table.transfer').allowed;
  });
  
  const canJoinTables = computed(() => {
    return permissionPolicy.evaluateAction(getActor().user, 'table.join').allowed;
  });
  
  const canSplitBillPermission = computed(() => {
    if (!getActor().user) return false;
    return can('pos.split_checks');
  });
  
  const canSplitActiveTable = computed(() => {
    const user = getActor().user;
    const table = activeTable.value;
    if (!user || !table?.current_order_id) return false;
  
    const isAdmin = user.role === 'admin' || user.role === 'programmer';
    if (table.status === 'printed') return isAdmin;
    if (table.status !== 'occupied') return false;
    if (isAdmin) return true;
    if (!can('pos.split_checks')) return false;
  
    const isOwner = table.waiter_id == null || String(table.waiter_id) === String(user.id);
    return isOwner || can('waiter.override_tables');
  });

  const autoApplyServiceCharge = computed(() => {
    return shouldAutoApplyServiceCharge();
  });

  const serviceChargeSnapshotPayload = () => serviceChargeSnapshot.value ? {
    id: serviceChargeSnapshot.value.id,
    version: serviceChargeSnapshot.value.version,
    ...(serviceChargeSnapshot.value.claimToken ? { claim_token: serviceChargeSnapshot.value.claimToken } : {})
  } : null;

  
  
  const handleServiceChargeSnapshotConflict = async (status, body) => {
    if (status !== 409) return false;
    if (body?.code === 'SERVICE_CHARGE_SNAPSHOT_EXPIRED') {
      cart.value = cart.value.filter(item => item.note !== 'Auto-Gratuity');
      serviceChargeSnapshot.value = null;
      writeServiceChargeSnapshot(localStorage, null);
      window.showPosToast?.(t('Service charge expired. Add it again before checkout.'), 'warning');
      return true;
    }
    if (body?.code === 'SERVICE_CHARGE_SNAPSHOT_CONFLICT' && activeTable.value?.id) {
      await loadActiveTableOrder({ ...activeTable.value }, { clearEmpty: false });
      return true;
    }
    return false;
  };
  
  
  const loadTableOrder = (table, items, invoiceId = null, orderId = null, opts = {}) => {
    if (!table) return;
  
    // Reset ALL order-scoped residue first; a table inherits nothing from the
    // previous order. Its own discount/note come from opts/the GET response.
    clearOrderDraft();
  
    activeOrderTaxInclusive.value = table.tax_inclusive_at_sale !== undefined && table.tax_inclusive_at_sale !== null
      ? (Number(table.tax_inclusive_at_sale) === 1)
      : (opts.taxInclusiveAtSale !== undefined && opts.taxInclusiveAtSale !== null
         ? (Number(opts.taxInclusiveAtSale) === 1)
         : null);
    if (activeOrderReceiptTaxInclusive) activeOrderReceiptTaxInclusive.value = table.receipt_tax_inclusive_at_sale !== undefined && table.receipt_tax_inclusive_at_sale !== null
      ? (Number(table.receipt_tax_inclusive_at_sale) === 1)
      : (opts.receiptTaxInclusiveAtSale !== undefined && opts.receiptTaxInclusiveAtSale !== null
        ? (Number(opts.receiptTaxInclusiveAtSale) === 1)
        : (activeOrderTaxInclusive.value !== null ? activeOrderTaxInclusive.value : null));
    activeOrderTaxRegistrationType.value = table.tax_registration_type_at_sale
      || opts.taxRegistrationTypeAtSale
      || null;
  
    const isDynamic = isDynamicTableMode.value;
    const normalizedTable = normalizeActiveTable(table, { isDynamic });
  
    activeTable.value = normalizedTable;
  
    cart.value = (items || []).map(item => ({
      ...item,
      price: item.price !== undefined ? parseFloat(item.price) : 0,
      qty: item.qty !== undefined ? parseFloat(item.qty) : 1,
      originalQty: item.originalQty !== undefined ? parseFloat(item.originalQty) : (item.qty !== undefined ? parseFloat(item.qty) : 1),
      discountValue: item.discountValue !== undefined ? parseFloat(item.discountValue) : 0,
      tax_rate: item.tax_rate !== undefined ? parseFloat(item.tax_rate) : 0,
      jofotara_tax_category: item.jofotara_tax_category || 'O',
      modifier_surcharge: item.modifier_surcharge != null ? parseFloat(item.modifier_surcharge) : null,
      modifier_tax_amount: item.modifier_tax_amount != null ? parseFloat(item.modifier_tax_amount) : null
    }));
    const explicitTaxExempt = table.tax_exempt_at_sale ?? opts.taxExemptAtSale;
    isTaxExempt.value = cart.value.length > 0
      && (explicitTaxExempt === true || explicitTaxExempt === 1 || explicitTaxExempt === '1');
  
    originalSavedItems.value = JSON.parse(JSON.stringify(cart.value));
    editingInvoiceId.value = invoiceId || table.current_order_id || null;
    editingOrderId.value = orderId || table.order_id || null;
    restoredHeldReference.value = '';
    serviceChargeSnapshot.value = opts.serviceChargeSnapshot || null;
  
    if (opts.orderDiscount && opts.orderDiscount.type) {
      orderDiscount.value = { type: opts.orderDiscount.type, value: Number(opts.orderDiscount.value) || 0 };
    }
    if (opts.orderNote) orderNote.value = opts.orderNote;

    const persistedContext = opts.persistedOrderSnapshot?.context;
    if (matchesTableOrderContext(persistedContext, normalizedTable)) {
      if (opts.persistedOrderSnapshot.note) orderNote.value = opts.persistedOrderSnapshot.note;
      selectedOrderType.value = persistedContext.selectedOrderType ?? '';
      hashNumber.value = persistedContext.hashNumber || '';
      customerPhone.value = persistedContext.customerPhone || '';
      customerName.value = persistedContext.customerName || '';
      customerAddress.value = persistedContext.customerAddress || '';
      orderDate.value = persistedContext.orderDate || '';
    }

    if (table.order_type_id != null) { selectedOrderType.value = table.order_type_id; hashNumber.value = table.hash_number || hashNumber.value; }
    reconcileDraftOrderType?.({ canInvalidate: true });
    savedTableDraft = tableDraftContent();
  
      ui.resetTransient();
  };
  
  const closeTable = (opts = {}) => {
    leaveTableSession();
    clearOrderDraft();
  
    clearCartStorage(localStorage);
  
      ui.resetTransient();
  
    if (opts.router) {
      opts.router.push(opts.destination || '/tables');
    } else if (typeof window !== 'undefined' && window.location) {
      window.location.href = opts.destination || '/tables';
    }
  };
  
  
  const createServiceChargeSnapshot = async ({
    autoTable = false,
    owner = captureTableSession()
  } = {}) => {
    if (!serviceChargeSnapshot.value) {
      const ownsPendingRequest = serviceChargeSnapshotRequest
        && serviceChargeSnapshotRequest.seq === owner.seq
        && String(serviceChargeSnapshotRequest.tableId ?? '') === String(owner.tableId ?? '');
      if (!ownsPendingRequest) {
        const body = autoTable
          ? { auto_table: true, table_id: owner.tableId }
          : {};
        let promise;
        promise = api.createServiceChargeSnapshot(body).then(({ response, data }) => {
          if (!response.ok || !data.success || !data.snapshot) {
            throw new Error(data.message || 'Failed to create service-charge snapshot.');
          }
          if (isCurrentTableSession(owner)) {
            serviceChargeSnapshot.value = data.snapshot;
          }
          return data.snapshot;
        }).finally(() => {
          if (serviceChargeSnapshotRequest?.promise === promise) {
            serviceChargeSnapshotRequest = null;
          }
        });
        serviceChargeSnapshotRequest = { ...owner, promise };
      }
      const snapshot = await serviceChargeSnapshotRequest.promise;
      return isCurrentTableSession(owner) ? (serviceChargeSnapshot.value || snapshot) : null;
    }
    return serviceChargeSnapshot.value;
  };
  
  const appendServiceCharge = (snapshot = serviceChargeSnapshot.value) => {
    if (!snapshot || cart.value.some(item => item.note === 'Auto-Gratuity')) {
      refreshServiceCharge();
      return;
    }
    const fee = serviceChargeFee(calculationCart.value, snapshot.percentage, { taxInclusive: taxInclusivePricing.value, taxExempt: isTaxExempt.value });
    if (fee <= 0) return;
    cart.value.push({
      id: `FEE_${Date.now()}`,
      product_id: null,
      name: `${snapshot.percentage}% Service Charge`,
      price: fee,
      tax_rate: snapshot.taxRate,
      jofotara_tax_category: snapshot.taxCategory || 'O',
      cartId: Date.now() + Math.random().toString(36).slice(2, 11),
      qty: 1,
      note: 'Auto-Gratuity',
      discountType: null,
      discountValue: 0
    });
  };
  
  const ensureAutoTableServiceCharge = async (owner = captureTableSession()) => {
    const table = activeTable.value;
    if (!isCurrentTableSession(owner) || !owner.tableId || table?.current_order_id || !autoApplyServiceCharge.value
      || autoServiceChargeRemoved.value
      || !cart.value.some(item => item.note !== 'Auto-Gratuity')) {
      return false;
    }
    if (cart.value.some(item => item.note === 'Auto-Gratuity')) {
      refreshServiceCharge();
      return true;
    }
    try {
      const snapshot = await createServiceChargeSnapshot({ autoTable: true, owner });
      if (!snapshot || !isCurrentTableSession(owner) || activeTable.value?.current_order_id
        || autoServiceChargeRemoved.value || !autoApplyServiceCharge.value) {
        return false;
      }
      appendServiceCharge(snapshot);
      return true;
    } catch (error) {
      if (!isCurrentTableSession(owner)) return false;
      // An unanswered snapshot request stops the save: saving on would drop the charge.
      if (isUnansweredRequest(error)) throw error;
      window.showPosToast?.(error.message || t('Failed to add service charge.'), 'error');
      return false;
    }
  };
  
  
  // Table workflow actions
  
  const persistActiveTable = () => {
    writeActiveTable(localStorage, activeTable.value);
  };
  
  const clearActiveTableSession = (options = {}) => {
    leaveTableSession();
      ui.tableActionError = '';
    ui.tableSaveError = '';
    if (options.clearCart) clearOrderDraft({ startNew: true });
  };
  
  const dropDeadActiveTableSession = () => {
    clearActiveTableSession({ clearCart: true });
  };
  
  // Single guarded loader for the QR customer draft. Captures the table-session
  // token before fetching and writes activeQrDraft only if still current, so a
  // late response after the operator switched/left the table cannot paint stale
  // draft data. Used by loadActiveTableOrder, the socket draft event, and POS
  // activation — one implementation, one guard.
  // Hash of each loaded draft array, so a dismiss names exactly the draft it imported.
  const qrDraftHashes = new WeakMap();
  // Imported draft whose conditional DELETE is not confirmed yet: { seq, tableId, hash }.
  // Before a save it belongs to this visit (leaving without saving discards the lines,
  // so the draft is offered again). Once saved ({ saved, orderId }) it belongs to the
  // table's order until confirmed, so no later visit re-offers lines already saved.
  let importedQrDraft = null;
  const ownsImportedQrDraft = (pending, tableId, seq) => Boolean(pending) && (pending.saved
    ? String(pending.tableId) === String(tableId) && String(pending.orderId) === String(activeTable.value?.current_order_id)
    : pending.seq === seq);
  let importedQrDraftDismiss = null;

  const loadActiveTableDraft = async (tableId) => {
    if (!tableId) return;
    const mySeq = tableSessionSeq.value;
    try {
      const { data } = await api.getTableDraft(tableId);
      if (mySeq !== tableSessionSeq.value) return; // session changed mid-flight
      const cart = (data.success && data.cart && data.cart.length > 0) ? data.cart : null;
      // A saved import whose table now holds a different order is moot.
      if (importedQrDraft?.saved && String(importedQrDraft.tableId) === String(tableId)
        && !ownsImportedQrDraft(importedQrDraft, tableId, mySeq)) importedQrDraft = null;
      const pending = ownsImportedQrDraft(importedQrDraft, tableId, mySeq) ? importedQrDraft : null;
      if (cart && data.draft_hash) qrDraftHashes.set(cart, data.draft_hash);
      // The draft this session already imported is never offered again.
      activeQrDraft.value = (cart && pending && data.draft_hash === pending.hash) ? null : cart;
      if (pending) void dismissImportedQrDraft();
    } catch (err) {
      console.error('Failed to load QR table draft:', err);
    }
  };

  // Deletes the imported draft only if the server still holds that exact draft.
  // Resolves 'ok' | 'changed' | 'failed'; 'failed' keeps it pending for the next
  // heartbeat/reconnect/load retry.
  const dismissImportedQrDraft = () => {
    const pending = importedQrDraft;
    if (!pending || (!pending.saved && pending.seq !== tableSessionSeq.value)) {
      importedQrDraft = null;
      return Promise.resolve('ok');
    }
    if (importedQrDraftDismiss) {
      // One DELETE at a time; a newer import waits for the older one, then runs.
      return importedQrDraftDismiss.pending === pending
        ? importedQrDraftDismiss
        : importedQrDraftDismiss.then(() => dismissImportedQrDraft());
    }
    const request = (async () => {
      try {
        const { response, data } = await api.dismissTableDraft(pending.tableId, pending.hash);
        if (importedQrDraft !== pending) return 'ok';
        if (data?.success) {
          importedQrDraft = null;
          return 'ok';
        }
        if (response?.status === 409 && data?.code === 'DRAFT_CHANGED') {
          importedQrDraft = null;
          window.showPosAlert?.(t('The customer changed the QR order after it was imported. The imported items are already in the cart; review the QR order before importing it again.'));
          if (String(activeTable.value?.id) === String(pending.tableId)) void loadActiveTableDraft(pending.tableId);
          return 'changed';
        }
        return 'failed';
      } catch (err) {
        console.error('Error dismissing imported table draft:', err);
        return 'failed';
      }
    })();
    request.pending = pending;
    importedQrDraftDismiss = request;
    request.finally(() => { if (importedQrDraftDismiss === request) importedQrDraftDismiss = null; });
    return request;
  };

  // Guarded QR draft dismissal — mirrors loadActiveTableDraft. Captures the table-session
  // token before the DELETE and skips the activeQrDraft null-out if the session changed
  // mid-flight, so a late-resolving dismiss from a table the operator already left cannot
  // null a newer session's freshly-loaded draft banner.
  // { imported: draft } clears the banner now and deletes only that draft (retried until
  // confirmed); { retryImported: true } retries a pending one and sends nothing otherwise.
  const dismissActiveQrDraft = async (tableId, options = {}) => {
    if (options.retryImported) return importedQrDraft ? dismissImportedQrDraft() : null;
    if (!tableId) return null;
    if (options.imported) {
      const hash = qrDraftHashes.get(toRaw(options.imported));
      if (activeQrDraft.value === options.imported) activeQrDraft.value = null;
      if (!hash) return 'failed';
      importedQrDraft = { seq: tableSessionSeq.value, tableId, hash };
      return dismissImportedQrDraft();
    }
    const mySeq = tableSessionSeq.value;
    try {
      const { data } = await api.dismissTableDraft(tableId);
      if (mySeq !== tableSessionSeq.value) return null; // session changed mid-flight
      if (data.success) {
        activeQrDraft.value = null;
      } else {
        console.error('Failed to dismiss table draft:', data.message);
      }
    } catch (err) {
      console.error('Error dismissing table draft:', err);
    }
    return null;
  };
  
  const loadActiveTableOrder = async (table, options = {}) => {
      ui.tableActionError = '';
    // A save notice belongs to its table; opening another table drops it.
    if (String(table?.id) !== String(activeTable.value?.id)) ui.tableSaveError = '';
    if (!table) return;
  
    // Entering a table is a fresh context.
    // clearOrderSlice is called inside loadTableOrder — no manual reset needed here.
  
    let targetTable = table;
    if (table.parent_table_id) {
      const parent = restaurantTables.value.find(t => t.id === table.parent_table_id);
      if (parent) {
        targetTable = parent;
      }
    }
  
    const normalized = normalizeActiveTable(targetTable, { isDynamic: isDynamicTableMode.value });
    normalized.original_table_number = table.table_number !== targetTable.table_number
      ? table.table_number
      : normalized.original_table_number;

    // Save already acknowledged this bill/version. Keep that recoverable draft
    // while refreshing row metadata, including if navigation aborts the read.
    const preserveDraft = options.preserveDraft === true && normalized.current_order_id
      && String(normalized.current_order_id) === String(activeTable.value?.current_order_id);
    const draftFingerprint = () => JSON.stringify([
      activeTable.value?.id, activeTable.value?.current_order_id, activeTable.value?.version,
      cart.value, orderNote.value, orderDiscount.value, selectedOrderType.value,
      customerPhone.value, customerName.value, customerAddress.value, orderDate.value,
      hashNumber.value, serviceChargeSnapshot.value, autoServiceChargeRemoved.value,
      activeOrderTaxInclusive.value, activeOrderReceiptTaxInclusive?.value,
      activeOrderTaxRegistrationType.value, isTaxExempt.value
    ]);
    const savedDraft = preserveDraft ? draftFingerprint() : null;
    // A table save never changes the QR draft, so its refresh keeps the banner
    // instead of re-reading it.
    const keptQrDraft = options.keepQrDraft === true && normalized.id
      && String(normalized.id) === String(activeTable.value?.id) ? activeQrDraft.value : undefined;
  
    // New table session: invalidate any in-flight load from the table we are
    // leaving (also clears the previous QR draft), then claim this session's token.
    invalidateTableSession();
    if (keptQrDraft !== undefined) activeQrDraft.value = keptQrDraft;
    const mySeq = tableSessionSeq.value;
    const persistedOrderSnapshot = readPersistedOrderSnapshot?.();
    if (!preserveDraft) clearOrderDraft();
  
    activeTable.value = normalized;
    if (normalized.id) ui.selectedTableId = String(normalized.id);
    persistActiveTable();
  
    // QR draft, read alongside the order (guarded inside against a session switch;
    // it never throws).
    const draftRead = normalized.id && keptQrDraft === undefined
      ? loadActiveTableDraft(normalized.id) : null;
  
    if (normalized.current_order_id) {
      try {
        const [{ data }] = await Promise.all([api.getTableOrder(normalized.current_order_id), draftRead]);
        if (mySeq !== tableSessionSeq.value) return; // a newer table took over — drop stale paint
        if (!data.success) throw Object.assign(new Error(data.message || 'Failed to load table order.'), { code: data.code });
        // New edits are based on the acknowledged version, not any later server
        // revision returned by this background read. Preserve both on divergence.
        if (preserveDraft && savedDraft !== draftFingerprint()) return;
  
        const mappedItems = (data.cart || []).map(item => ({
          ...item,
          price: parseFloat(item.price),
          qty: parseFloat(item.qty),
          originalQty: parseFloat(item.originalQty !== undefined ? item.originalQty : item.qty),
          discountValue: parseFloat(item.discountValue || 0),
          tax_rate: parseFloat(item.tax_rate || 0),
          jofotara_tax_category: item.jofotara_tax_category || 'O'
        }));
  
        const discType = data.order_discount_type || data.discount_type || null;
        const discVal  = data.order_discount_value ?? data.discount_value ?? 0;
        const loadedTable = {
          ...normalized,
          version: data.version ?? null,
          order_type_id: data.order_type_id ?? normalized.order_type_id ?? null,
          hash_number: data.hash_number ?? normalized.hash_number ?? null,
          order_id: data.order_id ?? normalized.order_id ?? null,
          invoice_number: data.invoice_number ?? normalized.invoice_number ?? null,
          invoice_display_no: data.invoice_display_no ?? normalized.invoice_display_no ?? null,
          order_display_no: data.order_display_no ?? null,
          ticket_display_no: data.ticket_display_no ?? null,
          table_display_no: data.table_display_no ?? normalized.table_display_no ?? null,
          waiter_id: data.waiter_id ?? normalized.waiter_id ?? null,
          order_taken_at: data.order_taken_at ?? data.created_at ?? normalized.order_taken_at ?? null,
          active_order_created_at: data.order_taken_at ?? data.created_at ?? normalized.active_order_created_at ?? null
        };
        loadTableOrder(loadedTable, mappedItems, data.invoice_id, data.order_id, {
          ...(discType ? { orderDiscount: { type: discType, value: Number(discVal) || 0 } } : {}),
          serviceChargeSnapshot: data.service_charge_snapshot || null,
          taxInclusiveAtSale: data.tax_inclusive_at_sale,
          receiptTaxInclusiveAtSale: data.receipt_tax_inclusive_at_sale,
          taxExemptAtSale: data.tax_exempt_at_sale,
          taxRegistrationTypeAtSale: data.tax_registration_type_at_sale,
          persistedOrderSnapshot,
        });
        activeTable.value.status = normalized.status;
        persistActiveTable();
      } catch (e) {
        if (mySeq !== tableSessionSeq.value) return; // stale failure from a superseded load
        const message = e.message || 'Failed to load table order.';
        if (!preserveDraft) clearActiveTableSession({ clearCart: true });
        ui.tableActionError = message;
        throw Object.assign(new Error(message), { code: e.code });
      }
    } else {
      await draftRead;
      if (mySeq !== tableSessionSeq.value) return; // superseded — do not wipe the new session's cart
      const restoredLocalDraft = matchesTableOrderContext(
        persistedOrderSnapshot?.context,
        normalized
      ) && restorePersistedDraftSnapshot?.(persistedOrderSnapshot);

      if (!restoredLocalDraft && options.clearEmpty !== false) {
        clearOrderDraft({ startNew: true });
      } else if (restoredLocalDraft) {
        ui.resetTransient();
        persistActiveTable();
      }
    }
  };
  
  const activateTableFromStorage = async (storageKey) => {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return false;
  
    try {
      const parsed = JSON.parse(stored);
      if (parsed && parsed.is_split) {
        const splitMoney = Object.prototype.hasOwnProperty.call(parsed, 'split_money_cents')
          ? validateSplitMoneyCents(parsed.split_money_cents)
          : null;
        invalidateTableSession();
        activeTable.value = normalizeActiveTable(parsed, { isDynamic: isDynamicTableMode.value });
        activeTable.value.split_money_cents = splitMoney;
        activeOrderTaxInclusive.value = parsed.tax_inclusive_at_sale != null
          ? Number(parsed.tax_inclusive_at_sale) === 1 : null;
        if (activeOrderReceiptTaxInclusive) activeOrderReceiptTaxInclusive.value = parsed.receipt_tax_inclusive_at_sale != null
          ? Number(parsed.receipt_tax_inclusive_at_sale) === 1 : activeOrderTaxInclusive.value;
        activeOrderTaxRegistrationType.value = parsed.tax_registration_type_at_sale || activeOrderTaxRegistrationType.value;
        persistActiveTable();
        return true;
      }
      let matchedTable = null;
  
      if (parsed.table_id) {
        matchedTable = restaurantTables.value.find(t => String(t.id) === String(parsed.table_id));
      } else if (parsed.id) {
        matchedTable = restaurantTables.value.find(t => String(t.id) === String(parsed.id));
      } else if (parsed.table_number) {
        matchedTable = restaurantTables.value.find(t => String(t.table_number) === String(parsed.table_number));
      }
  
      if (matchedTable) {
        await loadActiveTableOrder(matchedTable);
        return true;
      } else if (parsed.current_order_id || parsed.table_id || parsed.id) {
        await loadActiveTableOrder({
          id: parsed.table_id || parsed.id || null,
          table_number: parsed.table_number,
          section_name: parsed.section_name || '',
          status: parsed.status || 'occupied',
          current_order_id: parsed.current_order_id || null
        });
        return true;
      } else if (isDynamicTableMode.value && parsed.table_number) {
        await loadActiveTableOrder({
          id: parsed.table_id || parsed.id || null,
          table_number: parsed.table_number,
          section_name: 'Dynamic',
          status: 'available',
          current_order_id: parsed.current_order_id || null
        });
        return true;
      }
    } catch (e) {
      // Ignore stale floor-plan hints.
    } finally {
      if (storageKey === POS_ORDER_KEYS.tablePrefill) clearTablePrefill(localStorage);
    }
  
    return false;
  };
  
  const loadTableWorkspace = (options = {}) => {
    const { user } = getActor();
    if (!user) return Promise.resolve();
    if (tableWorkspaceRequest) {
      if (!options.force) return tableWorkspaceRequest;
      // A mutation/reconnect may happen after the current snapshot started.
      // Keep one follow-up read, and let every forced caller await that result.
      if (!queuedTableWorkspaceRequest) {
        queuedTableWorkspaceOptions = { ...options };
        queuedTableWorkspaceRequest = tableWorkspaceRequest.then(() => {
          const nextOptions = queuedTableWorkspaceOptions;
          queuedTableWorkspaceRequest = null;
          queuedTableWorkspaceOptions = null;
          return loadTableWorkspace(nextOptions);
        });
      } else if (!options.skipActivation) {
        queuedTableWorkspaceOptions.skipActivation = false;
      }
      return queuedTableWorkspaceRequest;
    }
    if (tableWorkspaceLoaded.value && !options.force) return Promise.resolve();
  
    ui.tableActionError = '';
    isTableWorkspaceLoading.value = true;
    const workspaceOwner = captureTableSession();
    const workspaceOrderId = activeTable.value?.current_order_id ?? null;
    tableWorkspaceRequest = Promise.resolve().then(async () => {
    try {
      const { data } = await api.getTables(user.id);
      if (!data.success) throw new Error(data.message || 'Unable to load tables.');
  
      tableSettings.value = data.settings || { tables_enabled: false, table_mode: 'fixed' };
      tableSections.value = data.sections || [];
      restaurantTables.value = data.tables || [];
      tableWorkspaceLoaded.value = true;
      tableWorkspaceLoadFailed.value = false;
  
      if (isFixedTableMode.value && restaurantTables.value.length && !selectedTable.value) {
        const available = restaurantTables.value.find(table => table.status === 'available');
        ui.selectedTableId = String((available || restaurantTables.value[0]).id);
      }
  
      if (!pendingTableAction.value && !(protectedTransferDraft && isCurrentTableSession(protectedTransferDraft))
        && activeTable.value?.id && !activeTable.value?.is_split
        && isCurrentTableSession(workspaceOwner)
        && String(activeTable.value.current_order_id ?? '') === String(workspaceOrderId ?? '')) {
        const freshActiveTable = restaurantTables.value.find(table => String(table.id) === String(activeTable.value.id));
        if (freshActiveTable) {
          if (tableRowEndsSession(workspaceOrderId, freshActiveTable)) {
            // Vacated or reassigned elsewhere: clear local active-table context so the
            // waiter router guard doesn't route into a dead session. While this till's own
            // checkout is in flight the row may be its own payment echo or a reopen: keep
            // the session so the response can finish the sale. The POS re-checks the
            // current row once the checkout settles.
            if (!isCheckoutInFlight()) dropDeadActiveTableSession();
          } else {
            activeTable.value = { ...activeTable.value, ...freshActiveTable };
            persistActiveTable();
          }
        } else {
          // The active table isn't in this user's fresh table set — it was deleted, or
          // it's outside the current operator's allowed sections (a different user on a
          // shared terminal). Drop the stale context so we never resume into another
          // user's table/cart session. (Split checks are virtual and intentionally
          // exempt — they don't appear in restaurantTables.)
          dropDeadActiveTableSession();
        }
      }
  
      if (!options.skipActivation) {
        const activatedFromPrefill = await activateTableFromStorage(POS_ORDER_KEYS.tablePrefill);
        if (!activatedFromPrefill && !activeTable.value) {
          await activateTableFromStorage(POS_ORDER_KEYS.activeTable);
        }
      }
    } catch (e) {
      ui.tableActionError = e.message || 'Unable to load tables.';
      tableWorkspaceLoadFailed.value = true;
    } finally {
      isTableWorkspaceLoading.value = false;
      tableWorkspaceRequest = null;
    }
    });
    return tableWorkspaceRequest;
  };
  
  
  const updateActiveTableOrder = async (options = {}) => {
    if (!activeTable.value || cart.value.length === 0) return false;
      // The visual disabled state is not a concurrency boundary: two rapid clicks
    // (or Update + guest-check save) can otherwise send the same snapshot version.
    if (ui.isProcessing) return false;
    // A failed save's notice stays until a save succeeds or the user dismisses it.
    if (!canUpdateTable.value) {
      ui.tableSaveError = 'You do not have permission to update table orders.';
      return false;
    }
  
    const processingRequest = ++tableSaveRequestSeq;
    ui.isProcessing = true;
    const owner = captureTableSession();
    const tableSnapshot = { ...activeTable.value };
    if (!options.skipAutoServiceChargeEnsure) {
      try {
        await ensureAutoTableServiceCharge(owner);
      } catch (_) {
        if (isCurrentTableSession(owner)) {
          ui.tableSaveError = t(UNCONFIRMED_TABLE_SAVE);
        }
        if (processingRequest === tableSaveRequestSeq) ui.isProcessing = false;
        return false;
      }
      if (!isCurrentTableSession(owner)) {
        if (processingRequest === tableSaveRequestSeq) ui.isProcessing = false;
        return false;
      }
    }
    // Cart watchers refresh this on the next Vue tick. Save is a correctness
    // boundary, so recalculate now as well: a newly added item must never send
    // the previous table charge to the server.
    refreshServiceCharge();
    const { user, shift } = getActor();
  
    const payload = {
      require_update_permission: true,
      user_id: user.id,
      shift_id: (user.role === 'admin' || user.role === 'programmer') ? null : shift?.id,
      table_id: tableSnapshot.id || null,
      table_number: tableSnapshot.table_number,
      current_order_id: tableSnapshot.current_order_id || null,
      expected_version: tableSnapshot.version ?? null,
      order_type_id: selectedOrderType.value || null,
      cart: cart.value,
      subtotal: cartSubtotal.value,
      tax: cartTax.value,
      total: cartTotal.value,
      service_charge_snapshot: serviceChargeSnapshotPayload(),
      auto_service_charge_removed: autoServiceChargeRemoved.value,
      void_reason: null,
      order_discount_type: orderDiscount.value.type || null,
      order_discount_value: orderDiscount.value.value || 0,
      tax_exempt: isTaxExempt.value
    };
  
    let continuationOwner = owner;
    let saveCommitted = false;
    try {
      const { response: res, data } = await api.saveTableOrder(payload);
      if (!isCurrentTableSession(owner)) return false;
      if (!isCurrentTableSession(owner)) return false;
      if (!data.success) {
        if (data.code === 'TABLE_ORDER_VERSION_CONFLICT') {
          window.showPosToast?.(t(data.message), 'warning');
          throw new Error(data.message);
        }
        const handled = await handleServiceChargeSnapshotConflict(res.status, data);
        if (!isCurrentTableSession(owner)) return false;
        if (handled) return false;
      }
      if (!data.success) throw new Error(data.message || 'Failed to update table order.');
      saveCommitted = true;
      serviceChargeSnapshot.value = data.service_charge_snapshot || null;
      if (data.auto_service_charge_applied) appendServiceCharge(serviceChargeSnapshot.value);
      refreshServiceCharge();
  
      originalSavedItems.value = JSON.parse(JSON.stringify(cart.value));
      savedTableDraft = tableDraftContent();
  
      const savedTable = {
        ...tableSnapshot,
        id: data.table_id || tableSnapshot.id,
        table_number: data.table_number || tableSnapshot.table_number,
        current_order_id: data.invoice_id || data.order_id,
        version: data.version ?? null,
        order_type_id: data.order_type_id ?? payload.order_type_id,
        status: 'occupied',
        waiter_id: data.waiter_id ?? tableSnapshot.waiter_id ?? user.id,
        invoice_number: data.invoice_number ?? null,
        invoice_display_no: data.invoice_display_no ?? null,
        order_display_no: data.order_display_no ?? null,
        ticket_display_no: data.ticket_display_no ?? null,
        table_display_no: data.table_display_no ?? null,
        tax_exempt_at_sale: data.tax_exempt_at_sale === true
      };
      activeTable.value = savedTable;
      ui.tableSaveError = '';
      persistActiveTable();
      // Imported QR lines are saved on this table's order now: an unconfirmed draft
      // delete belongs to that order across visits, and is retried at once.
      if (importedQrDraft?.seq === owner.seq) {
        Object.assign(importedQrDraft, { saved: true, orderId: savedTable.current_order_id });
        void dismissImportedQrDraft();
      }
      // The waiter is leaving for the floor: re-opening the table reloads it, and
      // the broadcast row patch refreshes the floor.
      if (options.leaving) return true;
      // Clear the processing lock before the best-effort reload starts a fresh table
      // session. continuationOwner is then replaced with that reload session's owner.
      // keepProcessingOnSuccess (guest-check print) intentionally holds the lock.
      if (!options.keepProcessingOnSuccess) ui.isProcessing = false;
      try {
        const reload = loadActiveTableOrder(savedTable, { preserveDraft: true, keepQrDraft: true });
        continuationOwner = captureTableSession();
        await reload;
        if (!isCurrentTableSession(continuationOwner)) return true;
        ui.tableActionError = '';
      } catch (_) {
        // The confirmed draft survives a failed metadata refresh. A different
        // active table means genuine supersession; leave that session untouched.
        if (activeTable.value && !isCurrentTableSession(continuationOwner)) return true;
        ui.tableActionError = '';
        window.showPosToast?.(t('Table saved. Reopen the table to continue.'), 'warning');
        return true;
      }
      // Best-effort resync, not awaited: the save's broadcast already patches the row.
      // Clear any error it sets so a hiccup never overrides the committed save.
      void loadTableWorkspace({ force: true, skipActivation: true }).then(() => {
        if (isCurrentTableSession(continuationOwner)) ui.tableActionError = '';
      });
      return true;
    } catch (e) {
      if (!isCurrentTableSession(continuationOwner)) return saveCommitted;
      // A lost answer may have committed. Keep the cart (a reload would drop unsaved
      // lines); expected_version rejects a blind retry, so the user reviews first.
      const unconfirmed = !saveCommitted && isUnansweredRequest(e);
      ui.tableSaveError = unconfirmed ? t(UNCONFIRMED_TABLE_SAVE) : e.message || 'Failed to update table order.';
      return false;
    } finally {
      if (processingRequest === tableSaveRequestSeq) {
        if (!(options.keepProcessingOnSuccess && !ui.tableSaveError)) {
          ui.isProcessing = false;
        }
      }
    }
  };
  
  const markActiveTablePrinted = async ({
    owner = captureTableSession(),
    tableId = activeTable.value?.id,
    invoiceId = activeTable.value?.current_order_id
  } = {}) => {
    const ownsInvoice = () => (
      isCurrentTableSession(owner)
      && !activeTable.value?.is_split
      && String(activeTable.value?.current_order_id ?? '') === String(invoiceId ?? '')
    );
    if (!tableId || !invoiceId || !ownsInvoice()) {
      return false;
    }
      try {
      const { response, data } = await api.markTablePrinted({ tableId, invoiceId });
      if (!ownsInvoice()) return false;
      if (!ownsInvoice()) return false;
      if (!response.ok || !data.success || data.status !== 'printed'
        || String(data.invoice_id ?? '') !== String(invoiceId)
        || !Array.isArray(data.table_ids)
        || !data.table_ids.some(id => String(id) === String(tableId))) {
        return false;
      }
  
      const printedIds = new Set(data.table_ids.map(String));
      activeTable.value = { ...activeTable.value, status: 'printed' };
      restaurantTables.value = restaurantTables.value.map(table => (
        printedIds.has(String(table.id)) ? { ...table, status: 'printed' } : table
      ));
      persistActiveTable();
      ui.tableActionError = '';
      return true;
    } catch (e) {
      if (!ownsInvoice()) return false;
      console.error('Failed to mark table printed:', e);
      return false;
    }
  };
  
  const holdCurrentOrder = async () => {
    if (cart.value.length === 0) return false;
    const { user, shift } = getActor();
      // Re-entrancy + cross-action guard: never hold twice concurrently (duplicate held
    // tickets) and never hold while a checkout is charging (charged-AND-held). (Task 3)
    if (ui.isHolding || ui.isProcessing || isCheckoutInFlight()) return false;
    const owner = captureOrderSession?.() ?? captureTableSession();
    const ownsDraft = () => isCurrentOrderSession ? isCurrentOrderSession(owner) : isCurrentTableSession(owner);
    ui.isHolding = true;
  
    try {
      let reference;
      const isCallCenter = user?.role === 'call_center';
      if (restoredHeldOrder.value?.id) {
        // A recalled register hold keeps the same server identity and lease.
        reference = restoredHeldReference.value;
      } else if (restoredHeldReference.value) {
        // Legacy context has only display text. It is never used as server identity.
        reference = restoredHeldReference.value;
      } else if (isCallCenter) {
        reference = '';
      } else {
        // Reference is optional. Cancel (null) aborts; an empty/blank entry is allowed —
        // the backend serializes a reference for it.
        const refName = await window.showPosPrompt("Enter a name/reference for this held order (optional):");
        if (!ownsDraft()) return false;
        if (refName === null) return false;   // finally still clears isHolding
        reference = (refName || "").trim();
      }
      const cartPayload = {
        items: cart.value,
        customer_name: customerName.value || "",
        customer_phone: customerPhone.value || "",
        customer_address: customerAddress.value || "",
        order_type_id: selectedOrderType.value || null,
        delivery_date: orderDate.value || "",
        order_note: orderNote.value || "",
        ...(!isCallCenter ? { order_discount: orderDiscount.value || { type: "percent", value: 0 } } : {}),
        hash_number: hashNumber.value || ""
      };
      cartPayload.tax_inclusive_at_hold = taxInclusivePricing.value ? 1 : 0;
      cartPayload.receipt_tax_inclusive_at_hold = activeOrderReceiptTaxInclusive?.value !== null && activeOrderReceiptTaxInclusive?.value !== undefined
        ? (activeOrderReceiptTaxInclusive.value ? 1 : 0)
        : (receiptTaxInclusiveDisplay?.value ? 1 : 0);
      const holdPayload = {
        user_id: user.id,
        reference_name: reference,
        receipt_printer_id: localStorage.getItem("pos_receipt_printer_id") || null,
        cart: cartPayload,
        subtotal: cartSubtotal.value,
        ...(!isCallCenter ? { service_charge_snapshot: serviceChargeSnapshotPayload(), shift_id:shift?.id || null } : {}),
      };
      let res;
      let data;
      if (restoredHeldOrder.value?.id) {
        // A lapsed lease is refused before the save commits: re-claim once and
        // replay the same save once with the new version and a new operation id.
        for (let attempt = 0; attempt < 2; attempt += 1) {
        const context = restoredHeldOrder.value;
        const operationId = getHeldOperationId('save', context.id, localStorage);
        ({ response: res, data } = await api.updateHeldOrder(context.id, {
          operation_id: operationId,
          claim_token: context.claimToken,
          expected_version: context.version,
          receipt_printer_id: localStorage.getItem("pos_receipt_printer_id") || null,
          cart: cartPayload,
          subtotal: cartSubtotal.value,
          reference_name: reference,
          ...(!isCallCenter ? { service_charge_snapshot: serviceChargeSnapshotPayload(), shift_id:shift?.id || null } : {}),
        }));
        if (data.success || res?.status < 500) clearHeldOperationId('save', context.id, localStorage);
        if (attempt > 0 || res?.status !== 409 || data.code !== 'HELD_CLAIM_REQUIRED' || !reclaimHeldOrder || !ownsDraft()) break;
        const reclaimError = await reclaimHeldOrder();
        if (!ownsDraft()) return false;
        if (reclaimError) return false; // reason already shown; the cart is kept
        }
      } else {
        pendingHoldRequestId.value ||= createHeldOperationId();
        ({ response: res, data } = await api.holdOrder({
          ...holdPayload,
          hold_request_id: pendingHoldRequestId.value,
        }));
      }
      if (!ownsDraft()) return data.success === true;
      if (data.success) {
        ui.isHolding = false;
        pendingHoldRequestId.value = null;
        clearOrderDraft({ applyDefault: user?.role !== 'call_center' });
        ui.clearQuickTargetAmount();
        ui.numpadInput = "";
        try { await printHeldCustomerReceipt(data.customer_receipt); }
        catch { window.showPosToast?.(t('Order saved. Customer receipt was not printed. Check the receipt printer settings.'), 'error'); }
        return true;
      } else {
        await onHeldMutationConflict?.(data, res);
        if (await handleServiceChargeSnapshotConflict(res.status, data)) return false;
        await window.showPosAlert(data.message || "Failed to hold order.");
        return false;
      }
    } catch (e) {
      if (!ownsDraft()) return false;
      console.error("Failed to hold order:", e);
      // The server may have held it; the retry reuses pendingHoldRequestId or the
      // save operation id, so it finishes the same hold instead of duplicating it.
      await window.showPosAlert(t("Could not confirm the hold. Retry to finish the same hold."));
      return false;
    } finally {
      if (ownsDraft()) ui.isHolding = false;
    }
  };
  
  const fetchHeldOrders = async () => {
      const { data } = await api.getHeldOrders();
    if (data.success) {
      heldOrders.value = data.data;
      ui.showHeldOrdersModal = true;
    }
  };

  const getHeldOrdersSummary = () => api.getHeldOrdersSummary();
  
  // --- Split Check Logic ---
  const openSplitModal = () => {
    if (cart.value.length === 0) return;
    if (!activeTable.value?.id || !activeTable.value?.current_order_id) {
      window.showPosToast?.(t("Split checks must start from an active table."), "error");
      return;
    }
    if (!canSplitActiveTable.value) {
      window.showPosToast?.(t("You cannot split this table."), "error");
      return;
    }
    ui.splitEditContext = null;
      ui.unassignedSplitItems = JSON.parse(JSON.stringify(
      cart.value.filter(item => item.note !== 'Auto-Gratuity')
    ));
    ui.splitSeats = [{ id: 2, name: "Check 2", items: [] }];
    ui.activeSplitSeat = 2;
    ui.showSplitModal = true;
  };
  
  const addSplitSeat = () => {
      const nextId = Math.max(0, ...ui.splitSeats.map(seat => Number(seat.id) || 0)) + 1;
    ui.splitSeats.push({ id: nextId, name: `Check ${nextId}`, items: [] });
  };
  
  const removeSplitSeat = (seatId) => {
      const index = ui.splitSeats.findIndex(seat => seat.id === seatId);
    if (index < 0 || ui.splitSeats.length <= 1 || ui.splitSeats[index].items.length > 0) return;
    ui.splitSeats.splice(index, 1);
    if (ui.activeSplitSeat === seatId) {
      ui.activeSplitSeat = ui.splitSeats[Math.min(index, ui.splitSeats.length - 1)]?.id || null;
    }
  };
  
  const splitItemFractionally = (index, ways) => {
      ui.unassignedSplitItems = splitUnassignedItem(
      ui.unassignedSplitItems,
      index,
      ways,
      () => Date.now() + Math.random().toString(36).substr(2, 9)
    );
  };
  
  const moveItemToSeat = (item, index, forcedSeatId = null, quantity) => {
      const targetId = forcedSeatId || ui.activeSplitSeat;
    if (!targetId) return;
    const seat = ui.splitSeats.find(s => s.id === targetId);
    if (!seat) return;
    const moved = moveSplitLine({
      fromItems: ui.unassignedSplitItems,
      toItems: seat.items,
      index,
      quantity,
      makeId: () => Date.now() + Math.random().toString(36).substr(2, 9)
    });
    ui.unassignedSplitItems = moved.fromItems;
    seat.items = moved.toItems;
  };

  const editSplitGroup = (group) => {
    const checks = Array.isArray(group?.splits) ? group.splits : [];
    if (!checks.length) return false;
    const parsed = checks.map((check) => {
      try {
        const payload = JSON.parse(check.cart_data || '{}');
        return { check, payload: Array.isArray(payload) ? { items: payload } : payload };
      } catch (_) {
        return { check, payload: null };
      }
    });
    if (parsed.some(({ payload }) => !payload || Number(payload.progressive_split_version) !== 2)) {
      window.showPosToast?.(t('This split group cannot be edited. Cancel and split it again.'), 'error');
      return false;
    }
    const remainder = parsed.find(({ payload }) => payload.split_role === 'remainder') || null;
    const destinations = parsed.filter(entry => entry !== remainder);
    const editMoneyCents = parsed.reduce((sum, { payload }) => {
      const money = payload.split_money_cents || {};
      return {
        subtotal: sum.subtotal + Number(money.subtotal || 0),
        discount: sum.discount + Number(money.discount || 0),
        tax: sum.tax + Number(money.tax || 0),
        total: sum.total + Number(money.total || 0)
      };
    }, { subtotal: 0, discount: 0, tax: 0, total: 0 });
    const percentDiscount = parsed.map(({ payload }) => payload.order_discount)
      .find(discount => discount?.type === 'percent');
    ui.unassignedSplitItems = JSON.parse(JSON.stringify(
      (remainder?.payload.items || []).filter(item => item.note !== 'Auto-Gratuity')
    ));
    ui.splitSeats = destinations.map(({ check, payload }, index) => ({
      id: index + 2,
      heldId: check.id,
      name: `Check ${index + 2}`,
      items: JSON.parse(JSON.stringify((payload.items || []).filter(item => item.note !== 'Auto-Gratuity')))
    }));
    if (!ui.splitSeats.length) ui.splitSeats = [{ id: 2, name: 'Check 2', items: [] }];
    ui.activeSplitSeat = ui.splitSeats[0].id;
    ui.splitEditContext = {
      splitId: checks[0].id,
      remainingCheckId: remainder?.check.id || null,
      table: { id: checks[0].table_id, table_number: group.tableNumber, current_order_id: checks[0].parent_invoice_id },
      parentTotals: {
        subtotal: editMoneyCents.subtotal / 100,
        discount: editMoneyCents.discount / 100,
        tax: editMoneyCents.tax / 100,
        total: editMoneyCents.total / 100
      },
      orderDiscount: percentDiscount
        ? { type: 'percent', value: Number(percentDiscount.value) || 0 }
        : editMoneyCents.discount > 0 ? { type: 'fixed', value: editMoneyCents.discount / 100 } : null,
      taxInclusive: Number(parsed[0].payload.tax_inclusive_at_sale) === 1,
      taxExempt: parsed[0].payload.tax_exempt_at_hold === true || Number(parsed[0].payload.tax_exempt_at_hold) === 1,
      expectedChecks: parsed.map(({ check, payload }) => ({ id: check.id, revision: Number(payload.split_revision || 1) }))
    };
    ui.showSplitModal = true;
    return true;
  };

  const moveAllItemToSeat = (item, index, forcedSeatId = null) => {
    const targetId = forcedSeatId || ui.activeSplitSeat;
    if (!targetId) return;
    const seat = ui.splitSeats.find(s => s.id === targetId);
    if (!seat) return;
    const moved = moveSplitLine({
      fromItems: ui.unassignedSplitItems,
      toItems: seat.items,
      index,
      moveAll: true,
      makeId: () => Date.now() + Math.random().toString(36).substr(2, 9)
    });
    ui.unassignedSplitItems = moved.fromItems;
    seat.items = moved.toItems;
  };
  
  const moveItemToUnassigned = (seatId, item, index, quantity) => {
      const seat = ui.splitSeats.find(s => s.id === seatId);
    if (!seat) return;
    const moved = moveSplitLine({
      fromItems: seat.items,
      toItems: ui.unassignedSplitItems,
      index,
      quantity,
      makeId: () => Date.now() + Math.random().toString(36).substr(2, 9)
    });
    seat.items = moved.fromItems;
    ui.unassignedSplitItems = moved.toItems;
  };
  
  const moveItemBetweenSeats = (fromId, toId, item, index) => {
      const fromSeat = ui.splitSeats.find(s => s.id === fromId);
    const toSeat = ui.splitSeats.find(s => s.id === toId);
    const moved = moveSplitLine({
      fromItems: fromSeat.items,
      toItems: toSeat.items,
      index,
      makeId: () => Date.now() + Math.random().toString(36).substr(2, 9)
    });
    fromSeat.items = moved.fromItems;
    toSeat.items = moved.toItems;
  };
  
  const splitPreview = computed(() => {
      return buildSplitPreview({
      seats: ui.splitSeats,
      unassignedItems: ui.unassignedSplitItems,
      parentTotals: ui.splitEditContext?.parentTotals || totals.value,
      orderDiscount: ui.splitEditContext?.orderDiscount || orderDiscount.value,
      serviceChargeSnapshot: serviceChargeSnapshot.value,
      serviceChargeLine: cart.value.find((item) => item.note === 'Auto-Gratuity') || null,
      taxInclusive: ui.splitEditContext?.taxInclusive ?? taxInclusivePricing.value,
      taxExempt: ui.splitEditContext?.taxExempt ?? isTaxExempt.value,
    });
  });
  
  const getSeatTotal = (seat) => {
    const bucket = splitPreview.value.byId.get(seat.id);
    if (bucket) return (bucket.totalCents / 100).toFixed(2);
    const raw = seat.items.reduce((sum, item) => sum + getItemTotalGross(item), 0);
    return roundMoney(raw).toFixed(2);
  };
  
  const getSplitItemTotal = (bucketId, index) => (
    (splitPreview.value.byId.get(bucketId)?.itemTotalCents[index] || 0) / 100
  );
  
  const confirmSplit = async (opts = {}) => {
    if (ui.isProcessing || ui.isHolding) return false;
    const owner = captureOrderSession?.() ?? captureTableSession();
    const ownsDraft = () => isCurrentOrderSession ? isCurrentOrderSession(owner) : isCurrentTableSession(owner);
    const editContext = ui.splitEditContext;
    const splitTable = editContext?.table || activeTable.value;
      if (!splitTable?.id || !splitTable?.current_order_id) {
      await window.showPosAlert(t("Split checks must start from an active table."));
      return;
    }
    if (!editContext && !canSplitActiveTable.value) {
      await window.showPosAlert(t("You cannot split this table."));
      return;
    }
    if (!ui.splitSeats.some((seat) => seat.items.length > 0) && !(editContext && ui.unassignedSplitItems.length)) {
      await window.showPosAlert(t("Move at least one item to another check."));
      return;
    }
    ui.isProcessing = true;
    const parentFee = cart.value.find(item => item.note === 'Auto-Gratuity');
    const payload = buildSplitRequest({
      table: splitTable,
      seats: ui.splitSeats,
      remainingItems: ui.unassignedSplitItems,
      remainingCheckId: editContext?.remainingCheckId || null,
      allowRemainingOnly: !!editContext,
      parentTotals: editContext?.parentTotals || totals.value,
      orderDiscount: editContext?.orderDiscount || orderDiscount.value,
      serviceChargeSnapshot: serviceChargeSnapshot.value,
      serviceChargeLine: parentFee,
      taxInclusive: editContext?.taxInclusive ?? taxInclusivePricing.value,
      taxExempt: editContext?.taxExempt ?? isTaxExempt.value,
      makeId: () => Date.now() + Math.random().toString(36).slice(2, 11)
    });
    if (!payload) {
      ui.isProcessing = false;
      return;
    }
  
    try {
      const requestPayload = editContext
        ? { splitId: editContext.splitId, expectedChecks: editContext.expectedChecks, splits: payload.splits }
        : payload;
      const { data } = editContext
        ? await api.updateTableSplits(requestPayload)
        : await api.splitTable(requestPayload);
      if (!ownsDraft()) return data.success === true;
      if (!data.success) {
        throw new Error(data.message || "Failed to split bill on the server.");
      }
  
      if (!editContext) cart.value = [];
      ui.closeSplitModal();
      if (editContext) {
        // The split board reads its own list on mount.
        if (opts.router) opts.router.push('/table-splits');
        else window.location.href = '/table-splits';
      } else if (activeTable.value) {
        closeTable({ ...opts, destination: '/table-splits' });
      } else {
        fetchHeldOrders();
      }
    } catch (e) {
      if (!ownsDraft()) return false;
      await window.showPosAlert(tableActionFailure(e) || t("Error saving split orders."));
    } finally {
      if (ownsDraft()) ui.isProcessing = false;
    }
  };
  
  const tableGroupState = (table) => [table, ...restaurantTables.value.filter(row => Number(row.parent_table_id) === Number(table.id))]
    .map(row => ({ id: Number(row.id), current_order_id: row.current_order_id == null ? null : Number(row.current_order_id),
      status: row.status, parent_table_id: row.parent_table_id == null ? null : Number(row.parent_table_id) }))
    .sort((a, b) => a.id - b.id);
  const captureTableActionSource = table => ({ ...table, expected_group: tableGroupState(table) });
  const actionStoragePrefix = () => `pos_table_action_${getActor().user?.id}:`;
  const actionStorageKey = payload => `${actionStoragePrefix()}${payload.operation_id}`;
  const restoreTableAction = () => {
    // Separate records prevent simultaneous tabs from overwriting each other's
    // recovery identity. Only the current actor's pending records are considered.
    const prefix = actionStoragePrefix();
    let raw = null;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) { raw = localStorage.getItem(key); break; }
    }
    pendingTableAction.value = raw ? JSON.parse(raw) : null;
    return pendingTableAction.value;
  };
  const uncertainTableAction = () => ({ success: false, uncertain: true,
    message: t('Transfer not confirmed. Check and retry before moving another table.') });
  const finishTableAction = async (payload, data, key) => {
    if (payload.action === 'move_items' && isAffectedDraft(payload)) {
      if (savedTableDraft && savedTableDraft === tableDraftContent()) clearActiveTableSession({ clearCart: true });
      else protectedTransferDraft = captureTableSession();
    }
    // Keep an open cart on the same bill when moving from the POS to the floor.
    // Its content revision is unchanged by relocation; floor data must not bless it.
    if (payload.action === 'transfer' && Number(activeTable.value?.current_order_id) === Number(data.source_invoice_id)
      && Number(activeTable.value?.id) === Number(payload.sourceTableId)) {
      const target = restaurantTables.value.find(row => Number(row.id) === Number(payload.targetTableId));
      activeTable.value = { ...activeTable.value, id: payload.targetTableId, table_id: payload.targetTableId,
        table_number: target?.table_number ?? activeTable.value.table_number, section_name: target?.section_name ?? '', parent_table_id: null };
      persistActiveTable();
    }
    localStorage.removeItem(key);
    restoreTableAction();
    // The backend broadcasts the changed rows; this reconcile must not hold the UI.
    // A failed read lands on tableWorkspaceLoadFailed and retries on the heartbeat.
    loadTableWorkspace({ force: true, skipActivation: true });
    ui.tableActionError = '';
    return { success: true, message: data.message || 'Tables action processed successfully.' };
  };
  const checkTableAction = async (payload, key) => {
    try {
      const { response, data } = await api.getTableAction(payload.operation_id);
      if (key !== actionStorageKey(payload)) return uncertainTableAction();
      if (response?.ok && data.committed && data.result?.operation_id === payload.operation_id) return await finishTableAction(payload, data.result, key);
      if (response?.ok && data.committed === false) return { ...uncertainTableAction(), retryable: true };
    } catch (_) { /* Retain the exact request when status is also unavailable. */ }
    return uncertainTableAction();
  };
  const sendTableAction = async (payload, key) => {
    try {
      const { response, data } = await api.transferTable(payload);
      if (key !== actionStorageKey(payload)) return uncertainTableAction();
      if (response.ok && data.success && data.operation_id === payload.operation_id) return await finishTableAction(payload, data, key);
      // A definitive rejection has no mutation. Server errors and broken response
      // bodies have unknown outcomes and always go through receipt reconciliation.
      if (response.status >= 400 && response.status < 500) {
        localStorage.removeItem(key); restoreTableAction();
        const conflict = ['TABLE_ACTION_CONFLICT', 'TABLE_ACTION_KEY_CONFLICT', 'TABLE_ORDER_VERSION_CONFLICT'].includes(data.code);
        const message = conflict ? t('The selected tables changed. Review the floor plan before trying again.') : data.message;
        ui.tableActionError = message;
        return { success: false, conflict, targetOccupied: data.code === 'TARGET_OCCUPIED', message };
      }
    } catch (_) { /* The server may have committed before the connection failed. */ }
    return checkTableAction(payload, key);
  };
  const runTableAction = work => {
    if (tableActionRequest) return tableActionRequest;
    tableActionRequest = Promise.resolve().then(work).catch(() => ({ success: false,
      message: t('Transfer recovery could not be saved on this device. Try again after restoring browser storage.')
    })).finally(() => { tableActionRequest = null; });
    return tableActionRequest;
  };
  const reconcileTableAction = () => runTableAction(async () => {
    const payload = restoreTableAction();
    return payload ? checkTableAction(payload, actionStorageKey(payload)) : { success: false, pending: false };
  });
  const retryTableAction = () => runTableAction(async () => {
    const payload = restoreTableAction();
    if (!payload) return { success: false, pending: false };
    const key = actionStorageKey(payload);
    const checked = await checkTableAction(payload, key);
    return checked.retryable ? sendTableAction(payload, key) : checked;
  });
  const transferTableOrder = async (sourceTableId, targetTableId, action) => {
    if (tableActionRequest) return uncertainTableAction();
    return runTableAction(async () => {
      ui.tableActionError = '';
      if (restoreTableAction()) return uncertainTableAction();
      const source = ui.activeModeSourceTable;
      const target = restaurantTables.value.find(row => Number(row.id) === Number(targetTableId));
      if (!source?.expected_group || Number(source.id) !== Number(sourceTableId) || !target) {
        return { success: false, conflict: true, message: t('The selected tables changed. Review the floor plan before trying again.') };
      }
      const payload = { sourceTableId, targetTableId, action, operation_id: createHeldOperationId(),
        expected_tables: [...source.expected_group, ...tableGroupState(target)].sort((a, b) => a.id - b.id) };
      const key = actionStorageKey(payload);
      // Persist before the first byte is sent. Reload/retry reuses these identities.
      localStorage.setItem(key, JSON.stringify(payload));
      pendingTableAction.value = payload;
      return sendTableAction(payload, key);
    });
  };

  const getTableItemsForTransfer = async (source, options = {}) => {
    assertSavedTransferDraft({ expected_tables: tableGroupState(source) });
    const { response, data } = await api.getTableOrder(source.current_order_id, options);
    if (response?.ok === false || !data.success) throw new Error(t(data.message || 'Failed to load table order.'));
    return data;
  };
  const previewTableItems = async (source, target, order, items, options = {}) => {
    const payload = { action: 'move_items', sourceTableId: source.id, targetTableId: target.id,
      source_version: order.version, items, expected_tables: [...source.expected_group, ...tableGroupState(target)].sort((a, b) => a.id - b.id) };
    assertSavedTransferDraft(payload);
    const { response, data } = await api.previewTableItemTransfer(payload, options);
    if (!response.ok || !data.success) throw new Error(t(data.message || 'Could not preview the transfer. Try again.'));
    return { ...data, payload: { ...payload, target_version: data.target_version } };
  };
  const moveTableItems = quote => {
    if (tableActionRequest) return Promise.resolve(uncertainTableAction());
    return runTableAction(async () => {
      if (restoreTableAction()) return uncertainTableAction();
      try { assertSavedTransferDraft(quote.payload); }
      catch (error) { return { success: false, message: error.message }; }
      const payload = { ...quote.payload, operation_id: createHeldOperationId() };
      const key = actionStorageKey(payload);
      localStorage.setItem(key, JSON.stringify(payload));
      pendingTableAction.value = payload;
      return sendTableAction(payload, key);
    });
  };
  
  // A lost answer may have committed: reconcile the floor and say so in words the user can read.
  const tableActionFailure = (e) => {
    if (!isUnansweredRequest(e)) return e?.message;
    loadTableWorkspace({ force: true, skipActivation: true });
    return t('The table action was not confirmed. Check the floor before retrying.');
  };

  const joinTables = async (parentTableId, childTableIds, managerPin = null) => {
      ui.tableActionError = '';
    try {
      const { response: res, data } = await api.joinTables({ parentTableId, childTableIds, managerPin });
      if (!res.ok) {
        if (data.code === 'PIN_REQUIRED') {
          return { success: false, pinRequired: true, message: data.message };
        }
        throw new Error(data.message || 'Failed to join tables.');
      }
      // Committed; the backend broadcasts the rows. Reconcile without holding the UI —
      // a failed read lands on tableWorkspaceLoadFailed.
      loadTableWorkspace({ force: true, skipActivation: true });
      ui.tableActionError = '';
      return { success: true, message: data.message };
    } catch (e) {
      const message = tableActionFailure(e);
      ui.tableActionError = message;
      return { success: false, message };
    }
  };
  
  const disjoinTable = async (tableIds, managerPin = null) => {
      ui.tableActionError = '';
    const ids = Array.isArray(tableIds) ? tableIds : [tableIds];
    try {
      const { response: res, data } = await api.disjoinTables({ tableIds: ids, managerPin });
      if (!res.ok) {
        if (data.code === 'PIN_REQUIRED') {
          return { success: false, pinRequired: true, message: data.message };
        }
        throw new Error(data.message || 'Failed to disjoin table.');
      }
      // Committed; the backend broadcasts the rows. Reconcile without holding the UI —
      // a failed read lands on tableWorkspaceLoadFailed.
      loadTableWorkspace({ force: true, skipActivation: true });
      ui.tableActionError = '';
      return { success: true, message: data.message };
    } catch (e) {
      const message = tableActionFailure(e);
      ui.tableActionError = message;
      return { success: false, message };
    }
  };
  
  const handleDragStart = (e, source, sourceId, item, index) => {
      ui.dragData = { source, sourceId, item, index };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", JSON.stringify({ source, sourceId, index }));
  };
  
  const handleDropOnSeat = (e, targetSeatId) => {
    e.preventDefault();
      if (!ui.dragData) return;
    const { source, sourceId, item, index } = ui.dragData;
    if (source === 'unassigned') {
      ui.activeSplitSeat = targetSeatId;
      moveItemToSeat(item, index, targetSeatId);
    } else if (source === 'seat' && sourceId !== targetSeatId) {
      moveItemBetweenSeats(sourceId, targetSeatId, item, index);
    }
    ui.dragData = null;
  };
  
  const handleDropOnMaster = (e) => {
    e.preventDefault();
      if (!ui.dragData) return;
    const { source, sourceId, item, index } = ui.dragData;
    if (source === 'seat') moveItemToUnassigned(sourceId, item, index);
    ui.dragData = null;
  };
  
  const fetchTableSplits = ({ force = true, parentInvoiceId = tableSplitsScope } = {}) => {
    const scope = parentInvoiceId == null ? null : String(parentInvoiceId);
    if (scope !== tableSplitsScope) {
      tableSplitsScope = scope;
      tableSplitsList.value = [];
      ui.tableSplitsError = '';
    }
    if (tableSplitsRequest) {
      if (!force && scope === tableSplitsRequestScope) return tableSplitsRequest;
      if (!queuedTableSplitsRequest) {
        queuedTableSplitsRequest = tableSplitsRequest.then(() => {
          queuedTableSplitsRequest = null;
          return fetchTableSplits();
        });
      }
      return queuedTableSplitsRequest;
    }
    tableSplitsRequestScope = scope;
    tableSplitsRequest = Promise.resolve().then(async () => {
    try {
      const { response, data } = await api.getTableSplits(scope);
      if (scope !== tableSplitsScope) return false;
      if (response?.ok !== false && data?.success && Array.isArray(data.data)) {
        tableSplitsList.value = data.data;
        ui.tableSplitsError = '';
        return true;
      }
    } catch (e) {
      console.error("Failed to fetch table splits:", e);
    }
    if (scope === tableSplitsScope) ui.tableSplitsError = t('Could not load split checks. Check the connection and retry.');
    return false;
    }).finally(() => { tableSplitsRequest = null; });
    return tableSplitsRequest;
  };
  
  const cancelSplitGroup = async (splitCheck, opts = {}) => {
    if (!splitCheck?.id) return false;
    if (!(await window.showPosConfirm(t('Cancel all unpaid checks for this table and return to the original order?')))) {
      return false;
    }
    try {
      const { response: res, data } = await api.cancelTableSplit(splitCheck.id);
      if (!res.ok || !data.success) throw new Error(data.message || t('Failed to cancel split checks.'));
      window.showPosToast?.(data.message, 'success');
      // The floor re-reads on activation and socket events refresh it.
      if (opts.router) opts.router.push('/tables');
      else void fetchTableSplits();
      return true;
    } catch (error) {
      await window.showPosAlert(tableActionFailure(error) || t('Failed to cancel split checks.'));
      return false;
    }
  };
  
  let splitRestoreInFlight = false;
  const restoreTableSplit = async (splitCheck, opts = {}) => {
    if (!splitCheck || splitRestoreInFlight || ui.isProcessing || ui.isHolding || isCheckoutInFlight()) return false;
    splitRestoreInFlight = true;
    let applied = false;
    const restoreCart = JSON.stringify(cart.value);
    const restoreOwner = captureOrderSession();
    ui.isProcessing = true;
    try {
      // We find the original table record if it exists to preserve table_id
      let originalTable = null;
      if (restaurantTables.value.length === 0 && !splitCheck.table_id) {
        await loadTableWorkspace({ skipActivation: true });
      }
  
      if (!isCurrentOrderSession(restoreOwner) || restoreCart !== JSON.stringify(cart.value)) return false;
      originalTable = restaurantTables.value.find(t => String(t.id) === String(splitCheck.table_id)) || null;
      // 1. Parse the table number and seat name from the reference_name
      let tableNumberDisplay = "";
      const refName = splitCheck.reference_name || "";
      const match = refName.match(/^Table\s+(.+?)\s+-\s+(.+)$/i);
      if (match) {
        tableNumberDisplay = `${match[1]} - ${match[2]}`;
      } else {
        tableNumberDisplay = refName.replace("Table ", "");
      }
  
      // 2. Load items to cart
      let items = [];
      let parentInvoiceId = null;
      let parentOrderId = null;
      let isSplit = false;
      let splitOrderDiscount = null;
      let splitMoney = null;
      let parsed = null;
  
      if (Array.isArray(splitCheck.items)) {
        items = splitCheck.items;
        parentInvoiceId = splitCheck.parent_invoice_id || null;
        parentOrderId = splitCheck.parent_order_id || null;
        splitOrderDiscount = splitCheck.order_discount || null;
        isSplit = true;
      } else {
        try {
          parsed = JSON.parse(splitCheck.cart_data || '{}');
          if (Array.isArray(parsed)) {
            items = parsed;
          } else if (parsed && typeof parsed === 'object') {
            items = parsed.items || [];
            parentInvoiceId = parsed.parent_invoice_id || null;
            parentOrderId = parsed.parent_order_id || null;
            splitOrderDiscount = parsed.order_discount || null;
            isSplit = parsed.is_split || false;
          }
        } catch (e) {
          items = [];
        }
      }
      if (parsed === null && splitCheck.cart_data) {
        try {
          parsed = JSON.parse(splitCheck.cart_data);
        } catch (_) {
          parsed = null;
        }
      }
      const allocationSource = Object.prototype.hasOwnProperty.call(splitCheck, 'split_money_cents')
        ? splitCheck
        : parsed;
      if (allocationSource && Object.prototype.hasOwnProperty.call(allocationSource, 'split_money_cents')) {
        splitMoney = validateSplitMoneyCents(allocationSource.split_money_cents);
      }
  
      // Same reset wall as a real table load: invalidate the previous session
      // (clears QR draft + token) then route the split through loadTableOrder,
      // which wipes ALL order-scoped residue (discount/note/customer/
      // editing ids) before applying the split's own table + items. Prevents the
      // previous order's metadata from riding into the restored check.
      const sourceTableId = Number(splitCheck.table_id || parsed?.table_id || originalTable?.id);
      if (!Number.isSafeInteger(sourceTableId) || sourceTableId <= 0) throw new Error(t('This check has no table identity. Reload the Split Board.'));
      invalidateTableSession();
      const splitTable = {
        id: sourceTableId,
        table_number: tableNumberDisplay,
        status: 'occupied',
        is_split: true,
        parent_invoice_id: parentInvoiceId,
        parent_order_id: parentOrderId,
        order_type_id: splitCheck.order_type_id ?? parsed?.order_type_id ?? originalTable?.order_type_id ?? null,
        split_check_id: splitCheck.id,
        split_money_cents: splitMoney,
        split_revision: Number(splitCheck.split_revision ?? parsed?.split_revision ?? 1),
        tax_exempt_at_sale: splitCheck.tax_exempt_at_hold ?? parsed?.tax_exempt_at_hold,
        tax_registration_type_at_sale: splitCheck.tax_registration_type_at_hold ?? parsed?.tax_registration_type_at_hold,
        tax_inclusive_at_sale: splitCheck.tax_inclusive_at_sale ?? (parsed ? parsed.tax_inclusive_at_sale : null),
        receipt_tax_inclusive_at_sale: splitCheck.receipt_tax_inclusive_at_hold
          ?? (parsed ? (parsed.receipt_tax_inclusive_at_hold ?? parsed.receipt_tax_inclusive_at_sale) : null)
      };
      const splitItems = items.map(item => ({
        id: item.id || item.product_id,
        name: item.name || item.product_name,
        price: parseFloat(item.price || item.price_at_sale),
        qty: parseFloat(item.qty || item.quantity),
        note: item.note || "",
        selectedModifiers: item.selectedModifiers || null,
        discountType: item.discountType || "percent",
        discountValue: parseFloat(item.discountValue || 0),
        courseId: item.courseId || null,
        modifiers: item.modifiers || [],
        tax_rate: parseFloat(item.tax_rate || 0),
        jofotara_tax_category: item.jofotara_tax_category || 'O',
        modifier_surcharge: item.modifier_surcharge != null ? parseFloat(item.modifier_surcharge) : null,
        modifier_tax_amount: item.modifier_tax_amount != null ? parseFloat(item.modifier_tax_amount) : null,
        // Carry the parent line id so split settle pins each line to its OWN frozen price
        // (two same-product/same-note lines at different prices must not collapse).
        order_item_id: item.order_item_id ?? null,
        cartId: item.cartId || 'RESTORED_' + Math.random().toString(36).substr(2, 9)
      }));
      loadTableOrder(splitTable, splitItems, null, null, splitOrderDiscount ? { orderDiscount: splitOrderDiscount } : {});
      applied = true;
      activeTable.value.split_money_cents = splitMoney;
      persistActiveTable();
  
      // Redirect to POS
      if (opts.router) {
        opts.router.push('/pos');
      } else if (typeof window !== 'undefined' && window.location) {
        window.location.href = '/pos';
      }
      return true;
    } catch (e) {
      await window.showPosAlert(e.message || "Failed to restore table split check.");
      return false;
    } finally {
      splitRestoreInFlight = false;
      if (!isCheckoutInFlight() && (applied || isCurrentOrderSession(restoreOwner))) ui.isProcessing = false;
    }
  };
  
  return {
    activeTable,
    activeQrDraft,
    tableSessionSeq,
    captureTableSession,
    isCurrentTableSession,
    clearTableScopedResidue,
    invalidateTableSession,
    leaveTableSession,
    restoredHeldReference,
    restoredHeldOrder,
    pendingHoldRequestId,
    tableSettings,
    tableSections,
    restaurantTables,
    tableWorkspaceLoaded,
    tableWorkspaceLoadFailed,
    isTableWorkspaceLoading,
    tableSplitsList,
    heldOrders,
    tablesEnabled,
    tableMode,
    isDynamicTableMode,
    isFixedTableMode,
    isInsideTableOrder,
    selectedTable,
    canHoldOrder,
    canUpdateTable,
    canTransferTable,
    canJoinTables,
    canSplitBillPermission,
    canSplitActiveTable,
    handleServiceChargeSnapshotConflict,
    createServiceChargeSnapshot,
    appendServiceCharge,
    ensureAutoTableServiceCharge,
    loadTableOrder,
    closeTable,
    persistActiveTable,
    clearActiveTableSession,
    dropDeadActiveTableSession,
    loadActiveTableDraft,
    dismissActiveQrDraft,
    loadActiveTableOrder,
    activateTableFromStorage,
    loadTableWorkspace,
    updateActiveTableOrder,
    markActiveTablePrinted,
    holdCurrentOrder,
    fetchHeldOrders,
    getHeldOrdersSummary,
    openSplitModal,
    editSplitGroup,
    addSplitSeat,
    removeSplitSeat,
    splitItemFractionally,
    moveItemToSeat,
    moveAllItemToSeat,
    moveItemToUnassigned,
    moveItemBetweenSeats,
    splitPreview,
    getSeatTotal,
    getSplitItemTotal,
    confirmSplit,
    transferTableOrder,
    getTableItemsForTransfer,
    previewTableItems,
    moveTableItems,
    captureTableActionSource,
    pendingTableAction,
    reconcileTableAction,
    retryTableAction,
    joinTables,
    disjoinTable,
    handleDragStart,
    handleDropOnSeat,
    handleDropOnMaster,
    fetchTableSplits,
    cancelSplitGroup,
    restoreTableSplit,
  };
}
