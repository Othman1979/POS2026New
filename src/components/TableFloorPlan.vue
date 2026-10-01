<template>
  <div :class="['tables-page h-[100dvh] w-screen overflow-hidden flex flex-col no-select', { 'pos-theme-dark': isPosDark }]">
    <div id="table-app" class="h-full flex flex-col relative w-full">
      <header class="tables-header">
        <div class="tables-heading">
          <span class="tables-heading__icon" aria-hidden="true">
            <i class="fa-solid fa-table-cells-large"></i>
          </span>
          <div class="min-w-0">
            <h1>{{ $t('Tables') }}</h1>
            <p data-no-i18n>{{ settings.table_mode === 'fixed' ? currentSectionName : $t('Dynamic Table') }}</p>
          </div>
        </div>

        <div class="tables-counts hidden md:flex" :aria-label="$t('Table status counts')">
          <span class="tables-count"><i class="status-dot status-dot--available" aria-hidden="true"></i><b data-no-i18n>{{ tableCounts.available }}</b>{{ $t('Available') }}</span>
          <span class="tables-count"><i class="status-dot status-dot--occupied" aria-hidden="true"></i><b data-no-i18n>{{ tableCounts.occupied }}</b>{{ $t('Occupied') }}</span>
          <span class="tables-count"><i class="status-dot status-dot--printed" aria-hidden="true"></i><b data-no-i18n>{{ tableCounts.printed }}</b>{{ $t('Bill Printed') }}</span>
        </div>

        <div class="tables-header__spacer"></div>

        <label class="tables-search hidden sm:block">
          <span class="sr-only">{{ $t('Search Table...') }}</span>
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input v-model="tableSearchQuery" type="search" :placeholder="$t('Search Table...')" />
        </label>

        <div data-testid="tables-wide-actions" class="hidden xl:flex items-center gap-2">
          <button
            v-if="activeUser && (activeUser.role === 'admin' || activeUser.role === 'programmer')"
            type="button"
            class="tables-action"
            @click="goToAdminDashboard"
          >
            <i class="fa-solid fa-gauge-high" aria-hidden="true"></i>
            <span>{{ $t('Admin Dashboard') }}</span>
          </button>
          <button
            v-if="activeUser && activeUser.role !== 'waiter' && can('shift.open')"
            type="button"
            class="tables-action"
            @click="goToPOS"
          >
            <i class="fa-solid fa-shop" aria-hidden="true"></i>
            <span>{{ $t('POS Terminal') }}</span>
          </button>
          <button
            v-if="canSplitBillPermission"
            type="button"
            class="tables-action"
            @click="router.push('/table-splits')"
          >
            <i class="fa-solid fa-arrows-split-up-and-left" aria-hidden="true"></i>
            <span>{{ $t('Table Splits') }}</span>
            <b v-if="totalTableSplits" data-no-i18n>{{ totalTableSplits }}</b>
          </button>
          <button type="button" class="tables-icon-action" :aria-label="$t('Logout')" @click="logout">
            <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
          </button>
        </div>

        <div class="relative xl:hidden" @keydown.esc="closeNavigationMenu">
          <button
            data-testid="tables-navigation-menu"
            class="tables-menu-trigger"
            type="button"
            :aria-label="$t('Navigation menu')"
            :aria-expanded="showNavigationMenu"
            @click="showNavigationMenu = !showNavigationMenu"
          >
            <span>{{ $t('Menu') }}</span>
            <i class="fa-solid fa-bars" aria-hidden="true"></i>
          </button>
          <button
            v-if="showNavigationMenu"
            class="tables-menu-backdrop"
            type="button"
            :aria-label="$t('Close navigation menu')"
            @click="closeNavigationMenu"
          ></button>
          <div v-if="showNavigationMenu" class="tables-navigation-menu" role="menu" :aria-label="$t('Navigation menu')">
            <button
              v-if="activeUser && (activeUser.role === 'admin' || activeUser.role === 'programmer')"
              type="button"
              role="menuitem"
              @click="closeNavigationMenu(); goToAdminDashboard()"
            >
              <i class="fa-solid fa-gauge-high" aria-hidden="true"></i>{{ $t('Admin Dashboard') }}
            </button>
            <button
              v-if="activeUser && activeUser.role !== 'waiter' && can('shift.open')"
              type="button"
              role="menuitem"
              @click="closeNavigationMenu(); goToPOS()"
            >
              <i class="fa-solid fa-shop" aria-hidden="true"></i>{{ $t('POS Terminal') }}
            </button>
            <button
              v-if="canSplitBillPermission"
              type="button"
              role="menuitem"
              @click="closeNavigationMenu(); router.push('/table-splits')"
            >
              <i class="fa-solid fa-arrows-split-up-and-left" aria-hidden="true"></i>{{ $t('Table Splits') }}
              <b v-if="totalTableSplits" data-no-i18n>{{ totalTableSplits }}</b>
            </button>
            <button type="button" role="menuitem" @click="closeNavigationMenu(); logout()">
              <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>{{ $t('Logout') }}
            </button>
          </div>
        </div>
      </header>

      <!-- Main Layout Body -->
      <main class="tables-main flex-1 w-full flex flex-col overflow-hidden z-10 relative">
        
        <div v-if="pendingTableAction" class="mode-bar mode-bar--transfer" role="status" data-testid="table-transfer-recovery">
          <span>{{ $t('Transfer not confirmed. Check and retry before moving another table.') }}</span>
          <button type="button" :disabled="checkingTransfer || pendingTableIds.length > 0" @click="recoverTransfer(true)">
            {{ $t(checkingTransfer ? 'Checking transfer...' : 'Check and retry') }}
          </button>
        </div>

        <div v-if="activeMode === 'transfer' && !pendingTableAction" class="mode-bar mode-bar--transfer">
          <div>
            <i class="fa-solid fa-arrows-spin" aria-hidden="true"></i>
            <span>{{ $t('Transfer Mode: Select an available target table for Table') }} <b data-no-i18n>{{ activeModeSourceTable?.table_number }}</b></span>
          </div>
          <button type="button" @click="cancelMode">{{ $t('Cancel') }}</button>
        </div>

        <div v-if="activeMode === 'join'" class="mode-bar mode-bar--join">
          <div>
            <i class="fa-solid fa-link" aria-hidden="true"></i>
            <span>{{ $t('Join Mode: Click tables to group with Table') }} <b data-no-i18n>{{ activeModeSourceTable?.table_number }}</b> · {{ $t('Bills stay separate.') }}</span>
          </div>
          <div class="mode-bar__actions">
            <button type="button" :disabled="joinSelectedChildIds.length === 0" @click="executeJoin(activeModeSourceTable.id, joinSelectedChildIds)">
              {{ $t('Done') }} <b data-no-i18n>{{ joinSelectedChildIds.length }}</b>
            </button>
            <button type="button" @click="cancelMode">{{ $t('Cancel') }}</button>
          </div>
        </div>

        <div v-if="tableWorkspaceLoadFailed" class="mode-bar mode-bar--transfer" role="status" data-testid="table-load-failed">
          <span>{{ $t('Could not load tables. Retrying...') }}</span>
          <button type="button" :disabled="isTableWorkspaceLoading" @click="loadTables({ force: true })">{{ $t('Retry') }}</button>
        </div>

        <!-- Loading State Skeleton -->
        <div v-if="showSkeleton" class="tables-loading" aria-busy="true">
          <div class="tables-loading__tabs" aria-hidden="true">
            <div v-for="i in 5" :key="i"></div>
          </div>
          <div class="tables-grid" aria-hidden="true">
            <div v-for="i in 24" :key="i" class="table-card table-card--loading"></div>
          </div>
        </div>

        <!-- Loaded State -->
        <template v-else>
          <div v-if="settings.table_mode === 'fixed'" class="w-full h-full flex flex-col">
            
            <div id="section-tabs-container" class="section-strip">
              <div class="section-strip__tabs hide-scroll">
                <button
                  v-for="section in sections"
                  :key="section.id"
                  :id="`section-tab-${section.id}`"
                  type="button"
                  @click="activeSection = section.id"
                  :class="['section-tab', { 'section-tab--active': activeSection === section.id }]"
                  :aria-pressed="activeSection === section.id"
                >
                  <span data-no-i18n>{{ section.name }}</span>
                </button>
              </div>
              <span class="section-strip__count hidden sm:block"><b data-no-i18n>{{ filteredTablesList.length }}</b> {{ $t('tables') }}</span>
            </div>
            <div 
              @touchstart.passive="handleTouchStart"
              @touchend.passive="handleTouchEnd"
              class="tables-floor premium-scroll"
            >
              <transition name="section-fade">
                <div :key="activeSection" class="w-full">
                  <div class="tables-grid">
                    
                    <div
                      v-for="table in filteredTablesList"
                      :key="table.id"
                      data-testid="table-card"
                      :data-table-number="String(table.table_number)"
                      :data-table-status="table.status"
                      role="button"
                      tabindex="0"
                      :aria-label="getTableAriaLabel(table)"
                      @click="handleTableClick(table)"
                      @keydown.enter.self="handleTableClick(table)"
                      @keydown.space.prevent.self="handleTableClick(table)"
                      @contextmenu.prevent="handleTableContext(table)"
                      @touchstart.passive="startTouchHold(table, $event)"
                      @touchmove.passive="moveTouchHold($event)"
                      @touchend.passive="endTouchHold"
                      :class="[
                        'table-card',
                        getTableStatusClass(table.status),
                        { 'table-card--join-selected': joinSelectedChildIds.includes(table.id) },
                        { 'table-card--pending': pendingTableIds.includes(table.id) },
                        { 'table-card--transfer-source': activeMode === 'transfer' && activeModeSourceTable?.id === table.id }
                      ]"
                    >
                      <div class="table-card__top">
                        <div>
                          <strong class="table-card__number" data-no-i18n>{{ table.table_number }}</strong>
                          <span class="table-card__label">{{ $t('Table') }}</span>
                        </div>
                        <button
                          v-if="!activeMode"
                          class="table-card__options"
                          type="button"
                          :aria-label="getTableOptionsLabel(table)"
                          @click.stop="triggerActionSheet(table)"
                          @contextmenu.stop.prevent
                          @touchstart.stop
                          @touchend.stop
                        >
                          <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
                        </button>
                      </div>

                      <div
                        v-if="table.qr_draft_count > 0 || table.seating_parent_id || table.parent_table_id || getTableSplitsCount(table) > 0"
                        class="table-card__indicators"
                      >
                        <span v-if="table.qr_draft_count > 0" :title="$t('QR Customer Cart Active')">
                          <i class="fa-solid fa-mobile-screen-button" aria-hidden="true"></i><b data-no-i18n>{{ table.qr_draft_count }}</b>
                        </span>
                        <span v-if="table.seating_parent_id" :title="$t('Joined Table')">
                          <i class="fa-solid fa-link" aria-hidden="true"></i><b data-no-i18n>{{ getParentTableNumber(table.seating_parent_id) }}</b>
                        </span>
                        <span v-if="table.parent_table_id" :title="$t('Shared Bill')">
                          <i class="fa-solid fa-receipt" aria-hidden="true"></i><b data-no-i18n>{{ getParentTableNumber(table.parent_table_id) }}</b>
                        </span>
                        <span v-if="getTableSplitsCount(table) > 0" :title="$t('Unpaid Split Checks')">
                          <i class="fa-solid fa-arrows-split-up-and-left" aria-hidden="true"></i><b data-no-i18n>{{ getTableSplitsCount(table) }}</b>
                        </span>
                      </div>

                      <div v-if="table.current_order_id" class="table-card__footer">
                        <span class="table-card__meta" data-no-i18n>
                          {{ table.active_order_waiter_name || $t('Staff member') }}
                          <template v-if="table.active_order_created_at"> · <TableElapsedTime :created-at="table.active_order_created_at" /></template>
                        </span>
                        <strong class="table-card__total" data-no-i18n>{{ formatTableTotal(table.active_order_total) }}</strong>
                      </div>

                    </div>
                  </div>

                  <!-- Empty table state -->
                  <div
                    v-if="filteredTablesList.length === 0 && !tableWorkspaceLoadFailed"
                    class="tables-empty-state"
                  >
                    <div class="tables-empty-state__icon" aria-hidden="true">
                      <i :class="tableSearchQuery ? 'fa-solid fa-magnifying-glass' : 'fa-solid fa-table'"></i>
                    </div>
                    <h3>{{ tableSearchQuery ? $t('No tables match your search.') : $t('Section is Empty') }}</h3>
                    <p>
                      {{ tableSearchQuery
                        ? $t('Try another table number or waiter name.')
                        : $t('There are no tables assigned to this section yet. Add tables from the Admin Dashboard.') }}
                    </p>
                  </div>
                </div>
              </transition>
            </div>
          </div>

          <div v-else class="dynamic-mode">
            <div class="dynamic-panel">
              <div class="dynamic-panel__intro">
                <div class="dynamic-panel__icon" aria-hidden="true"><i class="fa-solid fa-keyboard"></i></div>
                <h2>{{ $t('Open a Tab or Table') }}</h2>
                <p>{{ $t('Enter a unique tab name or table number to instantly open a new order or resume an existing one.') }}</p>
              </div>

              <div class="dynamic-panel__form">
                <label for="dynamic-table-number">{{ $t('Tab / Table Number') }}</label>
                <input
                  id="dynamic-table-number"
                  ref="dynamicInput"
                  v-model="dynamicTableInput"
                  type="text"
                  inputmode="numeric"
                  dir="ltr"
                  placeholder="00"
                  @keyup.enter="processDynamicTable"
                />
                <button type="button" :disabled="!dynamicTableInput" @click="processDynamicTable">
                  <span>{{ $t('Open Register') }}</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
                </button>
              </div>
            </div>
          </div>
        </template>

        <transition name="modal-fade">
          <div
            v-if="showActionSheet"
            class="dialog-backdrop"
            @click.self="showActionSheet = false"
          >
            <section
              ref="actionSheetDialog"
              class="table-actions-dialog"
              role="dialog"
              aria-modal="true"
              tabindex="-1"
              :aria-label="`${$t('Table')} ${selectedActionTable?.table_number}`"
            >
              
              <header class="table-actions-dialog__header">
                <div>
                  <h3>
                    {{ $t('Table') }} <span data-no-i18n>{{ selectedActionTable?.table_number }}</span>
                  </h3>
                  <p>
                    <span v-if="selectedActionTable?.seating_parent_id">
                      {{ $t('Joined to Table') }} <b data-no-i18n>{{ getParentTableNumber(selectedActionTable.seating_parent_id) }}</b>
                    </span>
                    <span v-else>
                      <b data-no-i18n>{{ selectedActionTable?.section_name }}</b> · {{ $t(getTableStatusKey(selectedActionTable?.status)) }}
                    </span>
                  </p>
                </div>
                <button type="button" class="dialog-close" :aria-label="$t('Close')" @click="showActionSheet = false">
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </header>

              <div class="table-actions-dialog__actions">
                <button v-if="canTransferTable && canUpdateTable && selectedActionTable?.current_order_id && !selectedActionTable?.parent_table_id && selectedActionTable?.status === 'occupied' && !Number(selectedActionTable?.active_split_count)"
                  type="button" class="dialog-action" @click="itemTransferSource = selectedActionTable; showActionSheet = false">
                  <i class="fa-solid fa-arrow-right-arrow-left" aria-hidden="true"></i><span>{{ $t('Move Items') }}</span>
                </button>
                <button data-dialog-initial-focus type="button" class="dialog-action dialog-action--primary" @click="openTable(selectedActionTable)">
                  <i class="fa-solid fa-utensils" aria-hidden="true"></i>
                  <span>{{ $t('Open Cart') }}</span>
                </button>

                <button
                  v-if="!selectedActionTable?.parent_table_id && canTransferTable"
                  type="button"
                  class="dialog-action"
                  @click="activeMode = 'transfer'; activeModeSourceTable = selectedActionTable; showActionSheet = false"
                >
                  <i class="fa-solid fa-arrows-spin" aria-hidden="true"></i>
                  <span>{{ $t('Transfer Order') }}</span>
                </button>

                <button
                  v-if="!selectedActionTable?.seating_parent_id && canJoinTables && !hasPrintedSeatingMember(selectedActionTable)"
                  type="button"
                  class="dialog-action"
                  @click="activeMode = 'join'; activeModeSourceTable = selectedActionTable; joinSelectedChildIds = []; showActionSheet = false"
                >
                  <i class="fa-solid fa-link" aria-hidden="true"></i>
                  <span>{{ $t('Join Tables') }}</span>
                </button>

                <button
                  v-if="selectedActionTable?.seating_parent_id || hasJoinedChildren(selectedActionTable?.id)"
                  type="button"
                  class="dialog-action dialog-action--danger"
                  @click="handleDisjoinClick"
                >
                  <i class="fa-solid fa-link-slash" aria-hidden="true"></i>
                  <span>{{ selectedActionTable?.seating_parent_id ? $t('Disjoin Table') : $t('Dissolve Joint Group') }}</span>
                </button>
              </div>

            </section>
          </div>
        </transition>

        <transition name="modal-fade">
          <div
            v-if="showPinModal"
            class="dialog-backdrop dialog-backdrop--pin"
          >
            <section ref="pinDialog" class="pin-dialog" role="dialog" aria-modal="true" tabindex="-1" :aria-label="$t('Manager Authorization')">
              <div class="pin-dialog__icon" aria-hidden="true"><i class="fa-solid fa-shield-halved"></i></div>
              <h3>{{ $t('Manager Authorization') }}</h3>
              <p>{{ $t('Enter Manager PIN to override') }}</p>
                <input
                  v-model="enteredPin"
                  data-dialog-initial-focus
                  type="password"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  maxlength="10"
                  dir="ltr"
                  class="pin-dialog__input"
                  @keyup.enter="submitPin"
                />
              <p v-if="pinErrorMessage" class="pin-dialog__error">{{ pinErrorMessage }}</p>
              <div class="pin-dialog__actions">
                <button type="button" class="dialog-action dialog-action--primary" @click="submitPin">{{ $t('Submit') }}</button>
                <button type="button" class="dialog-action" @click="closePinModal">{{ $t('Cancel') }}</button>
              </div>
            </section>
          </div>
        </transition>
        <TableItemTransferModal v-if="itemTransferSource" :source="itemTransferSource" @close="closeItemTransfer" />
      </main>
    </div>
  </div>
