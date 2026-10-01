import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { isRef, ref } from 'vue';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const storage = {};
global.window = {
  localStorage: {
    getItem: (key) => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = String(value); },
    removeItem: (key) => { delete storage[key]; },
  },
  location: { href: '' },
};
global.localStorage = global.window.localStorage;
global.document = { documentElement: { dir: 'ltr' } };

const router = { push: vi.fn() };
const terminal = {
  storeName: ref('POS'), storeAddress: ref(''), storePhone: ref(''),
  showReceiptModal: ref(false), closeReceiptModal: vi.fn(), lastOrder: ref(null),
  receiptConfig: ref(null), printReceipt: vi.fn(), isPrintingBackend: ref(false),
  useInvoiceNoOnly: ref(false), taxInclusivePricing: ref(false), receiptTaxInclusiveDisplay: ref(false), taxRegistrationType: ref('sales_tax'),
};

vi.mock('@/shared/i18n.js', () => ({ t: (key) => key }));
vi.mock('vue-router', () => ({ useRouter: () => router }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => terminal }));
vi.mock('@/pos/useAuth.js', () => ({
  useAuth: () => ({ activeUser: ref({ id: 1, role: 'cashier' }), activeShift: ref({ id: 1 }) }),
}));
vi.mock('@/pos/useProducts.js', () => ({
  useProducts: () => ({ products: ref([]), settings: ref({}) }),
}));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));

import { useCart } from '@/pos/useCart.js';
import { useTables } from '@/pos/useTables.js';
import { useOrderSessionStore } from '@/pos/stores/orderSessionStore.js';

const CART_KEYS = [
  'captureOrderSession', 'isCurrentOrderSession', 'checkoutInFlight', 'pendingCheckout', 'syncCheckoutPaymentForOrderType',
  'activeIdempotencyKey', 'activeModal', 'activeModifierProduct',
  'addServiceCharge', 'addToCart', 'amountTendered', 'appendNumpad', 'applyQuantityPreset', 'armQuickAmount', 'autoApplyServiceCharge',
  'backspaceNumpad', 'callCenterCommands', 'callCenterSession', 'canApplyDiscount', 'canApplyServiceCharge', 'canCheckout',
  'canCheckoutTable', 'canClearCart', 'canPrintCheck', 'canRemoveAutoServiceCharge', 'canRemoveSelectedCartItem',
  'canVoidActiveTable', 'cancelCallCenterEdits', 'cancelCallCenterOrder', 'cancelModifiers', 'cancelQuickAmount', 'cart',
  'cartOrderDiscountAmount', 'cartReceiptPresentation', 'cartSubtotal', 'cartTax', 'cartTotal', 'cashShortfall', 'changeDue', 'checkoutError',
  'claimHeldOrderForHandoff', 'clearCart', 'clearDiscount', 'clearItemCourse', 'clearNumpad', 'closeCheckoutModal',
  'confirmHeldKitchenBaseline', 'confirmModifiers', 'consumeRestoreSource', 'consumeServerCanonicalRestore', 'continueCallCenterOrder', 'courses', 'customerAddress', 'customerName', 'customerPhone', 'defaultOrderTypeId',
  'fetchOrderTypes', 'findCallCenterOrders', 'getHeldOrdersSummary', 'getItemTotalGross', 'getPendingQtyInCart', 'getQtyInCart',
  'handleOrderTypeSelection', 'hashNumber', 'hasSavedTableItems', 'importQrDraftItems',
  'initializeCallCenterSession', 'isCallCenter', 'isCustomerLoading', 'isDirectPlatformCheckout', 'isHolding', 'isProcessing', 'loadOrderForEditing',
  'loadSavedOrder', 'lookupCustomer', 'markLocalFallbackRestore', 'markServerCanonicalRestore', 'mobileCartOpen', 'modalTarget', 'numpadInput', 'numpadMode',
  'openCashDrawer', 'openCheckoutModal', 'openDiscountModal', 'openNoteModal',
  'orderDate', 'orderDiscount', 'orderNote', 'orderTypes', 'paymentMethod',
  'printGuestCheck', 'processCheckout', 'quickTargetAmount', 'reconnectHeldOrder', 'pendingCheckoutUnreadable', 'canDiscardPendingCheckout', 'probePendingCheckout',
  'discardPendingCheckout', 'dismissPendingCheckoutUnreadable',
  'removeAutoServiceCharge',
  'removeSelectedCartItem', 'receiptTaxInclusiveDisplay', 'restoreHeldOrder', 'restoredHeldOrder', 'restoredHeldReference', 'saveDiscount', 'saveNote', 'selectedCartIndex',
  'sendCallCenterOrder', 'sendHeldOrderFollowUp',
  'selectedModifiers', 'selectedOrderType',
  'selectedOrderTypeRequiresHash', 'serviceChargeEnabled', 'serviceChargePercentage',
  'setItemCourse', 'setNumpadMode', 'showCheckoutModal', 'showCourseModal', 'showCustomerDrawer',
  'showModifierModal', 'showMoreActionsModal',
  'splitBalanceDue', 'splitCardAmount', 'splitCashTendered', 'startCallCenterOrder', 'startNewOrder', 'tempDiscount', 'tempNote',
  'taxInclusivePricing', 'isTaxExempt', 'canTaxExempt', 'toggleTaxExempt', 'toggleModifier',
  'taxRegistrationType', 'guestCheckInFlight',
].sort();

