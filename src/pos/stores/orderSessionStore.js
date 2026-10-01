import { scheduledDateTimeInput } from '@/utils/businessDate.js';
// @/pos/stores/orderSessionStore.js
import { ref, computed, watch, nextTick } from 'vue';
import { defineStore } from 'pinia';
import { isUnansweredRequest } from '@/shared/http.js';
import { useAuth } from '../useAuth.js';
import { useTerminal } from '../useTerminal.js';
import { useProducts } from '../useProducts.js';
import { useOrderUiStore } from './orderUiStore.js';
import { usePermissions } from '../usePermissions.js';
import permissionPolicy from '@posapp/permission-policy';
import { t } from '@/shared/i18n.js';
import { exemptUnitPrice, lineNet, lineTax, modifierTaxAmount, orderDiscountAmount, posTotals, roundMoney, roundSix, serviceChargeFee } from '@/utils/posTotals.js';
import { buildReceiptPresentation } from '@/utils/receiptPresentation.js';
import { getDefaultOrderTypeId } from '@/utils/defaultOrderType.js';
import { clearCheckoutAttempt, resolveCheckoutAttemptKey, readPendingCheckout, savePendingCheckout, clearPendingCheckout } from './checkoutAttemptCache.js';
import { validateSplitMoneyCents } from './orderSession/splitChecks.js';
import { editableItemNote, isNoteProduct, saveEditableItemNote } from '@/pos/noteProductSelections.js';
import { buildCartQuantityIndex, buildPendingQuantityIndex } from '@/pos/cartQuantityIndex.js';
import {
  buildCheckoutFingerprintSource,
  buildCheckoutRequest,
  buildSuccessfulCheckoutResult,
  buildCallCenterCommandPolicy,
} from './orderSession/checkoutFlow.js';
import {
  clearOrderData,
  clearOrderDiscount,
  clearCartStorage,
  matchesTableOrderContext,
  readActiveTable,
  readOrderSnapshot,
  writeCart,
  writeOrderDiscount,
  writeOrderNote,
  writeTaxExempt,
  writeServiceChargeSnapshot,
  writeOrderContext,
  getHeldOperationId,
  clearHeldOperationId,
  clearHeldOrderHandoff,
  clearPosOrderSession,
  clearTablePrefill,
  createHeldClaimToken,
  readCallCenterOrderSnapshot,
} from './orderSession/orderSessionPersistence.js';
import * as orderSessionApi from './orderSession/orderSessionApi.js';
import { createTableOrderWorkflow } from './orderSession/tableOrderWorkflow.js';

const ORDER_TYPES_CACHE_KEY = "pos_backup_order_types";
const ORDER_TYPES_TTL_MS = 24 * 60 * 60 * 1000;
const JOFOTARA_PROVIDER_WINDOW_MS = 10_000;
const JOFOTARA_STATUS_CEILING_MS = 500;
const decidedFiscalReceiptKeys = new Set();

// Lazy + memoized cross-domain dependency resolution. MUST NOT be called from the
// store setup body. Only call from getter/action bodies, which run after setup completes.
let _deps = null;
const PENDING_DISCARD_MIN_AGE_MS = 5 * 60 * 1000;

function getDeps() {
  if (!_deps) {
    _deps = {
      auth: useAuth(),
      terminal: useTerminal(),
      products: useProducts(),
      permissions: usePermissions()
    };
  }
  return _deps;
}

const productCanSell = (product) => Number(product?.can_sell ?? product?.is_available ?? 1) === 1;

const canAddCatalogProduct = (product) => {
  if (!productCanSell(product)) return false;
  const catalog = getDeps().products.products?.value;
  const current = Array.isArray(catalog)
    ? catalog.find(entry => String(entry.id) === String(product?.id))
    : null;
  return !current || productCanSell(current);
};

const showPaymentSuccess = ({ receivable = false, platform = false } = {}) => {
  if (!receivable && !platform) return;
  window.showPosToast?.(
    `${t(platform ? 'Platform sale recorded' : 'Receivable Issued')} · ${t('No payment was collected.')}`,
    'success'
  );
};

const readCachedOrderTypes = (role) => {
  try {
    const raw = localStorage.getItem(ORDER_TYPES_CACHE_KEY);
    if (!raw) return [];
    const cached = JSON.parse(raw);
    if (Array.isArray(cached)) return role === 'call_center' ? [] : cached;
    if (!cached || typeof cached !== 'object') return [];
    if (cached.savedAt && Date.now() - Number(cached.savedAt) > ORDER_TYPES_TTL_MS) {
      localStorage.removeItem(ORDER_TYPES_CACHE_KEY);
      return [];
    }
    if (cached.role && cached.role !== role) return [];
    if (!cached.role && role === 'call_center') return [];
    return Array.isArray(cached.data) ? cached.data : [];
  } catch (error) {
    localStorage.removeItem(ORDER_TYPES_CACHE_KEY);
    return [];
  }
};