</template>

<script>
export default {
  name: 'TableFloorPlan'
}
</script>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick, onActivated, onDeactivated } from 'vue';
import { useRouter } from 'vue-router';
import { preloadRoute, scheduleIdlePreload } from '@/pos/idlePreload.js';
import { setLanguage, t } from '@/shared/i18n.js';
import { useAuth } from '@/pos/useAuth.js';
import { useTables } from '@/pos/useTables.js';
import TableItemTransferModal from './pos/TableItemTransferModal.vue';
import TableElapsedTime from './pos/TableElapsedTime.vue';
import { floorNow, setFloorClock } from '@/utils/floorMinuteClock.js';
import { useSocket } from '@/pos/useSocket.js';
import { createKeepAliveRefreshTracker } from '@/pos/keepAliveRefreshTracker.js';
import { startIdleTracker, stopIdleTracker } from '@/pos/useIdleTracker.js';
import { usePermissions } from '@/pos/usePermissions.js';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';
import {
  getTableStatusClass,
  getTableStatusKey
} from '../utils/tableFloorPlanPresentation.js';

const router = useRouter();
const isPosDark = localStorage.getItem('pos_theme') === 'dark';

// Wire up composables
const auth = useAuth();
const tablesStore = useTables();

const { can } = usePermissions();

