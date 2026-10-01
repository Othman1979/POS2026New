// @/pos/stores/orderUiStore.js
import { ref } from 'vue';
import { defineStore } from 'pinia';

/**
 * Transient, screen-scoped UI state for the POS order workflow.
 * Leaf store: imports nothing from the order domain. Freely resettable.
 */
export const useOrderUiStore = defineStore('orderUi', () => {
  // --- checkout / payment ---
  const showCheckoutModal = ref(false);
  const paymentMethod = ref('cash');
  const amountTendered = ref(null);
  const splitCardAmount = ref(null);
  const splitCashTendered = ref(null);
  const isProcessing = ref(false);
  const isHolding = ref(false);
  const checkoutError = ref('');
  const activeIdempotencyKey = ref('');

  // --- numpad / cart UI ---
  const numpadInput = ref('');
  const numpadMode = ref('qty');
  const quickTargetAmount = ref(null);
  const mobileCartOpen = ref(false);
  const showCustomerDrawer = ref(false);
  const isCustomerLoading = ref(false);

  // --- note/discount overlay ---
  const activeModal = ref(null);
  const modalTarget = ref('item');
  const tempNote = ref('');
  const tempDiscount = ref({ type: 'percent', value: 0 });

  // --- modifiers / course / more ---
  const showModifierModal = ref(false);
  const activeModifierProduct = ref(null);
  const activeModifierQty = ref(1);
  const selectedModifiers = ref({});
  const showCourseModal = ref(false);
  const showMoreActionsModal = ref(false);
  const showOrderTypeDropdown = ref(false);

  // --- held orders modal (carried over; see plan Issue 6) ---
  const showHeldOrdersModal = ref(false);


  // Save failures and split-board load failures own their notices; background
  // workspace loads write only tableActionError.
  const tableSaveError = ref('');
  const tableSplitsError = ref('');
  const tableActionError = ref('');

  // --- transfer/join mode ---
  const selectedTableId = ref(null);
  const activeMode = ref(null);
  const activeModeSourceTable = ref(null);
  const joinSelectedChildIds = ref([]);

  // --- split board ---
  const showSplitModal = ref(false);
  const splitSeats = ref([]);
  const unassignedSplitItems = ref([]);
  const activeSplitSeat = ref(1);
  const dragData = ref(null);
  const splitEditContext = ref(null);

  const setNumpadMode = (mode) => {
    numpadMode.value = mode;
    numpadInput.value = '';
    quickTargetAmount.value = null;
  };

  const clearQuickTargetAmount = () => {
    quickTargetAmount.value = null;
  };

  const closeCheckoutModal = () => {
    showCustomerDrawer.value = false;
    showCheckoutModal.value = false;
    activeIdempotencyKey.value = '';
  };



  const closeSplitModal = () => {
    showSplitModal.value = false;
    unassignedSplitItems.value = [];
    splitSeats.value = [];
    activeSplitSeat.value = 1;
    splitEditContext.value = null;
  };

  const resetTransient = () => {
    showCheckoutModal.value = false;
    paymentMethod.value = 'cash';
    amountTendered.value = null;
    splitCardAmount.value = null;
    splitCashTendered.value = null;
    isProcessing.value = false;
    isHolding.value = false;
    checkoutError.value = '';
    activeIdempotencyKey.value = '';
    numpadInput.value = '';
    numpadMode.value = 'qty';
    quickTargetAmount.value = null;
    mobileCartOpen.value = false;
    showCustomerDrawer.value = false;
    isCustomerLoading.value = false;
    activeModal.value = null;
    modalTarget.value = 'item';
    tempNote.value = '';
    tempDiscount.value = { type: 'percent', value: 0 };
    showModifierModal.value = false;
    activeModifierProduct.value = null;
    activeModifierQty.value = 1;
    selectedModifiers.value = {};
    showCourseModal.value = false;
    showMoreActionsModal.value = false;
    showOrderTypeDropdown.value = false;
    showHeldOrdersModal.value = false;

    tableSaveError.value = '';
    tableSplitsError.value = '';
    tableActionError.value = '';
    activeMode.value = null;
    activeModeSourceTable.value = null;
    joinSelectedChildIds.value = [];
    showSplitModal.value = false;
    splitSeats.value = [];
    unassignedSplitItems.value = [];
    activeSplitSeat.value = 1;
    dragData.value = null;
    splitEditContext.value = null;
    // selectedTableId is intentionally NOT reset because it is a sticky workspace selection.
  };

  return {
    showCheckoutModal,
    paymentMethod,
    amountTendered,
    splitCardAmount,
    splitCashTendered,
    isProcessing,
    isHolding,
    checkoutError,
    activeIdempotencyKey,
    numpadInput,
    numpadMode,
    quickTargetAmount,
    mobileCartOpen,
    showCustomerDrawer,
    isCustomerLoading,
    activeModal,
    modalTarget,
    tempNote,
    tempDiscount,
    showModifierModal,
    activeModifierProduct,
    activeModifierQty,
    selectedModifiers,
    showCourseModal,
    showMoreActionsModal,
    showOrderTypeDropdown,
    showHeldOrdersModal,

    tableSaveError,
    tableSplitsError,
    tableActionError,
    selectedTableId,
    activeMode,
    activeModeSourceTable,
    joinSelectedChildIds,
    showSplitModal,
    splitSeats,
    unassignedSplitItems,
    activeSplitSeat,
    dragData,
    splitEditContext,
    setNumpadMode,
    clearQuickTargetAmount,
    closeCheckoutModal,

    closeSplitModal,
    resetTransient,
  };
});