const TABLE_KEYS = [
  'captureTableActionSource', 'pendingTableAction', 'reconcileTableAction', 'retryTableAction',
  'activeMode', 'activeModeSourceTable', 'activeQrDraft', 'activeSplitSeat', 'activeTable', 'addSplitSeat',
  'canJoinTables', 'canSplitActiveTable', 'canSplitBillPermission', 'canTransferTable',
  'canUpdateTable', 'cancelSplitGroup', 'clearActiveTableSession', 'closeSplitModal', 'closeTable', 'confirmSplit', 'disjoinTable',
  'dismissActiveQrDraft', 'editSplitGroup', 'fetchTableSplits', 'getSeatTotal', 'getSplitItemTotal', 'handleDragStart',
  'handleDropOnSeat', 'holdCurrentOrder', 'getTableItemsForTransfer', 'previewTableItems', 'moveTableItems',
  'isTableWorkspaceLoading', 'joinSelectedChildIds', 'joinTables', 'loadActiveTableDraft',
  'loadActiveTableOrder', 'loadTableWorkspace', 'moveAllItemToSeat', 'moveItemToSeat', 'moveItemToUnassigned',
  'openSplitModal', 'removeSplitSeat', 'restaurantTables', 'restoreTableSplit',
  'showSplitModal',
  'splitEditContext', 'splitItemFractionally', 'splitSeats', 'tableActionError',
  'tableSaveError', 'tableSections', 'tableSplitsError', 'tableSettings', 'tableSplitsList', 'tableWorkspaceLoaded', 'tableWorkspaceLoadFailed', 'tablesEnabled',
  'transferTableOrder', 'unassignedSplitItems', 'updateActiveTableOrder',
].sort();

const sourceFiles = (directory) => readdirSync(directory).flatMap((entry) => {
  if (entry === '__tests__' || /\.(?:test|spec)\.js$/.test(entry)) return [];
  const fullPath = resolve(directory, entry);
  if (statSync(fullPath).isDirectory()) return sourceFiles(fullPath);
  return /\.(?:js|vue)$/.test(entry) ? [fullPath] : [];
});