const { activeUser, logout } = auth;
const {
  tableSettings: settings,
  tableSections: sections,
  restaurantTables: tables,
  isTableWorkspaceLoading,
  tableWorkspaceLoadFailed,
  canTransferTable,
  canUpdateTable,
  canJoinTables,
  transferTableOrder,
  captureTableActionSource,
  pendingTableAction,
  reconcileTableAction,
  retryTableAction,
  joinTables,
  disjoinTable,
  activeMode,
  activeModeSourceTable,
  joinSelectedChildIds,
  canSplitBillPermission
} = tablesStore;

// First-load skeleton follows the store's read, not component lifecycle hooks.
const showSkeleton = computed(() => isTableWorkspaceLoading.value && !tablesStore.tableWorkspaceLoaded.value);
// Tables with an in-flight open/transfer/join/disjoin; non-empty blocks a second action.
const pendingTableIds = ref([]);
const runTableAction = async (ids, action) => {
  if (pendingTableIds.value.length) return;
  pendingTableIds.value = ids;
  try { await action(); } finally { pendingTableIds.value = []; }
};
const itemTransferSource = ref(null);
const closeItemTransfer = async () => {
  const number = itemTransferSource.value?.table_number;
  itemTransferSource.value = null;
  await nextTick();
  [...document.querySelectorAll('[data-testid="table-card"]')].find(card => card.dataset.tableNumber === String(number))?.querySelector('.table-card__options')?.focus();
};
let floorVisible = false;
const activeSection = ref(null);
const dynamicTableInput = ref('');
const dynamicInput = ref(null);
const tableSearchQuery = ref('');
const showNavigationMenu = ref(false);

const closeNavigationMenu = () => {
  showNavigationMenu.value = false;
};

const getTableAriaLabel = (table) => {
  const parts = [
    `${t('Table')} ${table.table_number}`,
    t(getTableStatusKey(table.status))
  ];
  if (table.active_order_waiter_name) parts.push(table.active_order_waiter_name);
  return parts.join(', ');
};

const getTableOptionsLabel = (table) => `${t('Table options')} ${table.table_number}`;
const formatTableTotal = (value) => Number(value || 0).toFixed(2);

// Table Management Actions State
const selectedActionTable = ref(null);
const showActionSheet = ref(false);
const actionSheetDialog = ref(null);
const checkingTransfer = ref(false);
const pinModalCallback = ref(null); // Function to call when PIN is entered
const showPinModal = ref(false);
const pinDialog = ref(null);
const enteredPin = ref('');
const pinErrorMessage = ref('');

const closePinModal = () => {
  showPinModal.value = false;
  pinModalCallback.value = null;
};
usePosDialogFocus({
  open: showActionSheet,
  dialog: actionSheetDialog,
  onEscape: () => { showActionSheet.value = false; },
});
usePosDialogFocus({ open: showPinModal, dialog: pinDialog, onEscape: closePinModal });

// Touch & Context interaction variables
let touchTimer = null;
let isLongPress = false;
let startTouchX = 0;
let startTouchY = 0;

const startTouchHold = (table, event) => {
  if (event.touches && event.touches.length > 1) return;
  isLongPress = false;
  const touch = event.touches[0];
  startTouchX = touch.clientX;
  startTouchY = touch.clientY;
  
  if (touchTimer) clearTimeout(touchTimer);
  if (activeMode.value) return;

  touchTimer = setTimeout(() => {
    isLongPress = true;
    navigator.vibrate?.(40);
    triggerActionSheet(table);
  }, 600);
};

