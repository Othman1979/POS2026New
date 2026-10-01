// @/pos/useTables.js — logic-free facade over the order stores.
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useOrderSessionStore } from './stores/orderSessionStore.js';
import { useOrderUiStore } from './stores/orderUiStore.js';

// closeTable always navigates away from /pos, but the store clears activeTable
// before the router deactivates the POS. PosTerminal's activeTable watcher reads
// this synchronously to skip the register catalog read nobody would see; the
// POS clears it on its next activate/deactivate.
let leavingTable = false;
export const isLeavingTable = () => leavingTable;
export const clearLeavingTable = () => { leavingTable = false; };

export function useTables() {
  const session = useOrderSessionStore();
  const ui = useOrderUiStore();
  const router = typeof useRouter === 'function' ? useRouter() : null;
  const s = storeToRefs(session);
  const u = storeToRefs(ui);

  // Only allowed wrappers: bind the component router into navigation actions.
  const closeTable = () => {
    leavingTable = true;
    session.closeTable({ router });
  };
  const restoreTableSplit = (splitCheck) => session.restoreTableSplit(splitCheck, { router });
  const cancelSplitGroup = (splitCheck) => session.cancelSplitGroup(splitCheck, { router });
  const confirmSplit = () => session.confirmSplit({ router });
  const editSplitGroup = (group) => {
    const opened = session.editSplitGroup(group);
    if (opened) router?.push('/pos');
    return opened;
  };

  return {
    // session state + getters
    activeTable: s.activeTable,
    activeQrDraft: s.activeQrDraft,
    tableSettings: s.tableSettings,
    tableSections: s.tableSections,
    restaurantTables: s.restaurantTables,
    tableWorkspaceLoaded: s.tableWorkspaceLoaded,
    tableWorkspaceLoadFailed: s.tableWorkspaceLoadFailed,
    isTableWorkspaceLoading: s.isTableWorkspaceLoading,
    tableSplitsList: s.tableSplitsList,
    pendingTableAction: s.pendingTableAction,
    tablesEnabled: s.tablesEnabled,
    canUpdateTable: s.canUpdateTable,
    canTransferTable: s.canTransferTable,
    canJoinTables: s.canJoinTables,
    canSplitBillPermission: s.canSplitBillPermission,
    canSplitActiveTable: s.canSplitActiveTable,

    // ui state
    showSplitModal: u.showSplitModal,
    splitSeats: u.splitSeats,
    unassignedSplitItems: u.unassignedSplitItems,
    activeSplitSeat: u.activeSplitSeat,
    splitEditContext: u.splitEditContext,
    tableSaveError: u.tableSaveError,
    tableSplitsError: u.tableSplitsError,
    tableActionError: u.tableActionError,
    activeMode: u.activeMode,
    activeModeSourceTable: u.activeModeSourceTable,
    joinSelectedChildIds: u.joinSelectedChildIds,

    // actions
    closeTable,
    restoreTableSplit,
    cancelSplitGroup,
    editSplitGroup,
    holdCurrentOrder: session.holdCurrentOrder,
    clearActiveTableSession: session.clearActiveTableSession,
    loadActiveTableOrder: session.loadActiveTableOrder,
    loadActiveTableDraft: session.loadActiveTableDraft,
    dismissActiveQrDraft: session.dismissActiveQrDraft,
    updateActiveTableOrder: session.updateActiveTableOrder,
    loadTableWorkspace: session.loadTableWorkspace,
    openSplitModal: session.openSplitModal,
    closeSplitModal: ui.closeSplitModal,
    addSplitSeat: session.addSplitSeat,
    removeSplitSeat: session.removeSplitSeat,
    splitItemFractionally: session.splitItemFractionally,
    moveItemToSeat: session.moveItemToSeat,
    moveAllItemToSeat: session.moveAllItemToSeat,
    moveItemToUnassigned: session.moveItemToUnassigned,
    confirmSplit,
    handleDragStart: session.handleDragStart,
    handleDropOnSeat: session.handleDropOnSeat,
    getSeatTotal: session.getSeatTotal,
    getSplitItemTotal: session.getSplitItemTotal,
    transferTableOrder: session.transferTableOrder,
    getTableItemsForTransfer: session.getTableItemsForTransfer,
    previewTableItems: session.previewTableItems,
    moveTableItems: session.moveTableItems,
    captureTableActionSource: session.captureTableActionSource,
    reconcileTableAction: session.reconcileTableAction,
    retryTableAction: session.retryTableAction,
    joinTables: session.joinTables,
    disjoinTable: session.disjoinTable,
    fetchTableSplits: session.fetchTableSplits,
  };
}