describe('POS state public boundaries', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    router.push.mockReset();
    Object.keys(storage).forEach((key) => delete storage[key]);
  });

  it('keeps the cart facade key set and representative ref/function semantics', () => {
    const cart = useCart();

    expect(Object.keys(cart).sort()).toEqual(CART_KEYS);
    expect(isRef(cart.cart)).toBe(true);
    expect(isRef(cart.cartTotal)).toBe(true);
    expect(isRef(cart.showCheckoutModal)).toBe(true);
    expect(cart.processCheckout).toBeTypeOf('function');
    expect(isRef(cart.quickTargetAmount)).toBe(true);
    expect(cart.armQuickAmount).toBeTypeOf('function');
    expect(cart.applyQuantityPreset).toBeTypeOf('function');
    expect(cart.cancelQuickAmount).toBeTypeOf('function');
    expect(cart.confirmModifiers).toBeTypeOf('function');
    expect(cart.cancelModifiers).toBeTypeOf('function');
    expect(cart.markServerCanonicalRestore).toBeTypeOf('function');
    expect(cart.consumeServerCanonicalRestore).toBeTypeOf('function');
  });

  it('routes terminal consumers directly through the terminal owner', () => {
    const cartFacade = readFileSync(resolve(process.cwd(), 'src/pos/useCart.js'), 'utf8');
    expect(cartFacade).not.toContain('useTerminal');

    for (const file of [
      'src/components/pos/ReceiptPreviewModal.vue',
      'src/components/pos/ShiftReportModal.vue',
      'src/components/TableSplits.vue',
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source).toContain('useTerminal');
      expect(source).not.toMatch(/\{[^}]*\b(?:storeName|storeAddress|storePhone|lastOrder)\b[^}]*\}\s*=\s*useCart\(/);
    }
  });

  it('labels the tax-exempt tile with the current order state', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/PosTerminal.vue'), 'utf8');

    expect(source).toContain("isTaxExempt ? 'Tax Exempt: ON' : 'Tax Exempt: OFF'");
  });

  it('keeps the tables facade key set and binds router wrappers', async () => {
    const tables = useTables();
    const session = useOrderSessionStore();
    const closeTable = vi.fn();
    const restoreTableSplit = vi.fn();
    const cancelSplitGroup = vi.fn();
    session.closeTable = closeTable;
    session.restoreTableSplit = restoreTableSplit;
    session.cancelSplitGroup = cancelSplitGroup;

    expect(Object.keys(tables).sort()).toEqual(TABLE_KEYS);
    expect(isRef(tables.activeTable)).toBe(true);
    expect(tables.confirmSplit).toBeTypeOf('function');
    expect(tables.getTableItemsForTransfer).toBe(session.getTableItemsForTransfer);
    expect(tables.previewTableItems).toBe(session.previewTableItems);
    expect(tables.moveTableItems).toBe(session.moveTableItems);

    tables.closeTable();
    tables.restoreTableSplit({ id: 7 });
    tables.cancelSplitGroup({ id: 8 });
    expect(closeTable).toHaveBeenCalledWith({ router });
    expect(restoreTableSplit).toHaveBeenCalledWith({ id: 7 }, { router });
    expect(cancelSplitGroup).toHaveBeenCalledWith({ id: 8 }, { router });
  });

  it('keeps direct production access to the aggregate behind its two facades', () => {
    const srcRoot = resolve(process.cwd(), 'src');
    const consumers = sourceFiles(srcRoot)
      .filter(file => /useOrderSessionStore\s*\(/.test(readFileSync(file, 'utf8')))
      .map(file => file.slice(srcRoot.length + 1).replaceAll('\\', '/'))
      .sort();

    expect(consumers).toEqual(['pos/useCart.js', 'pos/useTables.js']);
  });

  it('requires the internal leaf-module directory before extraction starts', () => {
    expect(existsSync(resolve(process.cwd(), 'src/pos/stores/orderSession'))).toBe(true);
  });

  it('keeps internal leaf modules below the POS stores and facades', () => {
    const leafDirectory = resolve(process.cwd(), 'src/pos/stores/orderSession');
    const forbidden = /(?:orderSessionStore|orderUiStore|useCart|useTables|vue-router|\/components\/)/;

    for (const file of readdirSync(leafDirectory).filter((name) => name.endsWith('.js'))) {
      const source = readFileSync(resolve(leafDirectory, file), 'utf8');
      expect(source).not.toMatch(forbidden);
      if (!['tableSession.js', 'tableOrderWorkflow.js'].includes(file)) {
        expect(source).not.toMatch(/from ['"]vue['"]/);
      }
    }

    for (const facade of ['src/pos/useCart.js', 'src/pos/useTables.js']) {
      expect(readFileSync(resolve(process.cwd(), facade), 'utf8')).not.toContain('/orderSession/');
    }
  });

  it('keeps table transport and table state ownership out of the root session store', () => {
    const root = readFileSync(resolve(process.cwd(), 'src/pos/stores/orderSessionStore.js'), 'utf8');
    const workflow = readFileSync(resolve(process.cwd(), 'src/pos/stores/orderSession/tableOrderWorkflow.js'), 'utf8');

    expect(root).not.toMatch(/orderSessionApi\.(?:getTable|saveTable|markTable|holdOrder|getHeldOrders|splitTable|transferTable|joinTables|disjoinTables|cancelTableSplit)/);
    expect(workflow).not.toMatch(/from ['"][^'"]*(?:useCart|useTables|useProducts|useAuth|router|components\/|stores\/)[^'"]*['"]/);
    expect(workflow).not.toMatch(/(?:^|[{,]\s*)(?:context|deps|helpers)\s*[,}]/m);
  });

  it('keeps POS order/session storage mechanics behind the storage adapters', () => {
    const runtimeFiles = [
      'src/pos/stores/orderSessionStore.js',
      'src/components/PosTerminal.vue',
      'src/components/OrderNotes.vue',
      'src/router.js',
    ];
    const directOwnedStorage = /localStorage\.(?:getItem|setItem|removeItem)\(['"]pos_(?:active_table|table_prefill|cart|order_note|order_discount|restore_held_order|held_kitchen_fired|service_charge_snapshot|checkout_attempt)['"]\)/;

    for (const file of runtimeFiles) {
      expect(readFileSync(resolve(process.cwd(), file), 'utf8')).not.toMatch(directOwnedStorage);
    }
  });
});