const moveTouchHold = (event) => {
  if (!touchTimer) return;
  const touch = event.touches[0];
  const deltaX = Math.abs(touch.clientX - startTouchX);
  const deltaY = Math.abs(touch.clientY - startTouchY);
  if (deltaX > 10 || deltaY > 10) {
    clearTimeout(touchTimer);
    touchTimer = null;
  }
};

const endTouchHold = () => {
  if (touchTimer) {
    clearTimeout(touchTimer);
    touchTimer = null;
  }
};

const triggerActionSheet = (table) => {
  if (pendingTableAction.value) return;
  selectedActionTable.value = captureTableActionSource(table);
  showActionSheet.value = true;
};

const handleTableContext = (table) => {
  if (activeMode.value) return;
  triggerActionSheet(table);
};

const getParentTableNumber = (parentId) => {
  if (!parentId) return '';
  const parent = tables.value.find(t => t.id === parentId);
  return parent ? parent.table_number : '';
};

const getTableSplitsCount = (table) => {
  const count = Number(table?.active_split_count || 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
};

const totalTableSplits = computed(() => {
  const bills = new Set();
  let total = 0;
  for (const table of tables.value) {
    const count = getTableSplitsCount(table);
    if (!count || !table.current_order_id) continue;
    const billId = String(table.current_order_id);
    if (bills.has(billId)) continue;
    bills.add(billId);
    total += count;
  }
  return total;
});

const hasJoinedChildren = (tableId) => {
  if (!tableId) return false;
  return tables.value.some(t => t.seating_parent_id === tableId);
};

const hasPrintedSeatingMember = table => table?.status === 'printed'
  || tables.value.some(row => row.seating_parent_id === table?.id && row.status === 'printed');

const handleTableClick = async (table) => {
  if (pendingTableIds.value.length) return;
  if (isLongPress) {
    isLongPress = false;
    return;
  }

  // 1. If in Transfer mode
  if (activeMode.value === 'transfer') {
    if (pendingTableAction.value) return;
    if (!activeModeSourceTable.value) {
      cancelMode();
      return;
    }
    if (table.id === activeModeSourceTable.value.id) {
      window.showPosToast?.(t("Cannot transfer to the same table."), "warning");
      return;
    }
    if (table.current_order_id) {
      window.showPosToast?.(t("Target table is occupied. Choose an available table."), "warning");
      return;
    }
    if (table.parent_table_id) {
      window.showPosToast?.(t("Cannot transfer to a joined child table."), "warning");
      return;
    }
    await executeTransfer(activeModeSourceTable.value.id, table.id, 'transfer');
    return;
  }

  // 2. If in Join mode
  if (activeMode.value === 'join') {
    if (table.id === activeModeSourceTable.value.id) {
      window.showPosToast?.(t("Parent table cannot be a child."), "warning");
      return;
    }
    const idx = joinSelectedChildIds.value.indexOf(table.id);
    if (idx > -1) {
      joinSelectedChildIds.value.splice(idx, 1);
    } else {
      if (hasPrintedSeatingMember(table) || hasPrintedSeatingMember(activeModeSourceTable.value)) {
        window.showPosToast?.(t('Tables with a printed bill cannot be joined.'), 'warning');
        return;
      }
      if (table.seating_parent_id && table.seating_parent_id !== activeModeSourceTable.value.id) {
        window.showPosToast?.(t('Select the parent of that seating group.'), 'warning');
        return;
      }
      joinSelectedChildIds.value.push(table.id);
    }
    return;
  }

  // 3. Normal Click Flow - immediately enter the table
  await openTable(table);
};

const executeTransfer = (sourceId, targetId, actionType) => runTableAction([sourceId, targetId], async () => {
  const res = await transferTableOrder(sourceId, targetId, actionType);
  if (res.success) {
    window.showPosToast?.(t(res.message), "success");
    cancelMode();
    showActionSheet.value = false;
  } else {
    if (res.conflict) cancelMode();
    await window.showPosAlert(t(res.message));
  }
});

const recoverTransfer = async (retry = false) => {
  if (checkingTransfer.value) return;
  checkingTransfer.value = true;
  try {
    const result = await (retry ? retryTableAction() : reconcileTableAction());
    if (result.success) {
      cancelMode();
      window.showPosToast?.(t(result.message), 'success');
    } else if (retry && result.message) {
      if (result.conflict) cancelMode();
      window.showPosToast?.(t(result.message), 'warning');
    }
  } finally { checkingTransfer.value = false; }
};

const executeJoin = (parentId, childIds, pin = null) => runTableAction([parentId, ...childIds], async () => {
  const res = await joinTables(parentId, childIds, pin);
  if (res.success) {
    window.showPosToast?.(t(res.message), "success");
    cancelMode();
    showActionSheet.value = false;
  } else if (res.pinRequired) {
    promptPin((enteredPin) => {
      executeJoin(parentId, childIds, enteredPin);
    });
  } else {
    await window.showPosAlert(t(res.message));
  }
});

const executeDisjoin = (tableIds, pin = null) => runTableAction([...tableIds], async () => {
  const res = await disjoinTable(tableIds, pin);
  if (res.success) {
    window.showPosToast?.(t(res.message), "success");
    showActionSheet.value = false;
  } else if (res.pinRequired) {
    promptPin((enteredPin) => {
      executeDisjoin(tableIds, enteredPin);
    });
  } else {
    await window.showPosAlert(t(res.message));
  }
});

const handleDisjoinClick = () => {
  if (!selectedActionTable.value) return;
  const table = selectedActionTable.value;
  if (table.seating_parent_id) {
    // Child table: disjoin itself
    executeDisjoin([table.id]);
  } else {
    // Parent table: find all child tables and disjoin them
    const children = tables.value.filter(t => t.seating_parent_id === table.id).map(t => t.id);
    if (children.length > 0) {
      executeDisjoin(children);
    }
  }
};

const promptPin = (callback) => {
  pinModalCallback.value = callback;
  enteredPin.value = '';
  pinErrorMessage.value = '';
  showPinModal.value = true;
};

const submitPin = () => {
  const pin = enteredPin.value.trim();
  if (!pin) {
    pinErrorMessage.value = t("PIN is required.");
    return;
  }
  const callback = pinModalCallback.value;
  closePinModal();
  callback?.(pin);
};

const cancelMode = () => {
  activeMode.value = null;
  activeModeSourceTable.value = null;
  joinSelectedChildIds.value = [];
};

const nowTime = floorNow;
const presentationActive = ref(false);
const startPresentationClock = () => { presentationActive.value = true; };
const stopPresentationClock = () => { presentationActive.value = false; setFloorClock(false); };

const tableCounts = computed(() => {
  const counts = { available: 0, occupied: 0, printed: 0 };
  tables.value.forEach((t) => {
    if (t.status === 'available') counts.available++;
    else if (t.status === 'occupied') counts.occupied++;
    else if (t.status === 'printed') counts.printed++;
  });
  return counts;
});

const currentSectionName = computed(() => {
  const activeSec = sections.value.find((s) => s.id === activeSection.value);
  return activeSec ? activeSec.name : t('No section');
});

const activeSectionIndex = computed(() => {
  return sections.value.findIndex((s) => s.id === activeSection.value);
});

const handleSwipeLeft = () => {
  if (sections.value.length <= 1) return;
  const currentIndex = activeSectionIndex.value;
  if (currentIndex < sections.value.length - 1) {
    activeSection.value = sections.value[currentIndex + 1].id;
  }
};

const handleSwipeRight = () => {
  if (sections.value.length <= 1) return;
  const currentIndex = activeSectionIndex.value;
  if (currentIndex > 0) {
    activeSection.value = sections.value[currentIndex - 1].id;
  }
};

let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;

const handleTouchStart = (e) => {
  if (e.touches && e.touches.length === 1) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  }
};