const makeCheckoutIdempotencyKey = () => `TXN-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
const isExplicitTaxExempt = value => value === true || value === 1 || value === '1';

const clearCachedCheckoutAttempt = () => {
  clearCheckoutAttempt();
};

// The server's customer phone rule (backend/services/customerPhone.js): any number, written with digits and the
// usual separators only (space, tab, newline, + ( ) . -), 1 to 20 digits.
const isCustomerPhone = (value) => {
  const text = String(value ?? '').trim();
  const digits = text.replace(/\D/g, '').length;
  return /^[0-9+().\- \t\r\n]+$/.test(text) && digits >= 1 && digits <= 20;
};

export const useOrderSessionStore = defineStore('orderSession', () => {
  const priceAmountOriginalQty = new WeakMap();
  // Persistent cart state refs
  const cart = ref([]);
  const selectedCartIndex = ref(null);
  const orderNote = ref("");
  const orderDiscount = ref({ type: "percent", value: 0 });
  const editingInvoiceId = ref(null);
  const editingOrderId = ref(null);
  const originalSavedItems = ref([]);
  const selectedOrderType = ref("");
  const customerPhone = ref("");
  const customerName = ref("");
  const customerAddress = ref("");
  const orderDate = ref("");
  const hashNumber = ref("");
  const serviceChargeSnapshot = ref(null);
  let checkoutRequestSeq = 0;
  let orderDraftSeq = 0;
  let checkoutDraftId = makeCheckoutIdempotencyKey();
  const autoServiceChargeRemoved = ref(false);
  let suppressNextEmptyCartPersist = false;
  // 'server' | 'local' | null: how the last held-order restore sourced its cart.
  let restoreSourcePending = null;
  const completedCheckoutKeys = new Set();
  const activeOrderTaxInclusive = ref(null);
  const activeOrderReceiptTaxInclusive = ref(null);
  const activeOrderTaxRegistrationType = ref(null);
  const isTaxExempt = ref(false);
  // Checkout-only intent. It must never survive into a hold or table session.
  const callCenterSession = ref({ started: false, mode: 'new', matches: [], searchedPhone: '', error: '', loading: false });

  // Reference/config refs
  const orderTypes = ref([]);
  let orderTypesHaveLiveAuthority = false;
  const courses = ref([
    { id: 1, name: 'Course 1' }, { id: 2, name: 'Course 2' },
    { id: 3, name: 'Course 3' }, { id: 4, name: 'Course 4' }, { id: 5, name: 'Course 5' }
  ]);

  // Service charge percentage and settings helper
  const updateServiceCharge = () => {
    const feeIdx = cart.value.findIndex(item => item.note === 'Auto-Gratuity');
    if (feeIdx === -1 || !serviceChargeSnapshot.value) return false;
    const pct = serviceChargeSnapshot.value.percentage;
    const newFee = serviceChargeFee(calculationCart.value, pct, { taxInclusive: taxInclusivePricing.value, taxExempt: isTaxExempt.value });
    if (newFee === 0) {
      cart.value.splice(feeIdx, 1);
      return true;
    }
    let mutated = false;
    const feeItem = cart.value[feeIdx];
    const newName = `${pct}% Service Charge`;
    if (Math.abs(parseFloat(feeItem.price) - newFee) > 0.001 || feeItem.name !== newName) {
      feeItem.price = newFee;
      feeItem.name = newName;
      mutated = true;
    }
    if (feeIdx !== cart.value.length - 1) {
      cart.value.splice(feeIdx, 1);
      cart.value.push(feeItem);
      mutated = true;
    }
    return mutated;
  };

  // Watchers
  watch(cart, (newVal) => {
    // Bundle sub-items (item.bundleItems) are plain arrays on each cart item, so
    // JSON.stringify captures them automatically — no special serialization needed.
    if (suppressNextEmptyCartPersist && Array.isArray(newVal) && newVal.length === 0) {
      suppressNextEmptyCartPersist = false;
      clearCartStorage(localStorage);
      return;
    }
    // Refresh the fee in this same pre-flush. A mutation re-runs this watcher,
    // whose second pass finds nothing to change and persists once: one render,
    // one localStorage write per edit.
    if (updateServiceCharge()) return;
    writeCart(localStorage, newVal);
  }, { deep: true });
  watch(orderNote, (newVal) => writeOrderNote(localStorage, newVal));
  watch(orderDiscount, (newVal) => writeOrderDiscount(localStorage, newVal), { deep: true });
  watch(serviceChargeSnapshot, (value) => writeServiceChargeSnapshot(localStorage, value), { deep: true });
  watch(isTaxExempt, (value) => writeTaxExempt(localStorage, value));

  // Money getters as computed
  const taxRegistrationType = computed(() => activeOrderTaxRegistrationType.value
    || getDeps().terminal.taxRegistrationType?.value
    || 'sales_tax');
  // One effective-tax view of a line: income-tax venues keep product tax_rate
  // on file but charge no sales tax (backend PosCalculator.resolveEffectiveTaxRate).
  // Every money reader goes through this; mutations stay on cart.value.
  const effectiveLine = (item) => taxRegistrationType.value === 'income_tax'
    ? { ...item, tax_rate: 0, modifier_tax_amount: 0 }
    : item;
  const calculationCart = computed(() => taxRegistrationType.value === 'income_tax'
    ? cart.value.map(effectiveLine)
    : cart.value);
  const cartQuantityIndex = computed(() => buildCartQuantityIndex(cart.value));
  const pendingQuantityIndex = computed(() => buildPendingQuantityIndex(cart.value));

  const rawSubtotal = computed(() => {
    // Bundle lines: sub-items in item.bundleItems have NO price; only the
    // parent item.price contributes to the subtotal (matches checkout/PosCalculator).
    return calculationCart.value.reduce((sum, item) => sum + lineNet(item, { taxInclusive: taxInclusivePricing.value, taxExempt: isTaxExempt.value }), 0);
  });

  // Accounting mode belongs to the frozen server order/table context. New
  // carts always calculate normal net-plus-tax accounting; the terminal
  // preference is intentionally not consulted here.
  const taxInclusivePricing = computed(() => activeOrderTaxInclusive.value === true);
  const receiptTaxInclusiveDisplay = computed(() => {
    const deps = getDeps();
    if (activeOrderReceiptTaxInclusive.value !== null) return activeOrderReceiptTaxInclusive.value;
    return deps.terminal.receiptTaxInclusiveDisplay?.value ?? false;
  });

  const trustedSplitMoney = computed(() => {
    if (!activeTable.value?.is_split || !activeTable.value.split_money_cents) return null;
    try {
      return validateSplitMoneyCents(activeTable.value.split_money_cents);
    } catch (_) {
      return null;
    }
  });

  const totals = computed(() => {
    const calculated = posTotals(calculationCart.value, orderDiscount.value, { taxInclusive: taxInclusivePricing.value, taxExempt: isTaxExempt.value });
    const allocation = trustedSplitMoney.value;
    if (!allocation) return calculated;
    return {
      ...calculated,
      subtotal: allocation.subtotal / 100,
      discount: allocation.discount / 100,
      discountedSubtotal: (allocation.subtotal - allocation.discount) / 100,
      tax: allocation.tax / 100,
      total: allocation.total / 100,
    };
  });

  const cartSubtotal = computed(() => totals.value.subtotal);

  const cartOrderDiscountAmount = computed(() => totals.value.discount);

  const rawDiscountedSubtotal = computed(() => {
    return Math.max(0, rawSubtotal.value - orderDiscountAmount(rawSubtotal.value, orderDiscount.value));
  });

  const discountedSubtotal = computed(() => totals.value.discountedSubtotal);

  const cartTax = computed(() => totals.value.tax);

  const cartTotal = computed(() => totals.value.total);

  const effectiveTaxInclusive = computed(() => taxInclusivePricing.value);

  const cartReceiptPresentation = computed(() => {
    try {
      return buildCartReceiptPresentation();
    } catch (error) {
      if (error?.code !== 'RECEIPT_PRESENTATION_INVALID') throw error;
      console.error('[POS] cart receipt presentation diverged from totals', error);
      return null;
    }
  });
  const buildCartReceiptPresentation = () => buildReceiptPresentation({
    items: calculationCart.value.map((item, idx) => ({
      ...item,
      price: isTaxExempt.value
        ? exemptUnitPrice(item, item.tax_rate, taxInclusivePricing.value, { alreadyExempt: item.note === 'Auto-Gratuity' })
        : !effectiveTaxInclusive.value && item.modifier_surcharge != null && item.modifier_tax_amount != null
        ? Math.max(0, Number(item.price || 0) - Number(item.modifier_tax_amount || 0))
        : item.price,
      key: String(item.key ?? item.cartId ?? `row-${idx}`)
    })),
    summary: {
      subtotal: cartSubtotal.value,
      tax: cartTax.value,
      total: cartTotal.value
    },
    orderDiscount: {
      type: orderDiscount.value?.type || null,
      value: Number(orderDiscount.value?.value || 0),
      amount: cartOrderDiscountAmount.value
    },
    // Cashier totals remain an accounting view. The separate receipt preference
    // only changes customer-facing print models after the sale is frozen.
    taxMode: effectiveTaxInclusive.value ? 'inclusive' : 'exclusive',
    status: 'original',
    taxExempt: isTaxExempt.value,
    ...(trustedSplitMoney.value ? { subtotalAllocationToleranceCents: 1 } : {})
  });

  const changeDue = computed(() => {
    const ui = useOrderUiStore();
    if (ui.paymentMethod === 'split') {
      const cashNeeded = cartTotal.value - (parseFloat(ui.splitCardAmount) || 0);
      const tendered = parseFloat(ui.splitCashTendered) || 0;
      return roundMoney(Math.max(0, tendered - cashNeeded));
    }
    if (!ui.amountTendered) return 0;
    return roundMoney(Math.max(0, ui.amountTendered - cartTotal.value));
  });

  const cashShortfall = computed(() => {
    const ui = useOrderUiStore();
    if (ui.paymentMethod !== 'cash') return 0;
    const tendered = parseFloat(ui.amountTendered) || 0;
    return roundMoney(Math.max(0, cartTotal.value - tendered));
  });

  const splitBalanceDue = computed(() => {
    const ui = useOrderUiStore();
    const card = parseFloat(ui.splitCardAmount) || 0;
    const cash = parseFloat(ui.splitCashTendered) || 0;
    return roundMoney(Math.max(0, cartTotal.value - card - cash));
  });

  const getItemTotal = (rawItem) => {
    const item = effectiveLine(rawItem);
    return lineNet(item, { taxInclusive: taxInclusivePricing.value, taxExempt: isTaxExempt.value });
  };

  // Returns the tax-inclusive (gross) line total for display in cart rows
  const getItemTotalGross = (rawItem) => {
    const item = effectiveLine(rawItem);
    const pretax = lineNet(item, { taxInclusive: taxInclusivePricing.value, taxExempt: isTaxExempt.value });
    if (taxInclusivePricing.value || isTaxExempt.value) return pretax;
    return pretax + lineTax(item);
  };

  const cartGrossSubtotal = computed(() => {
    return roundMoney(cart.value.reduce((sum, item) => {
      return sum + getItemTotalGross(item);
    }, 0));
  });

  const ui = useOrderUiStore();
  const {
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
  } = createTableOrderWorkflow({
    api: orderSessionApi,
    ui,
    readPersistedOrderSnapshot: () => readOrderSnapshot(localStorage),
    restorePersistedDraftSnapshot: snapshot => restorePersistedDraftSnapshot(snapshot),
    reconcileDraftOrderType: options => reconcileDraftOrderType(options),
    readOrderDraft: () => ({
      cart,
      calculationCart,
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
      isTaxExempt,
      autoServiceChargeRemoved,
      taxInclusivePricing,
      cartSubtotal,
      cartTax,
      cartTotal,
      totals,
    }),
    clearOrderDraft: (options = {}) => {
      if (options.startNew) return startNewOrder();
      clearOrderSlice();
      if (options.applyDefault) applyDefaultOrderTypeToNewRegisterOrder();
    },
    captureOrderSession: () => captureOrderSession(),
    isCheckoutInFlight: () => checkoutInFlight.value,
    isCurrentOrderSession: owner => isCurrentOrderSession(owner),
    refreshServiceCharge: updateServiceCharge,
    getActor: () => ({
      user: getDeps().auth.activeUser.value,
      shift: getDeps().auth.activeShift.value,
    }),
    shouldAutoApplyServiceCharge: () => autoApplyServiceCharge.value,
    reclaimHeldOrder: () => reconnectHeldOrder(),
    onHeldMutationConflict: async (data, response) => {
      if (getDeps().auth.activeUser.value?.role !== 'call_center') return;
      if (response?.status === 409 || ['HELD_VERSION_CONFLICT', 'HELD_CLAIM_EXPIRED', 'HELD_KITCHEN_FOLLOW_UP_REQUIRED'].includes(data?.code)) {
        callCenterSession.value = { ...callCenterSession.value, error: data?.message || t('The phone order changed. Refresh it before continuing.') };
        await findCallCenterOrders();
      }
    },
    can: permission => getDeps().permissions.can(permission),
  });
  const guestCheckInFlight = ref(false);
  const checkoutInFlight = ref(false);
  const pendingCheckout = ref(null);
  // Set when an unreadable record was quarantined; the banner asks to check Orders.
  const pendingCheckoutUnreadable = ref(false);
  // Last read-only status probe of the active record: { key, status, at }.
  const pendingCheckoutProbe = ref(null);
  // Latest send per idempotency key, kept in memory too: a failed storage write must
  // never make a still-running retry look old enough to discard.
  const lastSendByKey = new Map();
  const auth = useAuth();
  const activeUserId = () => auth.activeUser?.value?.id ?? null;
  const loadPendingCheckout = () => {
    const { record, quarantined } = readPendingCheckout(activeUserId());
    if (quarantined) pendingCheckoutUnreadable.value = true;
    if (pendingCheckoutProbe.value?.key !== record?.frozen.payload.idempotency_key) pendingCheckoutProbe.value = null;
    pendingCheckout.value = record;
    return record;
  };
  watch(activeUserId, loadPendingCheckout, { immediate: true });
  const captureOrderSession = () => ({
    draftSeq: orderDraftSeq,
    table: captureTableSession(),
    userId: getDeps().auth.activeUser.value?.id,
  });
  const isCurrentOrderSession = owner => owner.draftSeq === orderDraftSeq
    && isCurrentTableSession(owner.table)
    && String(owner.userId ?? '') === String(getDeps().auth.activeUser.value?.id ?? '');
  // Clears edit residue so a prior table/edit session cannot bleed
  // into the next order. Shared by holdCurrentOrder, restoreHeldOrder, and the
  // PosTerminal component restore path.
  const resetEditResidue = () => {
    editingInvoiceId.value = null;
    editingOrderId.value = null;
    originalSavedItems.value = [];
  };

  // private: persistent-field reset only (no storage/nav/history/UI side effects)
  const clearOrderSlice = () => {
    clearOrderData(localStorage);
    clearCachedCheckoutAttempt();
    restoreSourcePending = null;
    suppressNextEmptyCartPersist = true;
    resetOrderDraftRefs();
  };

  const resetCallCenterSession = () => {
    callCenterSession.value = { started: false, mode: 'new', matches: [], searchedPhone: '', error: '', loading: false };
  };

  const resetOrderDraftRefs = () => {
    orderDraftSeq += 1;
    checkoutDraftId = makeCheckoutIdempotencyKey();
    cart.value = [];
    selectedCartIndex.value = null;
    orderNote.value = "";
    orderDiscount.value = { type: "percent", value: 0 };
    editingInvoiceId.value = null;
    editingOrderId.value = null;
    originalSavedItems.value = [];
    customerPhone.value = "";
    customerName.value = "";
    customerAddress.value = "";
    orderDate.value = "";
    hashNumber.value = "";
    restoredHeldReference.value = '';
    restoredHeldOrder.value = null;
    pendingHoldRequestId.value = null;
    serviceChargeSnapshot.value = null;
    autoServiceChargeRemoved.value = false;
    selectedOrderType.value = "";
    activeOrderTaxInclusive.value = null;
    activeOrderReceiptTaxInclusive.value = null;
    activeOrderTaxRegistrationType.value = null;
    isTaxExempt.value = false;
  };

  const applyPersistedOrderContext = (context) => {
    if (!context) return;
    checkoutDraftId = context.checkoutDraftId || checkoutDraftId;
    selectedOrderType.value = context.selectedOrderType ?? '';
    hashNumber.value = context.hashNumber;
    customerPhone.value = context.customerPhone;
    customerName.value = context.customerName;
    customerAddress.value = context.customerAddress;
    orderDate.value = context.orderDate;
    activeOrderTaxRegistrationType.value = context.taxRegistrationType;
    if (context.scope.kind === 'held') {
      restoredHeldReference.value = context.restoredHeldReference;
      restoredHeldOrder.value = context.heldOrder || null;
    }
    pendingHoldRequestId.value = context.holdRequestId || null;
    if (context.callCenter) {
      callCenterSession.value = {
        started: true,
        mode: context.callCenter.mode,
        matches: [],
        searchedPhone: context.customerPhone || '',
        error: '',
        loading: false,
      };
    }
  };

  const restorePersistedDraftSnapshot = (snapshot) => {
    const parsedCart = snapshot?.cart;
    const isLegacyModifierCart = Array.isArray(parsedCart) && parsedCart.some(item => {
      if (!Array.isArray(item?.selectedModifiers) || item.selectedModifiers.length === 0) return false;
      if (Object.prototype.hasOwnProperty.call(item, 'modifier_tax_amount')) return false;
      const hasPricedSelection = item.selectedModifiers.some(modifier => Number(modifier?.price || 0) > 0);
      return Number(item.modifier_surcharge || 0) > 0 || hasPricedSelection;
    });

    if (!Array.isArray(parsedCart) || !parsedCart.length || isLegacyModifierCart) {
      clearOrderData(localStorage);
      clearCachedCheckoutAttempt();
      resetOrderDraftRefs();
      if (isLegacyModifierCart) {
        window.showPosToast?.(t('Saved cart predates modifier tax update. Re-add its items before checkout.'), 'warning');
      }
      return false;
    }

    resetOrderDraftRefs();
    cart.value = parsedCart;
    isTaxExempt.value = snapshot.taxExempt === true;
    orderNote.value = snapshot.note || '';
    orderDiscount.value = snapshot.discount || { type: 'percent', value: 0 };
    serviceChargeSnapshot.value = snapshot.serviceChargeSnapshot || null;
    applyPersistedOrderContext(snapshot.context);
    return true;
  };

  const persistOrderContext = () => {
    const callCenter = callCenterSession.value.started ? {
      started: true,
      userId: getDeps().auth.activeUser.value?.id,
      mode: callCenterSession.value.mode,
    } : null;
    if (!cart.value.length && !callCenter) {
      writeOrderContext(localStorage, null);
      return;
    }

    const table = activeTable.value;
    const scope = table
        ? {
            kind: 'table',
            id: table.id == null ? null : String(table.id),
            orderId: table.current_order_id == null ? null : String(table.current_order_id),
            splitCheckId: table.split_check_id == null ? null : String(table.split_check_id),
            tableNumber: String(table.table_number ?? '').trim(),
          }
        : restoredHeldReference.value
          ? { kind: 'held', id: restoredHeldReference.value }
          : { kind: 'register', id: null };

    writeOrderContext(localStorage, {
      version: 2,
      checkoutDraftId,
      scope,
      selectedOrderType: selectedOrderType.value,
      hashNumber: hashNumber.value,
      customerPhone: customerPhone.value,
      customerName: customerName.value,
      customerAddress: customerAddress.value,
      orderDate: orderDate.value,
      restoredHeldReference: restoredHeldReference.value,
      heldOrder: restoredHeldOrder.value,
      holdRequestId: pendingHoldRequestId.value,
      taxRegistrationType: activeOrderTaxRegistrationType.value,
      callCenter,
    });
  };

  watch([
    () => cart.value.length,
    selectedOrderType,
    hashNumber,
    customerPhone,
    customerName,
    customerAddress,
    orderDate,
     restoredHeldReference,
     restoredHeldOrder,
     pendingHoldRequestId,
    activeOrderTaxRegistrationType,
    () => callCenterSession.value.started,
    () => callCenterSession.value.mode,
    () => activeTable.value?.id ?? null,
    () => activeTable.value?.current_order_id ?? null,
    () => activeTable.value?.split_check_id ?? null,
    () => activeTable.value?.table_number ?? '',
    () => activeTable.value?.is_split ?? false,
  ], persistOrderContext, { deep: true });

  const defaultOrderTypeId = computed(() => getDefaultOrderTypeId(orderTypes.value));
  const applyDefaultOrderTypeToNewRegisterOrder = (previousDefaultId = null) => {
    if (activeTable.value || editingInvoiceId.value || (cart.value.length > 0 && selectedOrderType.value)) return;
    const mayReplacePreviousDefault = previousDefaultId !== null
      && String(selectedOrderType.value) === String(previousDefaultId);
    if (!selectedOrderType.value || mayReplacePreviousDefault) {
      selectedOrderType.value = defaultOrderTypeId.value ?? '';
      hashNumber.value = '';
    }
  };

  const reconcileDraftOrderType = ({ canInvalidate = true } = {}) => {
    if ((editingInvoiceId.value && !activeTable.value) || (!orderTypes.value.length && !canInvalidate)) return;
    const selected = selectedOrderType.value;
    if (selected && orderTypes.value.some(type => String(type.id) === String(selected))) return;
    if (selected && (!canInvalidate || !orderTypesHaveLiveAuthority)) return;

    if (selected) {
      selectedOrderType.value = '';
      hashNumber.value = '';
      window.showPosToast?.(t('The saved order type is no longer available. The default was selected.'), 'warning');
    }

    applyDefaultOrderTypeToNewRegisterOrder();
  };

  const buildCheckoutFingerprint = () => {
    const deps = getDeps();
    const ui = useOrderUiStore();
    return buildCheckoutFingerprintSource({
      user: deps.auth.activeUser.value,
      shiftId: deps.auth.activeShift.value?.id,
      cart: cart.value,
      table: activeTable.value,
      editingInvoiceId: editingInvoiceId.value,
      editingOrderId: editingOrderId.value,
      orderTypeId: selectedOrderType.value,
      orderTypeDeferred: Number(selectedOrderTypeObj.value?.is_deferred_settlement) === 1,
      customer: { phone: customerPhone.value, name: customerName.value, address: customerAddress.value, deliveryDate: orderDate.value, note: orderNote.value },
      totals: { subtotal: cartSubtotal.value, tax: cartTax.value, total: cartTotal.value },
      orderDiscount: orderDiscount.value,
      hashNumber: hashNumber.value,
      serviceChargeSnapshot: serviceChargeSnapshot.value,
      payment: { method: ui.paymentMethod, amountTendered: ui.amountTendered, splitCardAmount: ui.splitCardAmount, splitCashTendered: ui.splitCashTendered },
      taxExempt: isTaxExempt.value,
      heldOrderContext: restoredHeldOrder.value,
    });
  };

  const serviceChargeSnapshotPayload = () => serviceChargeSnapshot.value ? {
    id: serviceChargeSnapshot.value.id,
    version: serviceChargeSnapshot.value.version,
    ...(serviceChargeSnapshot.value.claimToken ? { claim_token: serviceChargeSnapshot.value.claimToken } : {})
  } : null;

  const abandonCurrentServiceChargeSnapshot = () => {
    const snapshot = serviceChargeSnapshot.value;
    if (!snapshot) return;
    // A recalled held order owns this snapshot through its durable row. Its
    // release/cancel/checkout path performs the authoritative transition.
    if (restoredHeldOrder.value?.id) return;
    // Standalone draft snapshots still use their existing token-aware abandon route.
    orderSessionApi.abandonServiceChargeSnapshot(snapshot).catch(() => {});
  };

  const ensureCheckoutIdempotencyKey = () => {
    const ui = useOrderUiStore();
    ui.activeIdempotencyKey = resolveCheckoutAttemptKey({
      activeKey: ui.activeIdempotencyKey,
      fingerprintSource: buildCheckoutFingerprint(),
      makeKey: makeCheckoutIdempotencyKey
    });
    return ui.activeIdempotencyKey;
  };

  // Intent Actions
  const releaseHeldOrderClaimBestEffort = () => {
    const context = restoredHeldOrder.value;
    if (!context?.id || !context.claimToken || !context.version) return;
    const operationId = getHeldOperationId('release', context.id, localStorage);
    orderSessionApi.releaseHeldOrder(context.id, {
      operation_id: operationId,
      claim_token: context.claimToken,
      expected_version: context.version,
    }).then(() => clearHeldOperationId('release', context.id, localStorage)).catch(() => {});
  };

  const claimHeldOrderForHandoff = (payload) => orderSessionApi.claimHeldOrder(payload);
  const initializeCallCenterSession = (user = getDeps().auth.activeUser.value) => {
    if (user?.role !== 'call_center') return false;
    useOrderUiStore().resetTransient();
    getDeps().auth.activeShift.value = null;
    clearHeldOrderHandoff(localStorage);
    clearTablePrefill(localStorage);
    clearActiveTableSession({ clearCart: false });
    orderTypes.value = [];
    orderTypesHaveLiveAuthority = false;
    const saved = readCallCenterOrderSnapshot(user.id, localStorage);
    resetOrderDraftRefs();
    resetCallCenterSession();
    if (!saved?.context?.callCenter) return true;

    cart.value = Array.isArray(saved.cart) ? saved.cart : [];
    orderNote.value = saved.note || '';
    orderDiscount.value = saved.context.callCenter.mode === 'editing'
      ? (saved.discount || { type: 'percent', value: 0 })
      : { type: 'percent', value: 0 };
    serviceChargeSnapshot.value = saved.context.callCenter.mode === 'editing'
      ? (saved.serviceChargeSnapshot || null)
      : null;
    isTaxExempt.value = false;
    applyPersistedOrderContext(saved.context);
    return true;
  };

  const callCenterCustomerValid = () => {
    return isCustomerPhone(customerPhone.value)
      && String(customerName.value || '').trim().length > 0
      && String(customerName.value || '').trim().length <= 100
      && String(customerAddress.value || '').trim().length > 0
      && String(customerAddress.value || '').trim().length <= 500;
  };

  const startCallCenterOrder = () => {
    if (getDeps().auth.activeUser.value?.role !== 'call_center' || !callCenterCustomerValid()) {
      window.showPosToast?.(t('Customer name, phone, and address are required.'), 'warning');
      return false;
    }
    customerPhone.value = String(customerPhone.value).trim();
    customerName.value = String(customerName.value).trim();
    customerAddress.value = String(customerAddress.value).trim();
    callCenterSession.value = {
      ...callCenterSession.value,
      started: true,
      mode: 'new',
      searchedPhone: customerPhone.value,
      error: '',
    };
    selectedOrderType.value = '';
    hashNumber.value = '';
    orderDiscount.value = { type: 'percent', value: 0 };
    serviceChargeSnapshot.value = null;
    isTaxExempt.value = false;
    persistOrderContext();
    return true;
  };

  const findCallCenterOrders = async () => {
    if (getDeps().auth.activeUser.value?.role !== 'call_center') return [];
    const searchedPhone = String(customerPhone.value || '').trim();
    if (!isCustomerPhone(searchedPhone)) {
      callCenterSession.value = { ...callCenterSession.value, matches: [], error: t('Enter a valid phone number.') };
      return [];
    }
    callCenterSession.value = { ...callCenterSession.value, loading: true, error: '', searchedPhone };
    try {
      const customerResult = await orderSessionApi.getCustomerByPhone(searchedPhone, { privateBody: true });
      if (searchedPhone !== String(customerPhone.value || '').trim()) return [];
      if (customerResult.response?.status === 409
          && customerResult.data?.code === 'CUSTOMER_PHONE_AMBIGUOUS') {
        window.showPosToast?.(t(customerResult.data.message), 'warning');
      }
      if (customerResult.data?.success && customerResult.data.customer) {
        if (!String(customerName.value || '').trim()) customerName.value = customerResult.data.customer.name || '';
        if (!String(customerAddress.value || '').trim()) customerAddress.value = customerResult.data.customer.address || '';
      }
      const { response, data } = await orderSessionApi.findPhoneHeldOrders(searchedPhone);
      if (!response.ok || !data.success) throw new Error(data.message || t('Could not find phone orders.'));
      const matches = Array.isArray(data.data) ? data.data.slice(0, 10) : [];
      callCenterSession.value = { ...callCenterSession.value, matches, searchedPhone, error: '' };
      return matches;
    } catch (error) {
      const message = isUnansweredRequest(error) ? '' : error.message;
      callCenterSession.value = { ...callCenterSession.value, matches: [], error: message || t('Could not find phone orders.') };
      return [];
    } finally {
      callCenterSession.value = { ...callCenterSession.value, loading: false };
    }
  };

  const continueCallCenterOrder = async (match) => {
    if (getDeps().auth.activeUser.value?.role !== 'call_center' || !match?.id || !match?.version) return false;
    const claimToken = createHeldClaimToken();
    try {
      const { response, data } = await orderSessionApi.claimHeldOrder({
        id: match.id,
        claimToken,
        expectedVersion: match.version,
        customerPhone: callCenterSession.value.searchedPhone || customerPhone.value,
      });
      if (!response.ok || !data.success || !data.order) {
        if (response.status === 409) await findCallCenterOrders();
        window.showPosToast?.(data.message || t('Could not continue this phone order.'), 'error');
        return false;
      }
      const claimed = data.order;
      let payload;
      try { payload = JSON.parse(claimed.cart_data || '{}'); } catch (_) { payload = {}; }
      if (Array.isArray(payload)) payload = { items: payload };
      payload.reference_name = claimed.reference_name || '';
      payload.service_charge_snapshot = claimed.service_charge_snapshot || null;
      payload.held_order_context = {
        id: Number(claimed.id || match.id),
        version: Number(data.claim?.version || claimed.version),
        claimToken: data.claim?.claimToken || claimToken,
        claimExpiresAt: data.claim?.claimExpiresAt || null,
        kitchenFired: Number(claimed.kitchen_fired) === 1,
        kitchenDispatchVersion: Number(claimed.kitchen_dispatch_version || 0),
      };
      restoreHeldOrder(payload);
      callCenterSession.value = {
        started: true,
        mode: 'editing',
        matches: [],
        searchedPhone: payload.customer_phone || customerPhone.value,
        error: '',
        loading: false,
      };
      persistOrderContext();
      return true;
    } catch (error) {
      window.showPosToast?.(t('Could not confirm the phone order update. Retry when the connection returns.'), 'error');
      return false;
    }
  };

  // Re-leases the restored hold with its own claim token: the server replays an active
  // lease for that token and re-leases a lapsed one when the version is unchanged.
  // Returns '' on success, otherwise the translated reason (also toasted).
  const reconnectHeldOrder = async () => {
    const context = restoredHeldOrder.value;
    const isCallCenter = getDeps().auth.activeUser.value?.role === 'call_center';
    if (!context?.id || !(isCallCenter || canHoldOrder.value)) return t('Hold order permission required.');
    const claimToken = context.claimToken || createHeldClaimToken();
    const fail = (message, level) => { window.showPosToast?.(message, level); return message; };
    try {
      const { response, data } = await orderSessionApi.claimHeldOrder({
        id: context.id,
        claimToken,
        expectedVersion: Number(context.version),
        customerPhone: isCallCenter ? (customerPhone.value || callCenterSession.value.searchedPhone) : null,
      });
      if (response.ok && data.success && data.order) {
        restoredHeldOrder.value = {
          ...context,
          version: Number(data.claim?.version || context.version),
          claimToken: data.claim?.claimToken || claimToken,
          claimExpiresAt: data.claim?.claimExpiresAt || null,
        };
        persistOrderContext();
        return '';
      }
      if (isCallCenter) {
        if (response.status === 409) {
          await findCallCenterOrders();
          return fail(t('This phone order changed on the server. Your draft is preserved.'), 'warning');
        }
        return fail(data.message || t('This phone order is no longer available.'), 'warning');
      }
      if (data?.code === 'HELD_IN_USE') return fail(t('This suspended ticket is being edited on another terminal.'), 'warning');
      if (response.status === 409) return fail(t('This suspended ticket changed on the server. Your cart is kept.'), 'warning');
      return fail(t('This suspended ticket is no longer available. Your cart is kept.'), 'warning');
    } catch (_) {
      return fail(isCallCenter
        ? t('Could not confirm the phone order update. Retry when the connection returns.')
        : t('Could not confirm the suspended ticket. Retry when the connection returns.'), 'error');
    }
  };

  const finishCallCenterOrder = () => {
    clearOrderSlice();
    resetCallCenterSession();
    clearCartStorage(localStorage);
    useOrderUiStore().resetTransient();
  };

  const sendCallCenterOrder = async () => {
    if (getDeps().auth.activeUser.value?.role !== 'call_center' || !callCenterSession.value.started) return false;
    const saved = await holdCurrentOrder();
    if (saved) finishCallCenterOrder();
    return saved === true;
  };

  const cancelCallCenterEdits = async () => {
    const context = restoredHeldOrder.value;
    if (!context?.id || getDeps().auth.activeUser.value?.role !== 'call_center') return false;
    const operationId = getHeldOperationId('release', context.id, localStorage);
    try {
      const { response, data } = await orderSessionApi.releaseHeldOrder(context.id, {
        operation_id: operationId,
        claim_token: context.claimToken,
        expected_version: context.version,
      });
      if (!response.ok || !data.success) {
        if (response.status < 500) clearHeldOperationId('release', context.id, localStorage);
        window.showPosToast?.(data.message || t('Could not cancel these edits.'), 'error');
        return false;
      }
      clearHeldOperationId('release', context.id, localStorage);
      finishCallCenterOrder();
      return true;
    } catch (_) {
      window.showPosToast?.(t('Could not confirm the phone order update. Retry when the connection returns.'), 'error');
      return false;
    }
  };

  const cancelCallCenterOrder = async (reasonCode) => {
    const reasons = new Set(['customer_changed_mind', 'duplicate_order', 'entered_in_error', 'other_customer_request']);
    const context = restoredHeldOrder.value;
    if (!context?.id || !reasons.has(reasonCode) || getDeps().auth.activeUser.value?.role !== 'call_center') return false;
    const operationId = getHeldOperationId('cancel', context.id, localStorage);
    try {
      const { response, data } = await orderSessionApi.cancelHeldOrder(context.id, {
        operation_id: operationId,
        claim_token: context.claimToken,
        expected_version: context.version,
        reason_code: reasonCode,
        confirmed: true,
      });
      if (!response.ok || !data.success) {
        if (response.status < 500) clearHeldOperationId('cancel', context.id, localStorage);
        window.showPosToast?.(data.message || t('Could not cancel this phone order.'), 'error');
        return false;
      }
      clearHeldOperationId('cancel', context.id, localStorage);
      finishCallCenterOrder();
      window.showPosToast?.(t('Order cancelled'), 'success');
      return true;
    } catch (_) {
      try {
        const { response, data } = await orderSessionApi.claimHeldOrder({
          id: context.id,
          claimToken: context.claimToken,
          expectedVersion: context.version,
          customerPhone: customerPhone.value || callCenterSession.value.searchedPhone,
        });
        if (response.status === 404) {
          clearHeldOperationId('cancel', context.id, localStorage);
          finishCallCenterOrder();
          window.showPosToast?.(t('Order cancelled'), 'success');
          return true;
        }
        if (response.ok && data.success && data.order) {
          restoredHeldOrder.value = {
            ...context,
            version: Number(data.claim?.version || context.version),
            claimToken: data.claim?.claimToken || context.claimToken,
            claimExpiresAt: data.claim?.claimExpiresAt || context.claimExpiresAt || null,
          };
          persistOrderContext();
          window.showPosToast?.(t('The phone order is still open. Your draft is preserved.'), 'warning');
          return false;
        }
        if (response.status === 409) await findCallCenterOrders();
      } catch (_) {
        // Still uncertain: never clear the local draft or the retry operation id.
      }
      window.showPosToast?.(t('Could not confirm whether the order was cancelled. Your draft is preserved.'), 'error');
      return false;
    }
  };

  const startNewOrder = () => {
    releaseHeldOrderClaimBestEffort();
    abandonCurrentServiceChargeSnapshot();
    clearOrderSlice();
    applyDefaultOrderTypeToNewRegisterOrder();
    clearCartStorage(localStorage);

    const ui = useOrderUiStore();
    ui.resetTransient();
    resetCallCenterSession();
  };

  const restoreHeldOrder = (payload) => {
    if (!payload) return;
    clearOrderSlice();
    resetEditResidue();
    cart.value = (payload.items || []).map(item => ({
      ...item,
      price: item.price !== undefined ? parseFloat(item.price) : 0,
      qty: item.qty !== undefined ? parseFloat(item.qty) : 1,
      discountValue: item.discountValue !== undefined ? parseFloat(item.discountValue) : 0,
      tax_rate: item.tax_rate !== undefined ? parseFloat(item.tax_rate) : 0,
      jofotara_tax_category: item.jofotara_tax_category || 'O',
      modifier_surcharge: item.modifier_surcharge != null ? parseFloat(item.modifier_surcharge) : null,
      modifier_tax_amount: item.modifier_tax_amount != null ? parseFloat(item.modifier_tax_amount) : null
    }));
    selectedCartIndex.value = null;
    customerName.value = payload.customer_name || "";
    customerPhone.value = payload.customer_phone || "";
    customerAddress.value = payload.customer_address || "";
    orderDate.value = scheduledDateTimeInput(payload.delivery_date);
    selectedOrderType.value = payload.order_type_id !== undefined && payload.order_type_id !== null ? payload.order_type_id : "";
    orderNote.value = payload.order_note || "";
    orderDiscount.value = payload.order_discount || { type: "percent", value: 0 };
    hashNumber.value = payload.hash_number || "";
    restoredHeldReference.value = payload.reference_name || "";
    restoredHeldOrder.value = payload.held_order_context || payload.heldOrder || null;
    pendingHoldRequestId.value = null;
    serviceChargeSnapshot.value = payload.service_charge_snapshot || null;
    activeOrderTaxInclusive.value = payload.tax_inclusive_at_hold != null
      ? isExplicitTaxExempt(payload.tax_inclusive_at_hold)
      : null;
    activeOrderReceiptTaxInclusive.value = payload.receipt_tax_inclusive_at_hold != null
      ? isExplicitTaxExempt(payload.receipt_tax_inclusive_at_hold)
      : activeOrderTaxInclusive.value;
    activeOrderTaxRegistrationType.value = payload.tax_registration_type_at_hold || null;
    isTaxExempt.value = cart.value.length > 0 && isExplicitTaxExempt(payload.tax_exempt_at_hold);

    // Check if the hold-time tax mode differs from the current terminal's tax mode
    const holdInclusive = payload.tax_inclusive_at_hold === 1 || payload.tax_inclusive_at_hold === true || payload.tax_inclusive_at_hold === '1';
    const currentInclusive = taxInclusivePricing.value;
    if (payload.tax_inclusive_at_hold !== undefined && payload.tax_inclusive_at_hold !== null && holdInclusive !== currentInclusive) {
      window.showPosToast?.(t('Tax mode changed since hold. Re-evaluating totals under current mode.'), 'warning');
    }

    const ui = useOrderUiStore();
    ui.resetTransient();
  };

  const markServerCanonicalRestore = () => {
    restoreSourcePending = 'server';
  };

  // A held order restored from its local backup cart carries hold-time prices.
  const markLocalFallbackRestore = () => {
    restoreSourcePending = 'local';
  };

  const consumeRestoreSource = () => {
    const pending = restoreSourcePending;
    restoreSourcePending = null;
    return pending;
  };

  const consumeServerCanonicalRestore = () => consumeRestoreSource() === 'server';

  const sendHeldOrderFollowUp = async () => {
    const owner = captureOrderSession();
    const context = restoredHeldOrder.value;
    if (!context?.id || !context.claimToken || !context.version || context.kitchenFired !== true) {
      window.showPosToast?.(t('Claim a fired held order before sending a follow-up.'), 'warning');
      return false;
    }
    const operationId = getHeldOperationId('follow-up', context.id, localStorage);
    const cartPayload = {
      items: cart.value,
      customer_name: customerName.value || '',
      customer_phone: customerPhone.value || '',
      customer_address: customerAddress.value || '',
      order_type_id: selectedOrderType.value || null,
      delivery_date: orderDate.value || '',
      order_note: orderNote.value || '',
      ...(getDeps().auth.activeUser.value?.role === 'call_center'
        ? (Number(orderDiscount.value?.value || 0) !== 0
            ? { order_discount: orderDiscount.value }
            : {})
        : { order_discount: orderDiscount.value || { type: 'percent', value: 0 } }),
      hash_number: hashNumber.value || ''
    };
    const ui = useOrderUiStore();
    if (ui.isHolding || ui.isProcessing) return false;
    ui.isHolding = true;
    try {
      const { response, data } = await orderSessionApi.followUpHeldOrder(context.id, {
        operation_id: operationId,
        claim_token: context.claimToken,
        expected_version: context.version,
        cart: cartPayload,
        subtotal: cartSubtotal.value,
      });
      if (!isCurrentOrderSession(owner)) return data.success === true;
      if (!response.ok || !data.success) {
        if (response.status < 500) clearHeldOperationId('follow-up', context.id, localStorage);
        window.showPosToast?.(data.message || t('Could not send the kitchen follow-up.'), 'error');
        return false;
      }
      clearHeldOperationId('follow-up', context.id, localStorage);
      ui.isHolding = false;
      clearOrderSlice();
      if (getDeps().auth.activeUser.value?.role === 'call_center') resetCallCenterSession();
      else applyDefaultOrderTypeToNewRegisterOrder();
      ui.clearQuickTargetAmount();
      ui.numpadInput = '';
      window.showPosToast?.(t('FOLLOW UP sent to the kitchen.'), 'success');
      return true;
    } catch (error) {
      if (!isCurrentOrderSession(owner)) return false;
      console.error('Failed to send held-order follow-up:', error);
      window.showPosToast?.(t('Could not confirm the kitchen follow-up. Retry to finish the same follow-up.'), 'error');
      return false;
    } finally {
      if (isCurrentOrderSession(owner)) ui.isHolding = false;
    }
  };

  const confirmHeldKitchenBaseline = async () => {
    const owner = captureOrderSession();
    const context = restoredHeldOrder.value;
    if (!context?.id || !context.claimToken || !context.version || context.kitchenFired !== true) {
      window.showPosToast?.(t('Restore a fired held order before confirming its kitchen baseline.'), 'warning');
      return false;
    }
    const operationId = getHeldOperationId('baseline', context.id, localStorage);
    const cartPayload = {
      items: cart.value,
      customer_name: customerName.value || '',
      customer_phone: customerPhone.value || '',
      customer_address: customerAddress.value || '',
      order_type_id: selectedOrderType.value || null,
      delivery_date: orderDate.value || '',
      order_note: orderNote.value || '',
      order_discount: orderDiscount.value || { type: 'percent', value: 0 },
      hash_number: hashNumber.value || ''
    };
    const ui = useOrderUiStore();
    if (ui.isHolding || ui.isProcessing) return false;
    ui.isHolding = true;
    try {
      const { response, data } = await orderSessionApi.confirmHeldKitchenBaseline(context.id, {
        operation_id: operationId,
        claim_token: context.claimToken,
        expected_version: context.version,
        confirmed: true,
        reason_code: 'manual_review',
        cart: cartPayload,
      });
      if (!isCurrentOrderSession(owner)) return data.success === true;
      if (!response.ok || !data.success) {
        if (response.status < 500) clearHeldOperationId('baseline', context.id, localStorage);
        window.showPosToast?.(data.message || t('Could not confirm the kitchen baseline.'), 'error');
        return false;
      }
      clearHeldOperationId('baseline', context.id, localStorage);
      ui.isHolding = false;
      clearOrderSlice();
      applyDefaultOrderTypeToNewRegisterOrder();
      ui.clearQuickTargetAmount();
      ui.numpadInput = '';
      window.history.replaceState(window.history.state, '', window.location.pathname);
      window.showPosToast?.(t('Kitchen baseline confirmed. Restore the ticket again to continue.'), 'success');
      return true;
    } catch (error) {
      if (!isCurrentOrderSession(owner)) return false;
      console.error('Failed to confirm held-order kitchen baseline:', error);
      window.showPosToast?.(t('Could not confirm the kitchen baseline. Retry to finish the same confirmation.'), 'error');
      return false;
    } finally {
      if (isCurrentOrderSession(owner)) ui.isHolding = false;
    }
  };

  const finalizeCheckout = () => {
    clearOrderSlice();
    applyDefaultOrderTypeToNewRegisterOrder();

    if (typeof window !== 'undefined' && window.history && window.history.replaceState && window.location) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }

    const ui = useOrderUiStore();
    ui.resetTransient();
  };

  // Permission getters
  const canBypassPrintedLock = computed(() => getDeps().permissions.can('pos.void_printed_item'));
  const isCallCenter = computed(() => getDeps().auth.activeUser.value?.role === 'call_center');
  const callCenterCommands = computed(() => buildCallCenterCommandPolicy({
    editing: Boolean(restoredHeldOrder.value?.id),
    kitchenFired: restoredHeldOrder.value?.kitchenFired === true,
  }));
  // A temporary manager PIN is re-verified at register checkout. Table saves do
  // not accept that credential, so they require the user's durable grant.
  const canApplyDiscount = computed(() => {
    const permissions = getDeps().permissions;
    const durableGrant = typeof permissions.hasDirect === 'function'
      ? permissions.hasDirect('pos.discount')
      : permissions.can('pos.discount');
    return durableGrant || (!activeTable.value && permissions.can('pos.discount'));
  });
  const canVoidItems = computed(() => getDeps().permissions.can('pos.void_item'));
  const canReprint = computed(() => getDeps().permissions.can('pos.reprint_receipt'));
  const canApplyServiceCharge = computed(() => getDeps().permissions.can('pos.service_charge'));
  const canTaxExempt = computed(() => (
    taxRegistrationType.value !== 'income_tax' && getDeps().permissions.can('pos.tax_exempt')
  ));
  const canCheckout = computed(() => getDeps().permissions.can('pos.checkout'));
  const canCheckoutTable = computed(() => Boolean(activeTable.value?.current_order_id || activeTable.value?.split_check_id)
    && permissionPolicy.evaluateAction(getDeps().auth.activeUser.value, 'checkout', { tablePayment: true }).allowed);
  const canPrintCheck = computed(() => canCheckout.value || canCheckoutTable.value);
  const activeTableIsPrinted = computed(() => activeTable.value?.status === 'printed');
  const canVoidActiveTable = computed(() => (
    permissionPolicy.evaluateAction(getDeps().auth.activeUser.value, 'table.void', { printed: activeTableIsPrinted.value }).allowed
  ));
  const hasSavedTableItems = computed(() => cart.value.some(item => (
    item.note !== 'Auto-Gratuity' && Number(item.originalQty) > 0
  )));
  const selectedCartItem = computed(() => (
    selectedCartIndex.value === null ? null : cart.value[selectedCartIndex.value] || null
  ));
  const canRemoveSelectedCartItem = computed(() => {
    const item = selectedCartItem.value;
    if (!item || item.note === 'Auto-Gratuity') return false;
    if (isCallCenter.value && restoredHeldOrder.value?.kitchenFired === true && item.held_line_id) return false;
    return Number(item.originalQty) > 0 ? canVoidActiveTable.value : true;
  });
  const canClearCart = computed(() => (
    cart.value.length > 0 && (!hasSavedTableItems.value || canVoidActiveTable.value)
  ));

  // Order type getters
  const selectedOrderTypeObj = computed(() => orderTypes.value.find(t => String(t.id) === String(selectedOrderType.value)));
  const selectedOrderTypeRequiresHash = computed(() => selectedOrderTypeObj.value && selectedOrderTypeObj.value.requires_hash == 1);
  const isDirectPlatformCheckout = computed(() => (
    !isCallCenter.value &&
    !activeTable.value &&
    !editingInvoiceId.value &&
    !editingOrderId.value &&
    Number(selectedOrderTypeObj.value?.is_deferred_settlement) === 1
  ));

  const syncCheckoutPaymentForOrderType = () => {
    if (isCallCenter.value) return;
    const ui = useOrderUiStore();
    const platform = isDirectPlatformCheckout.value;
    ui.paymentMethod = platform ? 'platform' : 'cash';
    ui.amountTendered = platform ? 0 : Number(cartTotal.value.toFixed(2));
    ui.splitCardAmount = null;
    ui.splitCashTendered = null;
  };

  // Service charge settings helpers
  const serviceChargeEnabled = computed(() => getDeps().products.settings.value?.service_charge_enabled === '1');
  const serviceChargePercentage = computed(() => parseFloat(getDeps().products.settings.value?.service_charge_percentage || '10'));
  const autoApplyServiceCharge = computed(() => {
    const settings = getDeps().products.settings.value || {};
    return settings.tables_enabled === '1'
      && settings.service_charge_enabled === '1'
      && settings.auto_apply_service_charge === '1';
  });
  const canRemoveAutoServiceCharge = computed(() => {
    const role = getDeps().auth.activeUser.value?.role;
    return role === 'admin' || role === 'programmer';
  });

  const toggleTaxExempt = () => {
    if (cart.value.length === 0 || !canTaxExempt.value) return false;
    isTaxExempt.value = !isTaxExempt.value;
    updateServiceCharge();
    return true;
  };

  // Actions
  const loadSavedOrder = () => {
    ui.clearQuickTargetAmount();
    ui.numpadInput = '';
    try {
      const saved = readOrderSnapshot(localStorage);
      const context = saved.context;
      const activeTableRecord = context?.scope.kind === 'table' ? readActiveTable(localStorage) : null;
      const tableContextMatches = context?.scope.kind !== 'table'
        || matchesTableOrderContext(context, activeTableRecord);

      if (!tableContextMatches) {
        clearOrderData(localStorage);
        clearCachedCheckoutAttempt();
        resetOrderDraftRefs();
        return;
      }

      restorePersistedDraftSnapshot(saved);
    } catch (e) {
      console.error("Error parsing saved order data", e);
    }
  };

  const loadOrderForEditing = async (invoiceId) => {
    clearOrderSlice();
    const owner = captureOrderSession();
    ui.clearQuickTargetAmount();
    ui.numpadInput = '';
    // Reset stale editing residue before populating the edited invoice.
    resetEditResidue();
    isTaxExempt.value = false;
    // Clear stale delivery date / order type so an edited invoice that lacks them does
    // not inherit the terminal's previous values. (Task 6b)
    orderDate.value = "";
    selectedOrderType.value = "";
    hashNumber.value = "";
    try {
      const { data } = await orderSessionApi.getOrderDetails(invoiceId);
      if (!isCurrentOrderSession(owner)) return;
      if (data.success) {
        const order = data.order;
        editingInvoiceId.value = order.invoice_id;
        editingOrderId.value = order.order_id;

        orderNote.value = order.note || "";
        orderDiscount.value = {
          type: order.discount_type || "percent",
          value: parseFloat(order.discount_value) || 0
        };

        customerName.value = order.customer_name || "";
        customerPhone.value = order.customer_phone || "";
        customerAddress.value = order.customer_address || "";
        orderDate.value = scheduledDateTimeInput(order.delivery_date);
        if (order.order_type_id) selectedOrderType.value = order.order_type_id;
        hashNumber.value = order.hash_number || "";

        cart.value = data.items.map(item => ({
          cartId: 'EDIT_' + Math.random().toString(36).substr(2, 9),
          id: item.product_id || 'CUSTOM_' + Date.now(),
          name: item.product_name || "Custom/Deleted Item",
          price: parseFloat(item.price_at_sale),
          qty: parseFloat(item.quantity),
          originalQty: parseFloat(item.quantity),
          tax_rate: parseFloat(item.tax_rate) || 0,
          jofotara_tax_category: item.jofotara_tax_category || 'O',
          note: item.note || "",
          selectedModifiers: (() => {
            const rawMods = item.selected_modifiers;
            if (Array.isArray(rawMods)) return rawMods;
            if (typeof rawMods !== 'string' || !rawMods) return null;
            try {
              const parsed = JSON.parse(rawMods);
              return Array.isArray(parsed) ? parsed : null;
            } catch { return null; }
          })(),
          discountType: item.discount_type || null,
          discountValue: parseFloat(item.discount_value) || 0,
          modifier_surcharge: item.modifier_surcharge != null ? parseFloat(item.modifier_surcharge) : null,
          modifier_tax_amount: item.modifier_tax_amount != null ? parseFloat(item.modifier_tax_amount) : null,
          is_custom: item.product_id ? false : true,
          price_override_locked: Number(item.price_override_locked) || 0,
          // DB order_items.id (order_details returns oi.*); the refund endpoint resolves
          // selections by order_item_id. Null on any unsaved/synthetic line.
          order_item_id: item.id ?? null
        }));
        isTaxExempt.value = cart.value.length > 0 && isExplicitTaxExempt(order.tax_exempt_at_sale);
        originalSavedItems.value = JSON.parse(JSON.stringify(cart.value));
      } else {
        await window.showPosAlert("Error loading invoice: " + data.message);
      }
    } catch (e) {
      if (!isCurrentOrderSession(owner)) return;
      console.error("Failed to load invoice:", e);
    }
  };

  const fetchOrderTypes = async (options = {}) => {
    const activeRole = getDeps().auth.activeUser.value?.role || 'cashier';
    if (orderTypes.value.length > 0 && !options.force) {
      reconcileDraftOrderType({ canInvalidate: orderTypesHaveLiveAuthority });
      return;
    }
    const previousDefaultId = defaultOrderTypeId.value;
    let receivedLiveAuthority = false;
    try {
      const { data } = await orderSessionApi.getOrderTypes();
      if (data.success && Array.isArray(data.data)) {
        orderTypes.value = data.data;
        receivedLiveAuthority = true;
        localStorage.setItem(ORDER_TYPES_CACHE_KEY, JSON.stringify({
          data: data.data,
          savedAt: Date.now(),
          role: activeRole,
        }));
      } else {
        orderTypes.value = readCachedOrderTypes(activeRole);
      }
    } catch (e) {
      orderTypes.value = readCachedOrderTypes(activeRole);
    }
    orderTypesHaveLiveAuthority = receivedLiveAuthority;
    if (receivedLiveAuthority || orderTypes.value.length > 0) {
      reconcileDraftOrderType({ canInvalidate: receivedLiveAuthority });
      applyDefaultOrderTypeToNewRegisterOrder(previousDefaultId);
      if (receivedLiveAuthority && useOrderUiStore().showCheckoutModal) {
        syncCheckoutPaymentForOrderType();
      }
    }
  };

  const lookupCustomer = async () => {
    // Any number can be a customer phone, so a returning customer is found by a short number too.
    if (!isCustomerPhone(customerPhone.value)) return;
    const ui = useOrderUiStore();
    const phoneAtRequest = customerPhone.value;
    ui.isCustomerLoading = true;
    try {
      const { data } = await orderSessionApi.getCustomerByPhone(phoneAtRequest, {
        privateBody: getDeps().auth.activeUser.value?.role === 'call_center',
      });
      if (phoneAtRequest !== customerPhone.value) return; // a newer lookup superseded this one
      if (data.success && data.customer) {
        customerName.value = data.customer.name;
        customerAddress.value = data.customer.address;
      }
    } catch (e) {
    } finally {
      // Always clear the loading flag. The race guard above protects the name/address
      // WRITE from a stale response; the loading flag is shared UI state and must reset
      // even when this request was superseded — otherwise shortening the phone below the
      // lookup threshold mid-request leaves the spinner stuck on.
      ui.isCustomerLoading = false;
    }
  };

  const handleOrderTypeSelection = async (type) => {
    const ui = useOrderUiStore();
    ui.showOrderTypeDropdown = false;
    selectedOrderType.value = type?.id ?? null;
    // A hash belongs to a specific order type — clear it on any switch so a prior type's
    // hash can't ride into the new one. (Future-proofing Task 7)
    hashNumber.value = '';

    syncCheckoutPaymentForOrderType();
    if (type?.requires_hash == 1) {
      nextTick(() => document.getElementById('checkout-hash')?.focus());
    }
  };

  // Low-level request only. Remove/Clear own UI state so failed requests never
  // mutate the cart and committed voids can be followed by an authoritative reload.
  const requestTableVoid = async ({ invoice_id, expected_version, items = null }) => {
    const body = { invoice_id, expected_version: expected_version ?? null };
    if (items !== null) body.items = items;
    body.intent = 'void';
    let result;
    try {
      result = await orderSessionApi.voidTableItems(body);
    } catch (_) {
      throw new Error(t('Could not confirm whether the void was saved. Reopen the table to review it before trying again.'));
    }
    const { response, data } = result;
    if (!response.ok || !data.success) throw new Error(t(data.message || 'Void failed.'));
    return data;
  };

  const captureUncommittedCartChanges = (excludedOrderItemId) => ({
    newItems: cart.value
      .filter(item => item.note !== 'Auto-Gratuity' && !(Number(item.originalQty) > 0))
      .map(item => ({ ...item })),
    savedIncreases: cart.value
      .filter(item => (
        item.note !== 'Auto-Gratuity'
        && item.order_item_id != null
        && String(item.order_item_id) !== String(excludedOrderItemId)
        && Number(item.qty) > Number(item.originalQty)
      ))
      .map(item => ({
        orderItemId: item.order_item_id,
        quantity: Number(item.qty) - Number(item.originalQty)
      }))
  });

  const restoreUncommittedCartChanges = ({ newItems, savedIncreases }) => {
    for (const increase of savedIncreases) {
      const savedItem = cart.value.find(item => String(item.order_item_id) === String(increase.orderItemId));
      if (savedItem) savedItem.qty = Number(savedItem.qty) + increase.quantity;
    }

    const feeIndex = cart.value.findIndex(item => item.note === 'Auto-Gratuity');
    const feeItem = feeIndex === -1 ? null : cart.value.splice(feeIndex, 1)[0];
    cart.value.push(...newItems);
    if (feeItem) cart.value.push(feeItem);
    updateServiceCharge();
  };

  const finishCommittedTableVoid = async ({ result, table, draftChanges, successMessage, router }) => {
    if (result.table_freed) {
      closeTable({ router });
      window.showPosToast?.(t(successMessage), 'success');
      return true;
    }

    const ui = useOrderUiStore();
    let reloadOwner;
    try {
      const reload = loadActiveTableOrder(table);
      reloadOwner = captureTableSession();
      await reload;
      if (!isCurrentTableSession(reloadOwner)) return true;
      restoreUncommittedCartChanges(draftChanges);
      window.showPosToast?.(t(successMessage), 'success');
      return true;
    } catch (_) {
      if (activeTable.value && !isCurrentTableSession(reloadOwner)) return true;
      ui.tableActionError = '';
      closeTable({ router });
      window.showPosToast?.(t('Void saved. Reopen the table to continue.'), 'warning');
      return true;
    }
  };

  const executeTableVoid = async ({ table, items = null, draftChanges, successMessage, router }) => {
    const ui = useOrderUiStore();
    if (ui.isProcessing) return false;
    const owner = captureOrderSession();
    ui.isProcessing = true;
    try {
      const result = await requestTableVoid({ invoice_id: table.current_order_id, expected_version: table.version, items });
      if (!isCurrentOrderSession(owner)) return true;
      ui.isProcessing = false;
      return await finishCommittedTableVoid({ result, table, draftChanges, successMessage, router });
    } catch (error) {
      if (!isCurrentOrderSession(owner)) return false;
      window.showPosToast?.(error.message || t('Could not confirm whether the void was saved. Reopen the table to review it before trying again.'), 'error');
      return false;
    } finally {
      if (isCurrentOrderSession(owner)) ui.isProcessing = false;
    }
  };

  const clearCart = async (opts = {}) => {
    const owner = captureOrderSession();
    if (cart.value.length === 0 && !restoredHeldOrder.value?.id) {
      cancelQuickAmount();
      return false;
    }

    if (hasSavedTableItems.value) {
      if (!canVoidActiveTable.value) {
        window.showPosToast?.(t('You do not have permission to void saved items.'), 'error');
        return false;
      }
      if (!activeTable.value?.current_order_id) {
        window.showPosToast?.(t('This table order must be reopened before it can be cleared.'), 'error');
        return false;
      }

      const table = { ...activeTable.value };
      const confirmation = t('Clear Table {table}? This will cancel all saved items.')
        .replace('{table}', table.table_number);
      if (!(await window.showPosConfirm(confirmation))) return false;
      if (!isCurrentOrderSession(owner)) return false;

      return executeTableVoid({
        table,
        draftChanges: { newItems: [], savedIncreases: [] },
        successMessage: 'Table cleared',
        router: opts.router
      });
    }

    // A recalled held order is a server-owned row. Clearing its local cart must
    // use the explicit cancellation endpoint so the row, snapshot, and audit
    // event stay consistent; never silently discard the lease from the browser.
    let heldCancelled = false;
    if (restoredHeldOrder.value?.id) {
      const context = restoredHeldOrder.value;
      const shouldCancel = opts.skipConfirm || (await window.showPosConfirm(
        t('Cancel this suspended order? This cannot be undone.')
      ));
      if (!shouldCancel) return false;
      if (!isCurrentOrderSession(owner)) return false;
      const operationId = getHeldOperationId('cancel', context.id, localStorage);
      try {
        const { response, data } = await orderSessionApi.cancelHeldOrder(context.id, {
          operation_id: operationId,
          claim_token: context.claimToken,
          expected_version: context.version,
          reason_code: 'customer_changed_mind',
          confirmed: true,
        });
        if (!isCurrentOrderSession(owner)) return data.success === true;
        if (!response.ok || !data.success) {
          if (response.status < 500) clearHeldOperationId('cancel', context.id, localStorage);
          window.showPosToast?.(data.message || t('Could not cancel this suspended order.'), 'error');
          return false;
        }
        clearHeldOperationId('cancel', context.id, localStorage);
        heldCancelled = true;
      } catch (error) {
        if (!isCurrentOrderSession(owner)) return false;
        console.error('Failed to cancel recalled held order:', error);
        window.showPosToast?.(t('Could not confirm the cancellation. Retry to finish the same cancellation.'), 'error');
        return false;
      }
    }

    const shouldClear = heldCancelled || opts.skipConfirm || (await window.showPosConfirm(t('Clear current order?')));
    if (!shouldClear) return false;
    if (!isCurrentOrderSession(owner)) return false;

    clearOrderSlice();
    applyDefaultOrderTypeToNewRegisterOrder();
    const ui = useOrderUiStore();
    ui.resetTransient();
    window.history.replaceState(window.history.state, '', window.location.pathname);
    if (activeTable.value?.is_split) {
      clearActiveTableSession({ clearCart: false });
    }
    return true;
  };

  const removeSelectedCartItem = async ({ router } = {}) => {
    if (activeTable.value?.is_split) {
      window.showPosToast?.(t('Split checks are read-only here. Use Edit on the Split Board.'), 'warning');
      return false;
    }
    if (selectedCartIndex.value === null) return false;
    const selectedIndex = selectedCartIndex.value;
    const item = cart.value[selectedIndex];
    if (!item || item.note === 'Auto-Gratuity') return false;

    if (!(Number(item.originalQty) > 0)) {
      cart.value.splice(selectedIndex, 1);
      selectedCartIndex.value = null;
      if (cart.value.length === 0) {
        clearOrderSlice();
        applyDefaultOrderTypeToNewRegisterOrder();
      }
      useOrderUiStore().numpadInput = '';
      return true;
    }

    if (!canVoidActiveTable.value) {
      window.showPosToast?.(t('You do not have permission to void saved items.'), 'error');
      return false;
    }
    if (!activeTable.value?.current_order_id || item.order_item_id == null) {
      window.showPosToast?.(t('This saved item must be reloaded before it can be removed.'), 'error');
      return false;
    }

    const table = { ...activeTable.value };
    const draftChanges = captureUncommittedCartChanges(item.order_item_id);
    return executeTableVoid({
      table,
      items: [{ order_item_id: item.order_item_id, qty: Number(item.originalQty) }],
      draftChanges,
      successMessage: 'Item removed from table',
      router
    });
  };

  const applyLiveNumpad = () => {
    if (activeTable.value?.is_split) return;
    if (selectedCartIndex.value === null) return;
    const item = cart.value[selectedCartIndex.value];
    const ui = useOrderUiStore();
    let parsed = parseFloat(ui.numpadInput);
    const quickAmountMode = getDeps().terminal.quickNumpadMode?.value === true
      && ui.quickTargetAmount == null;

    if (isNaN(parsed)) {
      if (ui.numpadMode === 'qty' && !quickAmountMode) {
        if (item.originalQty && item.originalQty > 1) {
          window.showPosToast?.(t('Use Remove to remove a saved item.'), 'error');
          ui.numpadInput = '';
          return;
        }
        item.qty = 1;
      }
      else if (ui.numpadMode === 'price' || quickAmountMode) { /* empty input: keep existing price, don't zero */ }
      else if (ui.numpadMode === 'discount') item.discountValue = 0;
      return;
    }

    const canSetItemQuantity = (targetQty) => {
      if (targetQty > Number(item.qty || 0) && !canAddCatalogProduct(item)) {
        window.showPosToast?.(t('This product is sold out. You can keep the current quantity, but cannot add more.'), 'warning');
        ui.numpadInput = '';
        return false;
      }
      if (item.originalQty && targetQty < item.originalQty) {
        window.showPosToast?.(t('Use Remove to remove a saved item.'), 'error');
        ui.numpadInput = '';
        return false;
      }
      if (item.originalQty && targetQty > item.originalQty && !canUpdateTable.value) {
        window.showPosToast?.(t('You do not have permission to modify a saved item. Add a new line instead.'), 'error');
        ui.numpadInput = '';
        return false;
      }
      if (targetQty > Number(item.qty || 0) && !item.is_custom && getDeps().products.settings.value?.stock_enabled === '1') {
        const catalog = getDeps().products.products?.value;
        const current = Array.isArray(catalog) ? catalog.find(entry => String(entry.id) === String(item.id)) : null;
        // Not loaded or untracked: the server stays authoritative.
        if (current && current.stock !== null && current.stock !== undefined && current.stock !== '' && Number.isFinite(Number(current.stock))) {
          const originalQty = parseFloat(item.originalQty) || 0;
          const otherPending = getPendingQtyInCart(item.id) - Math.max(0, Number(item.qty) - originalQty);
          const availableStock = Math.max(0, Number(current.stock) - otherPending);
          if (targetQty - originalQty > availableStock + 1e-9) {
            window.showPosToast?.(t("Insufficient stock! Only {stock} remaining (you have {cartQty} in your cart).")
              .replace("{stock}", availableStock)
              .replace("{cartQty}", otherPending), 'error');
            ui.numpadInput = '';
            return false;
          }
        }
      }
      return true;
    };

    if (ui.numpadMode === 'qty' && !quickAmountMode) {
      const targetQty = parsed > 0 ? parsed : 1;
      if (!canSetItemQuantity(targetQty)) return;
      item.qty = targetQty;
    }
    else if (ui.numpadMode === 'price' || quickAmountMode) {
      if (!priceAmountOriginalQty.has(item)) priceAmountOriginalQty.set(item, Number(item.qty));
      const unitAmount = getItemTotalGross({ ...item, qty: 1 });
      if (!(parsed > 0) || !(unitAmount > 0)) {
        window.showPosToast?.(t('Enter a valid amount for this item.'), 'error');
        ui.numpadInput = '';
        return;
      }
      const targetQty = roundSix(parsed / unitAmount);
      if (!(targetQty > 0)) {
        window.showPosToast?.(t('Enter a valid amount for this item.'), 'error');
        ui.numpadInput = '';
        return;
      }
      if (!canSetItemQuantity(targetQty)) return;
      item.qty = targetQty;
    }
    else if (ui.numpadMode === 'discount') {
      if (!canApplyDiscount.value) {
        window.showPosToast?.(t("You do not have permission to apply discounts."), "error");
        ui.numpadInput = "";
        return;
      }
      item.discountType = 'percent';
      item.discountValue = Math.min(100, Math.max(0, parsed));
    }
  };

  const appendNumpad = (val) => {
    const ui = useOrderUiStore();
    if (ui.quickTargetAmount != null) {
      ui.clearQuickTargetAmount();
      ui.numpadInput = '';
    }
    if (val === "." && ui.numpadInput.includes(".")) return;
    if (ui.numpadInput === "0" && val !== ".") ui.numpadInput = val;
    else ui.numpadInput += val;
    applyLiveNumpad();
  };

  const clearNumpad = () => {
    const ui = useOrderUiStore();
    ui.clearQuickTargetAmount();
    const quickAmountMode = getDeps().terminal.quickNumpadMode?.value === true;
    if ((ui.numpadMode === 'price' || quickAmountMode) && selectedCartIndex.value !== null) {
      const item = cart.value[selectedCartIndex.value];
      if (item && priceAmountOriginalQty.has(item)) {
        item.qty = priceAmountOriginalQty.get(item);
        priceAmountOriginalQty.delete(item);
      }
    }
    ui.numpadInput = "";
    applyLiveNumpad();
  };

  const backspaceNumpad = () => {
    const ui = useOrderUiStore();
    if (ui.quickTargetAmount != null) {
      ui.clearQuickTargetAmount();
      ui.numpadInput = '';
    }
    ui.numpadInput = ui.numpadInput.slice(0, -1);
    applyLiveNumpad();
  };

  const pricesMatch = (left, right) => Math.abs((parseFloat(left) || 0) - (parseFloat(right) || 0)) < 0.0001;

  const findScannedCartLineIndex = (product, finalPrice, extraNote) => {
    for (let i = cart.value.length - 1; i >= 0; i--) {
      const item = cart.value[i];
      if (item.is_custom) continue;
      if (String(item.id) !== String(product.id)) continue;
      if ((item.note || "") !== (extraNote || "")) continue;
      if (item.discountType || parseFloat(item.discountValue || 0) !== 0) continue;
      if (!pricesMatch(item.price, finalPrice)) continue;
      return i;
    }
    return -1;
  };

  const processFinalAddToCart = (product, qty, finalPrice, extraNote, options = {}) => {
    if (activeTable.value?.is_split) {
      window.showPosToast?.(t('Split checks are read-only here. Use Edit on the Split Board.'), 'warning');
      return false;
    }
    if (!canAddCatalogProduct(product)) {
      window.showPosToast?.(t('This product is sold out.'), 'warning');
      return false;
    }

    if (options.mergeScanned) {
      const existingIndex = findScannedCartLineIndex(product, finalPrice, extraNote);
      if (existingIndex !== -1) {
        const existingItem = cart.value[existingIndex];
        const nextQty = (parseFloat(existingItem.qty) || 0) + (parseFloat(qty) || 1);
        existingItem.qty = roundSix(nextQty);
        selectedCartIndex.value = existingIndex;
        void ensureAutoTableServiceCharge();
        return true;
      }
    }

    // A line keeps only what the cart, receipt and server read. The catalog's
    // modifier definition, stock, card colour and price-list columns stay on the
    // product; copying them made every persist, save, hold and held-board read
    // grow with the menu instead of the order.
    const {
      modifiers: _modifiers, parsedMods: _parsedMods, barcode: _barcode, stock: _stock,
      background_color: _backgroundColor, category_name: _categoryName, category_is_active: _categoryIsActive,
      base_price: _basePrice, price_list_root_id: _priceListRootId, price_list_root_name: _priceListRootName,
      has_price_override: _hasPriceOverride,
      ...lineFields
    } = product;
    const newItem = {
      ...lineFields,
      price: finalPrice,
      cartId: Date.now() + Math.random().toString(36).substr(2, 9),
      qty: qty,
      note: extraNote,
      discountType: null,
      discountValue: 0,
      selectedModifiers: options.selectedModifiers || product.selectedModifiers || null,
      modifier_surcharge: Number(options.modifierSurcharge) > 0 ? Number(options.modifierSurcharge) : null,
      modifier_tax_amount: options.modifierTaxAmount != null && Number(options.modifierTaxAmount) >= 0
        ? Number(options.modifierTaxAmount) : null
    };

    // Bundle: deep-clone sub-items so per-line edits (notes/removals) do not mutate
    // the catalog product object. The parent newItem.price is the only priced line;
    // sub-items carry no price (see rawSubtotal comment above).
    if (Number(product.is_bundle) === 1 && Array.isArray(product.bundleItems)) {
      newItem.is_bundle = true;
      newItem.bundleItems = product.bundleItems.map(sub => ({
        product_id: sub.product_id,
        name: sub.name,
        qty: Number(sub.qty) || 1,
        category_id: sub.category_id,
        tax_rate: sub.tax_rate,
        jofotara_tax_category: sub.jofotara_tax_category || 'O',
        modifiers: sub.modifiers,
        note: '',
        removed: false,
        selectedModifiers: []
      }));
      newItem._modified = false;
    }

    if (selectedCartIndex.value !== null) {
      cart.value.splice(selectedCartIndex.value + 1, 0, newItem);
    } else {
      cart.value.push(newItem);
    }

    selectedCartIndex.value = null;
    void ensureAutoTableServiceCharge();
    return true;
  };

  const getQtyInCart = (productId) => {
    return cartQuantityIndex.value.get(String(productId)) ?? 0;
  };
  // Stock checks use this: saved quantity is already off product.stock.
  const getPendingQtyInCart = (productId) => {
    return pendingQuantityIndex.value.get(String(productId)) ?? 0;
  };

  const getAddQuantity = (useNumpad = true) => {
    const ui = useOrderUiStore();
    if (!useNumpad || !ui.numpadInput) return 1;
    const parsedQty = parseFloat(ui.numpadInput);
    return !isNaN(parsedQty) && parsedQty > 0 ? parsedQty : 1;
  };

  const cancelQuickAmount = () => {
    const ui = useOrderUiStore();
    ui.clearQuickTargetAmount();
    ui.numpadInput = '';
  };

  const armQuickAmount = () => {
    const ui = useOrderUiStore();
    if (selectedCartIndex.value !== null) {
      cancelQuickAmount();
      return false;
    }
    const amount = roundSix(Number(ui.numpadInput));
    if (!(amount > 0)) {
      cancelQuickAmount();
      window.showPosToast?.(t('Enter a valid quantity first.'), 'warning');
      return false;
    }
    ui.quickTargetAmount = amount;
    return true;
  };

  const applyQuantityPreset = (value) => {
    const quantity = Number(value);
    if (!(Number.isFinite(quantity) && quantity > 0)) return false;

    const ui = useOrderUiStore();
    clearNumpad();
    ui.setNumpadMode('qty');
    ui.numpadInput = String(value);

    if (selectedCartIndex.value === null) {
      if (getDeps().terminal.quickNumpadMode?.value === true) {
        ui.quickTargetAmount = quantity;
      }
      return true;
    }

    if (getDeps().terminal.quickNumpadMode?.value === true) {
      ui.quickTargetAmount = quantity;
    }
    applyLiveNumpad();
    ui.clearQuickTargetAmount();
    ui.numpadInput = '';
    return true;
  };

  const quantityForTargetAmount = (product, targetAmount) => {
    const plainLine = {
      ...product,
      discountType: null,
      discountValue: 0,
      modifier_surcharge: null,
      modifier_tax_amount: null,
      selectedModifiers: null
    };
    const unitAmount = getItemTotalGross({ ...plainLine, qty: 1 });
    if (!(Number.isFinite(unitAmount) && unitAmount > 0)) return null;
    const qty = roundSix(targetAmount / unitAmount);
    if (!(qty > 0)) return null;
    return roundMoney(getItemTotalGross({ ...plainLine, qty })) === roundMoney(targetAmount) ? qty : null;
  };

  const addToCart = async (product, options = {}) => {
    const isBarcodeAdd = options.source === "barcode" || options.mergeScanned === true;
    const deps = getDeps();
    const ui = useOrderUiStore();
    const usesQuickAmount = options.source === 'catalog' && options.useQuickAmount === true;
    const hasExplicitTargetAmount = Object.prototype.hasOwnProperty.call(options, 'targetAmount');
    const quickQuantity = usesQuickAmount ? Number(ui.quickTargetAmount) : null;
    const targetAmount = hasExplicitTargetAmount
      ? Number(options.targetAmount)
      : (usesQuickAmount && !(quickQuantity > 0) ? roundMoney(Number(ui.numpadInput)) : null);
    if (usesQuickAmount || ui.quickTargetAmount != null) cancelQuickAmount();
    if (hasExplicitTargetAmount && !(Number.isFinite(targetAmount) && targetAmount > 0)) return false;
    const targetQty = targetAmount > 0 ? quantityForTargetAmount(product, targetAmount) : null;
    if (targetAmount > 0 && targetQty == null) {
      await window.showPosAlert(t('This product needs a valid price before its quantity can be calculated.'));
      return false;
    }
    const qtyToAdd = quickQuantity > 0
      ? quickQuantity
      : (targetQty ?? getAddQuantity(!isBarcodeAdd && !usesQuickAmount));

    if (isNoteProduct(product)) {
      window.showPosToast?.(t('Note products must be added to an item.'), 'warning');
      return false;
    }

    if (!canAddCatalogProduct(product)) {
      await window.showPosAlert(t('This product is sold out.'));
      return false;
    }

    if (deps.products.settings.value?.stock_enabled === '1' && product.stock !== null && product.stock !== '') {
      const currentInCart = getPendingQtyInCart(product.id);
      const availableStock = Math.max(0, Number(product.stock) - currentInCart);

      if (availableStock - qtyToAdd < 0) {
        await window.showPosAlert(t("Insufficient stock! Only {stock} remaining (you have {cartQty} in your cart).")
          .replace("{stock}", availableStock)
          .replace("{cartQty}", currentInCart));
        return false;
      }
    }

    let parsedMods = [];
    if (product.modifiers) {
      let temp = product.modifiers;
      while (typeof temp === 'string') {
        try {
          temp = JSON.parse(temp);
        } catch (e) {
          break;
        }
      }
      if (Array.isArray(temp)) parsedMods = temp;
    }
    if (parsedMods.length > 0 && !isBarcodeAdd) {
      ui.activeModifierProduct = { ...product, parsedMods };
      ui.activeModifierQty = qtyToAdd;
      const initialMods = {};
      parsedMods.forEach((g, i) => { initialMods[i] = []; });
      ui.selectedModifiers = initialMods;
      ui.showModifierModal = true;
      ui.numpadInput = "";
      return true;
    }
    const added = processFinalAddToCart(product, qtyToAdd, product.price, "", { mergeScanned: isBarcodeAdd });
    ui.numpadInput = "";
    ui.setNumpadMode('qty');
    return added;
  };

  // All or nothing: every draft line must resolve (lines outside the loaded catalog
  // scope come from one bounded exact-id read kept local to the import), be sellable
  // and fit stock; otherwise nothing is imported and the draft stays. A complete
  // import dismisses exactly the imported draft.
  const importQrDraftItems = async (productList = []) => {
    const draft = Array.isArray(activeQrDraft.value) ? activeQrDraft.value : [];
    if (draft.length === 0) return { success: false, imported: 0 };
    const nameList = (items) => items.map(item => item.name || `#${item.product_id}`).join('، ');

    const productsById = new Map((productList || []).map(product => [String(product.id), product]));
    const missingIds = [...new Set(draft.map(item => String(item.product_id)))]
      .filter(id => /^[1-9]\d*$/.test(id) && !productsById.has(id));
    if (missingIds.length > 0 && missingIds.length <= 300) {
      try {
        const { response, data } = await orderSessionApi.getProductsByIds(missingIds, getDeps().products.salesContext?.value || 'register');
        if (!response.ok || !data?.success) throw new Error('product lookup refused');
        for (const product of data.products || []) productsById.set(String(product.id), product);
      } catch (err) {
        console.error('Failed to resolve QR draft products:', err);
        await window.showPosAlert?.(t('Could not load the QR order items. Nothing was imported. Check the connection and try again.'));
        return { success: false, imported: 0, reason: 'lookup' };
      }
    }
    if (activeQrDraft.value !== draft) {
      await window.showPosAlert?.(t('The QR order changed while importing. Nothing was imported. Review it and try again.'));
      return { success: false, imported: 0, reason: 'changed' };
    }

    const lines = [];
    const unresolved = [];
    const requestedByProduct = new Map();
    for (const draftItem of draft) {
      const qty = parseFloat(draftItem.qty) || 1;
      if (qty <= 0) continue;
      const product = productsById.get(String(draftItem.product_id));
      if (!product) { unresolved.push(draftItem); continue; }
      lines.push({ product, qty, draftItem });
      const key = String(product.id);
      requestedByProduct.set(key, (requestedByProduct.get(key) || 0) + qty);
    }

    if (unresolved.length > 0) {
      await window.showPosAlert?.(t('These QR items are no longer on the menu, so nothing was imported: {items}').replace('{items}', nameList(unresolved)));
      return { success: false, imported: 0, reason: 'unresolved' };
    }
    if (lines.length === 0) {
      await window.showPosAlert?.(t('The QR order has no items to import.'));
      return { success: false, imported: 0, reason: 'empty' };
    }

    if (lines.some(({ product }) => isNoteProduct(product))) {
      window.showPosToast?.(t('Note products must be added to an item.'), 'warning');
      return { success: false, imported: 0, reason: 'note_product' };
    }

    const soldOut = lines.filter(({ product }) => !canAddCatalogProduct(product));
    if (soldOut.length > 0) {
      await window.showPosAlert?.(t('These QR items are sold out, so nothing was imported: {items}').replace('{items}', nameList(soldOut.map(line => line.draftItem))));
      return { success: false, imported: 0, reason: 'sold_out' };
    }

    const deps = getDeps();
    if (deps.products.settings.value?.stock_enabled === '1') {
      for (const { product } of lines) {
        if (product.stock === null || product.stock === undefined || product.stock === '') continue;
        const requestedQty = requestedByProduct.get(String(product.id)) || 0;
        const currentInCart = getPendingQtyInCart(product.id);
        const availableStock = Math.max(0, Number(product.stock) - currentInCart);
        if (availableStock - requestedQty < 0) {
          await window.showPosAlert?.(`${product.name}: ${t("Insufficient stock! Only {stock} remaining (you have {cartQty} in your cart).")
            .replace("{stock}", availableStock)
            .replace("{cartQty}", currentInCart)}`);
          return { success: false, imported: 0, reason: 'stock' };
        }
      }
    }

    for (const { product, qty } of lines) {
      processFinalAddToCart(product, qty, product.price, "", { mergeScanned: true });
    }

    const tableId = activeTable.value?.id;
    const dismissed = tableId ? await dismissActiveQrDraft(tableId, { imported: draft }) : 'ok';
    return { success: true, imported: lines.length, dismissed };
  };

  const toggleModifier = (gIndex, oIndex, isMulti) => {
    const ui = useOrderUiStore();
    if (!ui.selectedModifiers[gIndex]) {
      ui.selectedModifiers[gIndex] = [];
    }
    const current = [...ui.selectedModifiers[gIndex]];
    if (isMulti) {
      const idx = current.indexOf(oIndex);
      if (idx > -1) current.splice(idx, 1); else current.push(oIndex);
      ui.selectedModifiers[gIndex] = current;
    } else {
      const idx = current.indexOf(oIndex);
      if (idx > -1) {
        ui.selectedModifiers[gIndex] = [];
      } else {
        ui.selectedModifiers[gIndex] = [oIndex];
      }
    }
    ui.selectedModifiers = { ...ui.selectedModifiers };
  };

  const cancelModifiers = () => {
    const ui = useOrderUiStore();
    ui.showModifierModal = false;
    ui.activeModifierProduct = null;
    ui.activeModifierQty = 1;
    ui.selectedModifiers = {};
    cancelQuickAmount();
  };

  const confirmModifiers = async () => {
    const ui = useOrderUiStore();
    const product = ui.activeModifierProduct;
    let extraPrice = 0;
    let noteLines = [];
    let selectedModifiers = [];
    for (let gIndex = 0; gIndex < product.parsedMods.length; gIndex++) {
      const group = product.parsedMods[gIndex];
      const selections = ui.selectedModifiers[gIndex] || [];
      if (group.required && selections.length === 0) {
        await window.showPosAlert(t("Requirement Missing: You must select an option for \"{group}\".").replace("{group}", group.name));
        return;
      }
      selections.forEach(optIndex => {
        const opt = group.options[optIndex];
        const priceExt = parseFloat(opt.price || 0);
        extraPrice += priceExt;
        noteLines.push(`${group.name}: ${opt.name}` + (priceExt > 0 ? ` (${priceExt.toFixed(2)} JD)` : ''));
        selectedModifiers.push({
          gid: group.id,
          oid: opt.id,
          group: group.name,
          option: opt.name,
          price: priceExt
        });
      });
    }
    // Mirror applyDatabasePrices exactly: final price rounds the raw DB fold,
    // while the per-unit surcharge itself is the separately rounded metadata.
    const modifierSurcharge = extraPrice > 0 ? Number(extraPrice.toFixed(6)) : null;
    const includedModifierTax = modifierSurcharge != null
      ? Number(modifierTaxAmount(modifierSurcharge, Number(product.tax_rate || 0)).toFixed(6))
      : null;
    const finalPrice = Number((parseFloat(product.price) + extraPrice).toFixed(4));
    const added = processFinalAddToCart(product, ui.activeModifierQty, finalPrice, noteLines.join('\n'), {
      selectedModifiers,
      modifierSurcharge,
      modifierTaxAmount: includedModifierTax
    });
    cancelModifiers();
    return added;
  };

  const openNoteModal = (target) => {
    const ui = useOrderUiStore();
    ui.modalTarget = target;
    ui.tempNote = target === "item" ? editableItemNote(cart.value[selectedCartIndex.value]) : orderNote.value;
    ui.activeModal = "note";
  };

  const saveNote = () => {
    const ui = useOrderUiStore();
    if (ui.modalTarget?.kind === 'bundleSub') {
      // Sub-item note flow: modalTarget = {kind:'bundleSub', item, sub}.
      // Set sub.note, then recompute parent _modified flag.
      ui.modalTarget.sub.note = ui.tempNote;
      ui.modalTarget.item._modified =
        ui.modalTarget.item.bundleItems.some(s => s.note) ||
        ui.modalTarget.item.bundleItems.some(s => s.removed);
    } else if (ui.modalTarget === "item") {
      saveEditableItemNote(cart.value[selectedCartIndex.value], ui.tempNote);
    } else {
      orderNote.value = ui.tempNote;
    }
    ui.activeModal = null;
  };

  const openDiscountModal = (target) => {
    if (!canApplyDiscount.value) {
      window.showPosToast?.(t("You do not have permission to apply discounts."), "error");
      return;
    }
    const ui = useOrderUiStore();
    ui.modalTarget = target;
    if (target === "item") {
      const item = cart.value[selectedCartIndex.value];
      ui.tempDiscount = { type: item.discountType || "percent", value: item.discountValue || 0 };
    } else {
      ui.tempDiscount = { ...orderDiscount.value };
    }
    ui.activeModal = "discount";
  };

  const saveDiscount = () => {
    if (!canApplyDiscount.value) {
      window.showPosToast?.(t("You do not have permission to apply discounts."), "error");
      return;
    }
    const ui = useOrderUiStore();

    let clampedValue = parseFloat(ui.tempDiscount.value) || 0;
    if (ui.tempDiscount.type === "percent") {
      clampedValue = Math.max(0, Math.min(100, clampedValue));
    } else {
      let maxLimit = 0;
      if (ui.modalTarget === "item") {
        const item = cart.value[selectedCartIndex.value];
        maxLimit = item ? parseFloat(item.price || 0) : 0;
      } else {
        maxLimit = parseFloat(rawSubtotal.value || 0);
      }
      clampedValue = Math.max(0, Math.min(maxLimit, clampedValue));
    }
    ui.tempDiscount.value = clampedValue;

    if (ui.modalTarget === "item") {
      cart.value[selectedCartIndex.value].discountType = ui.tempDiscount.type;
      cart.value[selectedCartIndex.value].discountValue = clampedValue;
    } else {
      orderDiscount.value = { ...ui.tempDiscount };
    }
    ui.activeModal = null;
  };

  const clearDiscount = () => {
    const ui = useOrderUiStore();
    if (ui.modalTarget === "item") {
      cart.value[selectedCartIndex.value].discountValue = 0;
    } else {
      orderDiscount.value = { type: "percent", value: 0 };
      clearOrderDiscount(localStorage);
    }
    ui.activeModal = null;
  };

  const openCheckoutModal = () => {
    if (cart.value.length === 0 && !pendingCheckout.value) return;
    const ui = useOrderUiStore();
    if (isCallCenter.value) {
      clearCachedCheckoutAttempt();
      ui.activeIdempotencyKey = '';
      ui.paymentMethod = null;
      ui.amountTendered = 0;
      ui.splitCardAmount = null;
      ui.splitCashTendered = null;
      ui.checkoutError = '';
      ui.showCheckoutModal = true;
      return;
    }
    ui.activeIdempotencyKey = '';
    syncCheckoutPaymentForOrderType();
    ensureCheckoutIdempotencyKey();
    ui.checkoutError = "";
    ui.showCheckoutModal = true;
  };

  const readJofotaraCheckoutStatus = async (payload) => {
    const statusRequest = orderSessionApi.getJofotaraCheckoutStatus(payload)
      .then(({ response, data }) => response?.ok && data?.success ? data : null)
      .catch(() => null);
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), JOFOTARA_STATUS_CEILING_MS));
    return Promise.race([statusRequest, timeout]);
  };

  const queueAutomaticReceiptSet = async ({ lastOrder, invoiceId, checkoutKey }) => {
    const key = `${checkoutKey}:${invoiceId}`;
    if (decidedFiscalReceiptKeys.has(key)) return;
    decidedFiscalReceiptKeys.add(key);
    const primary = { ...lastOrder, print_request_id: `checkout-receipt:${invoiceId}:primary` };
    const terminal = getDeps().terminal;
    const result = await terminal.dispatchToNodeSpooler('receipt', primary, { saved: true });
    if (result?.success && terminal.duplicateCustomerReceipt?.value) {
      await terminal.dispatchToNodeSpooler('receipt', { ...lastOrder, print_request_id: `checkout-receipt:${invoiceId}:duplicate` }, { saved: true });
    }
    return result;
  };

  const startJofotaraFinalization = (payload) => orderSessionApi.finalizeJofotaraCheckout(payload)
      .then(({ response, data }) => response?.ok && data?.success ? data : null)
      .catch(() => null);

  const runAutomaticReceiptFastPath = async ({ payload, finalization, checkoutKey, invoiceId, lastOrder }) => {
    const deadline = new Promise(resolve => setTimeout(() => resolve(null), JOFOTARA_PROVIDER_WINDOW_MS));
    const raced = await Promise.race([finalization, deadline]);
    let fiscal = raced;
    const accepted = value => value?.status === 'accepted' && typeof value?.document?.qr_text === 'string' && value.document.qr_text.length > 0;
    if (!accepted(fiscal)) fiscal = await readJofotaraCheckoutStatus(payload);
    const hasAcceptedQr = accepted(fiscal);
    try {
      await queueAutomaticReceiptSet({ lastOrder, invoiceId, checkoutKey });
    } catch (printError) {
      console.error('Automatic receipt print failed (order already charged):', printError);
    }
    if (!hasAcceptedQr) {
      window.showPosToast?.(t('Sale succeeded, but JoFotara needs attention in Operations.'), 'warning');
    }
    return { fiscal, hasAcceptedQr };
  };

  const processCheckout = async ({ reclaimed = false, router } = {}) => {
    const ui = useOrderUiStore();
    if (ui.isProcessing || ui.isHolding || checkoutInFlight.value) return;
    const processingRequest = ++checkoutRequestSeq;
    const deps = getDeps();
    ui.isProcessing = true;
    ui.checkoutError = "";

    const checkoutOwner = captureOrderSession();
    let checkoutKey = '';
    let serverConfirmed = false;
    let reclaimAndRetry = false;
    let firstSend = false;
    checkoutInFlight.value = true;
    try {
      const pending = loadPendingCheckout();
      if (!pending && cart.value.length === 0) return;
      if (!deps.terminal.settingsLoaded.value && !await deps.terminal.ensureSettings()) {
        ui.checkoutError = t('Settings could not be loaded. Retry before checkout or printing.');
        return;
      }
      if (!isCurrentOrderSession(checkoutOwner)) return;
      const currentShiftId = deps.auth.activeShift.value?.id || null;

      if (!pending && selectedOrderTypeRequiresHash.value && !hashNumber.value.trim()) {
        ui.checkoutError = "A Hash Number is required for this order type!";
        ui.isProcessing = false;
        return;
      }

      checkoutKey = pending?.frozen.payload.idempotency_key || ensureCheckoutIdempotencyKey();

      const checkoutTableOwner = captureTableSession();
      const kitchenAlreadyFired = restoredHeldOrder.value?.kitchenFired === true;
      let { payload, frozen } = buildCheckoutRequest({
        user: deps.auth.activeUser.value,
        shiftId: currentShiftId,
        cart: cart.value,
        table: activeTable.value,
        editingInvoiceId: editingInvoiceId.value,
        editingOrderId: editingOrderId.value,
        orderTypeId: selectedOrderType.value,
        orderTypeDeferred: Number(selectedOrderTypeObj.value?.is_deferred_settlement) === 1,
        orderTypeName: orderTypes.value.find((type) => String(type.id) === String(selectedOrderType.value))?.name || "",
        requiresHash: selectedOrderTypeRequiresHash.value,
        hashNumber: hashNumber.value,
        customer: { phone: customerPhone.value, name: customerName.value, address: customerAddress.value, deliveryDate: orderDate.value, note: orderNote.value },
        totals: { subtotal: cartSubtotal.value, discount: cartOrderDiscountAmount.value, tax: cartTax.value, total: cartTotal.value },
        orderDiscount: orderDiscount.value,
        payment: { method: ui.paymentMethod, amountTendered: ui.amountTendered, splitCardAmount: ui.splitCardAmount, splitCashTendered: ui.splitCashTendered, changeDue: changeDue.value },
        serviceChargeSnapshot: serviceChargeSnapshot.value,
        idempotencyKey: checkoutKey,
        tableOwner: checkoutTableOwner,
        taxInclusive: effectiveTaxInclusive.value,
        taxRegistrationType: taxRegistrationType.value,
        taxExempt: isTaxExempt.value,
        heldOrderContext: restoredHeldOrder.value,
        managerPin: deps.auth.isTempAdmin?.value ? deps.auth.activeManagerPin?.value : null,
      });
      if (pending) {
        frozen = pending.frozen;
        payload = { ...frozen.payload, ...(payload.manager_pin ? { manager_pin: payload.manager_pin } : {}) };
      } else {
        persistOrderContext();
        // Written before the send so a reload can recover it, but only shown once this send
        // settles without an answer: a normal payment in flight is not a "no reply" case.
        savePendingCheckout({ draftId: checkoutDraftId, frozen, kitchenFired: kitchenAlreadyFired });
        firstSend = true;
      }
      // This send makes the outcome unknown again: drop the previous status check and restart
      // the discard age from now, since this request may still commit after its deadline.
      if (pending) {
        lastSendByKey.set(checkoutKey, Date.now());
        pendingCheckoutProbe.value = null;
        const sent = { ...pending, lastSentAt: Date.now() };
        try { savePendingCheckout(sent); } catch (_) { /* this tab still counts the wait from this send */ }
        pendingCheckout.value = sent;
      }
      const { response, data } = await orderSessionApi.checkoutOrder(payload);
      if (data.success) {
        serverConfirmed = true;
        if (checkoutKey && completedCheckoutKeys.has(checkoutKey)) {
          return;
        }

        const { lastOrder, wasTableOrder } = buildSuccessfulCheckoutResult({ response: data, frozen });
        deps.terminal.lastOrder.value = { ...lastOrder, print_request_id: `checkout-receipt:${data.invoice_id}:primary` };
        const completedOrderPayload = JSON.parse(JSON.stringify(deps.terminal.lastOrder.value));
        const userRole = frozen.cashier.role;
        const ownsCheckoutSession = isCurrentOrderSession(checkoutOwner) && (!pending || pending.draftId === checkoutDraftId);

        if (ownsCheckoutSession) {
          finalizeCheckout();
          if (wasTableOrder) clearActiveTableSession({ clearCart: false });
        }
        clearPendingCheckout(frozen.payload.user_id, checkoutKey);
        pendingCheckout.value = null;
        lastSendByKey.delete(checkoutKey);
        if (checkoutKey) completedCheckoutKeys.add(checkoutKey);
        if (!ownsCheckoutSession) {
          // The recovery panel is done; never leave a live Pay screen open on the cashier's other
          // draft. Only hide it: the newer draft's own retry key must survive.
          ui.showCustomerDrawer = false;
          ui.showCheckoutModal = false;
          window.showPosToast?.(t('Previous sale completed. Your current draft was kept.'), 'warning');
        }
        const fiscalRequired = data.jofotara?.required === true;
        const fiscalPayload = { idempotency_key: checkoutKey, shift_id: frozen.payload.shift_id };
        const fiscalFinalization = fiscalRequired ? startJofotaraFinalization(fiscalPayload) : null;
        const fiscalFastPath = fiscalRequired && deps.terminal.printMethod.value === 'backend'
          ? runAutomaticReceiptFastPath({
            payload: fiscalPayload,
            finalization: fiscalFinalization,
            checkoutKey,
            invoiceId: data.invoice_id,
            lastOrder: completedOrderPayload
          })
          : null;
        if (fiscalFinalization && !fiscalFastPath) {
          fiscalFinalization.then((fiscal) => {
            if (fiscal?.status !== 'accepted') {
              window.showPosToast?.(t('Sale succeeded, but JoFotara needs attention in Operations.'), 'warning');
            }
          });
        }

        const receiptOwner = captureOrderSession();
        const returnToTablesAfterCheckout = wasTableOrder && ownsCheckoutSession
          && (userRole === 'admin' || userRole === 'programmer');

        // The sale is final here. Printing, the success dialog and the table redirect run
        // detached so a slow print endpoint never holds checkoutInFlight against the next sale.
        // Receipt printing is best-effort and must NEVER turn an already-charged order into a
        // checkout error. Automatic JoFotara receipts run privately with a bounded provider
        // race; browser and disabled/manual backend printing retain their existing behavior.
        const printing = (async () => {
          if (fiscalFastPath || lastOrder.receipt_display_error) return;
          try {
            const receiptAccepted = await deps.terminal.printReceipt(completedOrderPayload, { saved: true });
            if (receiptAccepted && deps.terminal.printMethod.value === 'backend' && deps.terminal.duplicateCustomerReceipt?.value) {
              await deps.terminal.dispatchToNodeSpooler('receipt', { ...completedOrderPayload, print_request_id: `checkout-receipt:${data.invoice_id}:duplicate` }, { saved: true });
            }
          } catch (printErr) {
            console.error('Receipt print failed (order already charged):', printErr);
            window.showPosToast?.(t('Transaction saved. Printing failed; check Printing before retrying.'), 'warning');
          }
        })();
        if (lastOrder.receipt_display_error) window.showPosToast?.(t(canReprint.value
          ? 'Sale completed. Receipt could not be displayed. Reprint it from Orders.'
          : 'Sale completed. Receipt could not be displayed. Ask a manager to reprint it from Orders.'), 'warning');
        // A table redirect would immediately erase a success message. Keep it
        // quiet rather than briefly flashing a dialog during navigation.
        if (ownsCheckoutSession && !returnToTablesAfterCheckout) {
          showPaymentSuccess({ receivable: data.payment_method === 'receivable', platform: data.payment_method === 'platform' });
        }
        if (returnToTablesAfterCheckout) {
          const returnToTables = () => {
            if (!isCurrentOrderSession(receiptOwner) || cart.value.length) return;
            if (router) router.push('/tables');
            else window.location.href = '/tables';
          };
          // A router navigation keeps in-flight spooler and fiscal fetches alive (they toast through
          // the app-level showPosToast), so leave as soon as the sale is final. Browser printing
          // renders the receipt layout inside the POS view before window.print(), and a reload
          // (no-router fallback) would cancel fetches, so those still leave after printing settles.
          if (router && deps.terminal.printMethod.value === 'backend') returnToTables();
          else (fiscalFastPath || printing).then(returnToTables, returnToTables);
        }
      } else {
        if (!pending && Number(response.status || 400) < 500) {
          clearPendingCheckout(frozen.payload.user_id, checkoutKey);
          pendingCheckout.value = null;
        }
        if (!isCurrentOrderSession(checkoutOwner)) return;
        // A lapsed lease on a restored hold is refused before anything commits:
        // re-claim once, then retry once (the new version yields a new key).
        reclaimAndRetry = !pending && !reclaimed && response.status === 409
          && data.code === 'HELD_CLAIM_REQUIRED' && Boolean(restoredHeldOrder.value?.id);
        if (!reclaimAndRetry) {
          if (await handleServiceChargeSnapshotConflict(response.status, data)) return;
          if (response.status === 409 && ['ORDER_TYPE_UNAVAILABLE', 'ORDER_TYPE_CONTEXT_REQUIRED', 'ORDER_TYPE_SETTLEMENT_CHANGED'].includes(data.code)) {
            clearCachedCheckoutAttempt();
            ui.activeIdempotencyKey = '';
            await fetchOrderTypes({ force: true });
          }
          ui.checkoutError = data.message || "Failed to process payment.";
        }
      }
    } catch (error) {
      if (isCurrentOrderSession(checkoutOwner)) {
        ui.checkoutError = serverConfirmed
          ? t('Sale completed. Reopen Orders to verify the receipt before starting another sale.')
          : t('No reply from the server yet. Check the connection and press again.');
      }
    } finally {
      // Publish the record only if this first send left it unresolved in storage.
      if (firstSend) loadPendingCheckout();
      checkoutInFlight.value = false;
      if (processingRequest === checkoutRequestSeq) ui.isProcessing = false;
    }
    if (!reclaimAndRetry) return;
    ui.isProcessing = true; // no second Pay with the stale version while re-claiming
    const reclaimError = await reconnectHeldOrder().finally(() => { ui.isProcessing = false; });
    if (!isCurrentOrderSession(checkoutOwner)) return;
    if (reclaimError) { ui.checkoutError = reclaimError; return; }
    return processCheckout({ reclaimed: true, router });
  };

  // Read-only: 200 = the key committed, 404 = no committed order yet, 409 =
  // another cashier holds it. Bounded by the transport deadline.
  const readPendingStatus = (pending) => orderSessionApi.getJofotaraCheckoutStatus({
    idempotency_key: pending.frozen.payload.idempotency_key,
    shift_id: pending.frozen.payload.shift_id,
  }).then(({ response }) => response?.status ?? null, () => null);
  const recordProbe = (pending, status) => {
    pendingCheckoutProbe.value = { key: pending.frozen.payload.idempotency_key, status, at: Date.now() };
  };
  let pendingProbe = null;
  // Runs on reconnect, heartbeat and activation; a no-op without a record.
  // Only a committed key is replayed: the server answers with the original
  // sale and no new charge, and the normal success path prints and clears.
  // The heartbeat stops once the outcome is settled enough for a person to act
  // (Discard is offered, or another cashier owns the key); reconnect and activation
  // still re-check, so a record never costs a standing request stream.
  const probePendingCheckout = ({ heartbeat = false, router } = {}) => {
    if (pendingProbe) return pendingProbe;
    const ui = useOrderUiStore();
    if (checkoutInFlight.value || ui.isProcessing || ui.isHolding) return Promise.resolve(null);
    const pending = loadPendingCheckout();
    if (!pending) return Promise.resolve(null);
    if (heartbeat && (canDiscardPendingCheckout.value || (pendingCheckoutProbe.value?.status === 409
      && pendingCheckoutProbe.value.key === pending.frozen.payload.idempotency_key))) return Promise.resolve(null);
    pendingProbe = readPendingStatus(pending).then(async (status) => {
      if (pendingCheckout.value?.frozen.payload.idempotency_key !== pending.frozen.payload.idempotency_key) return null;
      recordProbe(pending, status);
      if (status === 200 && !checkoutInFlight.value) await processCheckout({ router });
      return status;
    }).finally(() => { pendingProbe = null; });
    return pendingProbe;
  };
  // The original (or latest) request can still be running on the server after the client
  // deadline, so a 404 only counts once the last send is old enough.
  const canDiscardPendingCheckout = computed(() => {
    const pending = pendingCheckout.value, probe = pendingCheckoutProbe.value;
    if (!pending || probe?.status !== 404 || probe.key !== pending.frozen.payload.idempotency_key) return false;
    const sentAt = Math.max(Number(pending.lastSentAt) || 0, Number(pending.savedAt) || 0,
      lastSendByKey.get(pending.frozen.payload.idempotency_key) || 0);
    return !sentAt || probe.at - sentAt >= PENDING_DISCARD_MIN_AGE_MS;
  });
  const discardPendingCheckout = async () => {
    const pending = pendingCheckout.value;
    if (!canDiscardPendingCheckout.value || checkoutInFlight.value || pendingProbe) return false;
    if (!(await window.showPosConfirm?.(t('Only discard if this sale is not in Orders.'), t('Discard: this sale was not saved')))) return false;
    if (pendingCheckout.value !== pending || checkoutInFlight.value || pendingProbe) return false;
    const ui = useOrderUiStore();
    checkoutInFlight.value = true; // no retry can race the final probe
    try {
      const status = await readPendingStatus(pending);
      if (pendingCheckout.value !== pending) return false;
      recordProbe(pending, status);
      if (status !== 404) {
        ui.checkoutError = t('This sale may exist on the server, so it was kept. Retry it or check Orders.');
        return false;
      }
      clearPendingCheckout(pending.frozen.payload.user_id, pending.frozen.payload.idempotency_key);
      lastSendByKey.delete(pending.frozen.payload.idempotency_key);
      loadPendingCheckout();
      ui.checkoutError = '';
      return true;
    } finally {
      checkoutInFlight.value = false;
    }
  };
  const dismissPendingCheckoutUnreadable = () => { pendingCheckoutUnreadable.value = false; };

  const openCashDrawer = async (receiptPrinterId = null) => {
    const deps = getDeps();
    const role = deps.auth.activeUser.value?.role;
    if (!['cashier', 'admin', 'programmer'].includes(role)) return false;

    try {
      const { data } = await orderSessionApi.logDrawerPop({
        receipt_printer_id: receiptPrinterId,
        reason: 'No sale / Manual drawer open'
      });
      if (data.success) {
        await window.showPosAlert(t("Signal sent to pop Cash Drawer!"));
        const ui = useOrderUiStore();
        ui.showMoreActionsModal = false;
        return true;
      } else {
        await window.showPosAlert(data.message || t("Failed to pop drawer."));
      }
    } catch (e) {
      // Not idempotent: the drawer may have opened. Never retry automatically.
      await window.showPosAlert(t(isUnansweredRequest(e) ? "Drawer command not confirmed." : "Failed to pop drawer."));
    }
    return false;
  };

  const printGuestCheck = async () => {
    if (guestCheckInFlight.value || cart.value.length === 0) return false;
    if (!canPrintCheck.value) {
      window.showPosToast?.(t("You do not have permission to print the guest check."), "error");
      return false;
    }
    useOrderUiStore().showMoreActionsModal = false;
    guestCheckInFlight.value = true;
    try {
      return await printGuestCheckOnce();
    } finally {
      guestCheckInFlight.value = false;
    }
  };

  const printGuestCheckOnce = async () => {
    // Persist any pending edits before printing — but only for users who can
    // update the table (waiters/admins). Cashiers are settle-only: their cart
    // already mirrors the saved order, so they print the guest check to hand to
    // the customer without re-saving (and without needing waiter.edit_locked).
    if (activeTable.value && canUpdateTable.value && typeof updateActiveTableOrder === 'function') {
      const saved = await updateActiveTableOrder({ silent: true });
      if (!saved) return false;
      if (!activeTable.value || cart.value.length === 0) return false;
    }

    const owner = captureTableSession();
    const liveTableTarget = activeTable.value
      && !activeTable.value.is_split
      && activeTable.value.id
      && activeTable.value.current_order_id
      ? {
          tableId: activeTable.value.id,
          invoiceId: activeTable.value.current_order_id
        }
      : null;
    const deps = getDeps();
    const now = new Date();
    const activeTableNo = activeTable.value?.table_display_no ||
      (activeTable.value?.table_number == null ? null : String(activeTable.value.table_number));
    const orderTakenAt = activeTable.value?.order_taken_at ||
      activeTable.value?.active_order_created_at ||
      now.toISOString();
    const guestOrder = {
      invoice_id: "GUEST CHECK",
      guest_check: true,
      source_invoice_id: activeTable.value?.current_order_id || null,
      order_id: null,
      invoice_number: null,
      invoice_display_no: null,
      order_display_no: null,
      ticket_display_no: null,
      table_display_no: activeTableNo,
      order_taken_at: orderTakenAt,
      date: orderTakenAt,
      cashier: deps.auth.activeUser.value?.name || "",
      payment_method: "Unpaid",
      order_type_name: orderTypes.value.find((t) => String(t.id) === String(selectedOrderType.value))?.name || "",
      customer_name: customerName.value,
      customer_phone: customerPhone.value,
      customer_address: customerAddress.value,
      delivery_date: orderDate.value,
      order_note: orderNote.value,
      items: JSON.parse(JSON.stringify(cart.value)),
      subtotal: cartSubtotal.value,
      discount: cartOrderDiscountAmount.value,
      tax: cartTax.value,
      total: cartTotal.value,
      amount_tendered: 0,
      change_due: 0,
      hash_number: hashNumber.value,
      table_number: activeTable.value?.table_number || null,
      tax_exempt: isTaxExempt.value
    };
    const previousOrder = deps.terminal.lastOrder.value;
    // Browser print renders lastOrder; window.print() is synchronous, so the
    // sale is restored as soon as printReceipt returns (unless a checkout replaced it).
    deps.terminal.lastOrder.value = guestOrder;
    let printed = false;
    try {
      printed = await deps.terminal.printReceipt();
    } catch (error) {
      console.error('Guest check print failed:', error);
    } finally {
      if (deps.terminal.lastOrder.value === guestOrder) deps.terminal.lastOrder.value = previousOrder;
    }
    if (!printed) return false;
    if (!isCurrentTableSession(owner)) return true;

    if (liveTableTarget) {
      const marked = await markActiveTablePrinted({
        owner,
        tableId: liveTableTarget.tableId,
        invoiceId: liveTableTarget.invoiceId
      });
      if (!marked) {
        window.showPosToast?.(
          t('Guest check printed, but the table status could not be updated.'),
          'warning'
        );
        return false;
      }
    }

    return true;
  };

  const addServiceCharge = async () => {
    if (cart.value.length === 0) return;
    if (!canApplyServiceCharge.value) {
      window.showPosToast?.(t("You do not have permission to apply a service charge."), "error");
      return;
    }

    const ui = useOrderUiStore();
    const existing = cart.value.find(item => item.note === 'Auto-Gratuity');
    if (existing) {
      ui.showMoreActionsModal = false;
      return;
    }

    try {
      const snapshot = await createServiceChargeSnapshot();
      appendServiceCharge(snapshot);
    } catch (error) {
      await window.showPosAlert(error.message || 'Failed to add service charge.');
    }
    ui.showMoreActionsModal = false;
  };

  const removeAutoServiceCharge = async () => {
    const role = getDeps().auth.activeUser.value?.role;
    if (role !== 'admin' && role !== 'programmer') {
      window.showPosToast?.(t('Only an admin or programmer can remove the automatic service charge.'), 'error');
      return false;
    }
    const feeIndex = cart.value.findIndex(item => item.note === 'Auto-Gratuity');
    if (feeIndex === -1) return true;

    const removedFee = cart.value[feeIndex];
    const previousSnapshot = serviceChargeSnapshot.value;
    cart.value.splice(feeIndex, 1);
    autoServiceChargeRemoved.value = true;

    if (activeTable.value?.current_order_id) {
      const saved = await updateActiveTableOrder({ silent: true, skipAutoServiceChargeEnsure: true });
      if (!saved) {
        cart.value.push(removedFee);
        serviceChargeSnapshot.value = previousSnapshot;
        autoServiceChargeRemoved.value = false;
        updateServiceCharge();
        return false;
      }
    } else {
      abandonCurrentServiceChargeSnapshot();
      serviceChargeSnapshot.value = null;
    }
    return true;
  };

  const setItemCourse = (courseData) => {
    if (selectedCartIndex.value !== null) {
      cart.value[selectedCartIndex.value].course = courseData;
      const ui = useOrderUiStore();
      ui.showCourseModal = false;
      selectedCartIndex.value = null;
    }
  };

  const clearItemCourse = () => {
    if (selectedCartIndex.value !== null) {
      cart.value[selectedCartIndex.value].course = null;
      const ui = useOrderUiStore();
      ui.showCourseModal = false;
      selectedCartIndex.value = null;
    }
  };

  const quickLock = () => {
    const ui = useOrderUiStore();
    ui.showMoreActionsModal = false;
    const deps = getDeps();
    if (deps.auth.logout) {
      deps.auth.logout();
    }
  };

  return {
    cart,
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
    activeOrderTaxInclusive,
    activeOrderReceiptTaxInclusive,
    isTaxExempt,
    callCenterSession,
    isCallCenter,
    callCenterCommands,

    orderTypes,
    courses,

    rawSubtotal,
    cartSubtotal,
    cartGrossSubtotal,
    cartOrderDiscountAmount,
    rawDiscountedSubtotal,
    discountedSubtotal,
    cartTax,
    cartTotal,
    cartReceiptPresentation,
    taxInclusivePricing,
    receiptTaxInclusiveDisplay,
    taxRegistrationType,
    changeDue,
    cashShortfall,
    splitBalanceDue,

    getItemTotal,
    getItemTotalGross,
    updateServiceCharge,

    // Table-session state refs
    activeTable,
    activeQrDraft,
    tableSessionSeq,
    invalidateTableSession,
    clearTableScopedResidue,
    loadActiveTableDraft,
    dismissActiveQrDraft,
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

    // Table getters
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

    // Intent Actions
    startNewOrder,
    initializeCallCenterSession,
    startCallCenterOrder,
    findCallCenterOrders,
    continueCallCenterOrder,
    reconnectHeldOrder,
    sendCallCenterOrder,
    cancelCallCenterEdits,
    cancelCallCenterOrder,
    restoreHeldOrder,
    markServerCanonicalRestore,
    consumeServerCanonicalRestore,
    markLocalFallbackRestore,
    consumeRestoreSource,
    sendHeldOrderFollowUp,
    confirmHeldKitchenBaseline,
    claimHeldOrderForHandoff,
    getHeldOrdersSummary,
    releaseHeldOrderClaimBestEffort,
    loadTableOrder,
    closeTable,
    finalizeCheckout,

    // Permission getters
    canApplyDiscount,
    canVoidItems,
    canReprint,
    canApplyServiceCharge,
    canTaxExempt,
    canCheckout,
    canCheckoutTable,
    canPrintCheck,
    canVoidActiveTable,
    hasSavedTableItems,
    canRemoveSelectedCartItem,
    canClearCart,

    // Order type getters
    selectedOrderTypeObj,
    selectedOrderTypeRequiresHash,
    isDirectPlatformCheckout,
    defaultOrderTypeId,
    syncCheckoutPaymentForOrderType,
    checkoutInFlight,
    pendingCheckout,
    pendingCheckoutUnreadable,
    canDiscardPendingCheckout,
    probePendingCheckout,
    discardPendingCheckout,
    dismissPendingCheckoutUnreadable,
    captureOrderSession,
    isCurrentOrderSession,

    // Service charge getters
    serviceChargeEnabled,
    serviceChargePercentage,
    autoApplyServiceCharge,
    canRemoveAutoServiceCharge,
    serviceChargeSnapshot,
    serviceChargeSnapshotPayload,
    handleServiceChargeSnapshotConflict,

    // Ported actions
    loadSavedOrder,
    loadOrderForEditing,
    fetchOrderTypes,
    lookupCustomer,
    handleOrderTypeSelection,
    clearCart,
    removeSelectedCartItem,
    applyLiveNumpad,
    appendNumpad,
    clearNumpad,
    backspaceNumpad,
    armQuickAmount,
    cancelQuickAmount,
    applyQuantityPreset,
    processFinalAddToCart,
    importQrDraftItems,
    getQtyInCart,
    getPendingQtyInCart,
    addToCart,
    toggleModifier,
    confirmModifiers,
    cancelModifiers,
    openNoteModal,
    saveNote,
    openDiscountModal,
    saveDiscount,
    clearDiscount,
    openCheckoutModal,
    processCheckout,
    openCashDrawer,
    guestCheckInFlight,
    printGuestCheck,
    addServiceCharge,
    removeAutoServiceCharge,
    toggleTaxExempt,
    setItemCourse,
    clearItemCourse,
    quickLock,

    // Ported table actions
    persistActiveTable,
    clearActiveTableSession,
    loadActiveTableOrder,
    activateTableFromStorage,
    loadTableWorkspace,
    updateActiveTableOrder,
    markActiveTablePrinted,
    holdCurrentOrder,
    fetchHeldOrders,
    openSplitModal,
    editSplitGroup,
    addSplitSeat,
    removeSplitSeat,
    splitItemFractionally,
    moveItemToSeat,
    moveAllItemToSeat,
    moveItemToUnassigned,
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
    restoreTableSplit
  };
});
