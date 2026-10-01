// backend/tests/unit/orderUiStore.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useOrderUiStore } from '@/pos/stores/orderUiStore.js';

describe('useOrderUiStore — transient leaf', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('starts with clean defaults', () => {
    const ui = useOrderUiStore();
    expect(ui.isProcessing).toBe(false);
    expect(ui.showCheckoutModal).toBe(false);
    expect(ui.numpadMode).toBe('qty');
    expect(ui.activeIdempotencyKey).toBe('');
    expect(ui.paymentMethod).toBe('cash');
    expect(ui.amountTendered).toBe(null);
    expect(ui.splitCardAmount).toBe(null);
    expect(ui.splitCashTendered).toBe(null);
    expect(ui.checkoutError).toBe('');
    expect(ui.numpadInput).toBe('');
    expect(ui.mobileCartOpen).toBe(false);
    expect(ui.showCustomerDrawer).toBe(false);
    expect(ui.isCustomerLoading).toBe(false);
    expect(ui.activeModal).toBe(null);
    expect(ui.modalTarget).toBe('item');
    expect(ui.tempNote).toBe('');
    expect(ui.tempDiscount).toEqual({ type: 'percent', value: 0 });
    expect(ui.showModifierModal).toBe(false);
    expect(ui.activeModifierProduct).toBe(null);
    expect(ui.activeModifierQty).toBe(1);
    expect(ui.selectedModifiers).toEqual({});
    expect(ui.showCourseModal).toBe(false);
    expect(ui.showMoreActionsModal).toBe(false);
    expect(ui.showOrderTypeDropdown).toBe(false);
    expect(ui.showHeldOrdersModal).toBe(false);
    expect(ui.selectedTableId).toBe(null);
    expect(ui.tableSaveError).toBe('');
    expect(ui.tableActionError).toBe('');
    expect(ui.activeMode).toBe(null);
    expect(ui.activeModeSourceTable).toBe(null);
    expect(ui.joinSelectedChildIds).toEqual([]);
    expect(ui.showSplitModal).toBe(false);
    expect(ui.splitSeats).toEqual([]);
    expect(ui.unassignedSplitItems).toEqual([]);
    expect(ui.activeSplitSeat).toBe(1);
    expect(ui.dragData).toBe(null);
  });

  it('resetTransient() restores every flag', () => {
    const ui = useOrderUiStore();
    ui.isProcessing = true;
    ui.showCheckoutModal = true;
    ui.numpadInput = '42';
    ui.checkoutError = 'boom';
    ui.paymentMethod = 'card';
    ui.amountTendered = 100;
    ui.splitCardAmount = 50;
    ui.splitCashTendered = 50;
    ui.activeIdempotencyKey = 'TXN-123';
    ui.mobileCartOpen = true;
    ui.showCustomerDrawer = true;
    ui.isCustomerLoading = true;
    ui.activeModal = 'discount';
    ui.modalTarget = 'order';
    ui.tempNote = 'Hello';
    ui.tempDiscount = { type: 'fixed', value: 10 };
    ui.showModifierModal = true;
    ui.activeModifierProduct = { id: 1 };
    ui.activeModifierQty = 2;
    ui.selectedModifiers = { 1: [] };
    ui.showCourseModal = true;
    ui.showMoreActionsModal = true;
    ui.showOrderTypeDropdown = true;
    ui.showHeldOrdersModal = true;
    ui.tableSaveError = 'msg';
    ui.tableActionError = 'act_err';
    ui.activeMode = 'transfer';
    ui.activeModeSourceTable = { id: 2 };
    ui.joinSelectedChildIds = [3, 4];
    ui.showSplitModal = true;
    ui.splitSeats = [1, 2];
    ui.unassignedSplitItems = [{ id: 5 }];
    ui.activeSplitSeat = 2;
    ui.dragData = { id: 6 };

    // Set non-resettable sticky values to verify they are NOT reset
    ui.selectedTableId = 15;

    ui.resetTransient();

    expect(ui.isProcessing).toBe(false);
    expect(ui.showCheckoutModal).toBe(false);
    expect(ui.numpadInput).toBe('');
    expect(ui.checkoutError).toBe('');
    expect(ui.paymentMethod).toBe('cash');
    expect(ui.amountTendered).toBe(null);
    expect(ui.splitCardAmount).toBe(null);
    expect(ui.splitCashTendered).toBe(null);
    expect(ui.activeIdempotencyKey).toBe('');
    expect(ui.mobileCartOpen).toBe(false);
    expect(ui.showCustomerDrawer).toBe(false);
    expect(ui.isCustomerLoading).toBe(false);
    expect(ui.activeModal).toBe(null);
    expect(ui.modalTarget).toBe('item');
    expect(ui.tempNote).toBe('');
    expect(ui.tempDiscount).toEqual({ type: 'percent', value: 0 });
    expect(ui.showModifierModal).toBe(false);
    expect(ui.activeModifierProduct).toBe(null);
    expect(ui.activeModifierQty).toBe(1);
    expect(ui.selectedModifiers).toEqual({});
    expect(ui.showCourseModal).toBe(false);
    expect(ui.showMoreActionsModal).toBe(false);
    expect(ui.showOrderTypeDropdown).toBe(false);
    expect(ui.showHeldOrdersModal).toBe(false);
    expect(ui.tableSaveError).toBe('');
    expect(ui.tableActionError).toBe('');
    expect(ui.activeMode).toBe(null);
    expect(ui.activeModeSourceTable).toBe(null);
    expect(ui.joinSelectedChildIds).toEqual([]);
    expect(ui.showSplitModal).toBe(false);
    expect(ui.splitSeats).toEqual([]);
    expect(ui.unassignedSplitItems).toEqual([]);
    expect(ui.activeSplitSeat).toBe(1);
    expect(ui.dragData).toBe(null);

    // sticky values should be preserved
    expect(ui.selectedTableId).toBe(15);
  });

  it('setNumpadMode sets mode and clears input', () => {
    const ui = useOrderUiStore();
    ui.numpadInput = '9';
    ui.setNumpadMode('price');
    expect(ui.numpadMode).toBe('price');
    expect(ui.numpadInput).toBe('');
  });

  it('closeCheckoutModal closes drawers/modals and clears key', () => {
    const ui = useOrderUiStore();
    ui.showCheckoutModal = true;
    ui.showCustomerDrawer = true;
    ui.activeIdempotencyKey = 'TX-123';
    ui.closeCheckoutModal();
    expect(ui.showCheckoutModal).toBe(false);
    expect(ui.showCustomerDrawer).toBe(false);
    expect(ui.activeIdempotencyKey).toBe('');
  });

  it('closeSplitModal closes split modal and resets split state', () => {
    const ui = useOrderUiStore();
    ui.showSplitModal = true;
    ui.unassignedSplitItems = [{ id: 1 }];
    ui.splitSeats = [1, 2];
    ui.activeSplitSeat = 3;
    ui.closeSplitModal();
    expect(ui.showSplitModal).toBe(false);
    expect(ui.unassignedSplitItems).toEqual([]);
    expect(ui.splitSeats).toEqual([]);
    expect(ui.activeSplitSeat).toBe(1);
  });
});