const handleTouchEnd = (e) => {
  if (e.changedTouches && e.changedTouches.length === 1) {
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const touchEndTime = Date.now();

    const diffX = touchEndX - touchStartX;
    const diffY = touchEndY - touchStartY;
    const elapsedTime = touchEndTime - touchStartTime;

    if (Math.abs(diffX) > 60 && Math.abs(diffY) < 50 && elapsedTime < 350) {
      if (diffX < 0) {
        handleSwipeLeft();
      } else {
        handleSwipeRight();
      }
    }
  }
};

watch(activeSection, (newId, oldId) => {
  if (!newId) return;
  nextTick(() => {
    const tabEl = document.getElementById(`section-tab-${newId}`);
    if (tabEl) {
      tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  });
});

const filteredTablesList = computed(() => {
  if (!activeSection.value) return [];
  let list = tables.value.filter((t) => t.section_id === activeSection.value);
  const q = String(tableSearchQuery.value || '').trim().toLowerCase();
  if (q) {
    list = list.filter(t => 
      String(t.table_number).includes(q) ||
      String(t.active_order_waiter_name || '').toLowerCase().includes(q)
    );
  }
  return list;
});

// The minute clock runs only while an elapsed label is on screen.
const needsPresentationClock = computed(() => presentationActive.value
  && filteredTablesList.value.some(table => table.current_order_id && table.active_order_created_at));
watch(needsPresentationClock, setFloorClock, { flush: 'sync' });


let cancelPosPreload = null;
const loadTables = async ({ force = false } = {}) => {
  try {
    await tablesStore.loadTableWorkspace({ force, skipActivation: true });
    if (!floorVisible) return;
    // Every table open leads to POS: warm its chunk once the floor is painted.
    cancelPosPreload ??= scheduleIdlePreload(() => [preloadRoute(router, '/pos')]);
    if (sections.value.length > 0 && !activeSection.value) activeSection.value = sections.value[0].id;
    await setLanguage(settings.value?.admin_language || localStorage.getItem('pos_admin_language') || 'en');
    if (settings.value.table_mode === 'dynamic') {
      nextTick(() => {
        if (dynamicInput.value) dynamicInput.value.focus();
      });
    }
  } catch (e) {
    console.error('Error loading tables', e);
    window.showPosToast?.(t("Failed to load tables data. Please check connection."), "error");
  }
};

const openTable = async (table) => {
  const billId = table.current_order_id;
  const openSplits = () => router.push({ path: '/table-splits', query: { parent_invoice_id: String(billId) } });
  if (billId && canSplitBillPermission.value && getTableSplitsCount(table) > 0) {
    openSplits();
    return;
  }
  await runTableAction([table.id], async () => {
    try {
      await tablesStore.loadActiveTableOrder(table);
      // Stay pending until POS mounts; a failed chunk load is already announced
      // by router.onError, so it only frees the floor for another tap.
      await router.push('/pos').catch(() => {});
    } catch (e) {
      if (billId && canSplitBillPermission.value && e.code === 'SPLIT_CHECKS_OPEN') {
        openSplits();
        return;
      }
      console.error('Error opening table order', e);
      await window.showPosAlert(e.message ? t(e.message) : t('Error opening table order'));
    }
  });
};

const processDynamicTable = async () => {
  const tableNumber = String(dynamicTableInput.value || '').trim();
  if (!tableNumber) return;
  if (!/^\d+$/.test(tableNumber)) {
    await window.showPosAlert(t('Enter a valid table number.'));
    return;
  }
  const table = tables.value.find((t) => String(t.table_number) === tableNumber);

  if (table) {
    openTable(table);
  } else {
    openTable({ id: null, table_number: tableNumber, section_name: 'Dynamic', status: 'available' });
  }
};

const goToPOS = () => {
  tablesStore.clearActiveTableSession({ clearCart: true });
  router.push('/pos');
};

// Admin dashboard is a separate app (own auth guard, reads pos_user from
// sessionStorage); a full navigation hands off cleanly.
const goToAdminDashboard = () => {
  window.location.href = '/admin/dashboard';
};

const { socket, connectionGeneration, isSocketConnected, printerStatuses, initSocket } = useSocket();
// Table listeners stay bound while the floor is parked: row patches apply in place,
// anything needing a snapshot marks it dirty, and activation reads only then.
const floorRefresh = createKeepAliveRefreshTracker();

const allPrintersOnline = computed(() => printerStatuses.value.length > 0 && printerStatuses.value.every(p => p.online));
const anyPrinterOnline = computed(() => printerStatuses.value.some(p => p.online));

let updateTimeout = null;
const queueFloorRefresh = () => {
  if (!floorVisible) {
    floorRefresh.markDirty('tables');
    return;
  }
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = setTimeout(() => {
    updateTimeout = null;
    if (floorVisible) tablesStore.loadTableWorkspace({ force: true, skipActivation: true });
  }, 250);
};

const onTableUpdate = (payload) => {
  if (payload && payload.action === 'update_single_table' && payload.table) {
    const idx = tables.value.findIndex((t) => t.id === payload.table.id);
    if (idx !== -1) {
      tables.value[idx] = { ...tables.value[idx], ...payload.table };
    }
    // A full read already in flight may carry an older row; queue one follow-up read.
    if (isTableWorkspaceLoading.value) tablesStore.loadTableWorkspace({ force: true, skipActivation: true });
    return;
  }
  queueFloorRefresh();
};

// tables_enabled and table_mode arrive with the floor read; refresh once when either
// changes (or when the event names no keys).
const onSettingsChanged = (payload) => {
  if (payload?.keys?.length && !payload.keys.some(key => key === 'tables_enabled' || key === 'table_mode')) return;
  queueFloorRefresh();
};

const onTableDraftChanged = ({ tableId, itemCount }) => {
  const t = tables.value.find((tbl) => tbl.id === tableId);
  if (t) {
    t.qr_draft_count = itemCount;
  }
};

// Register holds (no table, no parent bill) never change a floor field; split
// mutations also broadcast update_single_table rows. A failed floor load
// retries on the heartbeat, so these events are not needed for recovery.
const onHeldOrdersChanged = (payload) => {
  if (payload?.action && payload.action !== 'cleared'
    && payload.table_id == null && payload.parent_invoice_id == null) return;
  queueFloorRefresh();
};

let lastSeenUserId = null; // Set on mount; checked on each activation for same-tab user-switch defense
let hasActivatedTables = false;

const handleSocketReconnected = () => {
  if (pendingTableAction.value) recoverTransfer();
  loadTables({ force: true });
};

// Heartbeat/focus recovery: a no-op while healthy and while the floor is parked.
const retryFailedFloorReads = () => {
  if (!floorVisible) return;
  if (pendingTableAction.value) recoverTransfer();
  if (tableWorkspaceLoadFailed.value && !isTableWorkspaceLoading.value) loadTables({ force: true });
  // A saved QR import whose draft delete is unconfirmed (no request otherwise).
  void tablesStore.dismissActiveQrDraft(null, { retryImported: true });
};
const unbindFloorRetry = () => {
  socket.value?.io?.off('ping', retryFailedFloorReads);
  window.removeEventListener('focus', retryFailedFloorReads);
};

onMounted(() => {
  const userStr = sessionStorage.getItem('pos_user');
  if (!userStr) {
    window.location.href = '/login';
    return;
  }
  try {
    lastSeenUserId = JSON.parse(userStr)?.id ?? null;
    activeUser.value = JSON.parse(userStr);
  } catch (parseErr) {
    console.error("Failed to parse user session in floor plan:", parseErr);
    window.location.href = '/login';
    return;
  }
  floorVisible = true;
  recoverTransfer();
  loadTables();
  startPresentationClock();
});

onActivated(() => {
  // D3-MED: Detect same-tab user switch (defense-in-depth — logout normally hard-reloads)
  try {
    const userStr = sessionStorage.getItem('pos_user');
    const currentId = userStr ? JSON.parse(userStr)?.id : null;
    if (currentId && lastSeenUserId && String(currentId) !== String(lastSeenUserId)) {
      window.location.reload();
      return;
    }
    if (currentId) lastSeenUserId = currentId;
  } catch (_) {}

  // Keep deliberate POS -> floor-plan transfer/join handoff, but clear stale modes.
  if (!['transfer', 'join'].includes(activeMode.value) || !activeModeSourceTable.value) {
    activeMode.value = null;
    activeModeSourceTable.value = null;
  }
  joinSelectedChildIds.value = [];

  showActionSheet.value = false;
  showPinModal.value = false;
  showNavigationMenu.value = false;
  enteredPin.value = '';
  pinErrorMessage.value = '';
  tableSearchQuery.value = '';
  dynamicTableInput.value = '';
  selectedActionTable.value = null;

  // Mounted owns the first load. Activation refreshes subsequent visits.
  floorVisible = true;
  startPresentationClock();
  const refresh = floorRefresh.activate(connectionGeneration.value);
  if (hasActivatedTables) {
    recoverTransfer();
    if (refresh.tables || tableWorkspaceLoadFailed.value) loadTables({ force: true });
    else if (!tablesStore.tableWorkspaceLoaded.value) loadTables();
  }
  hasActivatedTables = true;

  try {
    const s = initSocket();
    s.off('table_update', onTableUpdate);
    s.on('table_update', onTableUpdate);
    s.off('settings_changed', onSettingsChanged);
    s.on('settings_changed', onSettingsChanged);
    s.off('table_draft_changed', onTableDraftChanged);
    s.on('table_draft_changed', onTableDraftChanged);
    s.off('held_orders_changed', onHeldOrdersChanged);
    s.on('held_orders_changed', onHeldOrdersChanged);
    s.io?.off('ping', retryFailedFloorReads);
    s.io?.on('ping', retryFailedFloorReads);
  } catch (socketErr) {
    console.error("Failed to initialize floor plan Socket connection:", socketErr);
  }
  window.removeEventListener('socket_reconnected', handleSocketReconnected); // D5-LOW: remove before re-adding
  window.addEventListener('socket_reconnected', handleSocketReconnected);
  window.removeEventListener('focus', retryFailedFloorReads);
  window.addEventListener('focus', retryFailedFloorReads);
  // Restart idle tracker in case this is a fresh login (App.vue's onMounted ran before sessionStorage was populated)
  if (activeUser.value?.id) startIdleTracker(activeUser.value);
});

onDeactivated(() => {
  itemTransferSource.value = null;
  floorVisible = false;
  stopPresentationClock();
  floorRefresh.deactivate(connectionGeneration.value);
  if (updateTimeout) {
    clearTimeout(updateTimeout);
    floorRefresh.markDirty('tables');
  }
  updateTimeout = null;
  showNavigationMenu.value = false;
  // Table listeners stay bound (unbound on unmount); while parked they only
  // patch rows or mark the floor dirty. A reconnect shows as a generation change.
  window.removeEventListener('socket_reconnected', handleSocketReconnected);
  unbindFloorRetry();
});

onUnmounted(() => {
  floorVisible = false;
  stopIdleTracker();
  stopPresentationClock();
  cancelPosPreload?.();
  if (updateTimeout) clearTimeout(updateTimeout);
  if (socket.value) {
    socket.value.off('table_update', onTableUpdate);
    socket.value.off('settings_changed', onSettingsChanged);
    socket.value.off('table_draft_changed', onTableDraftChanged);
    socket.value.off('held_orders_changed', onHeldOrdersChanged);
  }
  window.removeEventListener('socket_reconnected', handleSocketReconnected);
  unbindFloorRetry();
});
</script>

<style scoped>
.tables-page {
  --tables-teal: #24405e;
  --tables-canvas: #e3e6ea;
  --tables-surface: #f2f4f6;
  --tables-surface-muted: #e7eaef;
  --tables-card: #f2f4f6;
  --tables-card-hover: #f8f9fa;
  --tables-line: #aeb8c2;
  --tables-ink: #111827;
  --tables-muted: #526071;
  --tables-tactile-edge: #7f8b98;
  min-height: 100dvh;
  background: var(--tables-canvas);
  color: var(--tables-ink);
  font-family: 'Inter', 'IBM Plex Sans Arabic', sans-serif;
}

.tables-page.pos-theme-dark {
  color-scheme: dark;
  --tables-teal: #4b7199;
  --tables-canvas: #15191e;
  --tables-surface: #20252b;
  --tables-surface-muted: #242a31;
  --tables-card: #2a3038;
  --tables-card-hover: #303741;
  --tables-line: #46515e;
  --tables-ink: #f1f4f7;
  --tables-muted: #c3cbd5;
  --tables-tactile-edge: #11151a;
}

:global(html[dir='rtl']) .tables-page {
  font-family: 'IBM Plex Sans Arabic', 'Inter', sans-serif;
}

.tables-main {
  background: var(--tables-canvas);
}

.mode-bar {
  position: relative;
  z-index: 20;
  min-height: 56px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 13px;
  color: #fff;
}

.mode-bar--transfer { background: #24405e; }
.mode-bar--join { background: #a16207; }

.mode-bar > div:first-child {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 0.82rem;
  font-weight: 650;
}

.mode-bar > div:first-child span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.mode-bar b {
  direction: ltr;
  display: inline-block;
  font-variant-numeric: tabular-nums;
  unicode-bidi: isolate;
}

.mode-bar button {
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid rgb(255 255 255 / 0.32);
  border-radius: 8px;
  background: rgb(17 24 39 / 0.13);
  color: #fff;
  font-size: 0.78rem;
  font-weight: 750;
  white-space: nowrap;
}

.mode-bar button:hover,
.mode-bar button:focus-visible {
  background: rgb(255 255 255 / 0.14);
  outline: none;
}

.mode-bar button:focus-visible {
  box-shadow: 0 0 0 3px rgb(255 255 255 / 0.28);
}

.mode-bar button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.mode-bar__actions {
  flex: 0 0 auto;
  display: flex;
  gap: 7px;
}

.tables-empty-state {
  width: min(100%, 380px);
  min-height: 280px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 44px 18px;
  color: var(--tables-muted);
  text-align: center;
}

.tables-empty-state__icon {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  margin-bottom: 14px;
  border: 1px solid var(--tables-line);
  border-radius: 10px;
  background: var(--tables-surface);
  color: var(--tables-teal);
}

.tables-empty-state h3 {
  margin: 0;
  color: var(--tables-ink);
  font-size: 1rem;
  font-weight: 800;
}

.tables-empty-state p {
  margin: 7px 0 0;
  font-size: 0.82rem;
  font-weight: 550;
  line-height: 1.6;
}

.dynamic-mode {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  padding: 18px;
}

.dynamic-panel {
  width: min(100%, 380px);
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  border: 1px solid var(--tables-line);
  border-radius: 12px;
  background: var(--tables-surface);
}

.dynamic-panel__intro {
  text-align: center;
}

.dynamic-panel__icon,
.pin-dialog__icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  margin: 0 auto 12px;
  border-radius: 9px;
  background: rgb(36 64 94 / 0.1);
  color: var(--tables-teal);
}

.dynamic-panel h2,
.pin-dialog h3 {
  margin: 0;
  color: var(--tables-ink);
  font-size: 1rem;
  font-weight: 800;
}

.dynamic-panel__intro p,
.pin-dialog > p {
  margin: 7px 0 0;
  color: var(--tables-muted);
  font-size: 0.82rem;
  line-height: 1.55;
}

.dynamic-panel__form {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.dynamic-panel__form label {
  color: var(--tables-muted);
  font-size: 0.78rem;
  font-weight: 700;
}

.dynamic-panel__form input,
.pin-dialog__input {
  width: 100%;
  min-height: 52px;
  border: 1px solid var(--tables-line);
  border-radius: 8px;
  background: var(--tables-card);
  color: var(--tables-ink);
  font-family: 'Inter', sans-serif;
  font-size: 1.6rem;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  outline: none;
  text-align: center;
}

.dynamic-panel__form input:focus,
.pin-dialog__input:focus {
  border-color: var(--tables-teal);
  box-shadow: 0 0 0 3px rgb(36 64 94 / 0.13);
}

.dynamic-panel__form > button {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--tables-teal);
  border-radius: 8px;
  background: var(--tables-teal);
  color: #fff;
  font-size: 0.82rem;
  font-weight: 800;
}

.dynamic-panel__form > button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgb(25 29 27 / 0.48);
}

.dialog-backdrop--pin {
  z-index: 110;
  align-items: center;
  padding: 14px;
}

.table-actions-dialog,
.pin-dialog {
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--tables-line);
  background: var(--tables-surface);
  color: var(--tables-ink);
}

.table-actions-dialog {
  max-height: calc(100dvh - 18px);
  padding-bottom: max(10px, env(safe-area-inset-bottom));
  border-radius: 14px 14px 0 0;
}

.table-actions-dialog__header {
  min-height: 67px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 13px;
  border-bottom: 1px solid var(--tables-line);
  background: var(--tables-surface-muted);
}

.table-actions-dialog__header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 850;
}

.table-actions-dialog__header h3 span,
.table-actions-dialog__header p b {
  direction: ltr;
  display: inline-block;
  font-variant-numeric: tabular-nums;
  unicode-bidi: isolate;
}

.table-actions-dialog__header p {
  margin: 3px 0 0;
  color: var(--tables-muted);
  font-size: 0.75rem;
  font-weight: 600;
}

.dialog-close {
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--tables-muted);
}

.dialog-close:hover,
.dialog-close:focus-visible {
  background: rgb(36 64 94 / 0.09);
  color: var(--tables-teal);
  outline: none;
}

.table-actions-dialog__actions {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px 2px;
}

.dialog-action {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  padding: 0 13px;
  border: 1px solid var(--tables-line);
  border-radius: 8px;
  background: var(--tables-surface-muted);
  color: var(--tables-ink);
  font-size: 0.82rem;
  font-weight: 750;
  text-align: start;
}

.dialog-action i {
  width: 18px;
  color: var(--tables-teal);
  text-align: center;
}

.dialog-action:hover,
.dialog-action:focus-visible {
  border-color: rgb(36 64 94 / 0.35);
  background: rgb(36 64 94 / 0.09);
  color: var(--tables-teal);
  outline: none;
}

.dialog-action--primary {
  border-color: var(--tables-teal);
  background: var(--tables-teal);
  color: #fff;
}

.dialog-action--primary i { color: #fff; }
.dialog-action--primary:hover,
.dialog-action--primary:focus-visible { background: #345988; color: #fff; }

.dialog-action--danger {
  border-color: #e1b5b1;
  background: #f6e7e5;
  color: #8e3731;
}

.dialog-action--danger i { color: #8e3731; }
.dialog-action--danger:hover,
.dialog-action--danger:focus-visible { border-color: #c97870; background: #f2d8d5; color: #7a2f2a; }

.pin-dialog {
  max-width: 320px;
  padding: 20px;
  border-radius: 12px;
  text-align: center;
}

.pin-dialog__input {
  margin-top: 16px;
  letter-spacing: 0.2em;
}

.pin-dialog__error {
  margin: 7px 0 0;
  color: #ad4c45;
  font-size: 0.75rem;
  font-weight: 700;
}

.pin-dialog__actions {
  display: flex;
  gap: 7px;
  margin-top: 12px;
}

.pin-dialog__actions .dialog-action {
  justify-content: center;
}

.tables-header {
  position: relative;
  z-index: 30;
  min-height: 50px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 2px;
  background: var(--tables-surface);
  border-bottom: 1px solid var(--tables-line);
}

.tables-heading {
  min-width: 118px;
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: stretch;
  padding-inline: 8px;
}

.tables-heading__icon {
  width: 40px;
  height: 100%;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 1px solid var(--tables-line);
  border-radius: 3px;
  background: rgb(36 64 94 / 0.1);
  color: var(--tables-teal);
}

.tables-heading h1 {
  margin: 0;
  font-size: 1.05rem;
  line-height: 1.2;
  font-weight: 800;
}

.tables-heading p {
  margin: 2px 0 0;
  max-width: 145px;
  overflow: hidden;
  color: var(--tables-muted);
  font-size: 0.72rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tables-header__spacer {
  flex: 1;
}

.tables-counts {
  gap: 5px;
}

.tables-count {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 7px;
  border: 1px solid var(--tables-line);
  border-radius: 3px;
  background: var(--tables-surface-muted);
  color: var(--tables-muted);
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.tables-count b {
  direction: ltr;
  color: var(--tables-ink);
  font-size: 0.88rem;
  font-variant-numeric: tabular-nums;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.status-dot--available { background: #2d6a4f; }
.status-dot--occupied { background: #ad4c45; }
.status-dot--printed { background: #3d699b; }

.tables-search {
  position: relative;
  width: 155px;
}

.tables-search i {
  position: absolute;
  inset-inline-start: 11px;
  top: 50%;
  color: #747c77;
  transform: translateY(-50%);
}

.tables-search input {
  width: 100%;
  min-height: 40px;
  padding-inline: 34px 11px;
  border: 1px solid var(--tables-line);
  border-radius: 3px;
  background: var(--tables-surface-muted);
  color: var(--tables-ink);
  font-size: 0.78rem;
  outline: none;
}

.tables-search input:focus {
  border-color: var(--tables-teal);
  box-shadow: 0 0 0 3px rgb(36 64 94 / 0.12);
}

.tables-action,
.tables-icon-action,
.tables-menu-trigger {
  min-height: 44px;
  border: 1px solid var(--tables-line);
  border-radius: 3px;
  background: var(--tables-surface-muted);
  color: var(--tables-ink);
  font-size: 0.78rem;
  font-weight: 700;
  box-shadow: inset 0 -2px 0 var(--tables-tactile-edge);
}

.tables-action {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 11px;
}

.tables-action i {
  color: var(--tables-teal);
}

.tables-action b {
  min-width: 20px;
  height: 20px;
  display: inline-grid;
  place-items: center;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--tables-teal);
  color: #fff;
  font-size: 0.7rem;
}

.tables-icon-action {
  width: 44px;
  display: grid;
  place-items: center;
}

.tables-menu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 13px;
  border-color: var(--tables-teal);
  background: var(--tables-teal);
  color: #fff;
}

.tables-action:hover,
.tables-icon-action:hover {
  border-color: rgb(36 64 94 / 0.35);
  background: rgb(36 64 94 / 0.08);
  color: var(--tables-teal);
}

.tables-action:focus-visible,
.tables-icon-action:focus-visible,
.tables-menu-trigger:focus-visible {
  outline: 3px solid rgb(36 64 94 / 0.28);
  outline-offset: 2px;
}

.tables-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 31;
  border: 0;
  background: transparent;
}

.tables-navigation-menu {
  position: absolute;
  z-index: 32;
  inset-block-start: calc(100% + 7px);
  inset-inline-end: 0;
  width: min(220px, calc(100vw - 24px));
  padding: 6px;
  border: 1px solid var(--tables-line);
  border-radius: 10px;
  background: var(--tables-surface);
  box-shadow: 0 6px 18px rgb(25 29 27 / 0.1);
}

.tables-navigation-menu button {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 11px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--tables-ink);
  font-size: 0.82rem;
  font-weight: 700;
  text-align: start;
}

.tables-navigation-menu button i {
  width: 18px;
  color: var(--tables-teal);
  text-align: center;
}

.tables-navigation-menu button b {
  margin-inline-start: auto;
  direction: ltr;
}

.tables-navigation-menu button:hover,
.tables-navigation-menu button:focus-visible {
  background: rgb(36 64 94 / 0.1);
  color: var(--tables-teal);
  outline: none;
}

.section-strip {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 1px 2px;
  background: var(--tables-surface);
  border-bottom: 1px solid var(--tables-line);
}

.section-strip__tabs {
  min-width: 0;
  display: flex;
  gap: 1px;
  overflow-x: auto;
}

.section-tab {
  min-height: 36px;
  padding: 0 13px;
  border: 1px solid var(--tables-line);
  border-radius: 3px;
  background: var(--tables-surface-muted);
  color: var(--tables-muted);
  font-size: 0.8rem;
  font-weight: 650;
  white-space: nowrap;
  box-shadow: inset 0 -2px 0 var(--tables-tactile-edge);
}

.section-tab:hover {
  background: rgb(36 64 94 / 0.08);
  color: var(--tables-teal);
}

.section-tab:focus-visible {
  outline: 3px solid rgb(36 64 94 / 0.24);
  outline-offset: 1px;
}

.section-tab--active,
.section-tab--active:hover {
  background: var(--tables-teal);
  color: #fff;
  font-weight: 800;
}

.section-strip__count {
  margin-inline-start: auto;
  color: var(--tables-muted);
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
}

.tables-floor {
  flex: 1;
  padding: 4px;
  overflow-x: hidden;
  overflow-y: auto;
}

.tables-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  width: 100%;
}

.table-card {
  --table-status: #626b66;
  min-width: 0;
  height: 132px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  border: 1px solid rgb(255 255 255 / 0.3);
  border-radius: 4px;
  background: var(--table-status);
  color: #fff;
  cursor: pointer;
  overflow: hidden;
  box-shadow: inset 0 -2px 0 rgb(17 24 39 / 0.48);
  transition: filter 140ms ease, transform 80ms ease, box-shadow 80ms ease, opacity 140ms ease;
}

.table-card:hover { filter: brightness(1.06); }
.table-card:active { transform: translateY(2px); box-shadow: none; }
.table-card:focus-visible { outline: 3px solid var(--tables-teal); outline-offset: 2px; }
.table-card--pending { opacity: 0.6; pointer-events: none; }
.table-card--available { --table-status: #2d6a4f; }
.table-card--occupied { --table-status: #ad4c45; }
.table-card--printed { --table-status: #3d699b; }
.table-card--unknown { --table-status: #626b66; }
.table-card--join-selected { box-shadow: 0 0 0 4px #f59e0b; }
.table-card--transfer-source { opacity: 0.58; box-shadow: 0 0 0 4px #8fa6c4; }

.table-card__top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.table-card__number {
  direction: ltr;
  display: block;
  font: 900 2.45rem/.92 'Inter', sans-serif;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.05em;
  unicode-bidi: isolate;
}

.table-card__label {
  display: block;
  margin-top: 5px;
  color: rgb(255 255 255 / 0.82);
  font-size: 0.72rem;
  font-weight: 650;
}

.table-card__options {
  margin-inline-start: auto;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 0.32);
  border-radius: 4px;
  background: rgb(17 24 39 / 0.18);
  color: #fff;
  box-shadow: inset 0 -2px 0 rgb(17 24 39 / 0.35);
}

.table-card__options:hover { background: rgb(17 24 39 / 0.3); }
.table-card__options:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }

.table-card__indicators {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.table-card__indicators span {
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid rgb(255 255 255 / 0.26);
  background: rgb(17 24 39 / 0.18);
  color: #fff;
  font-size: 0.72rem;
}

.table-card__footer {
  margin-top: auto;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
}

.table-card__meta {
  min-width: 0;
  overflow: hidden;
  color: rgb(255 255 255 / 0.86);
  font-size: 0.76rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-card__total {
  direction: ltr;
  font: 900 0.96rem/1 'Inter', sans-serif;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  unicode-bidi: isolate;
}

.tables-loading {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: var(--tables-canvas);
}

.tables-loading__tabs {
  display: flex;
  gap: 6px;
  overflow: hidden;
}

.tables-loading__tabs div {
  width: 96px;
  height: 36px;
  flex: 0 0 auto;
  border-radius: 7px;
  background: #d7dad6;
  animation: tables-pulse 1.4s ease-in-out infinite alternate;
}

.table-card--loading {
  cursor: default;
  background: #d7dad6;
  animation: tables-pulse 1.4s ease-in-out infinite alternate;
}

@keyframes tables-pulse {
  to { opacity: 0.55; }
}

@media (min-width: 640px) {
  .tables-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .dialog-backdrop { align-items: center; padding: 14px; }
  .table-actions-dialog { max-width: 384px; padding-bottom: 10px; border-radius: 12px; }
}

@media (min-width: 768px) {
  .tables-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
  .table-card { height: 136px; padding: 11px; }
  .tables-floor { padding: 4px; }
}

@media (min-width: 1024px) {
  .tables-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .table-card { height: 140px; }
}

@media (min-width: 1280px) {
  .tables-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
}

@media (min-width: 1536px) {
  .tables-grid { grid-template-columns: repeat(8, minmax(0, 1fr)); }
}

@media (max-width: 767px) {
  .tables-header { min-height: 60px; }
  .tables-heading { min-width: 0; }
  .tables-heading__icon { display: none; }
  .tables-heading p { max-width: 108px; }
}

@media (max-width: 639px) {
  .mode-bar { align-items: stretch; gap: 7px; padding: 7px 9px; }
  .mode-bar > div:first-child { font-size: 0.76rem; }
  .mode-bar > div:first-child span { white-space: normal; }
  .mode-bar__actions { align-items: stretch; }
  .mode-bar button { padding-inline: 10px; }
}

@media (prefers-reduced-motion: reduce) {
  .table-card { transition: none; }
  .section-fade-enter-active,
  .modal-fade-enter-active { transition-duration: 0.01ms; }
  .tables-loading__tabs div,
  .table-card--loading { animation: none; }
}

* {
  -webkit-tap-highlight-color: transparent;
}

.no-select {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}

/* Section Fade Slide Transition */
.section-fade-enter-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.section-fade-enter-from {
  opacity: 0;
  transform: translateX(8px);
}
.section-fade-leave-active {
  display: none;
}

.hide-scroll::-webkit-scrollbar {
  display: none;
}
.hide-scroll {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.premium-scroll::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}
.premium-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.premium-scroll::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.08);
  border-radius: 4px;
}
.premium-scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.15);
}

button, a, select, input, [role="button"] {
  touch-action: manipulation;
}

.overflow-y-auto {
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  touch-action: pan-x pan-y !important; /* Allow swipe left/right for section tabs while scrolling vertically */
}
.overflow-x-auto {
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-x: contain;
  touch-action: pan-x pan-y !important; /* Allow swipe on section tabs and counts bar */
}

/* Modal Fade Transition */
/* Enter-only: the sheet hands off to the PIN dialog or Move Items in the same click. */
.modal-fade-enter-active {
  transition: opacity 150ms ease-out;
}
.modal-fade-enter-from {
  opacity: 0;
}
.modal-fade-leave-active {
  display: none;
}
</style>
